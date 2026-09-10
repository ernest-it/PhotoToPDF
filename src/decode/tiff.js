'use strict';

// TIFF, including the multi-page kind that scanners and fax machines produce.
// Jimp only ever hands back the first page, so we walk the IFD chain with utif
// ourselves and emit one frame per page.
//
// utif and the utif2 fork buried inside Jimp have different holes, so they
// cover for each other: utif scrambles CCITT Group 3 and sub-8-bit palettes,
// Jimp mangles JPEG-compressed TIFF and throws outright on CMYK. utif goes
// first because it is the only one of the two that can see past page 1.

const UTIF = require('utif');
const Jimp = require('jimp');

function first(tag, fallback) {
  return tag && tag.length ? tag[0] : fallback;
}

// A page, as opposed to an EXIF block or a stray directory with no pixels.
function isPage(ifd) {
  return !!(ifd.t256 && ifd.t257 && (ifd.t273 || ifd.t324));
}

// NewSubfileType bit 0 marks a reduced-resolution thumbnail. Emitting one as a
// page would put a blurry duplicate in the user's PDF.
function isThumbnail(ifd) {
  return (first(ifd.t254, 0) & 1) === 1;
}

// A file cut short — an interrupted download, a half-copied scan — still has a
// readable header, and utif will happily hand back the rows it managed to
// reach and leave the rest transparent.
function isTruncated(ifd, length) {
  const offsets = ifd.t273 || ifd.t324;
  const counts = ifd.t279 || ifd.t325;
  return offsets.some((offset, i) => offset + (counts ? counts[i] : 1) > length);
}

// Why a page cannot go through utif, and whether Jimp's utif2 fork is worth a
// try for it. We fail closed: Jimp only gets a turn where it is known to do
// better, because guessing wrong puts a scrambled page in the user's PDF.
//
// UTIF.toRGBA8 implements only certain PhotometricInterpretation /
// BitsPerSample pairs and silently leaves the rest transparent black, and
// utif's Group 3 decoder returns a scrambled page rather than an error.
// Bilevel polarity (PhotometricInterpretation 0 = WhiteIsZero, the usual fax
// convention) is toRGBA8's own job; all we do is keep to the depths where it
// actually inverts.
function utifVerdict(ifd, length) {
  const photometric = first(ifd.t262, 2);
  const bps = first(ifd.t258, 1);
  const samples = ifd.t258 ? ifd.t258.length : first(ifd.t277, 1);
  const no = (reason, tryJimp) => ({ reason: `the page ${reason}`, tryJimp: !!tryJimp });

  if (isTruncated(ifd, length)) return no('is cut short');
  // decodeImage only logs a warning for this and then reads the planes as if
  // they were interleaved; utif2 has the same gap.
  if (first(ifd.t284, 1) === 2) return no('stores its colour planes separately');
  if (first(ifd.t259, 1) === 3) return no('uses CCITT Group 3 fax compression', true);
  // utif unwinds the horizontal predictor across the whole image width rather
  // than one tile's width, which smears every tile but the first. Photoshop
  // writes tiled-and-predicted TIFFs routinely; utif2 gets them right.
  if (ifd.t322 && first(ifd.t317, 1) === 2) return no('is tiled with a horizontal predictor', true);
  // JPEG-in-TIFF splits the other way round: utif reads the 1- and 4-channel
  // forms correctly and scrambles plain 3-channel RGB, where utif2 is exact.
  if (first(ifd.t259, 1) === 7 && samples === 3) return no('is JPEG-compressed RGB', true);
  // utif sizes every row off BitsPerSample's length, so a file that disagrees
  // with SamplesPerPixel decodes at the wrong stride.
  if (ifd.t258 && ifd.t277 && ifd.t258.length !== first(ifd.t277)) return no('has inconsistent channel counts');

  switch (photometric) {
    case 0: return samples === 1 && [1, 4, 8].includes(bps) ? null : no(`is ${bps}-bit greyscale`);
    case 1: return samples === 1 && [1, 2, 8, 16].includes(bps) ? null : no(`is ${bps}-bit greyscale`);
    case 2: return [8, 16].includes(bps) && (samples === 3 || samples === 4) ? null : no(`is ${bps}-bit RGB`);
    case 3: return bps === 8 && ifd.t320 ? null : no(`uses a ${bps}-bit colour palette`, true);
    case 5: return bps === 8 && samples >= 4 ? null : no(`is ${bps}-bit CMYK`);
    default: return no(`uses colour space ${photometric}`);
  }
}

// ExtraSamples 1 = associated alpha, i.e. the colour channels are already
// multiplied by alpha. toRGBA8 hands them over untouched, which would come out
// too dark once pdfBuilder flattens the page onto white.
function unpremultiply(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha === 0 || alpha === 255) continue;
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round((rgba[i + c] * 255) / alpha));
  }
}

function label(index, total) {
  return total > 1 ? `page ${index + 1} of ${total}` : undefined;
}

function decodePage(bytes, ifds, index, total) {
  const ifd = ifds[index];
  const verdict = utifVerdict(ifd, bytes.byteLength);
  if (verdict) return verdict;

  try {
    UTIF.decodeImage(bytes, ifd, ifds);
    const rgba = UTIF.toRGBA8(ifd);
    if (first(ifd.t338) === 1) unpremultiply(rgba);
    return {
      frame: {
        width: ifd.width,
        height: ifd.height,
        data: rgba,
        orientation: first(ifd.t274, 1),
        label: label(index, total)
      }
    };
  } catch (e) {
    return { reason: e.message, tryJimp: true };
  }
}

// Jimp's own TIFF reader, as a second opinion on page 1. It ignores the
// Orientation tag, so we still carry that ourselves.
async function decodeViaJimp(buffer, orientation, total) {
  const image = await Jimp.read(buffer);
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    data: image.bitmap.data,
    orientation,
    label: label(0, total)
  };
}

/**
 * @param buffer  the whole TIFF file
 * @returns       one Frame per page, in file order
 */
async function decode(buffer) {
  // utif reads from an ArrayBuffer and assumes it starts at byte 0, which a
  // pooled Buffer does not.
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  let ifds = [];
  try {
    ifds = UTIF.decode(bytes).filter(isPage);
    const pages = ifds.filter(ifd => !isThumbnail(ifd));
    if (pages.length) ifds = pages;
  } catch (e) {
    // A header utif cannot even parse; Jimp still gets its turn below.
  }

  const total = ifds.length;
  const frames = [];
  // Nothing parsed at all still counts as "page 1 is missing, let Jimp look".
  let page1 = total ? null : { tryJimp: true };
  let firstReason;
  for (let i = 0; i < total; i++) {
    const result = decodePage(bytes, ifds, i, total);
    if (result.frame) frames.push(result.frame);
    else {
      if (i === 0) page1 = result;
      if (!firstReason) firstReason = result.reason;
    }
  }

  // Jimp can only ever replace page 1, so a multi-page file whose later pages
  // utif refuses comes back short — with the labels still saying which pages
  // are missing.
  if (page1 && page1.tryJimp) {
    try {
      frames.unshift(await decodeViaJimp(buffer, first(ifds[0] && ifds[0].t274, 1), total));
    } catch (e) {
      // Keep whatever utif managed, and fall through to the throw below.
    }
  }
  if (!frames.length) throw new Error(firstReason || 'not a readable TIFF');
  return frames;
}

module.exports = { formats: ['tiff'], decode };
