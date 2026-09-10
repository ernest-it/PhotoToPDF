'use strict';
// HEIC/HEIF and AVIF decoding: src/decode/heif.js on its own, plus runs through
// the real dispatcher so we know the wiring — and the orientation handover —
// holds end to end.
const fs = require('fs');
const path = require('path');
const heif = require('../src/decode/heif');
const { decodeImageFile } = require('../src/decode');

const samples = path.join(__dirname, '..', 'testdata', 'samples');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}
function skip(label, why) {
  console.log(`skipped: ${label}  — ${why}`);
}

function fixture(name) {
  const file = path.join(samples, name);
  return fs.existsSync(file) ? file : null;
}

// HEVC and AV1 are both lossy, so a flat corner still drifts a few levels.
function near(px, rgba, tolerance = 12) {
  return px.length === 4 && rgba.every((v, i) => Math.abs(px[i] - v) <= tolerance);
}
function show(px) {
  return `[${px.join(',')}]`;
}

// Frame pixel, and the same for a Jimp image out of the dispatcher.
function framePixel(frame, x, y) {
  const o = (y * frame.width + x) * 4;
  return [...frame.data.slice(o, o + 4)];
}
function jimpPixel(image, x, y) {
  const o = image.bitmap.width * y * 4 + x * 4;
  return [...image.bitmap.data.slice(o, o + 4)];
}
function corners(get, width, height) {
  return {
    tl: get(2, 2), tr: get(width - 3, 2), bl: get(2, height - 3), br: get(width - 3, height - 3)
  };
}

async function decodeFixture(name, format) {
  const file = fixture(name);
  return heif.decode(fs.readFileSync(file), { filePath: file, ext: path.extname(name).slice(1), format });
}

async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e.message;
  }
}

// The four quadrants of both rainbow-corner fixtures, so a flip or a rotate
// cannot pass unnoticed.
const HEIC_CORNERS = { tl: [160, 11, 253, 255], tr: [40, 206, 254, 255], bl: [253, 64, 22, 255], br: [91, 255, 8, 255] };
const AVIF_CORNERS = { tl: [254, 0, 0, 255], tr: [0, 255, 1, 255], bl: [0, 0, 254, 255], br: [255, 255, 1, 255] };

