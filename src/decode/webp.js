'use strict';

// WebP. The open dialog has always offered .webp, but Jimp 0.22 has no WebP
// decoder at all, so until now every one the user picked was skipped as "not a
// readable image".
//
// @cwasm/webp is libwebp's still-image decoder compiled to WASM. It reads
// lossy (VP8), lossless (VP8L) and the extended container (VP8X + ALPH), which
// covers ordinary photos. What it does not read is an animation: WebPDecodeRGBA
// fails outright on ANIM/ANMF because libwebp's demuxer is not in this build.
// Animations are common in the wild (saved GIFs, Android screen recordings), so
// we take the container apart ourselves and re-wrap the first ANMF frame as a
// still file — one page beats a skipped file.

// VP8X feature flags (libwebp mux_types.h).
const ALPHA_FLAG = 0x10;

function u24(buf, at) {
  return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16);
}

function write24(buf, at, value) {
  buf[at] = value & 0xff;
  buf[at + 1] = (value >> 8) & 0xff;
  buf[at + 2] = (value >> 16) & 0xff;
}

const TRUNCATED = 'the WebP file is truncated';

// Walk the top-level chunks, believing the length fields only as far as the
// bytes actually go: a half-downloaded WebP keeps its original RIFF size, so a
// size that overruns the file is the signature of a truncated one.
function riffChunks(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF' ||
      buffer.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file');
  }
  const declared = buffer.readUInt32LE(4) + 8;
  if (declared > buffer.length) throw new Error(TRUNCATED);

  const chunks = [];
  let at = 12;
  while (at + 8 <= declared) {
    const size = buffer.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > declared) throw new Error(TRUNCATED);
    chunks.push({ id: buffer.toString('latin1', at, at + 4), start, size });
    at = start + size + (size & 1); // chunks are padded to an even length
  }
  if (!chunks.length) throw new Error('the WebP file has no image data');
  return chunks;
}

function chunkAt(buffer, chunk) {
  return buffer.slice(chunk.start, chunk.start + chunk.size);
}

function riffFile(parts) {
  let body = 4; // the 'WEBP' form type
  for (const part of parts) body += 8 + part.payload.length + (part.payload.length & 1);
  const out = Buffer.alloc(8 + body);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(body, 4);
  out.write('WEBP', 8, 'latin1');
  let at = 12;
  for (const part of parts) {
    out.write(part.id, at, 'latin1');
    out.writeUInt32LE(part.payload.length, at + 4);
    part.payload.copy(out, at + 8);
    at += 8 + part.payload.length + (part.payload.length & 1);
  }
  return out;
}

function vp8xPayload(width, height, flags) {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  write24(payload, 4, width - 1);
  write24(payload, 7, height - 1);
  return payload;
}

// One ANMF -> a standalone still WebP. The frame's bitstream is already a
// complete image; all it lacks is the RIFF wrapper, and it only needs a VP8X
// header when a separate alpha plane travels alongside it.
function frameToStill(buffer, anmf) {
  if (anmf.size < 24) throw new Error(TRUNCATED); // 16-byte header + a chunk header
  const rect = {
    x: u24(buffer, anmf.start) * 2,
    y: u24(buffer, anmf.start + 3) * 2,
    width: u24(buffer, anmf.start + 6) + 1,
    height: u24(buffer, anmf.start + 9) + 1
  };

  const end = anmf.start + anmf.size;
  const parts = [];
  let at = anmf.start + 16;
  while (at + 8 <= end) {
    const size = buffer.readUInt32LE(at + 4);
    if (at + 8 + size > end) throw new Error(TRUNCATED);
    parts.push({ id: buffer.toString('latin1', at, at + 4), payload: buffer.slice(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }

  const image = parts.find(p => p.id === 'VP8 ' || p.id === 'VP8L');
  if (!image) throw new Error('the WebP animation has no first frame');
  const alpha = parts.find(p => p.id === 'ALPH');
  rect.still = alpha
    ? riffFile([{ id: 'VP8X', payload: vp8xPayload(rect.width, rect.height, ALPHA_FLAG) }, alpha, image])
    : riffFile([image]);
  return rect;
}

// gif2webp and friends can store a first frame smaller than the canvas, so
// place it on a full-size canvas of the animation's background colour rather
// than handing back a page of the wrong shape.
function onCanvas(image, canvas, rect, background) {
  const data = Buffer.alloc(canvas.width * canvas.height * 4);
  if (background.some(Boolean)) data.fill(Buffer.from(background));
  const src = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);
  const rowBytes = image.width * 4;
  for (let row = 0; row < image.height; row++) {
    src.copy(data, ((rect.y + row) * canvas.width + rect.x) * 4, row * rowBytes, (row + 1) * rowBytes);
  }
  return { width: canvas.width, height: canvas.height, data };
}

// The ANIM chunk opens with the canvas background colour, stored BGRA.
function animBackground(buffer, anim) {
  if (!anim || anim.size < 4) return [0, 0, 0, 0];
  const bgra = chunkAt(buffer, anim);
  return [bgra[2], bgra[1], bgra[0], bgra[3]];
}

// WebP stores EXIF as a bare TIFF stream, but writers that copy a JPEG's APP1
// segment wholesale leave the "Exif\0\0" marker on the front.
function exifOrientation(payload) {
  const tiff = payload.toString('latin1', 0, 4) === 'Exif' ? payload.slice(6) : payload;
  if (tiff.length < 10) return 0;
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return 0;
  const u16 = at => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = at => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 0;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 0;
    if (u16(entry) !== 0x0112) continue; // Orientation
    const value = u16(entry + 8);        // SHORT, so it lives inline
    return value >= 1 && value <= 8 ? value : 0;
  }
  return 0;
}

async function decode(buffer, ctx) {
  const chunks = riffChunks(buffer);
  const find = id => chunks.find(c => c.id === id);

  const exif = find('EXIF');
  const orientation = exif ? exifOrientation(chunkAt(buffer, exif)) : 0;

  const anmf = find('ANMF');
  const frameCount = anmf ? chunks.filter(c => c.id === 'ANMF').length : 0;
  const rect = anmf ? frameToStill(buffer, anmf) : null;
  if (!anmf && !find('VP8 ') && !find('VP8L')) throw new Error('the WebP file has no image data');

  // Compiling the WASM module happens on require, so pay for it only here.
  const image = (() => {
    try {
      return require('@cwasm/webp').decode(rect ? rect.still : buffer);
    } catch (e) {
      throw new Error(anmf ? 'the first frame of this WebP animation could not be decoded' : 'this WebP image could not be decoded');
    }
  })();

  const vp8x = find('VP8X');
  const canvas = vp8x
    ? { width: u24(buffer, vp8x.start + 4) + 1, height: u24(buffer, vp8x.start + 7) + 1 }
    : { width: image.width, height: image.height };

  let frame;
  if (rect && (image.width !== canvas.width || image.height !== canvas.height)) {
    if (rect.x + image.width > canvas.width || rect.y + image.height > canvas.height) {
      throw new Error('this WebP animation has a malformed first frame');
    }
    frame = onCanvas(image, canvas, rect, animBackground(buffer, find('ANIM')));
  } else {
    frame = {
      width: image.width,
      height: image.height,
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length)
    };
  }

  if (orientation > 1) frame.orientation = orientation;
  // Say so on the page: an animation contributes its opening frame, not a page each.
  if (frameCount > 1) frame.label = `frame 1 of ${frameCount}`;
  return [frame];
}

module.exports = { formats: ['webp'], decode };
