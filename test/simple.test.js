'use strict';
// Pixel-exact checks for the hand-written TGA / QOI / Netpbm / ICO decoders.
//
// All four formats are lossless, so every fixture is compared channel for
// channel against a reference PNG. The references were produced by OTHER
// decoders — Pillow, or ImageMagick where Pillow cannot read the variant — so
// a shared misunderstanding cannot make these checks pass.
//
// The fixtures in testdata/samples, and what each one is:
//
//   tga-24-plain.tga        type 2  24bpp  bottom-up (ImageMagick)
//   tga-24-rle.tga          type 10 24bpp  bottom-up
//   tga-24-topdown.tga      type 2  24bpp  top-down, plus a 12-byte image ID
//   tga-24-mirror.tga       type 2  24bpp  bottom-up and right-to-left
//   tga-32-plain.tga        type 2  32bpp  8 attribute bits
//   tga-32-rle.tga          type 10 32bpp  8 attribute bits
//   tga-32-topdown-rle.tga  type 10 32bpp  top-down
//   tga-32-zeroalpha.tga    type 2  32bpp  no attribute bits, alpha all zero
//   tga-16.tga / -rle       type 2/10 16bpp ARRRRRGG GGGBBBBB
//   tga-15.tga              type 2  15bpp  (same words, no attribute bit)
//   tga-8-gray.tga / -rle   type 3/11 8bpp greyscale
//   tga-8-cmap.tga / -rle   type 1/9  8bpp indexed, 24-bit colour map
//   tga-8-cmap16.tga        type 1    8bpp indexed, 16-bit colour map
//   qoi-rgb.qoi             3 channels; uses RUN, INDEX, DIFF, LUMA, RGB
//   qoi-rgba.qoi            4 channels; the above plus RGBA
//   pnm-p1-ascii.pbm        P1, 16x9 bilevel
//   pnm-p4-bilevel.pbm      P4, same picture packed one bit per pixel
//   pnm-p4-odd.pbm          P4, 13 px wide, so rows carry padding bits
//   pnm-p2-ascii.pgm        P2, maxval 255
//   pnm-p5-gray.pgm         P5, maxval 255
//   pnm-p5-16bit.pgm        P5, maxval 65535 (scaled down to 8 bits)
//   pnm-p5-maxval15.pgm     P5, maxval 15   (scaled up to 8 bits)
//   pnm-p3-ascii.ppm        P3
//   pnm-p3-comments.ppm     P3 with '#' comments and ragged whitespace
//   pnm-p6-rgb.ppm          P6
//   pnm-p7-rgba.pam         P7/PAM, DEPTH 4
//   ico-png.ico             one 32x32 entry holding a PNG
//   ico-dib32.ico           32x32 BGRA DIB, doubled height, AND mask
//   ico-dib24.ico           32x32 BGR DIB; transparency only in the AND mask
//   ico-dib8.ico            32x32 8-bit palette DIB + AND mask
//   ico-dib4.ico            32x32 4-bit palette DIB + AND mask
//   ico-dib4-odd.ico        23x17 4-bit DIB, so both strides are padded
//   ico-dib1.ico            32x32 1-bit palette DIB + AND mask
//   ico-multi.ico           16x16 and 32x32 entries; the 32x32 must win
//   ico-cur.cur             a CUR: type 2, hotspot where the bit count goes
//
// Reference PNGs are the *-ref-*.png files beside them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Jimp = require('jimp');
const simple = require('../src/decode/simple');
const { decodeImageFile } = require('../src/decode');

const samples = path.join(__dirname, '..', 'testdata', 'samples');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const FORMAT_BY_EXT = { tga: 'tga', qoi: 'qoi', pbm: 'pnm', pgm: 'pnm', ppm: 'pnm', pam: 'pnm', ico: 'ico', cur: 'ico' };

async function decodeFixture(name) {
  const file = path.join(samples, name);
  const format = FORMAT_BY_EXT[path.extname(name).slice(1)];
  const frames = await simple.decode(fs.readFileSync(file), { filePath: file, ext: path.extname(name).slice(1), format });
  if (!Array.isArray(frames) || frames.length !== 1) throw new Error(`expected 1 frame, got ${frames && frames.length}`);
  return frames[0];
}

// A frame is either raw RGBA or bytes for Jimp; both end up as a Jimp bitmap.
async function bitmapOf(frame) {
  if (frame.encoded) return (await Jimp.read(frame.encoded)).bitmap;
  return { width: frame.width, height: frame.height, data: frame.data };
}