(async () => {
  check('formats claimed', JSON.stringify(heif.formats) === '["heic","avif"]', heif.formats.join(', '));

  // ---------------------------------------------------------------- HEIC ----

  if (!fixture('heic-rgb.heic')) {
    skip('HEIC primary image', 'no testdata/samples/heic-rgb.heic');
  } else {
    const t = Date.now();
    const frames = await decodeFixture('heic-rgb.heic', 'heic');
    const f = frames[0];
    check('HEIC one frame, full RGBA bitmap',
      frames.length === 1 && f.width === 451 && f.height === 461 && f.data.length === 451 * 461 * 4,
      `${f.width}x${f.height} ${f.data.length} bytes in ${Date.now() - t}ms`);
    const c = corners((x, y) => framePixel(f, x, y), f.width, f.height);
    check('HEIC pixels land the right way up',
      near(c.tl, HEIC_CORNERS.tl) && near(c.tr, HEIC_CORNERS.tr) && near(c.bl, HEIC_CORNERS.bl) && near(c.br, HEIC_CORNERS.br),
      `tl${show(c.tl)} tr${show(c.tr)} bl${show(c.bl)} br${show(c.br)}`);
    check('opaque HEIC comes back opaque', framePixel(f, 20, 20)[3] === 255);

    // --- through the dispatcher, the way the PDF builder reaches it ---
    const r = await decodeImageFile(fixture('heic-rgb.heic'));
    const img = r.images[0];
    check('dispatcher: sniffed and routed to this decoder',
      r.format === 'heic' && r.images.length === 1 && img.bitmap.width === 451 && img.bitmap.height === 461,
      `format=${r.format} ${img.bitmap.width}x${img.bitmap.height}`);
    check('dispatcher: pixels survive the trip into Jimp',
      near(jimpPixel(img, 2, 2), HEIC_CORNERS.tl) && near(jimpPixel(img, img.bitmap.width - 3, img.bitmap.height - 3), HEIC_CORNERS.br),
      `tl${show(jimpPixel(img, 2, 2))} br${show(jimpPixel(img, img.bitmap.width - 3, img.bitmap.height - 3))}`);
  }

  // --- rotation: the same rainbow with a 90° CCW irot in its container ---
  // libheif applies irot/imir itself, so the frame is already upright and must
  // not carry an orientation for the dispatcher to apply a second time.
  if (!fixture('heic-irot90.heic')) {
    skip('HEIC container rotation', 'no testdata/samples/heic-irot90.heic');
  } else {
    const f = (await decodeFixture('heic-irot90.heic', 'heic'))[0];
    check('HEIC irot applied by libheif: sides swapped once',
      f.width === 462 && f.height === 452, `${f.width}x${f.height}`);
    check('HEIC irot applied by libheif: top-left is the old top-right',
      near(framePixel(f, 2, 2), HEIC_CORNERS.tr) && near(framePixel(f, 2, f.height - 3), HEIC_CORNERS.tl),
      `tl${show(framePixel(f, 2, 2))} bl${show(framePixel(f, 2, f.height - 3))}`);
    check('HEIC asks the dispatcher for no orientation', f.orientation === undefined, String(f.orientation));

    // If we ever hand the orientation on as well, this comes back 452x462.
    const r = await decodeImageFile(fixture('heic-irot90.heic'));
    check('dispatcher does not rotate the HEIC again',
      r.images[0].bitmap.width === 462 && r.images[0].bitmap.height === 452,
      `${r.images[0].bitmap.width}x${r.images[0].bitmap.height}`);
  }

  if (!fixture('heic-alpha.heic')) {
    skip('HEIC alpha channel', 'no testdata/samples/heic-alpha.heic');
  } else {
    const f = (await decodeFixture('heic-alpha.heic', 'heic'))[0];
    const corner = framePixel(f, 40, 40);
    const middle = framePixel(f, 256, 256);
    check('HEIC alpha kept, not flattened',
      f.width === 512 && f.height === 512 && corner[3] === 0 && near(middle, [255, 255, 255, 255]),
      `corner${show(corner)} middle${show(middle)}`);
  }

  // ---------------------------------------------------------------- AVIF ----

  if (!fixture('avif-rgb.avif')) {
    skip('AVIF primary image', 'no testdata/samples/avif-rgb.avif');
  } else {
    const t = Date.now();
    const frames = await decodeFixture('avif-rgb.avif', 'avif');
    const f = frames[0];
    check('AVIF one frame, full RGBA bitmap',
      frames.length === 1 && f.width === 96 && f.height === 64 && f.data.length === 96 * 64 * 4,
      `${f.width}x${f.height} ${f.data.length} bytes in ${Date.now() - t}ms`);
    const c = corners((x, y) => framePixel(f, x, y), f.width, f.height);
    check('AVIF pixels land the right way up',
      near(c.tl, AVIF_CORNERS.tl) && near(c.tr, AVIF_CORNERS.tr) && near(c.bl, AVIF_CORNERS.bl) && near(c.br, AVIF_CORNERS.br),
      `tl${show(c.tl)} tr${show(c.tr)} bl${show(c.bl)} br${show(c.br)}`);
    check('untransformed AVIF asks for no orientation', f.orientation === undefined, String(f.orientation));

    const r = await decodeImageFile(fixture('avif-rgb.avif'));
    const img = r.images[0];
    check('dispatcher: AVIF sniffed and routed to this decoder',
      r.format === 'avif' && img.bitmap.width === 96 && img.bitmap.height === 64,
      `format=${r.format} ${img.bitmap.width}x${img.bitmap.height}`);
    check('dispatcher: AVIF pixels survive the trip into Jimp',
      near(jimpPixel(img, 2, 2), AVIF_CORNERS.tl) && near(jimpPixel(img, 93, 61), AVIF_CORNERS.br),
      `tl${show(jimpPixel(img, 2, 2))} br${show(jimpPixel(img, 93, 61))}`);
  }

  if (!fixture('avif-alpha.avif')) {
    skip('AVIF alpha channel', 'no testdata/samples/avif-alpha.avif');
  } else {
    const f = (await decodeFixture('avif-alpha.avif', 'avif'))[0];
    const left = framePixel(f, 20, 32);
    const right = framePixel(f, 76, 32);
    check('AVIF alpha kept, not flattened',
      near(left, [254, 0, 0, 255]) && right[3] === 0,
      `left${show(left)} right${show(right)}`);
  }

  // --- 10-bit AV1 must arrive as 8-bit RGBA, not a buffer of 16-bit samples ---
  if (!fixture('avif-10bit.avif')) {
    skip('10-bit AVIF', 'no testdata/samples/avif-10bit.avif');
  } else {
    const f = (await decodeFixture('avif-10bit.avif', 'avif'))[0];
    const c = corners((x, y) => framePixel(f, x, y), f.width, f.height);
    check('10-bit AVIF reduced to 8-bit RGBA',
      f.data.length === f.width * f.height * 4 && near(c.tl, AVIF_CORNERS.tl) && near(c.br, AVIF_CORNERS.br),
      `${f.width}x${f.height} ${f.data.length} bytes tl${show(c.tl)} br${show(c.br)}`);
  }

  // --- container transforms: libavif does NOT apply them, so we hand the
  // matching EXIF orientation to the dispatcher and it turns the picture once.
  if (!fixture('avif-irot90.avif')) {
    skip('AVIF container rotation', 'no testdata/samples/avif-irot90.avif');
  } else {
    const f = (await decodeFixture('avif-irot90.avif', 'avif'))[0];
    const c = corners((x, y) => framePixel(f, x, y), f.width, f.height);
    check('AVIF irot: libavif leaves the pixels alone, we report orientation 8',
      f.width === 96 && f.height === 64 && f.orientation === 8 && near(c.tl, AVIF_CORNERS.tl),
      `${f.width}x${f.height} orientation=${f.orientation} tl${show(c.tl)}`);

    const img = (await decodeImageFile(fixture('avif-irot90.avif'))).images[0];
    check('AVIF irot: upright exactly once after the dispatcher',
      img.bitmap.width === 64 && img.bitmap.height === 96 &&
      near(jimpPixel(img, 2, 2), AVIF_CORNERS.tr) && near(jimpPixel(img, 2, 93), AVIF_CORNERS.tl),
      `${img.bitmap.width}x${img.bitmap.height} tl${show(jimpPixel(img, 2, 2))} bl${show(jimpPixel(img, 2, 93))}`);
  }

  if (!fixture('avif-imir.avif')) {
    skip('AVIF container mirror', 'no testdata/samples/avif-imir.avif');
  } else {
    const f = (await decodeFixture('avif-imir.avif', 'avif'))[0];
    check('AVIF imir axis 0 reported as orientation 4', f.orientation === 4, String(f.orientation));

    const img = (await decodeImageFile(fixture('avif-imir.avif'))).images[0];
    check('AVIF imir: flipped exactly once after the dispatcher',
      img.bitmap.width === 96 && img.bitmap.height === 64 &&
      near(jimpPixel(img, 2, 2), AVIF_CORNERS.bl) && near(jimpPixel(img, 2, 61), AVIF_CORNERS.tl),
      `${img.bitmap.width}x${img.bitmap.height} tl${show(jimpPixel(img, 2, 2))} bl${show(jimpPixel(img, 2, 61))}`);
  }

  // --- an image sequence ('avis'): one page, the first frame ---
  if (!fixture('avif-anim.avif')) {
    skip('animated AVIF', 'no testdata/samples/avif-anim.avif');
  } else {
    const frames = await decodeFixture('avif-anim.avif', 'avif');
    const f = frames[0];
    check('animated AVIF gives one page from its first frame',
      frames.length === 1 && f.width === 640 && f.height === 480 &&
      framePixel(f, 2, 2)[3] === 0 && near(framePixel(f, 2, 477), [14, 156, 249, 255]),
      `${f.width}x${f.height} tl${show(framePixel(f, 2, 2))} bl${show(framePixel(f, 2, 477))}`);
  }

  // ------------------------------------------------------- bad and mixed ----

  // The dispatcher tries this decoder speculatively, so each engine has to
  // fail politely on the other one's file.
  if (fixture('heic-rgb.heic') && fixture('avif-rgb.avif')) {
    const heicBytes = fs.readFileSync(fixture('heic-rgb.heic'));
    const avifBytes = fs.readFileSync(fixture('avif-rgb.avif'));
    check('HEIC sent down the AVIF path fails politely',
      await throws(() => heif.decode(heicBytes, { format: 'avif' })) === 'not a readable AVIF image');
    check('AVIF sent down the HEIF path fails politely',
      await throws(() => heif.decode(avifBytes, { format: 'heic' })) === 'this HEIF file uses a codec we cannot read');

    // An ISO-BMFF brand the sniffer does not know: both engines get a turn.
    const unknownHeic = await heif.decode(heicBytes, { format: 'unknown' });
    const unknownAvif = await heif.decode(avifBytes, { format: 'unknown' });
    check('unrecognised brand: both engines tried',
      unknownHeic[0].width === 451 && unknownAvif[0].width === 96,
      `heic ${unknownHeic[0].width}x${unknownHeic[0].height}, avif ${unknownAvif[0].width}x${unknownAvif[0].height}`);
  }

  if (!fixture('avif-bad-truncated.avif')) {
    skip('truncated AVIF', 'no testdata/samples/avif-bad-truncated.avif');
  } else {
    const message = await throws(() => decodeFixture('avif-bad-truncated.avif', 'avif'));
    check('truncated AVIF throws rather than returning half a photo',
      message === 'the AVIF file is damaged or incomplete', message || 'did not throw');
  }

  check('random bytes rejected',
    await throws(() => heif.decode(Buffer.from('this is not an image at all!!'), { format: 'unknown' })) === 'not a readable HEIF or AVIF image');
  check('ftyp header with nothing behind it rejected',
    !!await throws(() => heif.decode(Buffer.concat([Buffer.from('\0\0\0\x18ftypheic'), Buffer.alloc(64)]), { format: 'heic' })));
  if (fixture('heic-rgb.heic')) {
    const truncated = fs.readFileSync(fixture('heic-rgb.heic')).slice(0, 3000);
    const message = await throws(() => heif.decode(truncated, { format: 'heic' }));
    check('truncated HEIC throws rather than returning half a photo', !!message, message);
  }

  // --- anything you drop in testdata/ yourself: real phone photos ---
  const own = path.join(__dirname, '..', 'testdata');
  const extra = fs.existsSync(own)
    ? fs.readdirSync(own).filter(f => /\.(heic|heif|hif|avif)$/i.test(f))
    : [];
  if (!extra.length) {
    skip('your own HEIC/AVIF files', 'drop some in testdata/ to decode them here');
  }
  for (const name of extra) {
    const file = path.join(own, name);
    const t = Date.now();
    try {
      const r = await decodeImageFile(file);
      check(`testdata/${name}`, r.images.length > 0,
        `${r.images[0].bitmap.width}x${r.images[0].bitmap.height} in ${Date.now() - t}ms`);
    } catch (e) {
      check(`testdata/${name}`, false, e.message);
    }
  }

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('all checks passed');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
