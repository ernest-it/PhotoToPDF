'use strict';

// The ISO base-media image formats: HEIC/HEIF (iPhone and iPad photos, Canon
// and Sony .HIF) and AVIF. Same container, different codec, so two WASM
// engines behind one decoder — libheif-js for HEVC, @saschazar/wasm-avif
// (libavif) for AV1. No native module, no external tool.
//
// libheif-js entry point matters for packaging. 'libheif-js/wasm' loads its
// binary with fs.readFileSync('./libheif-wasm/libheif.wasm'), a path relative
// to the working directory, which never resolves inside an asar archive. The
// default entry is pure asm.js: it works, but it is ~2.5x slower to require
// (150ms vs 55ms), ~2x slower to decode a 12 MP photo (1.7s vs 0.8s) and needs
// twice the peak memory (360MB vs 170MB). 'wasm-bundle' inlines the .wasm
// inside the JS, so it loads by require alone and is the fastest of the three.
//
// The two engines differ in what they hand back, and the difference is the
// whole reason this file is longer than its siblings: libheif applies the
// container's rotation itself, libavif does not, so AVIF frames carry an
// `orientation` and HEIC frames must not.

const fs = require('fs');
const path = require('path');

// Both modules are megabytes of JS around a megabyte-plus of WASM and cost
// 20-30 MB of heap to instantiate; a job of nothing but JPEGs should never pay
// for either, and an all-HEIC job should not pay for libavif.
let libheif = null;
let avifReady = null;

function loadHeif() {
  if (!libheif) libheif = require('libheif-js/wasm-bundle');
  return libheif;
}

function loadAvif() {
  // Cache the promise, not the module: two files in flight must not
  // instantiate twice, and a second instance's ~28 MB never comes back.
  if (!avifReady) {
    const factory = require('@saschazar/wasm-avif');
    const dir = path.dirname(require.resolve('@saschazar/wasm-avif'));
    avifReady = factory({
      // Its glue fetch()es this path, which throws under Node — and a path
      // relative to anything would not survive asar packaging either.
      wasmBinary: fs.readFileSync(path.join(dir, 'wasm_avif.wasm')),
      // libavif narrates its failures on stderr; we return them in the thrown
      // message instead of littering the app's log.
      print: () => {},
      printErr: () => {}
    });
  }
  return avifReady;
}

// Both libraries report failures with long internal text ("Error while loading
// plugin: ...", "BMFF parsing failed"), and this string can end up in the skip
// list in front of the user.
function describe(message, kind) {
  if (/has not been built in/.test(message)) return `this ${kind} file uses a codec we cannot read`;
  if (/Security limit exceeded/.test(message)) return `this ${kind} file is not readable`;
  if (/Invalid ftyp|BMFF parsing failed/.test(message)) return `not a readable ${kind} image`;
  return `the ${kind} file is damaged or incomplete`;
}

// --- HEIC/HEIF, via libheif ---

async function decodeHeic(buffer) {
  const heif = loadHeif();
  const context = heif.heif_context_alloc();
  let handle = null;
  let image = null;
  try {
    const read = heif.heif_context_read_from_memory(context, buffer);
    if (read.code !== heif.heif_error_code.heif_error_Ok) throw new Error(describe(read.message, 'HEIF'));

    // Bursts and .heics collections hold a dozen top-level images; the primary
    // one is the picture the phone shows, and the rest would be near-identical
    // pages nobody asked for.
    handle = heif.heif_js_context_get_primary_image_handle(context);
    if (!handle || handle.code) throw new Error(describe((handle && handle.message) || '', 'HEIF'));

    // Asking for interleaved RGBA makes libheif's own colour conversion do the
    // work: 4:2:0 chroma is upsampled and a 10-bit HDR photo comes back at
    // 8 bits per channel.
    const decoded = await heif.heif_js_decode_image2(
      handle, heif.heif_colorspace.heif_colorspace_RGB, heif.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!decoded || decoded.code) throw new Error(describe((decoded && decoded.message) || '', 'HEIF'));
    image = decoded.image;

    const plane = decoded.channels.find(c => c.id === heif.heif_channel.heif_channel_interleaved);
    if (!plane) throw new Error('the HEIF file is damaged or incomplete');

    const { width, height, stride } = plane;
    const rowBytes = width * 4;
    const data = Buffer.allocUnsafe(rowBytes * height);
    for (let y = 0; y < height; y++) {
      data.set(plane.data.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    }

    // No `orientation` on the frame: libheif has already applied the
    // container's irot/imir transforms — plane width and height come back
    // swapped for a rotated photo — and a HEIF file's EXIF orientation only
    // repeats what those transforms said. Passing it on would turn the picture
    // a second time. libheif's own heif-dec ignores it for the same reason.
    return [{ width, height, data }];
  } finally {
    if (image) heif.heif_image_release(image);
    if (handle && !handle.code) heif.heif_image_handle_release(handle);
    // Without this every decoded photo leaves libheif's copy of the file and
    // its parsed boxes behind: measured at ~6 MB per 3 MB HEIC, which a
    // few hundred holiday photos turn into a dead app.
    heif.heif_context_free(context);
  }
}

// --- AVIF, via libavif ---

async function decodeAvif(buffer) {
  const mod = await loadAvif();
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // An image sequence ('avis', a short animation) decodes to its first frame,
  // which is the right page for a PDF.
  const out = mod.decode(bytes, bytes.length, true);
  if (!out || out.error) throw new Error(describe((out && out.error) || '', 'AVIF'));

  const { width, height, depth } = mod.dimensions();
  const expected = width * height * 4;
  // libavif reduces 10- and 12-bit AV1 to 8-bit RGBA for us, and `depth` is
  // the source depth, not the output. Trust the byte count, not the promise:
  // a 16-bit-per-sample buffer read as RGBA would be a page of noise.
  if (out.length !== expected) throw new Error(`this AVIF is ${depth} bits per channel, which we cannot read`);

  // Copy now. The returned array is a live view into the WASM heap that the
  // next decode overwrites, and mod.free() would poison the module for every
  // file after this one, so it is never called.
  const data = Buffer.from(out);

  // libavif hands back the coded pixels untouched, so the container's rotation
  // is ours to pass on.
  const orientation = containerOrientation(buffer);
  return [orientation > 1 ? { width, height, data, orientation } : { width, height, data }];
}

// --- ISO-BMFF: enough of it to find the primary image's rotation ---

function boxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p + header, end: p + size });
    p += size;
  }
  return out;
}

