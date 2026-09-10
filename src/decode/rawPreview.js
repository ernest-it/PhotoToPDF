'use strict';

// Camera RAW: CR2, NEF, ARW, DNG, ORF, RW2, RAF, PEF, SRW, CR3 and the rest.
//
// We do not demosaic the sensor data, and we deliberately don't want to. Every
// camera writes a JPEG preview into its RAW files — usually full-size, because
// that is what the camera shows you on its own screen — so the honest, standard
// approach (the one every fast viewer takes) is to hand that preview back.
// Debayering in pure JS would mean per-vendor CFA layouts, white balance and
// colour matrices: thousands of lines, seconds per photo, and a worse picture
// than the camera's own JPEG. What the user gets in the PDF is therefore the
// embedded preview, not a RAW render.
//
// This module is also the dispatcher's last-resort fallback for files nothing
// else could identify (see index.js), so every candidate is validated by
// walking its JPEG marker chain before we return anything: a skipped file with
// a reason beats a corrupt page in someone's PDF.

const Jimp = require('jimp');

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);

const MIN_EDGE = 8;              // below this it is an icon, not a preview
const MAX_PIXELS = 100 * 1000000; // jpeg-js refuses more, and a bogus SOF can claim 4 gigapixels
const MAX_CANDIDATES = 64;
const MAX_DECODE_ATTEMPTS = 4;   // each failed attempt costs a full JPEG decode
const MAX_IFDS = 64;             // IFD chains are short; more means we are chasing junk offsets

// --- JPEG ---------------------------------------------------------------

