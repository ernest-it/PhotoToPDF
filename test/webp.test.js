'use strict';
// WebP decoding: the variants people actually have (lossy, lossless, alpha,
// animated), the container edge cases, and the dispatcher wiring.
//
// Fixtures in testdata/samples/ are committed and read as-is — nothing here
// shells out to ImageMagick. Most came from `convert` (lossy, lossless, alpha,
// and animations built from multi-frame input); webp-exif.webp and
// webp-animated-offset.webp were assembled chunk by chunk, because ImageMagick
// 6.9 writes no EXIF chunk into WebP and produces no offset first frame.

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const webp = require('../src/decode/webp');
const { decodeImageFile } = require('../src/decode');

const samples = path.join(__dirname, '..', 'testdata', 'samples');
const W = 96, H = 72;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
function skip(label, detail) {
  console.log(`skip  ${label}${detail ? '  — ' + detail : ''}`);
}

function fixture(name) {
  const file = path.join(samples, name);
  return fs.existsSync(file) ? file : null;
}

// Compare a decoded frame against the source PNG it was encoded from.
// Transparent pixels carry no meaningful colour, so only their alpha counts.
function compare(frame, reference, region) {
  const ox = region ? region.x : 0;
  const oy = region ? region.y : 0;
  let maxColor = 0, sumColor = 0, colorCount = 0, maxAlpha = 0, off = 0;
  for (let y = 0; y < reference.bitmap.height; y++) {
    for (let x = 0; x < reference.bitmap.width; x++) {
      const r = (y * reference.bitmap.width + x) * 4;
      const f = ((y + oy) * frame.width + (x + ox)) * 4;
      const alpha = reference.bitmap.data[r + 3];
      maxAlpha = Math.max(maxAlpha, Math.abs(frame.data[f + 3] - alpha));
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(frame.data[f + c] - reference.bitmap.data[r + c]);
        maxColor = Math.max(maxColor, d);
        if (d > 24) off++;
        sumColor += d;
        colorCount++;
      }
    }
  }
  // VP8 rings around the fixture's hard colour edges, so a single worst pixel
  // says little; the mean plus the share of far-off samples is what catches a
  // swapped channel or a shifted row.
  return { maxColor, meanColor: sumColor / colorCount, outliers: off / colorCount, maxAlpha };
}

function px(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2], frame.data[i + 3]];
}

// Jimp's bitmap is already RGBA, so it doubles as a Frame for compare().
function asFrame(image) {
  return { width: image.bitmap.width, height: image.bitmap.height, data: image.bitmap.data };
}

