'use strict';
// Previews for the reorder grid: they must come out the way the page will
// (same decoder, same orientation), be small, and explain unreadable files
// instead of throwing.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { PDFDocument } = require('pdf-lib');
const { makeThumbnail, getThumbnail, THUMB_EDGE } = require('../src/thumbnail');
const { decodeImageFile } = require('../src/decode');

const samples = path.join(__dirname, '..', 'testdata', 'samples');
const fixtures = path.join(__dirname, '..', 'testdata', '_fixtures');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function fromDataUrl(src) {
  return Jimp.read(Buffer.from(src.replace(/^data:image\/jpeg;base64,/, ''), 'base64'));
}

(async () => {
  fs.mkdirSync(fixtures, { recursive: true });

  // A full-size phone-shaped photo shrinks to THUMB_EDGE on its long side.
  const big = path.join(fixtures, 'thumb-big.jpg');
  await new Jimp(3000, 2000, 0x3366ccff).quality(80).writeAsync(big);
  const r = await makeThumbnail(big);
  check('jpeg: ok, image, one page', r.ok && r.kind === 'image' && r.pages === 1);
  check('jpeg: data URL', /^data:image\/jpeg;base64,/.test(r.src || ''));
  const t = await fromDataUrl(r.src);
  check('jpeg: long edge is THUMB_EDGE', t.getWidth() === THUMB_EDGE && t.getHeight() === THUMB_EDGE * 2 / 3,
    `${t.getWidth()}x${t.getHeight()}`);

  // Never upscaled.
  const small = await fromDataUrl((await makeThumbnail(path.join(samples, 'psd-rgb.psd'))).src);
  const smallSrc = (await decodeImageFile(path.join(samples, 'psd-rgb.psd'))).images[0];
  check('small image keeps its size', small.getWidth() === smallSrc.getWidth() && small.getHeight() === smallSrc.getHeight());

  // Rotated containers come out the way the PDF page will.
  for (const name of ['heic-irot90.heic', 'avif-irot90.avif', 'raw-orient-ifd.dng']) {
    const file = path.join(samples, name);
    const th = await makeThumbnail(file);
    const page = (await decodeImageFile(file)).images[0];
    const img = th.ok && await fromDataUrl(th.src);
    check(`${name}: same orientation as the page`,
      img && (img.getWidth() >= img.getHeight()) === (page.getWidth() >= page.getHeight()),
      img ? `thumb ${img.getWidth()}x${img.getHeight()}, page ${page.getWidth()}x${page.getHeight()}` : th.reason);
  }

  // PDFs report their page count.
  const doc = await PDFDocument.create();
  doc.addPage(); doc.addPage(); doc.addPage();
  const pdfPath = path.join(fixtures, 'thumb-three.pdf');
  fs.writeFileSync(pdfPath, await doc.save());
  const p = await makeThumbnail(pdfPath);
  check('pdf: page count', p.ok && p.kind === 'pdf' && p.pages === 3, JSON.stringify(p));

  // Unreadable files explain themselves instead of throwing.
  const bad = await makeThumbnail(path.join(samples, 'avif-bad-truncated.avif'));
  check('damaged image: reason', !bad.ok && /damaged|incomplete/i.test(bad.reason), bad.reason);
  const brokenPdf = path.join(fixtures, 'thumb-broken.pdf');
  fs.writeFileSync(brokenPdf, 'not a pdf');
  const bp = await makeThumbnail(brokenPdf);
  check('broken pdf: reason', !bp.ok && bp.kind === 'pdf' && bp.reason === 'not a readable PDF', bp.reason);
  const missing = await makeThumbnail(path.join(fixtures, 'does-not-exist.jpg'));
  check('missing file: reason', !missing.ok && missing.reason === 'file not found', missing.reason);

  // Cached: asking twice decodes once.
  const a = getThumbnail(big), b = getThumbnail(big);
  check('cache: same promise for the same file', a === b);
  await a;

  console.log('');
  if (failures) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
  console.log('all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
