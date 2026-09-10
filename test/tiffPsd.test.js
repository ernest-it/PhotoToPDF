'use strict';
// TIFF and PSD decoding, checked against the PNGs the fixtures were made from.
// Committed fixtures only — nothing here shells out to ImageMagick.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { decodeImageFile } = require('../src/decode');
const tiff = require('../src/decode/tiff');
const psd = require('../src/decode/psd');

const samples = path.join(__dirname, '..', 'testdata', 'samples');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
function skip(label, why) {
  console.log(`skipped: ${label}  — ${why}`);
}

function frameToJimp(frame) {
  const data = Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data.buffer, 0, frame.width * frame.height * 4);
  return new Jimp({ data, width: frame.width, height: frame.height });
}

async function source(name) {
  return Jimp.read(path.join(samples, name));
}

// Worst per-channel difference, and how many pixels are off by more than the
// tolerance. Alpha is only compared when the test asks for it.
function diff(actual, expected, tolerance, withAlpha) {
  if (actual.bitmap.width !== expected.bitmap.width || actual.bitmap.height !== expected.bitmap.height) {
    return { ok: false, detail: `size ${actual.bitmap.width}x${actual.bitmap.height}, expected ${expected.bitmap.width}x${expected.bitmap.height}` };
  }
  const channels = withAlpha ? 4 : 3;
  let bad = 0;
  let worst = 0;
  for (let i = 0; i < actual.bitmap.data.length; i += 4) {
    let pixelBad = false;
    for (let c = 0; c < channels; c++) {
      const d = Math.abs(actual.bitmap.data[i + c] - expected.bitmap.data[i + c]);
      if (d > worst) worst = d;
      if (d > tolerance) pixelBad = true;
    }
    if (pixelBad) bad++;
  }
  return { ok: bad === 0, detail: `${bad} pixels off, worst channel diff ${worst}` };
}

function pixel(image, x, y) {
  const i = (y * image.bitmap.width + x) * 4;
  return Array.from(image.bitmap.data.slice(i, i + 4));
}

// A whole fixture decoded through our module, as Jimp images.
async function frames(decoder, file) {
  return decoder.decode(fs.readFileSync(path.join(samples, file)));
}
async function images(decoder, file) {
  return (await frames(decoder, file)).map(frameToJimp);
}

async function throws(label, decoder, file, pattern) {
  try {
    await frames(decoder, file);
    check(label, false, 'decoded instead of throwing');
  } catch (e) {
    check(label, pattern.test(e.message), e.message);
  }
}

