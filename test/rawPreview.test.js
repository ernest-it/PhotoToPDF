'use strict';

// Camera RAW preview extraction. Real RAW files are 20-40 MB each, so the
// fixtures in testdata/samples are small synthetic containers built by the
// writers at the top of this file — each one imitating the part of a real
// format that the decoder has to get right. `node test/rawPreview.test.js
// --write-fixtures` regenerates them (deterministic: seeded noise, Jimp's own
// JPEG encoder); a plain run only reads the committed files, so nothing here
// depends on ImageMagick or any other tool.

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const rawPreview = require('../src/decode/rawPreview');
const { decodeImageFile, sniffFormat } = require('../src/decode');

const samples = path.join(__dirname, '..', 'testdata', 'samples');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// --- fixture writers ----------------------------------------------------

// A picture whose corners are identifiable after any rotation: red top-left,
// green top-right, blue bottom-left, white elsewhere.
async function markerImage(w, h) {
  const img = new Jimp(w, h, 0xffffffff);
  const bw = Math.round(w / 4);
  const bh = Math.round(h / 4);
  const box = (x0, y0, colour) => {
    for (let x = x0; x < x0 + bw; x++) for (let y = y0; y < y0 + bh; y++) img.setPixelColor(colour, x, y);
  };
  box(0, 0, 0xff0000ff);
  box(w - bw, 0, 0x00ff00ff);
  box(0, h - bh, 0x0000ffff);
  return img;
}

async function markerJpeg(w, h, quality) {
  const img = await markerImage(w, h);
  img.quality(quality);
  return img.getBufferAsync(Jimp.MIME_JPEG);
}

// Seeded noise: a small picture that costs *more* bytes than a big smooth one.
async function noiseJpeg(w, h, quality) {
  const img = new Jimp(w, h, 0x000000ff);
  let seed = 12345;
  img.scan(0, 0, w, h, function (x, y, idx) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    this.bitmap.data[idx] = seed & 0xff;
    this.bitmap.data[idx + 1] = (seed >> 8) & 0xff;
    this.bitmap.data[idx + 2] = (seed >> 16) & 0xff;
    this.bitmap.data[idx + 3] = 0xff;
  });
  img.quality(quality);
  return img.getBufferAsync(Jimp.MIME_JPEG);
}

// A minimal APP1/Exif segment carrying nothing but Orientation, spliced in
// after the SOI — exactly what a camera writes into its preview.
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);      // one entry
  tiff.writeUInt16LE(274, 10);   // Orientation
  tiff.writeUInt16LE(3, 12);     // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.slice(0, 2), app1, jpeg.slice(2)]);
}

// Structurally intact (SOI, SOF, SOS, EOI all present and consistent) but the
// entropy-coded data is rubbish, so only an actual decode notices. All the
// junk bytes stay below 0x80 so no accidental marker appears.
function garbleScan(jpeg) {
  const out = Buffer.from(jpeg);
  const sos = out.indexOf(Buffer.from([0xff, 0xda]));
  for (let i = sos + 40; i < out.length - 2; i++) out[i] = (i * 37) & 0x7f;
  return out;
}

function junk(len, seed) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = (i * 31 + seed) & 0x7f; // no 0xff: no fake SOI
  return out;
}

/**
 * Minimal writer for TIFF-based RAW (CR2, NEF, ARW, DNG, ORF, ...): a TIFF
 * header, an IFD chain, then the JPEG previews, then junk standing in for the
 * sensor data that fills the rest of a real file.
 *
 * ifds: [{ tags: [[tag, type, value], ...], next }] — value may be a number or
 * a reference { blob }, { blobLen } or { ifd }, resolved once the layout is
 * known. type 3 = SHORT, 4 = LONG.
 */
