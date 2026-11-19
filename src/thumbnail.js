'use strict';

// Small previews for the reorder grid, so people can see which photo is which
// while they drag things around.
//
// Thumbnails go through the same decoder as the PDF itself (src/decode), so a
// HEIC, a RAW file or a sideways phone photo looks in the grid exactly the way
// it will look on its page — and a file that cannot be read shows up as such
// *before* anyone presses Create PDF.

const fs = require('fs');
const Jimp = require('jimp');
const { PDFDocument } = require('pdf-lib');
const { decodeImageFile } = require('./decode');
const { isPdfPath, describeFailure } = require('./pdfBuilder');

// Longest edge in pixels. The largest tile is 240 CSS px, so this stays sharp
// on a 150% display without making each data URL heavy.
const THUMB_EDGE = 360;
const THUMB_QUALITY = 72;

// Downscale a decoded picture and return it as a JPEG data URL.
async function encodeThumb(image, edge) {
  // Jimp's default resampler: ~120 ms for a 12 MP photo, against ~800 ms to
  // decode it, and no aliasing on fine detail like a VIN plate.
  if (Math.max(image.getWidth(), image.getHeight()) > edge) {
    image.scaleToFit(edge, edge);
  }
  // Flatten onto white, as the PDF page does.
  const flat = new Jimp(image.getWidth(), image.getHeight(), 0xffffffff);
  flat.composite(image, 0, 0);
  flat.quality(THUMB_QUALITY);
  const buf = await flat.getBufferAsync(Jimp.MIME_JPEG);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * @param filePath  absolute path to an image or PDF
 * @returns {Promise<
 *   { ok: true, kind: 'image', src: string, pages: number } |
 *   { ok: true, kind: 'pdf', pages: number } |
 *   { ok: false, kind: 'image'|'pdf', reason: string }>}
 *   `pages` is how many PDF pages the file will turn into. Never throws.
 */
async function makeThumbnail(filePath, edge = THUMB_EDGE) {
  const isPdf = isPdfPath(filePath);
  try {
    if (isPdf) {
      // Rendering a PDF page needs a full PDF renderer; the page count is
      // what actually matters when deciding where an estimate goes.
      const src = await PDFDocument.load(fs.readFileSync(filePath), { updateMetadata: false });
      const pages = src.getPageCount();
      if (!pages) throw new Error('PDF has no pages');
      return { ok: true, kind: 'pdf', pages };
    }
    const { images } = await decodeImageFile(filePath);
    return { ok: true, kind: 'image', src: await encodeThumb(images[0], edge), pages: images.length };
  } catch (e) {
    return { ok: false, kind: isPdf ? 'pdf' : 'image', reason: describeFailure(e, isPdf) };
  }
}

// Decoding is CPU-bound and runs on the main process, so do one file at a
// time and remember the answers: re-adding a folder, or dragging tiles
// around, should never decode the same photo twice.
const CACHE_LIMIT = 400;
const cache = new Map(); // key -> Promise<result>
let queue = Promise.resolve();

function cacheKey(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${filePath}|${st.size}|${st.mtimeMs}`;
  } catch (e) {
    return null; // missing file: don't cache, let makeThumbnail explain
  }
}

function getThumbnail(filePath) {
  const key = cacheKey(filePath);
  if (key && cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit); // most recently used last
    return hit;
  }
  const job = queue.then(() => makeThumbnail(filePath));
  queue = job.catch(() => {});
  if (key) {
    cache.set(key, job);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return job;
}

module.exports = { getThumbnail, makeThumbnail, THUMB_EDGE };
