'use strict';

// One entry point for "give me the pictures inside this file", whatever the
// file happens to be: an iPhone HEIC, an AVIF off the web, a WebP screenshot,
// a camera RAW, a multi-page scanner TIFF, or a plain JPEG.
//
// Every decoder here is pure JavaScript or WebAssembly — no native modules —
// so the app still builds for Windows and Linux from one machine (see
// pdfBuilder.js). Decoders are loaded lazily: the WASM ones cost real memory
// and startup time, and most jobs never touch them.
//
// A decoder module exports:
//   formats: string[]                      sniff ids it handles
//   decode(buffer, ctx): Promise<Frame[]>  ctx = { filePath, ext, format }
// and a Frame is either
//   { width, height, data }   RGBA, 8 bits per channel, row-major
//   { encoded: Buffer }       bytes in a format Jimp reads (jpeg/png/bmp/gif)
// optionally carrying { orientation: 1..8 } (EXIF sense, applied here) and
// { label } for a page within a multi-page file.

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { sniffFormat, IMAGE_EXT, PHOTO_EXT, RAW_EXT } = require('./sniff');

// format id -> module path. Required on first use.
const ROUTES = {
  heic: './heif',
  avif: './heif',
  webp: './webp',
  raw: './rawPreview',
  cr3: './rawPreview',
  tiff: './tiff',
  psd: './psd',
  tga: './simple',
  qoi: './simple',
  pnm: './simple',
  ico: './simple'
};

// Formats Jimp reads by itself.
const JIMP_FORMATS = new Set(['jpeg', 'png', 'gif', 'bmp']);

// Tried in order when the header is unrecognised, or when the format's own
// decoder fails. rawPreview is last because it is the catch-all: many odd
// containers still hide an ordinary JPEG preview inside them. The headerless
// formats (TGA and friends) are deliberately absent — they would happily
// "decode" random bytes into a garbage page instead of failing.
const FALLBACKS = ['./heif', './webp', './rawPreview'];

// Formats we can name but cannot decode, so the skip message can say why
// instead of "not a readable image".
const KNOWN_UNSUPPORTED = {
  jxl: 'JPEG XL is not supported yet',
  jp2: 'JPEG 2000 is not supported yet',
  svg: 'SVG is a drawing, not a photo'
};

const cache = new Map();
function loadDecoder(modulePath) {
  if (!cache.has(modulePath)) cache.set(modulePath, require(modulePath));
  return cache.get(modulePath);
}

// EXIF orientation 1..8 -> the transform that puts the picture upright.
// Jimp's rotate() turns counter-clockwise, hence the negative angles.
function applyOrientation(image, orientation) {
  switch (orientation) {
    case 2: return image.mirror(true, false);
    case 3: return image.rotate(180);
    case 4: return image.mirror(false, true);
    case 5: return image.rotate(-90).mirror(true, false);
    case 6: return image.rotate(-90);
    case 7: return image.rotate(-90).mirror(false, true);
    case 8: return image.rotate(90);
    default: return image;
  }
}

async function frameToJimp(frame) {
  let image;
  if (frame && frame.encoded) {
    // Jimp applies EXIF orientation itself when it reads a JPEG.
    image = await Jimp.read(Buffer.isBuffer(frame.encoded) ? frame.encoded : Buffer.from(frame.encoded));
  } else if (frame && frame.data && frame.width > 0 && frame.height > 0) {
    const raw = frame.data;
    // Wrap, never re-wrap-from-.buffer: a typed array can be a view into a
    // larger buffer, and ignoring byteOffset would hand Jimp the wrong bytes.
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const expected = frame.width * frame.height * 4;
    if (data.length < expected) throw new Error('decoder returned a short bitmap');

    // Assign the bitmap rather than `new Jimp({ data })`, which copies it. A
    // 20 MP camera-RAW preview is 76 MB of RGBA, and we are already holding
    // the file plus the decoder's own buffers.
    image = new Jimp(1, 1);
    image.bitmap = { data: data.length === expected ? data : data.subarray(0, expected), width: frame.width, height: frame.height };
    if (frame.orientation > 1) applyOrientation(image, frame.orientation);
  } else {
    throw new Error('decoder returned an empty frame');
  }
  return image;
}

async function runDecoder(modulePath, buffer, ctx) {
  const frames = await loadDecoder(modulePath).decode(buffer, ctx);
  if (!Array.isArray(frames) || !frames.length) throw new Error('no images found in the file');
  return frames;
}

/**
 * Decode every picture in one file.
 *
 * @param filePath  absolute path to an image file
 * @returns         { images: Jimp[], format, labels: (string|undefined)[] }
 * @throws          Error with a short, user-facing message
 */
async function decodeImageFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) throw new Error('the file is empty');

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const format = sniffFormat(buffer, filePath);
  const ctx = { filePath, ext, format };

  if (KNOWN_UNSUPPORTED[format]) {
    const err = new Error(KNOWN_UNSUPPORTED[format]);
    err.userFacing = true;
    throw err;
  }

  // The sniffer works from the file's own bytes, so when it names a format
  // that has its own decoder, that decoder's verdict is final. Retrying with
  // something else can only turn a clean refusal into a corrupt page — Jimp
  // will cheerfully render the readable half of a truncated TIFF, and the
  // format's own decoder rejected it for a reason.
  const attempts = ROUTES[format] && !JIMP_FORMATS.has(format)
    ? [ROUTES[format]]
    : ['jimp', ...FALLBACKS];

  let primaryError;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const frames = attempt === 'jimp'
        ? [{ encoded: buffer }]
        : await runDecoder(attempt, buffer, ctx);
      const images = [];
      for (const frame of frames) images.push(await frameToJimp(frame));
      return {
        images,
        format,
        labels: frames.map(f => f && f.label)
      };
    } catch (e) {
      // Only the decoder the sniffer actually chose gets to explain itself.
      // A fallback's complaint ("input buffer is not a HEIC image") would just
      // confuse someone whose file was never HEIC in the first place.
      if (i === 0) primaryError = e;
    }
  }

  const known = format !== 'unknown' && primaryError && primaryError.message;
  const err = new Error(known ? primaryError.message : 'not a readable image');
  err.userFacing = !!known;
  err.format = format;
  throw err;
}

module.exports = { decodeImageFile, applyOrientation, sniffFormat, IMAGE_EXT, PHOTO_EXT, RAW_EXT };