function tiffFile({ be = false, cr2 = false, ifds, blobs = [], tail = 0 }) {
  const headerLen = cr2 ? 16 : 8;
  const ifdOffsets = [];
  let at = headerLen;
  for (const ifd of ifds) {
    ifdOffsets.push(at);
    at += 2 + 12 * ifd.tags.length + 4;
  }
  const blobOffsets = [];
  for (const blob of blobs) {
    blobOffsets.push(at);
    at += blob.length;
  }
  const buf = Buffer.alloc(at + tail);
  const u16 = (o, v) => (be ? buf.writeUInt16BE(v, o) : buf.writeUInt16LE(v, o));
  const u32 = (o, v) => (be ? buf.writeUInt32BE(v, o) : buf.writeUInt32LE(v, o));
  const resolve = (v) => {
    if (typeof v === 'number') return v;
    if (v.blob !== undefined) return blobOffsets[v.blob];
    if (v.blobLen !== undefined) return blobs[v.blobLen].length;
    return ifdOffsets[v.ifd];
  };

  buf.write(be ? 'MM' : 'II', 0, 'latin1');
  u16(2, 0x2a);
  u32(4, ifdOffsets[0]);
  if (cr2) {
    buf.write('CR', 8, 'latin1');            // Canon's marker, which sniff.js looks for
    buf[10] = 2;
    u32(12, ifdOffsets[ifds.length - 1]);
  }

  ifds.forEach((ifd, i) => {
    const tags = ifd.tags.slice().sort((a, b) => a[0] - b[0]); // TIFF wants ascending tags
    let e = ifdOffsets[i] + 2;
    u16(ifdOffsets[i], tags.length);
    for (const [tag, type, value] of tags) {
      u16(e, tag);
      u16(e + 2, type);
      u32(e + 4, 1);
      if (type === 3) u16(e + 8, resolve(value));
      else u32(e + 8, resolve(value));
      e += 12;
    }
    u32(e, ifd.next === undefined ? 0 : ifdOffsets[ifd.next]);
  });

  blobs.forEach((blob, i) => blob.copy(buf, blobOffsets[i]));
  junk(tail, 7).copy(buf, at);
  return buf;
}

// One ISO-BMFF box.
function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}

