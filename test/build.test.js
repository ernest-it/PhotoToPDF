'use strict';
// Headless verification of the core files->PDF pipeline (no Electron, no GUI).
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { PDFDocument, PDFName, rgb } = require('pdf-lib');
const { buildPhotoPdf } = require('../src/pdfBuilder');

const dir = path.join(__dirname, '..', 'testdata');
const fixtures = path.join(dir, '_fixtures');
const samples = path.join(dir, 'samples');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// Synthetic inputs so the suite runs on a clean checkout. Any real images you
// drop in testdata/ are picked up too.
async function makeFixtures() {
  fs.mkdirSync(fixtures, { recursive: true });

  const wide = new Jimp(1400, 900, 0x3366ccff);
  await wide.writeAsync(path.join(fixtures, 'wide.jpg'));
  const tall = new Jimp(900, 1400, 0xcc6633ff);
  await tall.writeAsync(path.join(fixtures, 'tall.png'));

  // A stand-in "estimate": 2 pages, A4-ish, with real text on them.
  const doc = await PDFDocument.create();
  for (const n of [1, 2]) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Estimate page ${n}`, { x: 60, y: 760, size: 24, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(path.join(fixtures, 'estimate.pdf'), await doc.save());

  // Not a real PDF — must be skipped with a reason, not crash the build.
  fs.writeFileSync(path.join(fixtures, 'broken.pdf'), 'this is not a pdf at all');
}

(async () => {
  await makeFixtures();

  const userImages = fs.readdirSync(dir)
    .filter(f => /\.(jpe?g|png)$/i.test(f))
    .map(f => path.join(dir, f));
  const images = [
    path.join(fixtures, 'wide.jpg'),
    path.join(fixtures, 'tall.png'),
    ...userImages
  ];
  const estimate = path.join(fixtures, 'estimate.pdf');

  console.log('input images:', images.map(f => path.basename(f)).join(', '));
  console.log('');

  // --- images only, every quality preset ---
  for (const q of ['smaller', 'balanced', 'higher']) {
    const r = await buildPhotoPdf(images, { quality: q, labels: true });
    const head = Buffer.from(r.bytes.slice(0, 5)).toString();
    check(
      `[${q.padEnd(8)}] images only`,
      head === '%PDF-' && r.pages === images.length && r.pdfs === 0,
      `pages=${r.pages} skipped=${r.skipped.length} size=${(r.bytes.length / 1024).toFixed(0)}KB`
    );
  }

  // --- mixed: photo, estimate (2 pages), photo — in that order ---
  const mixed = [images[0], estimate, images[1]];
  const r = await buildPhotoPdf(mixed, { quality: 'balanced', labels: true });
  check('mixed build counts', r.images === 2 && r.pdfs === 1 && r.used === 3 && r.pages === 4,
    `images=${r.images} pdfs=${r.pdfs} pages=${r.pages}`);

  // The copied estimate pages must land in position 2-3 at their original size,
  // with the photos still on US Letter pages around them.
  const out = await PDFDocument.load(r.bytes);
  const sizes = out.getPages().map(p => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
  check('page order + sizes preserved',
    out.getPageCount() === 4 && sizes[0] === '792x612' && sizes[1] === '595x842' && sizes[2] === '595x842' && sizes[3] === '612x792',
    sizes.join(', '));

  // The estimate pages must still be vector text: a font resource and no image
  // XObject. Photo pages are the opposite — one embedded image each.
  const resources = out.getPages().map(p => {
    const res = p.node.Resources();
    const xobj = res && res.lookup(PDFName.of('XObject'));
    const font = res && res.lookup(PDFName.of('Font'));
    return { images: xobj ? xobj.keys().length : 0, fonts: font ? font.keys().length : 0 };
  });
  check('estimate pages copied as text, not rasterised',
    resources[1].images === 0 && resources[1].fonts > 0 &&
    resources[2].images === 0 && resources[2].fonts > 0 &&
    resources[0].images === 1 && resources[3].images === 1,
    resources.map(x => `img:${x.images}/font:${x.fonts}`).join(', '));

  // --- a PDF on its own ---
  const pdfOnly = await buildPhotoPdf([estimate], {});
  check('PDF-only build', pdfOnly.pages === 2 && pdfOnly.images === 0 && pdfOnly.pdfs === 1,
    `pages=${pdfOnly.pages}`);

  // --- bad inputs are skipped, not fatal ---
  const withBad = await buildPhotoPdf(
    [...images, path.join(dir, 'does-not-exist.jpg'), path.join(fixtures, 'broken.pdf')], {});
  check('bad image + bad PDF skipped',
    withBad.skipped.length === 2 && withBad.pages === images.length,
    withBad.skipped.map(s => `${path.basename(s.file)}: ${s.reason}`).join(' | '));

  // --- nothing usable -> throws ---
  try {
    await buildPhotoPdf(['/nope/a.jpg', path.join(fixtures, 'broken.pdf')], {});
    check('all-unusable throws', false, 'did not throw');
  } catch (e) {
    check('all-unusable throws', e.message === 'NO_USABLE_FILES', e.message);
  }

  // --- small images must not trip pdf-lib's byteOffset bug ---
  // jimp encodes small JPEGs into Node's shared 8 KB buffer pool, so they
  // arrive with a non-zero byteOffset; pdf-lib's JPEG embedder used to read
  // from the pool's start and reject them as unreadable. Several in one build
  // is what makes an offset land somewhere awkward.
  const tinies = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(fixtures, `tiny-${i}.png`);
    await new Jimp(8 + i, 8, 0x336699ff).writeAsync(f);
    tinies.push(f);
  }
  const tiny = await buildPhotoPdf(tinies, { quality: 'smaller' });
  check('small images embed (pooled-buffer regression)',
    tiny.skipped.length === 0 && tiny.pages === tinies.length,
    `pages=${tiny.pages} skipped=${tiny.skipped.map(x => x.reason).join('|') || 'none'}`);

  // --- every committed sample format survives the whole pipeline ---
  // The per-format suites (heif, webp, rawPreview, tiffPsd, simple) check
  // decoding in detail; this is the net under them: whatever formats we claim
  // to support, a real file of each must come out as at least one PDF page.
  // Two kinds of fixture are expected NOT to render: *-bad-* is deliberately
  // broken (truncated previews, random bytes wearing a camera extension), and
  // *-unsupported-* is a perfectly good file in a variant we can't read (a
  // CMYK or 16-bit PSD). They belong to the suites that own each format; here
  // they only have to fail *politely*.
  const allSamples = fs.existsSync(samples)
    ? fs.readdirSync(samples).filter(f => !/\.(md|txt)$/i.test(f)).sort()
    : [];
  const expectSkip = f => /(^|-)(bad|unsupported)-/.test(f);
  const sampleFiles = allSamples.filter(f => !expectSkip(f)).map(f => path.join(samples, f));
  const badSamples = allSamples.filter(expectSkip).map(f => path.join(samples, f));
  if (sampleFiles.length) {
    const s = await buildPhotoPdf(sampleFiles, { quality: 'smaller', labels: true });
    check('every committed sample format builds a page',
      s.skipped.length === 0 && s.used === sampleFiles.length && s.pages >= sampleFiles.length,
      `${sampleFiles.length} samples -> ${s.pages} pages` +
      (s.skipped.length ? ' | SKIPPED: ' + s.skipped.map(x => `${path.basename(x.file)} (${x.reason})`).join(', ') : ''));

    // One file at a time, so a broken format names itself instead of hiding in
    // a pass/fail for the whole batch.
    const broken = [];
    for (const file of sampleFiles) {
      try {
        const one = await buildPhotoPdf([file], { quality: 'smaller' });
        if (!one.pages) broken.push(`${path.basename(file)} (no pages)`);
      } catch (e) {
        broken.push(`${path.basename(file)} (${e.message})`);
      }
    }
    check('each sample format on its own', broken.length === 0, broken.join(', ') || `${sampleFiles.length} formats`);
  } else {
    console.log('note  no testdata/samples/ — per-format samples not checked');
  }

  // --- broken files fail politely: skipped with a reason, never a crash ---
  if (badSamples.length) {
    let bad;
    try {
      bad = await buildPhotoPdf(badSamples, { quality: 'smaller' });
    } catch (e) {
      bad = { skipped: e.skipped || [], thrown: e.message };
    }
    const reasons = (bad.skipped || []).filter(x => x.reason && x.reason.length > 3);
    check('unreadable samples are skipped with a reason, not a crash',
      reasons.length === badSamples.length && (bad.thrown === 'NO_USABLE_FILES' || !bad.pages),
      `${badSamples.length} files -> ${reasons.length} reasons | ` +
      (bad.skipped || []).map(x => `${path.basename(x.file)}: ${x.reason}`).join(', '));
  }

  // Write one out so we can eyeball it.
  const sample = path.join(dir, '_sample-output.pdf');
  const final = await buildPhotoPdf([...images, estimate], { quality: 'balanced' });
  fs.writeFileSync(sample, final.bytes);
  console.log('\nwrote sample PDF:', sample);

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('all checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