// irot angle (0..3, each 90° counter-clockwise) by imir axis (none, 0 = flip
// top to bottom, 1 = flip left to right) -> the EXIF orientation with the same
// effect. Derived by composing the transforms in Jimp and matching the result
// against index.js's applyOrientation, rather than read off the spec.
const ORIENTATION = [
  [1, 4, 2],
  [8, 5, 7],
  [3, 2, 4],
  [6, 7, 5]
];

/**
 * The rotation the container asks for, as an EXIF orientation.
 *
 * Only the primary item's own properties count, so this walks pitm and ipma
 * instead of scanning for the box name: a thumbnail or the alpha plane can
 * carry its own irot, and the four letters turn up inside compressed data too.
 * Anything unexpected returns 1 — a picture the right way up beats a guess.
 */
function containerOrientation(buf) {
  const meta = boxes(buf, 0, buf.length).find(b => b.type === 'meta');
  if (!meta) return 1;

  // meta is a FullBox: step over its version and flags.
  const children = boxes(buf, meta.start + 4, meta.end);
  const pitm = children.find(b => b.type === 'pitm');
  const iprp = children.find(b => b.type === 'iprp');
  if (!pitm || !iprp) return 1;
  const primary = buf[pitm.start] < 1 ? buf.readUInt16BE(pitm.start + 4) : buf.readUInt32BE(pitm.start + 4);

  const inside = boxes(buf, iprp.start, iprp.end);
  const ipco = inside.find(b => b.type === 'ipco');
  const ipma = inside.find(b => b.type === 'ipma');
  if (!ipco || !ipma) return 1;
  const properties = boxes(buf, ipco.start, ipco.end);

  let angle = 0;
  let axis = -1;
  const wide = buf[ipma.start] >= 1;                        // 4-byte item IDs
  const large = (buf.readUIntBE(ipma.start + 1, 3) & 1) !== 0; // 2-byte property indices
  let p = ipma.start + 4;
  let entries = buf.readUInt32BE(p);
  p += 4;
  while (entries-- > 0 && p < ipma.end) {
    const item = wide ? buf.readUInt32BE(p) : buf.readUInt16BE(p);
    p += wide ? 4 : 2;
    let count = buf[p++];
    while (count-- > 0 && p < ipma.end) {
      const index = (large ? buf.readUInt16BE(p) & 0x7fff : buf[p] & 0x7f);
      p += large ? 2 : 1;
      const property = item === primary && properties[index - 1];
      if (property && property.type === 'irot') angle = buf[property.start] & 3;
      if (property && property.type === 'imir') axis = buf[property.start] & 1;
    }
  }
  return ORIENTATION[angle][axis + 1];
}

/**
 * @param buffer  the whole file
 * @param ctx     { filePath, ext, format }
 * @returns       one Frame — the primary image, RGBA
 */
async function decode(buffer, ctx) {
  // The dispatcher also tries this decoder on files it could not identify, so
  // reject non-container bytes before paying for a WASM module.
  if (buffer.length < 12 || buffer.toString('latin1', 4, 8) !== 'ftyp') {
    throw new Error('not a readable HEIF or AVIF image');
  }

  // The sniffed brand picks the engine. An ISO-BMFF brand the sniffer has
  // never seen gets both tried, since that is the only way to tell HEVC from
  // AV1 without decoding.
  const format = ctx && ctx.format;
  const engines = format === 'avif' ? [decodeAvif]
    : format === 'heic' ? [decodeHeic]
      : [decodeHeic, decodeAvif];

  let firstError;
  for (const engine of engines) {
    try {
      return await engine(buffer);
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  throw firstError;
}

module.exports = { formats: ['heic', 'avif'], decode };