async function buildFixtures() {
  fs.mkdirSync(samples, { recursive: true });
  const write = (name, buf) => {
    fs.writeFileSync(path.join(samples, name), buf);
    console.log(`  wrote ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
  };

  // 1. Canon CR2 shape: "II*\0" + 'CR' marker, IFD0 holding the full-size
  //    preview as a single JPEG strip (Compression 6), IFD1 holding the small
  //    JPEGInterchangeFormat thumbnail, then trailing sensor junk.
  write('raw-tiff.cr2', tiffFile({
    cr2: true,
    blobs: [await markerJpeg(640, 480, 70), await markerJpeg(160, 120, 60)],
    ifds: [
      { tags: [[274, 3, 1], [259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]], next: 1 },
      { tags: [[259, 3, 6], [513, 4, { blob: 1 }], [514, 4, { blobLen: 1 }]] }
    ],
    tail: 2048
  }));

  // 2. Canon CR3: ISO-BMFF, 'crx ' brand, a PRVW box nested in a uuid box
  //    under moov, and the full-size JPEG inside mdat.
  const prvw = box('PRVW', Buffer.concat([junk(12, 1), await markerJpeg(320, 240, 70)]));
  const uuid = box('uuid', Buffer.concat([junk(16, 2), prvw]));
  write('raw-cr3.cr3', Buffer.concat([
    box('ftyp', Buffer.concat([Buffer.from('crx ', 'latin1'), Buffer.alloc(4), Buffer.from('crx isom', 'latin1')])),
    box('moov', uuid),
    box('mdat', Buffer.concat([junk(16, 3), await markerJpeg(800, 600, 60), junk(512, 4)]))
  ]));

  // 3. Fujifilm RAF: fixed header, JPEG offset at byte 84 and length at 88.
  const rafJpeg = await markerJpeg(400, 300, 70);
  const rafHead = Buffer.alloc(148);
  rafHead.write('FUJIFILMCCD-RAW 0201FF383501FinePix X100        ', 0, 'latin1');
  rafHead.writeUInt32BE(rafHead.length, 84);
  rafHead.writeUInt32BE(rafJpeg.length, 88);
  write('raw-raf.raf', Buffer.concat([rafHead, rafJpeg, junk(256, 5)]));

  // 4. The largest preview is neither the first one nor the longest one: a
  //    noisy 64x48 thumbnail costs more bytes (12.5 KB) than the smooth
  //    640x480 preview behind it (9 KB). Big-endian, like a real Nikon NEF.
  write('raw-order.nef', tiffFile({
    be: true,
    blobs: [await noiseJpeg(64, 48, 100), await markerJpeg(640, 480, 25)],
    ifds: [
      { tags: [[513, 4, { blob: 0 }], [514, 4, { blobLen: 0 }], [330, 4, { ifd: 1 }]] },
      { tags: [[254, 4, 1], [259, 3, 6], [273, 4, { blob: 1 }], [279, 4, { blobLen: 1 }]] }
    ],
    tail: 1024
  }));

  // 5. The trap: the preview carries EXIF Orientation 6 *and* the container's
  //    IFD0 says 6. Jimp applies the preview's own tag while reading, so
  //    forwarding the container's would rotate the photo twice.
  write('raw-orient-exif.arw', tiffFile({
    blobs: [withExifOrientation(await markerJpeg(240, 160, 80), 6)],
    ifds: [{ tags: [[274, 3, 6], [259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]] }],
    tail: 512
  }));

  // 6. The other half of the trap: the same preview with no EXIF at all, so the
  //    only Orientation in the file is the container's.
  write('raw-orient-ifd.dng', tiffFile({
    blobs: [await markerJpeg(240, 160, 80)],
    ifds: [{ tags: [[274, 3, 6], [259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]] }],
    tail: 512
  }));

  // 7. The only preview is cut off mid-scan: no EOI, so nothing to return.
  const truncated = (await markerJpeg(640, 480, 70)).slice(0, 900);
  write('raw-bad-corrupt.cr2', tiffFile({
    cr2: true,
    blobs: [truncated],
    ifds: [{ tags: [[259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]] }],
    tail: 512
  }));

  // 8. The largest preview passes the marker walk but will not decode; the
  //    smaller one behind it is fine.
  write('raw-fallback.nef', tiffFile({
    blobs: [garbleScan(await markerJpeg(800, 600, 70)), await markerJpeg(240, 160, 80)],
    ifds: [
      { tags: [[513, 4, { blob: 0 }], [514, 4, { blobLen: 0 }], [330, 4, { ifd: 1 }]] },
      { tags: [[259, 3, 6], [273, 4, { blob: 1 }], [279, 4, { blobLen: 1 }]] }
    ],
    tail: 512
  }));

  // The 'raw-bad-*' fixtures below are meant to be unreadable, which is why
  // they carry that marker: build.test.js asserts every sample in the folder
  // builds a PDF page, and these five never will.
  //
  // 9. Nothing else to fall back to: the one preview looks like a JPEG all the
  //    way through and still will not decode.
  write('raw-bad-garbled.orf', tiffFile({
    blobs: [garbleScan(await markerJpeg(320, 240, 70))],
    ifds: [{ tags: [[259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]] }],
    tail: 256
  }));

  // 10. A preview whose SOF claims 20000x20000 (400 MP, 1.6 GB of RGBA). We must
  //     refuse it on the numbers rather than hand it to the JPEG decoder.
  const huge = Buffer.from(await markerJpeg(320, 240, 70));
  const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
  huge.writeUInt16BE(20000, sof + 5);
  huge.writeUInt16BE(20000, sof + 7);
  write('raw-bad-hugesof.rw2', tiffFile({
    blobs: [huge],
    ifds: [{ tags: [[259, 3, 6], [273, 4, { blob: 0 }], [279, 4, { blobLen: 0 }]] }],
    tail: 256
  }));

  // 11-12. Not images at all. The dispatcher sends everything it cannot place
  //        here as a last resort, so both must be rejected outright.
  write('raw-bad-text.dng', Buffer.from(
    'Shot list, 12 March\r\n1. wide of the car park\r\n2. close on the bumper\r\n', 'latin1'));
  let seed = 987654321;
  const random = Buffer.alloc(4096);
  for (let i = 0; i < random.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    random[i] = (seed >> 16) & 0xff;
  }
  if (random.indexOf(Buffer.from([0xff, 0xd8, 0xff])) >= 0) throw new Error('reseed: random fixture contains an SOI');
  write('raw-bad-random.arw', random);
}

// --- helpers ------------------------------------------------------------

function read(name) {
  const file = path.join(samples, name);
  if (!fs.existsSync(file)) {
    throw new Error(`missing fixture ${file} — run: node test/rawPreview.test.js --write-fixtures`);
  }
  return { file, buffer: fs.readFileSync(file) };
}

async function decodeFixture(name) {
  const { file, buffer } = read(name);
  const format = sniffFormat(buffer, file);
  const frames = await rawPreview.decode(buffer, { filePath: file, ext: path.extname(file).slice(1), format });
  return { frames, format, buffer, file };
}

async function expectThrow(name) {
  try {
    const { frames } = await decodeFixture(name);
    return { threw: false, message: `returned ${frames.length} frame(s)` };
  } catch (e) {
    return { threw: true, message: e.message };
  }
}

// Every JPEG stream in a file, the crude way — used to prove a fixture really
// does hold a small-but-fat preview ahead of the big one.
function jpegStreams(buf) {
  const out = [];
  let p = 0;
  for (;;) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), p);
    if (start < 0) break;
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    out.push({ start, length: end + 2 - start });
    p = end + 2;
  }
  return out;
}

const COLOURS = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255] };

// Name of the colour nearest a pixel, sampled 8% in from the corner so JPEG
// ringing at the edges cannot flip the answer.
function cornerColours(image) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const dx = Math.round(w * 0.08);
  const dy = Math.round(h * 0.08);
  return [[dx, dy], [w - 1 - dx, dy], [dx, h - 1 - dy], [w - 1 - dx, h - 1 - dy]].map(([x, y]) => {
    const px = Jimp.intToRGBA(image.getPixelColor(x, y));
    let best = '?';
    let bestDistance = Infinity;
    for (const [name, [r, g, b]] of Object.entries(COLOURS)) {
      const d = (px.r - r) ** 2 + (px.g - g) ** 2 + (px.b - b) ** 2;
      if (d < bestDistance) { bestDistance = d; best = name; }
    }
    return best;
  }).join(',');
}

function frameToImage(frame) {
  return new Jimp({ data: frame.data, width: frame.width, height: frame.height });
}

// --- checks -------------------------------------------------------------

(async () => {
  if (process.argv.includes('--write-fixtures')) {
    console.log('building fixtures in', samples);
    await buildFixtures();
    console.log('');
  }

  // The fixtures have to reach this decoder in the first place.
  const sniffs = {
    'raw-tiff.cr2': 'raw',
    'raw-cr3.cr3': 'cr3',
    'raw-raf.raf': 'raw',
    'raw-order.nef': 'raw',
    'raw-orient-exif.arw': 'raw',
    'raw-orient-ifd.dng': 'raw',
    'raw-bad-corrupt.cr2': 'raw',
    'raw-fallback.nef': 'raw',
    'raw-bad-garbled.orf': 'raw',
    'raw-bad-hugesof.rw2': 'raw',
    'raw-bad-text.dng': 'raw',
    'raw-bad-random.arw': 'raw'
  };
  const wrong = Object.entries(sniffs).filter(([name, want]) => {
    const { file, buffer } = read(name);
    return sniffFormat(buffer, file) !== want;
  });
  check('sniff routes every fixture to this decoder', wrong.length === 0,
    wrong.length ? wrong.map(([n]) => n).join(', ') : Object.keys(sniffs).length + ' fixtures');

  // --- containers we parse ---
  {
    const { frames } = await decodeFixture('raw-tiff.cr2');
    const image = frameToImage(frames[0]);
    check('CR2: full-size IFD0 strip preview, not the IFD1 thumbnail',
      frames.length === 1 && frames[0].width === 640 && frames[0].height === 480 &&
      frames[0].data.length === 640 * 480 * 4 && cornerColours(image) === 'red,green,blue,white',
      `${frames[0].width}x${frames[0].height} corners=${cornerColours(image)}`);
  }
  {
    const { frames } = await decodeFixture('raw-cr3.cr3');
    check('CR3: mdat full-size JPEG beats the PRVW box',
      frames[0].width === 800 && frames[0].height === 600 &&
      cornerColours(frameToImage(frames[0])) === 'red,green,blue,white',
      `${frames[0].width}x${frames[0].height}`);
  }
  {
    const { frames } = await decodeFixture('raw-raf.raf');
    check('RAF: preview at the header offsets (84/88)',
      frames[0].width === 400 && frames[0].height === 300,
      `${frames[0].width}x${frames[0].height}`);
  }

  // --- the winner is chosen by pixel area ---
  {
    const { frames, buffer } = await decodeFixture('raw-order.nef');
    const streams = jpegStreams(buffer);
    check('biggest by pixel area, not by byte length or file order',
      frames[0].width === 640 && frames[0].height === 480 &&
      streams.length === 2 && streams[0].length > streams[1].length,
      `chose ${frames[0].width}x${frames[0].height}; first stream ${streams[0].length}B (64x48) ` +
      `> second ${streams[1].length}B (640x480)`);
  }

  // --- orientation, applied exactly once in both directions ---
  let uprightCorners = null;
  {
    const { frames } = await decodeFixture('raw-orient-exif.arw');
    const image = frameToImage(frames[0]);
    uprightCorners = cornerColours(image);
    check('EXIF orientation in the preview is applied once (and not forwarded)',
      frames[0].width === 160 && frames[0].height === 240 && frames[0].orientation === undefined &&
      uprightCorners === 'blue,red,white,green',
      `240x160 stored -> ${frames[0].width}x${frames[0].height}, orientation=${frames[0].orientation}, corners=${uprightCorners}`);
  }
  {
    const { frames } = await decodeFixture('raw-orient-ifd.dng');
    check('no EXIF in the preview: container Orientation is forwarded unapplied',
      frames[0].width === 240 && frames[0].height === 160 && frames[0].orientation === 6 &&
      cornerColours(frameToImage(frames[0])) === 'red,green,blue,white',
      `${frames[0].width}x${frames[0].height}, orientation=${frames[0].orientation}`);

    // ...and once the dispatcher has applied it, the two files agree pixel for pixel.
    const viaDispatcher = await decodeImageFile(read('raw-orient-ifd.dng').file);
    const corners = cornerColours(viaDispatcher.images[0]);
    check('both orientation paths end up identical through the dispatcher',
      viaDispatcher.images[0].bitmap.width === 160 && viaDispatcher.images[0].bitmap.height === 240 &&
      corners === uprightCorners,
      `${viaDispatcher.images[0].bitmap.width}x${viaDispatcher.images[0].bitmap.height} corners=${corners}`);
  }

  // --- damaged and non-images ---
  {
    const r = await expectThrow('raw-bad-corrupt.cr2');
    check('truncated preview throws instead of returning a torn image',
      r.threw && /no preview image/.test(r.message), r.message);
  }
  {
    const { frames } = await decodeFixture('raw-fallback.nef');
    check('undecodable largest preview falls through to the next-largest',
      frames[0].width === 240 && frames[0].height === 160 &&
      cornerColours(frameToImage(frames[0])) === 'red,green,blue,white',
      `${frames[0].width}x${frames[0].height} (800x600 candidate rejected by the decoder)`);
  }
  {
    const r = await expectThrow('raw-bad-garbled.orf');
    check('a preview that will not decode at all throws, with its own reason',
      r.threw && /damaged/.test(r.message), r.message);
  }
  {
    const r = await expectThrow('raw-bad-hugesof.rw2');
    check('a preview claiming 400 MP is refused without being decoded',
      r.threw && /too large/.test(r.message), r.message);
  }
  for (const name of ['raw-bad-text.dng', 'raw-bad-random.arw']) {
    const r = await expectThrow(name);
    check(`${name} is rejected outright`, r.threw && /no preview image/.test(r.message), r.message);
  }
  {
    // Nothing to walk at all: the header alone must not pass validation.
    const r = await (async () => {
      try {
        await rawPreview.decode(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), { format: 'raw' });
        return { threw: false, message: 'returned a frame' };
      } catch (e) { return { threw: true, message: e.message }; }
    })();
    check('a bare SOI with no frame header is not a preview', r.threw, r.message);
  }

  // --- end to end through the real dispatcher ---
  {
    const r = await decodeImageFile(read('raw-tiff.cr2').file);
    check('dispatcher: decodeImageFile() on a RAW file',
      r.format === 'raw' && r.images.length === 1 &&
      r.images[0].bitmap.width === 640 && r.images[0].bitmap.height === 480,
      `format=${r.format} ${r.images[0].bitmap.width}x${r.images[0].bitmap.height}`);
  }
  {
    let message = '';
    try {
      await decodeImageFile(read('raw-bad-text.dng').file);
    } catch (e) { message = e.message; }
    check('dispatcher: a text file with a RAW extension is skipped with a reason',
      /no preview image/.test(message), message || 'did not throw');
  }

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
