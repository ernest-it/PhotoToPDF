'use strict';
// Headless verification of the core image->PDF pipeline (no Electron, no GUI).
const fs = require('fs');
const path = require('path');
const { buildPhotoPdf } = require('../src/pdfBuilder');

(async () => {
  const dir = path.join(__dirname, '..', 'testdata');
  const files = fs.readdirSync(dir)
    .filter(f => /\.(jpe?g|png)$/i.test(f))
    .map(f => path.join(dir, f));
  if (!files.length) { console.error('no test images in testdata/'); process.exit(1); }

  console.log('input images:', files.map(f => path.basename(f)).join(', '));

  for (const q of ['smaller', 'balanced', 'higher']) {
    const r = await buildPhotoPdf(files, { quality: q, labels: true });
    const head = Buffer.from(r.bytes.slice(0, 5)).toString();
    console.log(`[${q.padEnd(8)}] pages=${r.used} skipped=${r.skipped.length} size=${(r.bytes.length/1024).toFixed(0)}KB validPDF=${head === '%PDF-'}`);
  }

  // include a bad path -> must be skipped, not fatal
  const withBad = await buildPhotoPdf([...files, path.join(dir, 'does-not-exist.jpg')], {});
  console.log('with 1 missing file -> skipped:', JSON.stringify(withBad.skipped.map(s => path.basename(s.file))));

  // all-bad -> must throw
  try {
    await buildPhotoPdf(['/nope/a.jpg'], {});
    console.log('ERROR: should have thrown on all-missing');
  } catch (e) {
    console.log('all-missing threw:', e.message);
  }

  // write one out so we can eyeball it
  const out = path.join(__dirname, '..', 'testdata', '_sample-output.pdf');
  const { bytes } = await buildPhotoPdf(files, { quality: 'balanced' });
  fs.writeFileSync(out, bytes);
  console.log('wrote sample PDF:', out);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