// Markers with no length word after them.
function isStandalone(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

// SOF0..SOF15 minus the three that are not frame headers (DHT, JPG, DAC).
function isSof(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Orientation out of an APP1 Exif payload, or 0 when it carries no such tag.
function readExifOrientation(buf, from, to) {
  if (buf.slice(from, from + 6).toString('latin1') !== 'Exif\0\0') return 0;
  const tiff = tiffReader(buf, from + 6, to);
  if (!tiff) return 0;
  const ifd = readIfd(tiff, tiff.base + tiff.u32(tiff.base + 4));
  const orientation = ifd ? tagValue(ifd, 274) : 0;
  return orientation >= 1 && orientation <= 8 ? orientation : 0;
}

/**
 * Walk one JPEG's marker segments. This is what stops us returning bytes that
 * merely start with FFD8: it proves the segment chain is intact, reads the real
 * pixel size from the SOF (container tags lie often enough), picks up the
 * stream's own EXIF orientation, and finds where it actually ends — declared
 * lengths in RAW containers are routinely padded, short, or plain wrong.
 *
 * @returns { start, end, width, height, exifOrientation } or null
 */
function inspectJpeg(buf, start, limit) {
  if (start < 0 || start + 4 > limit || buf[start] !== 0xff || buf[start + 1] !== 0xd8) return null;
  let p = start + 2;
  let width = 0;
  let height = 0;
  let exifOrientation = 0;

  while (p + 3 < limit) {
    if (buf[p] !== 0xff) return null; // lost step with the chain: not a real JPEG
    let marker = buf[p + 1];
    while (marker === 0xff && p + 2 < limit) { p++; marker = buf[p + 1]; } // fill bytes
    p += 2;
    if (marker === 0xd9 || marker === 0xd8) return null; // ended or restarted before any scan
    if (isStandalone(marker)) continue;

    const len = buf.readUInt16BE(p);
    if (len < 2 || p + len > limit) return null;
    if (isSof(marker)) {
      if (len < 8) return null;
      height = buf.readUInt16BE(p + 3);
      width = buf.readUInt16BE(p + 5);
    } else if (marker === 0xe1 && !exifOrientation) {
      exifOrientation = readExifOrientation(buf, p + 2, p + len);
    }
    p += len;

    if (marker === 0xda) {
      // Entropy-coded data follows, in which every FF is stuffed as FF00 or is
      // a restart marker — so the first FFD9 from here is the end of the image.
      if (width < MIN_EDGE || height < MIN_EDGE) return null;
      const eoi = buf.indexOf(EOI, p);
      if (eoi < 0 || eoi + 2 > limit) return null; // truncated
      return { start, end: eoi + 2, width, height, exifOrientation };
    }
  }
  return null;
}

// Validate a possible preview and remember it. Duplicates are common: the same
// stream gets found by the container walk and again by the scan.
function offer(buf, found, start, source) {
  const already = found.find(f => f.start === start);
  if (already) return already;
  if (found.length >= MAX_CANDIDATES) return null;
  const info = inspectJpeg(buf, start, buf.length);
  if (!info) return null;
  info.source = source;
  found.push(info);
  return info;
}

// The general fallback: look for JPEG streams byte by byte. Used for containers
// we do not parse (Minolta MRW, Sigma X3F, vendor MakerNote previews) and for
// whatever the dispatcher could not identify at all. Skipping to the end of
// each stream found keeps us from re-reporting the thumbnail inside its APP1.
function scanForJpegs(buf, found, from, to, source) {
  let p = from;
  while (p < to && found.length < MAX_CANDIDATES) {
    const at = buf.indexOf(SOI, p);
    if (at < 0 || at >= to) break;
    const info = offer(buf, found, at, source);
    p = info ? info.end : at + 3;
  }
}

// --- TIFF / EXIF IFDs ---------------------------------------------------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// Offsets inside a TIFF are relative to its header, which is at `base`: 0 for a
// RAW file, or the start of the Exif blob inside an APP1 segment.
function tiffReader(buf, base, end) {
  const order = buf.slice(base, base + 2).toString('latin1');
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  return {
    base,
    end: Math.min(end, buf.length),
    le,
    u16(o) { return o >= 0 && o + 2 <= this.end ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : 0; },
    u32(o) { return o >= 0 && o + 4 <= this.end ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : 0; }
  };
}

function readIfd(r, at) {
  if (at <= r.base || at + 2 > r.end) return null;
  const count = r.u16(at);
  if (!count || count > 512) return null;
  const dirEnd = at + 2 + count * 12;
  if (dirEnd > r.end) return null;
  return { r, at, count, next: r.u32(dirEnd) };
}

// Numbers held by one tag: inline in the entry when they fit in 4 bytes,
// otherwise at an offset from the TIFF header.
function tagValues(ifd, tag, max) {
  const r = ifd.r;
  for (let i = 0; i < ifd.count; i++) {
    const e = ifd.at + 2 + i * 12;
    if (r.u16(e) !== tag) continue;
    const type = r.u16(e + 2);
    const size = TYPE_SIZE[type];
    const count = r.u32(e + 4);
    if (!size || !count || count > 1024) return [];
    const bytes = size * count;
    const from = bytes <= 4 ? e + 8 : r.base + r.u32(e + 8);
    const out = [];
    for (let n = 0; n < Math.min(count, max); n++) {
      const o = from + n * size;
      out.push(type === 3 || type === 8 ? r.u16(o) : r.u32(o));
    }
    return out;
  }
  return [];
}

function tagValue(ifd, tag) {
  return tagValues(ifd, tag, 1)[0] || 0;
}

/**
 * Walk the IFD chain of a TIFF-based RAW and collect the JPEGs hidden in it.
 * Where previews live, by tag:
 *   513/514  JPEGInterchangeFormat + Length — the classic EXIF thumbnail, but
 *            also where ARW, NEF and PEF keep their larger previews
 *   273/279  StripOffsets + ByteCounts on an IFD whose Compression is 6 or 7,
 *            i.e. an IFD that *is* a JPEG: Canon CR2's full-size preview in
 *            IFD0, DNG's preview IFDs, NEF's NewSubfileType=1 SubIFD
 * SubIFDs (330) and the Exif IFD (34665) are followed too, since that is where
 * DNG and NEF hang theirs.
 *
 * @returns the container's own Orientation (IFD0), or 0
 */
function collectTiff(buf, found, base) {
  const r = tiffReader(buf, base, buf.length);
  if (!r) return 0;

  let orientation = 0;
  const seen = new Set();
  const queue = [r.u32(base + 4)];
  let budget = MAX_IFDS;
  let isIfd0 = true;

  while (queue.length && budget-- > 0) {
    const rel = queue.shift();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const ifd = readIfd(r, base + rel);
    if (!ifd) continue;
    if (ifd.next) queue.push(ifd.next);

    if (isIfd0) {
      const o = tagValue(ifd, 274);
      if (o >= 1 && o <= 8) orientation = o;
      isIfd0 = false; // only IFD0 speaks for the whole file
    }

    const jpegOffset = tagValue(ifd, 513);
    if (jpegOffset) offer(buf, found, base + jpegOffset, 'ifd 513');

    const compression = tagValue(ifd, 259);
    if (compression === 6 || compression === 7 || compression === 34892) {
      const offsets = tagValues(ifd, 273, 2);
      // More than one strip means tiled JPEG sensor data, not a preview.
      if (offsets.length === 1) offer(buf, found, base + offsets[0], 'ifd strip');
    }

    for (const sub of tagValues(ifd, 330, 8)) queue.push(sub);
    const exifIfd = tagValue(ifd, 34665);
    if (exifIfd) queue.push(exifIfd);
  }
  return orientation;
}

// --- other containers ---------------------------------------------------

// Fujifilm RAF: a fixed big-endian header, JPEG offset at 84 and length at 88.
function collectRaf(buf, found) {
  if (buf.length < 92) return;
  offer(buf, found, buf.readUInt32BE(84), 'raf header');
}

const CR3_BOXES = new Set(['moov', 'uuid', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'CMT1']);

// Canon CR3 is ISO-BMFF. Previews sit in 'PRVW' and 'THMB' boxes (nested in a
// 'uuid' box under moov) and the full-size JPEG is a track in 'mdat'. Both wrap
// the JPEG behind a small vendor header, so we locate the box and look for the
// SOI inside it rather than guessing header sizes.
function collectCr3(buf, found, from, to, depth) {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    let body = p + 8;
    if (size === 1) { // 64-bit size; the high word is always 0 for real files
      if (p + 16 > to || buf.readUInt32BE(p + 8) !== 0) return;
      size = buf.readUInt32BE(p + 12);
      body = p + 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < body - p || p + size > to) return; // malformed: stop, the scan will cover it
    const end = p + size;

    if (type === 'PRVW' || type === 'THMB' || type === 'mdat') {
      scanForJpegs(buf, found, body, end, 'cr3 ' + type);
    } else if (CR3_BOXES.has(type) && depth < 6) {
      collectCr3(buf, found, type === 'uuid' ? body + 16 : body, end, depth + 1);
    }
    p = end;
  }
}

// --- decode -------------------------------------------------------------

function isTiffHeader(buf) {
  const order = buf.slice(0, 2).toString('latin1');
  // The version word is 42 for TIFF/DNG/CR2/NEF/ARW, but Olympus and Panasonic
  // put their own numbers there while keeping TIFF's layout.
  return order === 'II' || order === 'MM';
}

/**
 * @param buffer  the whole file
 * @param ctx     { filePath, ext, format }
 * @returns       one Frame: the largest usable embedded preview, decoded
 */
async function decode(buffer, ctx) {
  const found = [];
  let containerOrientation = 0;

  if (buffer.slice(0, 8).toString('latin1') === 'FUJIFILM') {
    collectRaf(buffer, found);
  } else if (buffer.slice(4, 8).toString('latin1') === 'ftyp') {
    collectCr3(buffer, found, 0, buffer.length, 0);
  } else if (isTiffHeader(buffer)) {
    containerOrientation = collectTiff(buffer, found, 0);
  }
  // Always finish with the scan: it costs one memchr pass over the file and
  // catches previews the container walk cannot reach.
  scanForJpegs(buffer, found, 0, buffer.length, 'scan');

  if (!found.length) {
    // The dispatcher sends us files nothing else could place, so the skip
    // reason has to read sensibly for something that was never a RAW.
    const isRaw = ctx && (ctx.format === 'raw' || ctx.format === 'cr3');
    throw new Error(isRaw ? 'no preview image inside this RAW file' : 'no readable image inside this file');
  }

  // Biggest picture wins, by pixel area — not byte length, which would prefer a
  // noisy thumbnail over a smooth full-size preview. Same area: more bytes.
  found.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.end - b.start - (a.end - a.start)));

  let oversized = false;
  let attempts = 0;
  for (const candidate of found) {
    if (candidate.width * candidate.height > MAX_PIXELS) { oversized = true; continue; }
    if (attempts++ >= MAX_DECODE_ATTEMPTS) break;
    let image;
    try {
      // Decoding the winner here rather than returning its bytes costs nothing
      // — the dispatcher would decode it once anyway — and buys two things: a
      // corrupt preview drops us to the next-largest candidate instead of
      // failing the file, and Jimp resolves the preview's own EXIF orientation
      // for us (see below). buffer.slice is a view, so no copy of the stream.
      image = await Jimp.read(buffer.slice(candidate.start, candidate.end));
    } catch (e) {
      continue; // a corrupt stream costs us one decode, then the next candidate
    }
    const frame = { width: image.bitmap.width, height: image.bitmap.height, data: image.bitmap.data };
    // Jimp has already rotated the bitmap if the preview carried its own EXIF
    // Orientation, so forwarding that would apply it twice — sideways photos.
    // The container's Orientation is ours to pass on only when the preview
    // declares none of its own.
    if (!candidate.exifOrientation && containerOrientation > 1) frame.orientation = containerOrientation;
    return [frame];
  }

  if (oversized) throw new Error('the preview image inside this file is too large to decode');
  throw new Error('the preview image inside this file is damaged');
}

module.exports = { formats: ['raw', 'cr3'], decode };