const refs = new Map();
async function refBitmap(name) {
  if (!refs.has(name)) refs.set(name, (await Jimp.read(path.join(samples, name))).bitmap);
  return refs.get(name);
}

/**
 * @param hidden  'compare' or 'alpha-only' — where a format keeps colour under
 *                a transparency mask, the hidden RGB is not meaningful and
 *                different decoders keep different values there.
 */
function diff(got, want, hidden) {
  if (got.width !== want.width || got.height !== want.height) {
    return `size ${got.width}x${got.height}, expected ${want.width}x${want.height}`;
  }
  for (let i = 0; i < want.data.length; i += 4) {
    const invisible = want.data[i + 3] === 0 && hidden === 'alpha-only';
    const channels = invisible ? [3] : [0, 1, 2, 3];
    for (const c of channels) {
      if (got.data[i + c] !== want.data[i + c]) {
        const at = `pixel ${(i / 4) % want.width},${Math.floor(i / 4 / want.width)}`;
        return `${at} is ${[...got.data.slice(i, i + 4)]}, expected ${[...want.data.slice(i, i + 4)]}`;
      }
    }
  }
  return null;
}

// fixture, reference, how to treat pixels the reference calls invisible
const CASES = [
  ['tga-24-plain.tga', 'tga-ref-rgb.png'],
  ['tga-24-rle.tga', 'tga-ref-rgb.png'],
  ['tga-24-topdown.tga', 'tga-ref-rgb.png'],
  ['tga-24-mirror.tga', 'tga-ref-rgb.png'],
  ['tga-32-plain.tga', 'tga-ref-rgba.png'],
  ['tga-32-rle.tga', 'tga-ref-rgba.png'],
  ['tga-32-topdown-rle.tga', 'tga-ref-rgba.png'],
  ['tga-32-zeroalpha.tga', 'tga-ref-rgb.png'],
  ['tga-16.tga', 'tga-ref-16.png'],
  ['tga-16-rle.tga', 'tga-ref-16.png'],
  ['tga-15.tga', 'tga-ref-16.png'],
  ['tga-8-gray.tga', 'tga-ref-grey.png'],
  ['tga-8-gray-rle.tga', 'tga-ref-grey.png'],
  ['tga-8-cmap.tga', 'tga-ref-pal.png'],
  ['tga-8-cmap-rle.tga', 'tga-ref-pal.png'],
  ['tga-8-cmap16.tga', 'tga-ref-pal5.png'],
  ['qoi-rgb.qoi', 'qoi-ref-rgb.png'],
  ['qoi-rgba.qoi', 'qoi-ref-rgba.png'],
  ['pnm-p1-ascii.pbm', 'pnm-ref-bilevel.png'],
  ['pnm-p4-bilevel.pbm', 'pnm-ref-bilevel.png'],
  ['pnm-p4-odd.pbm', 'pnm-ref-bilevel-odd.png'],
  ['pnm-p2-ascii.pgm', 'pnm-ref-grey.png'],
  ['pnm-p5-gray.pgm', 'pnm-ref-grey.png'],
  ['pnm-p5-16bit.pgm', 'pnm-ref-grey.png'],
  ['pnm-p5-maxval15.pgm', 'pnm-ref-grey15.png'],
  ['pnm-p3-ascii.ppm', 'pnm-ref-rgb.png'],
  ['pnm-p3-comments.ppm', 'pnm-ref-rgb.png'],
  ['pnm-p6-rgb.ppm', 'pnm-ref-rgb.png'],
  ['pnm-p7-rgba.pam', 'pnm-ref-rgba.png'],
  ['ico-png.ico', 'ico-ref-32.png', 'alpha-only'],
  ['ico-dib32.ico', 'ico-ref-32.png', 'alpha-only'],
  ['ico-dib24.ico', 'ico-ref-24.png', 'alpha-only'],
  ['ico-dib8.ico', 'ico-ref-8.png', 'alpha-only'],
  ['ico-dib4.ico', 'ico-ref-4.png', 'alpha-only'],
  ['ico-dib4-odd.ico', 'ico-ref-4-odd.png', 'alpha-only'],
  ['ico-dib1.ico', 'ico-ref-1.png', 'alpha-only'],
  ['ico-multi.ico', 'ico-ref-32.png', 'alpha-only'],
  ['ico-cur.cur', 'ico-ref-32.png', 'alpha-only']
];

