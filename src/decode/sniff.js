'use strict';

// What kind of image is this? Answered from the file's own bytes, with the
// extension used only to break ties the bytes genuinely cannot settle.
//
// Trusting the extension alone breaks on the files people actually have:
// ".jpg" that is really a PNG (saved by a browser), ".heic" from an Android
// phone that is really AVIF, and camera RAW where a dozen vendors all share
// TIFF's magic number. So we look at the header first.

const path = require('path');

// TIFF-based and other RAW containers we recognise by extension. All of these
// wrap a full-size JPEG preview, which is what we actually render.
const RAW_EXT = new Set([
  '3fr', 'arq', 'arw', 'cap', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'eip', 'erf',
  'fff', 'iiq', 'k25', 'kdc', 'mdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'orf',
  'ori', 'pef', 'ptx', 'pxn', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw',
  'x3f'
]);

// Extensions that carry no usable magic number of their own.
const TGA_EXT = new Set(['tga', 'tpic', 'icb', 'vda', 'vst']);

function ascii(buf, start, len) {
  return buf.slice(start, start + len).toString('latin1');
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

// ISO base media containers (HEIC, AVIF, CR3, JPEG XL) all begin with a
// 'ftyp' box; the brand that follows says which one it is.
function sniffIsoBmff(buf) {
  if (ascii(buf, 4, 4) !== 'ftyp') return null;
  const brand = ascii(buf, 8, 4).trim().toLowerCase();
  // Brands can also appear in the compatible-brands list, so scan the box.
  const boxLen = Math.min(buf.readUInt32BE(0) || 32, 64, buf.length);
  const brands = ascii(buf, 8, Math.max(0, boxLen - 8)).toLowerCase();
  if (brand === 'crx' || brands.includes('crx ')) return 'cr3';
  if (brand === 'jxl' || brands.includes('jxl ')) return 'jxl';
  if (brand.startsWith('avi') || brands.includes('avif') || brands.includes('avis')) return 'avif';
  if (brand.startsWith('hei') || brand.startsWith('hev') || brand === 'mif1' ||
      brand === 'msf1' || brand === 'mif2' || brands.includes('heic') ||
      brands.includes('mif1')) return 'heic';
  return null;
}

/**
 * @param buf       the first few KB of the file (or all of it)
 * @param filePath  used only for extension tie-breaks
 * @returns         a format id: 'jpeg' 'png' 'gif' 'bmp' 'tiff' 'heic' 'avif'
 *                  'webp' 'psd' 'qoi' 'tga' 'pnm' 'ico' 'raw' 'cr3' 'jxl'
 *                  'jp2' 'svg' 'unknown'
 */
function sniffFormat(buf, filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (!buf || buf.length < 4) return 'unknown';

  // --- unambiguous magic numbers ---
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(buf, 0, 3) === 'GIF') return 'gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';
  if (ascii(buf, 0, 4) === '8BPS') return 'psd';
  if (ascii(buf, 0, 4) === 'qoif') return 'qoi';
  if (ascii(buf, 0, 4) === 'FOVb') return 'raw';                       // Sigma X3F
  if (ascii(buf, 1, 3) === 'MRM') return 'raw';                        // Minolta MRW
  if (ascii(buf, 0, 8) === 'FUJIFILM') return 'raw';                   // Fujifilm RAF
  if (startsWith(buf, [0x00, 0x00, 0x00, 0x0c]) && ascii(buf, 4, 4) === 'jP  ') return 'jp2';
  if (startsWith(buf, [0xff, 0x4f, 0xff, 0x51])) return 'jp2';         // raw J2K codestream
  if (startsWith(buf, [0xff, 0x0a])) return 'jxl';
  if (ascii(buf, 0, 2) === 'BM') return 'bmp';

  const iso = sniffIsoBmff(buf);
  if (iso) return iso;

  // --- TIFF, and the RAW formats built on top of it ---
  const le = startsWith(buf, [0x49, 0x49, 0x2a, 0x00]);
  const be = startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a]);
  if (le || be) {
    if (ascii(buf, 8, 2) === 'CR') return 'raw';                       // Canon CR2
    if (RAW_EXT.has(ext)) return 'raw';
    return 'tiff';
  }
  // Olympus ORF and Panasonic RW2 use TIFF's layout with their own version word.
  if (startsWith(buf, [0x49, 0x49, 0x52, 0x4f]) || startsWith(buf, [0x4d, 0x4d, 0x4f, 0x52]) ||
      startsWith(buf, [0x49, 0x49, 0x52, 0x53]) || startsWith(buf, [0x49, 0x49, 0x55, 0x00])) {
    return 'raw';
  }

  // --- formats that need the extension to disambiguate ---
  // Netpbm: 'P1'..'P7' followed by whitespace.
  if (buf[0] === 0x50 && buf[1] >= 0x31 && buf[1] <= 0x37 && /\s/.test(String.fromCharCode(buf[2]))) return 'pnm';
  // ICO/CUR and TGA share a 00 00 0X 00 header; the extension decides.
  if (startsWith(buf, [0x00, 0x00]) && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) {
    if (ext === 'ico' || ext === 'cur') return 'ico';
    if (TGA_EXT.has(ext)) return 'tga';
  }
  if (TGA_EXT.has(ext)) return 'tga';
  // A corrupt icon may not even have a valid directory header. Sending it to
  // the ICO decoder anyway gets the user a real reason instead of the generic
  // "not a readable image".
  if (ext === 'ico' || ext === 'cur') return 'ico';
  if (/^\s*<(\?xml|svg)/i.test(ascii(buf, 0, 64))) return 'svg';
  if (RAW_EXT.has(ext)) return 'raw';

  return 'unknown';
}

// Everything the app offers to open, as bare lowercase extensions. This list
// lives next to the sniffer because this is where the formats are really
// defined; main.js turns it into file-dialog filters and the folder scan, and
// the renderer gets it over IPC instead of keeping its own copy.
//
// Formats we can name but not decode (JPEG XL, JPEG 2000, SVG) are absent on
// purpose: offering a file we then skip is worse than not offering it. That
// was the old .webp bug — advertised in the dialog since 1.0.0, silently
// skipped on every build because jimp could not read it.
const PHOTO_EXT = [
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp',
  'heic', 'heif', 'hif', 'avif', 'psd', 'psb', 'tga', 'tpic', 'qoi', 'pnm',
  'pam', 'pbm', 'pgm', 'ppm', 'ico', 'cur'
];

const IMAGE_EXT = [...PHOTO_EXT, ...Array.from(RAW_EXT).sort()];

module.exports = { sniffFormat, RAW_EXT, PHOTO_EXT, IMAGE_EXT };