(async () => {
  const opaque = await Jimp.read(path.join(samples, 'webp-src.png'));
  const alpha = await Jimp.read(path.join(samples, 'webp-src-alpha.png'));

  // --- still variants: right size, right pixels ---
  const stills = [
    ['lossy    (VP8)', 'webp-lossy.webp', opaque, 8, 0.03],
    ['lossless (VP8L)', 'webp-lossless.webp', opaque, 0, 0],
    ['alpha    (VP8X+ALPH+VP8)', 'webp-alpha.webp', alpha, 8, 0.03],
    ['lossless alpha (VP8L)', 'webp-lossless-alpha.webp', alpha, 0, 0]
  ];
  for (const [label, name, reference, meanLimit, outlierLimit] of stills) {
    const file = fixture(name);
    if (!file) { skip(label, 'no fixture'); continue; }
    const frames = await webp.decode(fs.readFileSync(file), { format: 'webp' });
    const frame = frames[0];
    const sized = frames.length === 1 && frame.width === W && frame.height === H &&
      frame.data.length === W * H * 4;
    check(`${label}: geometry`, sized, `${frame.width}x${frame.height} frames=${frames.length} bytes=${frame.data.length}`);
    const diff = compare(frame, reference);
    check(`${label}: pixels`,
      sized && diff.meanColor <= meanLimit && diff.outliers <= outlierLimit && diff.maxAlpha <= 2,
      `mean=${diff.meanColor.toFixed(2)} max=${diff.maxColor} off>24=${(diff.outliers * 100).toFixed(1)}% alphaMax=${diff.maxAlpha}`);
  }

  // Alpha has to survive as alpha, not as a colour that happens to look right.
  for (const name of ['webp-alpha.webp', 'webp-lossless-alpha.webp']) {
    const file = fixture(name);
    if (!file) { skip(`${name}: transparency`, 'no fixture'); continue; }
    const [frame] = await webp.decode(fs.readFileSync(file), { format: 'webp' });
    const clear = px(frame, 80, 60);   // the transparent quadrant
    const solid = px(frame, 16, 12);
    check(`${name}: transparency preserved`, clear[3] === 0 && solid[3] === 255,
      `clear=${clear.join(',')} solid=${solid.join(',')}`);
  }

  // --- animation: libwebp's still decoder cannot, so we take it apart ---
  const animFile = fixture('webp-animated.webp');
  if (animFile) {
    let raw = 'decoded';
    try { require('@cwasm/webp').decode(fs.readFileSync(animFile)); }
    catch (e) { raw = e.message; }
    check('animated: @cwasm/webp alone cannot read it', raw !== 'decoded', raw);
  }

  const anims = [
    ['animated (VP8 frame)', 'webp-animated.webp', opaque],
    ['animated (ALPH+VP8 frame)', 'webp-animated-alpha.webp', alpha],
    ['animated (VP8L frame)', 'webp-animated-lossless.webp', alpha]
  ];
  for (const [label, name, reference] of anims) {
    const file = fixture(name);
    if (!file) { skip(label, 'no fixture'); continue; }
    const frames = await webp.decode(fs.readFileSync(file), { format: 'webp' });
    const frame = frames[0];
    const diff = compare(frame, reference);
    check(`${label}: first frame recovered`,
      frames.length === 1 && frame.width === W && frame.height === H &&
      diff.meanColor <= 8 && diff.outliers <= 0.04 && diff.maxAlpha <= 2,
      `${frame.width}x${frame.height} mean=${diff.meanColor.toFixed(2)} off>24=${(diff.outliers * 100).toFixed(1)}% label=${frame.label}`);
    check(`${label}: labelled as one frame of many`, frame.label === 'frame 1 of 2', String(frame.label));
  }

  // A first frame smaller than the canvas must land at its offset on the
  // animation background, not become a page of the wrong size.
  const offsetFile = fixture('webp-animated-offset.webp');
  if (!offsetFile) {
    skip('animated: offset first frame', 'no fixture');
  } else {
    const [frame] = await webp.decode(fs.readFileSync(offsetFile), { format: 'webp' });
    const diff = compare(frame, opaque, { x: 4, y: 6 });
    const corner = px(frame, 0, 0);
    check('animated: offset first frame placed on canvas',
      frame.width === 104 && frame.height === 84 && diff.meanColor <= 8 &&
      corner.join(',') === '255,255,255,255',
      `${frame.width}x${frame.height} mean=${diff.meanColor.toFixed(2)} corner=${corner.join(',')}`);
  }

  // --- EXIF orientation (VP8X + EXIF chunk) ---
  const exifFile = fixture('webp-exif.webp');
  if (!exifFile) {
    skip('EXIF orientation reported', 'no fixture');
  } else {
    const [frame] = await webp.decode(fs.readFileSync(exifFile), { format: 'webp' });
    check('EXIF orientation reported', frame.orientation === 6, `orientation=${frame.orientation}`);
  }

  // --- container edge cases ---
  async function throws(label, buffer, pattern) {
    try {
      await webp.decode(buffer, { format: 'webp' });
      check(label, false, 'did not throw');
    } catch (e) {
      check(label, pattern.test(e.message), e.message);
    }
  }

  const lossyBytes = fs.readFileSync(path.join(samples, 'webp-lossy.webp'));
  await throws('truncated file rejected', lossyBytes.slice(0, 120), /truncated/);
  await throws('non-WebP rejected', fs.readFileSync(path.join(samples, 'webp-src.png')), /not a WebP/);
  await throws('short header rejected', Buffer.from('RIFF'), /not a WebP/);

  // RIFF says 8 bytes of payload but the chunk inside claims far more.
  const lying = Buffer.concat([lossyBytes.slice(0, 12), Buffer.from('VP8 '), Buffer.alloc(4)]);
  lying.writeUInt32LE(0x7fffffff, 16);
  lying.writeUInt32LE(lying.length - 8, 4);
  await throws('overlong chunk size rejected', lying, /truncated/);

  // Metadata but no picture: clearer to say so than to let libwebp fail.
  const metaOnly = Buffer.concat([lossyBytes.slice(0, 12), Buffer.from('VP8X'), Buffer.alloc(4), Buffer.alloc(10)]);
  metaOnly.writeUInt32LE(10, 16);
  metaOnly.writeUInt32LE(metaOnly.length - 8, 4);
  await throws('no image data rejected', metaOnly, /no image data/);

  // --- through the real dispatcher, which is where the shipped bug lives ---
  const viaDispatcher = await decodeImageFile(path.join(samples, 'webp-lossy.webp'));
  const diff = compare(asFrame(viaDispatcher.images[0]), opaque);
  check('dispatcher: decodeImageFile reads a WebP',
    viaDispatcher.format === 'webp' && viaDispatcher.images.length === 1 &&
    viaDispatcher.images[0].getWidth() === W && viaDispatcher.images[0].getHeight() === H &&
    diff.meanColor <= 8,
    `format=${viaDispatcher.format} ${viaDispatcher.images[0].getWidth()}x${viaDispatcher.images[0].getHeight()} mean=${diff.meanColor.toFixed(2)}`);

  const animViaDispatcher = await decodeImageFile(path.join(samples, 'webp-animated.webp'));
  check('dispatcher: animation yields its first frame',
    animViaDispatcher.images.length === 1 && animViaDispatcher.labels[0] === 'frame 1 of 2',
    `pages=${animViaDispatcher.images.length} label=${animViaDispatcher.labels[0]}`);

  // Orientation 6 is a quarter turn, so the dispatcher must hand back a
  // portrait image from our landscape fixture.
  const exifViaDispatcher = await decodeImageFile(path.join(samples, 'webp-exif.webp'));
  check('dispatcher: EXIF orientation applied',
    exifViaDispatcher.images[0].getWidth() === H && exifViaDispatcher.images[0].getHeight() === W,
    `${exifViaDispatcher.images[0].getWidth()}x${exifViaDispatcher.images[0].getHeight()}`);

  const alphaViaDispatcher = await decodeImageFile(path.join(samples, 'webp-alpha.webp'));
  check('dispatcher: alpha survives to the Jimp image',
    Jimp.intToRGBA(alphaViaDispatcher.images[0].getPixelColor(80, 60)).a === 0,
    JSON.stringify(Jimp.intToRGBA(alphaViaDispatcher.images[0].getPixelColor(80, 60))));

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