// Each must throw: a clean failure means the file is skipped with a reason,
// while a lenient "success" would put a page of noise in the user's PDF.
function badInputs() {
  const qoi = fs.readFileSync(path.join(samples, 'qoi-rgb.qoi'));
  const ico = fs.readFileSync(path.join(samples, 'ico-dib32.ico'));

  // Deterministic junk, since a .tga is routed here on its extension alone.
  let seed = 12345;
  const junk = Buffer.alloc(2048);
  for (let i = 0; i < junk.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    junk[i] = (seed >> 16) & 0xff;
  }

  const tgaHeader = (fields) => {
    const h = Buffer.alloc(18 + 64);
    h[1] = fields.cmapType || 0;
    h[2] = fields.type;
    h.writeUInt16LE(fields.width, 12);
    h.writeUInt16LE(fields.height, 14);
    h[16] = fields.depth;
    return h;
  };

  return [
    ['random bytes named .tga', 'tga', junk],
    ['a JPEG named .tga', 'tga', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), junk])],
    ['TGA with an unknown image type', 'tga', tgaHeader({ type: 7, width: 4, height: 4, depth: 24 })],
    ['TGA with a 6-bit pixel depth', 'tga', tgaHeader({ type: 2, width: 4, height: 4, depth: 6 })],
    ['TGA with no size', 'tga', tgaHeader({ type: 2, width: 0, height: 0, depth: 24 })],
    ['TGA claiming more pixels than it has', 'tga', tgaHeader({ type: 2, width: 900, height: 900, depth: 24 })],
    ['colour-mapped TGA with no colour map', 'tga', tgaHeader({ type: 1, width: 4, height: 4, depth: 8 })],
    ['truncated QOI', 'qoi', qoi.slice(0, qoi.length - 30)],
    ['QOI without its end marker', 'qoi', Buffer.concat([qoi.slice(0, qoi.length - 8), Buffer.alloc(8)])],
    ['QOI that stops mid-stream', 'qoi', Buffer.concat([qoi.slice(0, 40), qoi.slice(qoi.length - 8)])],
    ['QOI with 5 channels', 'qoi', (() => { const b = Buffer.from(qoi); b[12] = 5; return b; })()],
    ['QOI whose header claims too much', 'qoi', (() => { const b = Buffer.from(qoi); b.writeUInt32BE(40, 4); return b; })()],
    ['QOI whose header claims too little', 'qoi', (() => { const b = Buffer.from(qoi); b.writeUInt32BE(3, 8); return b; })()],
    ['PNM with a bogus maxval', 'pnm', Buffer.from('P5\n4 4\n70000\n' + 'x'.repeat(32))],
    ['PNM with a zero maxval', 'pnm', Buffer.from('P5\n4 4\n0\n' + 'x'.repeat(16))],
    ['PNM with a non-numeric width', 'pnm', Buffer.from('P6\nwide 4\n255\n' + 'x'.repeat(48))],
    ['truncated PNM', 'pnm', Buffer.from('P6\n8 8\n255\n' + 'x'.repeat(20))],
    ['ASCII PNM that runs out of samples', 'pnm', Buffer.from('P3\n4 4\n255\n1 2 3 4 5 6\n')],
    ['ASCII PNM with a sample above maxval', 'pnm', Buffer.from('P2\n2 2\n15\n1 2 3 99\n')],
    ['a CMYK PAM', 'pnm', Buffer.from('P7\nWIDTH 2\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE CMYK\nENDHDR\n' + 'x'.repeat(16))],
    ['PAM with 7 channels', 'pnm', Buffer.from('P7\nWIDTH 2\nHEIGHT 2\nDEPTH 7\nMAXVAL 255\nENDHDR\n' + 'x'.repeat(28))],
    ['icon with a zero-entry directory', 'ico', (() => { const b = Buffer.from(ico); b.writeUInt16LE(0, 4); return b; })()],
    ['icon whose entry points past the end', 'ico', (() => { const b = Buffer.from(ico); b.writeUInt32LE(90000, 18); return b; })()],
    ['icon with a bogus DIB header', 'ico', (() => { const b = Buffer.from(ico); b.writeUInt32LE(9, 22); return b; })()],
    ['icon with an unsupported compression', 'ico', (() => { const b = Buffer.from(ico); b.writeUInt32LE(4, 22 + 16); return b; })()],
    ['icon with a 3-bit colour depth', 'ico', (() => { const b = Buffer.from(ico); b.writeUInt16LE(3, 22 + 14); return b; })()],
    ['a format this module does not handle', 'jpeg', junk]
  ];
}