(async () => {
  // ---------------------------------------------------------------- TIFF
  // Multi-page, through the real dispatcher: this is the case the whole
  // decoder exists for, so it gets checked end to end.
  const multi = await decodeImageFile(path.join(samples, 'tiff-multipage.tif'));
  check('multi-page TIFF: page count', multi.images.length === 3, `${multi.images.length} images, format=${multi.format}`);
  check('multi-page TIFF: labels', JSON.stringify(multi.labels) === JSON.stringify(['page 1 of 3', 'page 2 of 3', 'page 3 of 3']),
    JSON.stringify(multi.labels));
  const expectedPages = [await source('tiff-src-a.png'), await source('tiff-src-b.png'), await source('tiff-src-c.png')];
  for (let i = 0; i < expectedPages.length; i++) {
    const r = diff(multi.images[i], expectedPages[i], 0);
    check(`multi-page TIFF: page ${i + 1} pixels in order`, r.ok, r.detail);
  }

  // A single-page file must not be captioned "page 1 of 1".
  const single = await decodeImageFile(path.join(samples, 'tiff-gray.tif'));
  check('single-page TIFF: no label', single.images.length === 1 && single.labels[0] === undefined,
    JSON.stringify(single.labels));

  // Bilevel fax output, both polarities. PhotometricInterpretation 0
  // (WhiteIsZero) is the one that comes out inverted if you ignore the tag.
  const bw = await source('tiff-src-bw.png');
  for (const file of ['tiff-bilevel-g4.tif', 'tiff-bilevel-g4-black0.tif', 'tiff-bilevel-g3.tif']) {
    const [image] = await images(tiff, file);
    const r = diff(image, bw, 0);
    check(`${file}: pixels`, r.ok, r.detail);
    // Spelled out, because "black and white swapped" still scores well on
    // some looser comparisons.
    const paper = pixel(image, 0, 0);
    const ink = pixel(image, 10, 40);
    check(`${file}: black on white, not inverted`, paper[0] > 200 && ink[0] < 55, `corner=${paper.slice(0, 3)} bar=${ink.slice(0, 3)}`);
  }

  // Known limitation, pinned so a change is noticed: Group 3 only survives
  // via Jimp, which cannot see past page 1, so a multi-page G3 fax loses its
  // later pages — the label says which page the one we kept was.
  const g3multi = await frames(tiff, 'tiff-bilevel-g3-multipage.tif');
  check('multi-page G3 fax: page 1 recovered, rest lost',
    g3multi.length === 1 && g3multi[0].label === 'page 1 of 2',
    `${g3multi.length} of 2 pages, labels ${JSON.stringify(g3multi.map(f => f.label))}`);

  // The rest of the layouts and compressions, each against its own source.
  const cases = [
    ['tiff-none.tif', 'tiff-src-a.png', 0],
    ['tiff-packbits.tif', 'tiff-src-a.png', 0],
    ['tiff-deflate.tif', 'tiff-src-detail.png', 0],
    ['tiff-jpeg.tif', 'tiff-src-detail.png', 14],
    ['tiff-jpeg-rgba.tif', 'tiff-src-detail.png', 14],
    ['tiff-jpeg-gray.tif', 'tiff-src-detail-gray.png', 14],
    ['tiff-tiled.tif', 'tiff-src-detail.png', 0],
    ['tiff-tiled-nopred.tif', 'tiff-src-detail.png', 0],
    ['tiff-16bit.tif', 'tiff-src-detail.png', 0],
    ['tiff-gray.tif', 'tiff-src-detail-gray.png', 1],
    ['tiff-gray16.tif', 'tiff-src-detail-gray.png', 1],
    ['tiff-cmyk.tif', 'tiff-src-detail.png', 2],
    ['tiff-palette.tif', 'tiff-src-a.png', 0],
    ['tiff-palette8.tif', 'tiff-src-grad.png', 6]
  ];
  for (const [file, src, tolerance] of cases) {
    const list = await images(tiff, file);
    const r = diff(list[0], await source(src), tolerance);
    check(`${file}: pixels`, list.length === 1 && r.ok, r.detail);
  }

  // Alpha, stored both ways. Associated alpha is premultiplied on disk and has
  // to be undone or the page comes out dark.
  const rgbaSrc = await source('tiff-src-rgba.png');
  for (const file of ['tiff-rgba.tif', 'tiff-rgba-assoc.tif']) {
    const [image] = await images(tiff, file);
    const r = diff(image, rgbaSrc, 2, true);
    check(`${file}: RGBA pixels`, r.ok, `${r.detail}; half-transparent pixel = ${pixel(image, 30, 10)}`);
  }

  // Orientation is passed up as an EXIF-sense tag; the dispatcher rotates.
  const [orientFrame] = await frames(tiff, 'tiff-orient6.tif');
  check('tiff-orient6.tif: orientation tag reported', orientFrame.orientation === 6, `orientation=${orientFrame.orientation}`);
  // Orientation 6 turns the stored image a quarter turn clockwise, so the
  // stored bottom-left quadrant (blue) ends up top-left and the stored
  // top-left one (red) ends up top-right.
  const rotated = await decodeImageFile(path.join(samples, 'tiff-orient6.tif'));
  const upright = rotated.images[0];
  const topLeft = pixel(upright, 2, 2);
  const topRight = pixel(upright, 45, 2);
  check('tiff-orient6.tif: dispatcher rotates it upright',
    upright.getWidth() === 48 && upright.getHeight() === 64 && topLeft[2] > 200 && topRight[0] > 200,
    `${upright.getWidth()}x${upright.getHeight()} top-left=${topLeft.slice(0, 3)} top-right=${topRight.slice(0, 3)}`);

  // Layouts neither library can read must fail, not produce a scrambled page.
  await throws('tiff-bad-planar.tif: separate colour planes refused', tiff, 'tiff-bad-planar.tif', /colour planes/);
  await throws('tiff-bad-truncated.tif: missing pixel data refused', tiff, 'tiff-bad-truncated.tif', /cut short/);

  // A multi-page file whose tail is missing still yields the pages that are
  // there, rather than nothing at all.
  const cut = await images(tiff, 'tiff-multipage-cut.tif');
  const cutDiff = diff(cut[0], expectedPages[0], 0);
  check('tiff-multipage-cut.tif: surviving page kept', cut.length === 1 && cutDiff.ok, `${cut.length} page(s), ${cutDiff.detail}`);

  // ----------------------------------------------------------------- PSD
  const psdSrc = await source('psd-src.png');
  const rgbPsd = await decodeImageFile(path.join(samples, 'psd-rgb.psd'));
  const rgbDiff = diff(rgbPsd.images[0], psdSrc, 0);
  check('psd-rgb.psd: composite via dispatcher',
    rgbPsd.images.length === 1 && rgbPsd.labels[0] === undefined && rgbDiff.ok,
    `${rgbPsd.images.length} image(s), ${rgbDiff.detail}`);

  const [grayPsd] = await images(psd, 'psd-gray.psd');
  const grayDiff = diff(grayPsd, await source('psd-src-gray.png'), 1);
  check('psd-gray.psd: greyscale composite', grayDiff.ok, grayDiff.detail);

  const [indexedPsd] = await images(psd, 'psd-indexed.psd');
  const indexedDiff = diff(indexedPsd, psdSrc, 2);
  check('psd-indexed.psd: indexed composite', indexedDiff.ok, indexedDiff.detail);

  const [psbPsd] = await images(psd, 'psd-large.psb');
  const psbDiff = diff(psbPsd, psdSrc, 0);
  check('psd-large.psb: large-document format reads', psbDiff.ok, psbDiff.detail);

  // Transparency survives, un-premultiplied.
  const [alphaPsd] = await images(psd, 'psd-alpha.psd');
  const alphaDiff = diff(alphaPsd, await source('psd-src-alpha.png'), 2, true);
  check('psd-alpha.psd: alpha kept, not premultiplied', alphaDiff.ok, `${alphaDiff.detail}; half-transparent pixel = ${pixel(alphaPsd, 20, 10)}`);

  // psd-layers.psd has a red composite over a blue and a green layer, so a
  // decoder that blended the layer stack instead would come out wrong.
  const [layered] = await images(psd, 'psd-layers.psd');
  check('psd-layers.psd: composite used, not the layer stack',
    JSON.stringify(pixel(layered, 24, 16)) === JSON.stringify([255, 0, 0, 255]),
    `centre pixel = ${pixel(layered, 24, 16)}`);

  // The cases we cannot render must say why.
  await throws('psd-bad-nocomposite.psd: named as having no preview', psd, 'psd-bad-nocomposite.psd', /flattened preview/);
  await throws('psd-bad-cmyk.psd: named as CMYK', psd, 'psd-bad-cmyk.psd', /CMYK/);
  await throws('psd-bad-16bit.psd: named as 16-bit', psd, 'psd-bad-16bit.psd', /16 bits per channel/);
  skip('32-bit PSD', 'no fixture — ImageMagick 6 writes 16-bit for -depth 32');

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
