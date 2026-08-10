'use strict';

// Core: turn a list of local files — images and/or existing PDFs — into one PDF.
//
// Pure JavaScript (jimp + pdf-lib) on purpose — no native binaries — so the
// same code packages cleanly for Windows and Linux from one machine. This is
// the standalone-desktop sibling of the CollisionOps in-app "combine photos
// into a PDF" feature; same idea (shrink each image, one per page), no server.
//
// Images are downscaled and re-encoded as JPEG. PDFs (estimates, invoices,
// reports) are copied through page-for-page at their original size and
// quality — their text stays selectable and we never re-compress them.

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// maxEdge = longest side (px) after downscale; quality = JPEG quality.
const QUALITY_PRESETS = {
  smaller:  { maxEdge: 1200, quality: 65 },
  balanced: { maxEdge: 1600, quality: 75 },
  higher:   { maxEdge: 2048, quality: 82 }
};
const DEFAULT_QUALITY = 'balanced';

function isPdfPath(filePath) {
  return path.extname(String(filePath || '')).toLowerCase() === '.pdf';
}

// pdf-lib StandardFonts use WinAnsi and throw on un-encodable code points.
// Filenames can contain anything, so strip the caption to printable ASCII.
function sanitizeCaption(text, maxLen) {
  const cleaned = String(text || '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + '...' : cleaned;
}

// Library errors are long and technical ("Failed to parse PDF document
// (line:0 col:48 offset=24)..."); this list ends up in front of the user.
function describeFailure(err, isPdf) {
  const raw = (err && err.message) || '';
  if (/ENOENT|no such file/i.test(raw)) return 'file not found';
  if (/EACCES|EPERM|permission/i.test(raw)) return 'no permission to read it';
  if (!isPdf) return 'not a readable image';
  if (/encrypt|password/i.test(raw)) return 'password-protected PDF';
  if (/no pages/i.test(raw)) return 'PDF has no pages';
  return 'not a readable PDF';
}

// One page per image: downscale, flatten onto white, embed as JPEG.
async function addImagePage(pdf, font, filePath, preset, showLabels) {
  const image = await Jimp.read(filePath); // jimp applies EXIF orientation on read

  // Downscale only (never upscale a small image).
  const w = image.getWidth();
  const h = image.getHeight();
  if (Math.max(w, h) > preset.maxEdge) {
    image.scaleToFit(preset.maxEdge, preset.maxEdge);
  }

  // Flatten onto white so a transparent PNG doesn't become black in JPEG.
  const flat = new Jimp(image.getWidth(), image.getHeight(), 0xffffffff);
  flat.composite(image, 0, 0);
  flat.quality(preset.quality);
  const jpgBuffer = await flat.getBufferAsync(Jimp.MIME_JPEG);

  const img = await pdf.embedJpg(jpgBuffer);

  // Page orientation follows the image. US Letter.
  const landscape = img.width >= img.height;
  const pageW = landscape ? 792 : 612;
  const pageH = landscape ? 612 : 792;
  const page = pdf.addPage([pageW, pageH]);

  const margin = 24;
  const captionH = showLabels ? 22 : 0;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2 - captionH;
  const scale = Math.min(availW / img.width, availH / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  page.drawImage(img, {
    x: (pageW - drawW) / 2,
    y: margin + captionH + (availH - drawH) / 2,
    width: drawW,
    height: drawH
  });

  if (showLabels) {
    const label = sanitizeCaption(path.basename(filePath), 110);
    if (label) {
      page.drawText(label, { x: margin, y: margin - 2 + captionH / 2, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
    }
  }

  return 1;
}

// Every page of an existing PDF, copied in order and untouched: original page
// size, rotation, vector text and embedded fonts all preserved. No caption is
// drawn — the source page already uses its full area, and stamping over it
// would cover real content.
async function addPdfPages(pdf, filePath) {
  const srcBytes = fs.readFileSync(filePath);
  // Not ignoreEncryption: pdf-lib cannot decrypt, so "loading" a protected PDF
  // would copy unreadable pages. Better to throw here and skip the file.
  const src = await PDFDocument.load(srcBytes, { updateMetadata: false });
  const indices = src.getPageIndices();
  if (!indices.length) throw new Error('PDF has no pages');
  const pages = await pdf.copyPages(src, indices);
  for (const page of pages) pdf.addPage(page);
  return pages.length;
}

/**
 * @param filePaths  absolute paths to images and/or PDFs, in the order they should appear
 * @param options    { quality: 'smaller'|'balanced'|'higher', labels: boolean, onProgress: fn }
 * @returns          { bytes, used, images, pdfs, pages, skipped: [{file, reason}] }
 * @throws           Error('NO_USABLE_FILES') if nothing could be rendered
 */
async function buildPhotoPdf(filePaths, options = {}) {
  const preset = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS[DEFAULT_QUALITY];
  const showLabels = options.labels !== false; // default on
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const skipped = [];
  let used = 0;    // source files that contributed at least one page
  let images = 0;
  let pdfs = 0;
  let pages = 0;
  let index = 0;

  for (const filePath of filePaths) {
    index++;
    const isPdf = isPdfPath(filePath);
    onProgress({ index, total: filePaths.length, file: path.basename(filePath), kind: isPdf ? 'pdf' : 'image' });
    try {
      if (isPdf) {
        pages += await addPdfPages(pdf, filePath);
        pdfs++;
      } else {
        pages += await addImagePage(pdf, font, filePath, preset, showLabels);
        images++;
      }
      used++;
    } catch (e) {
      skipped.push({ file: filePath, reason: describeFailure(e, isPdf) });
    }
  }

  if (used === 0) {
    const err = new Error('NO_USABLE_FILES');
    err.skipped = skipped;
    throw err;
  }

  const bytes = await pdf.save();
  return {
    bytes,
    used,
    images,
    pdfs,
    pages,
    skipped,
    quality: options.quality && QUALITY_PRESETS[options.quality] ? options.quality : DEFAULT_QUALITY
  };
}

module.exports = { buildPhotoPdf, isPdfPath, QUALITY_PRESETS, DEFAULT_QUALITY };