(async () => {
  for (const [fixture, ref, hidden] of CASES) {
    try {
      const got = await bitmapOf(await decodeFixture(fixture));
      const problem = diff(got, await refBitmap(ref), hidden);
      check(`${fixture.padEnd(23)} == ${ref}`, !problem, problem || `${got.width}x${got.height} exact`);
    } catch (e) {
      check(`${fixture.padEnd(23)} == ${ref}`, false, `threw: ${e.message}`);
    }
  }

  // PBM polarity has its own check, straight against the bits in the file: a
  // set bit is BLACK, and getting that backwards inverts every scanned page
  // while still "working". 16 pixels per row means no padding bits to skip.
  const pbm = await bitmapOf(await decodeFixture('pnm-p4-bilevel.pbm'));
  const pbmFile = fs.readFileSync(path.join(samples, 'pnm-p4-bilevel.pbm'));
  const bits = pbmFile.slice(pbmFile.indexOf(0x0a, pbmFile.indexOf(0x0a) + 1) + 1);
  let ones = 0;
  for (const byte of bits) for (let b = 0; b < 8; b++) if (byte & (1 << b)) ones++;
  let black = 0;
  for (let i = 0; i < pbm.data.length; i += 4) if (!pbm.data[i]) black++;
  check('PBM 1 = black', pbm.data[0] === 0 && black === ones && ones > 0,
    `top-left ${pbm.data[0]},${pbm.data[1]},${pbm.data[2]}; ${black} black pixels for ${ones} set bits`);

  // ico-multi holds a 16x16 and a 32x32 entry; the biggest must win.
  const multi = await bitmapOf(await decodeFixture('ico-multi.ico'));
  check('largest icon entry chosen', multi.width === 32 && multi.height === 32, `${multi.width}x${multi.height}`);

  // --- through the real dispatcher, so we know the wiring works ---
  const WIRED = [
    ['tga-24-rle.tga', 'tga-ref-rgb.png'],
    ['tga-24-topdown.tga', 'tga-ref-rgb.png'],
    ['qoi-rgba.qoi', 'qoi-ref-rgba.png'],
    ['pnm-p4-odd.pbm', 'pnm-ref-bilevel-odd.png'],
    ['pnm-p7-rgba.pam', 'pnm-ref-rgba.png'],
    ['ico-dib32.ico', 'ico-ref-32.png'],
    ['ico-png.ico', 'ico-ref-32.png'],
    ['ico-cur.cur', 'ico-ref-32.png']
  ];
  for (const [fixture, ref] of WIRED) {
    try {
      const out = await decodeImageFile(path.join(samples, fixture));
      const problem = diff(out.images[0].bitmap, await refBitmap(ref), 'alpha-only');
      check(`dispatcher: ${fixture.padEnd(19)} == ${ref}`, out.images.length === 1 && !problem,
        problem || `format=${out.format} images=${out.images.length}`);
    } catch (e) {
      check(`dispatcher: ${fixture.padEnd(19)} == ${ref}`, false, `threw: ${e.message}`);
    }
  }

  // --- bad input throws instead of returning a page ---
  for (const [label, format, buffer] of badInputs()) {
    let outcome;
    try {
      const frames = await simple.decode(buffer, { filePath: `x.${format}`, ext: format, format });
      outcome = `returned ${frames.length} frame(s) ${frames[0].width}x${frames[0].height}`;
    } catch (e) {
      outcome = e.message;
    }
    check(`rejects ${label.padEnd(38)}`, !outcome.startsWith('returned'), outcome);
  }

  // The dispatcher must skip junk with a .tga name too, rather than letting a
  // fallback decoder invent something.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phototopdf-simple-'));
  const junkFile = path.join(tmp, 'noise.tga');
  fs.writeFileSync(junkFile, badInputs()[0][2]);
  try {
    const out = await decodeImageFile(junkFile);
    check('dispatcher: junk .tga is skipped', false, `returned ${out.images.length} image(s)`);
  } catch (e) {
    check('dispatcher: junk .tga is skipped', true, e.message);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
