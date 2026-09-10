'use strict';

// The long tail of small, completely specified image formats: Truevision TGA,
// QOI, Netpbm (PBM/PGM/PPM/PAM) and Windows ICO/CUR. Each is a few dozen lines
// of byte shuffling, so they are decoded here by hand rather than pulling in
// four more dependencies for formats hardly anyone drops on the app.
//
// TGA and Netpbm carry no real magic number — index.js routes files here on
// the extension alone, and never as a fallback — so validation is this
// module's main job. Every header field is checked against the others and
// against the actual file length, and anything that does not add up throws: a
// skipped file with a reason beats a page of noise in the user's PDF.

// Past any real photograph, and a 400 MB RGBA bitmap. Guards against a
// corrupt header asking for an allocation that kills the process.
const MAX_PIXELS = 100e6;

function bad(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------- TGA

const TGA_TYPES = { 1: 'map', 2: 'true', 3: 'grey', 9: 'map', 10: 'true', 11: 'grey' };

// TGA RLE: a packet header byte, then either one pixel record to repeat
// (high bit set) or a literal run of them. Packets may cross row boundaries,
// which the spec forbids and encoders do anyway.
function expandTgaRle(buf, offset, count, recordSize) {
  const out = Buffer.allocUnsafe(count * recordSize);
  let src = offset;
  let dst = 0;
  while (dst < out.length) {
    if (src >= buf.length) bad('the TGA image data ends early');
    const packet = buf[src++];
    const run = (packet & 0x7f) + 1;
    const bytes = run * recordSize;
    if (dst + bytes > out.length) bad('a TGA compressed packet runs past the end of the image');
    if (packet & 0x80) {
      if (src + recordSize > buf.length) bad('the TGA image data ends early');
      for (let i = 0; i < run; i++) buf.copy(out, dst + i * recordSize, src, src + recordSize);
      src += recordSize;
    } else {
      if (src + bytes > buf.length) bad('the TGA image data ends early');
      buf.copy(out, dst, src, src + bytes);
      src += bytes;
    }
    dst += bytes;
  }
  return out;
}

// 5 bits per channel -> 8, spreading the top bits into the bottom so full
// scale stays full scale (31 -> 255, not 248).
function expand5(v) {
  return (v << 3) | (v >> 2);
}

function decodeTga(buf) {
  if (buf.length < 18) bad('the TGA file is too short to hold a header');

  const idLength = buf[0];
  const cmapType = buf[1];
  const imageType = buf[2];
  const cmapFirst = buf.readUInt16LE(3);
  const cmapLength = buf.readUInt16LE(5);
  const cmapDepth = buf[7];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf[16];
  const descriptor = buf[17];

  const kind = TGA_TYPES[imageType];
  if (!kind) bad('not a TGA image (unknown image type)');
  if (cmapType > 1) bad('not a TGA image (bad colour-map type)');
  if (!width || !height) bad('the TGA header has no image size');
  if (width * height > MAX_PIXELS) bad('the TGA image is too large to open');

  if (kind === 'map') {
    if (cmapType !== 1 || !cmapLength) bad('the colour-mapped TGA has no colour map');
    if (cmapDepth !== 15 && cmapDepth !== 16 && cmapDepth !== 24 && cmapDepth !== 32) {
      bad('the TGA colour map uses an unsupported entry size');
    }
    if (depth !== 8 && depth !== 16) bad('the colour-mapped TGA uses an unsupported index size');
  } else if (kind === 'grey') {
    if (depth !== 8 && depth !== 16) bad('the greyscale TGA uses an unsupported bit depth');
  } else if (depth !== 15 && depth !== 16 && depth !== 24 && depth !== 32) {
    bad('the TGA uses an unsupported bit depth');
  }

  const recordSize = depth === 15 ? 2 : depth >> 3;
  const cmapSize = cmapType === 1 ? cmapLength * (cmapDepth === 15 ? 2 : cmapDepth >> 3) : 0;
  const dataStart = 18 + idLength + cmapSize;
  if (dataStart >= buf.length) bad('the TGA file is truncated');

  // Colour map entries are stored like true-colour pixels: BGR(A), or a
  // 16-bit word.
  let palette = null;
  if (kind === 'map') {
    palette = new Uint8Array(cmapLength * 4);
    const entry = cmapDepth === 15 ? 2 : cmapDepth >> 3;
    for (let i = 0; i < cmapLength; i++) {
      const at = 18 + idLength + i * entry;
      const to = i * 4;
      if (entry === 2) {
        const word = buf.readUInt16LE(at);
        palette[to] = expand5((word >> 10) & 31);
        palette[to + 1] = expand5((word >> 5) & 31);
        palette[to + 2] = expand5(word & 31);
        palette[to + 3] = 255;
      } else {
        palette[to] = buf[at + 2];
        palette[to + 1] = buf[at + 1];
        palette[to + 2] = buf[at];
        palette[to + 3] = entry === 4 ? buf[at + 3] : 255;
      }
    }
  }

  const count = width * height;
  let pixels;
  if (imageType > 8) {
    pixels = expandTgaRle(buf, dataStart, count, recordSize);
  } else {
    const need = count * recordSize;
    if (buf.length - dataStart < need) bad('the TGA file is truncated');
    pixels = buf.slice(dataStart, dataStart + need);
  }

  // Bit 5 of the descriptor: set = rows stored top to bottom. Clear (the
  // default, and what most encoders write) = bottom row first, which is the
  // usual reason a TGA comes out upside down. Bit 4 mirrors left to right.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  const alphaBits = descriptor & 0x0f;

  const out = Buffer.allocUnsafe(count * 4);
  let maxAlpha = 0;
  for (let i = 0; i < count; i++) {
    const row = (i / width) | 0;
    const col = i - row * width;
    const y = topDown ? row : height - 1 - row;
    const x = rightToLeft ? width - 1 - col : col;
    const to = (y * width + x) * 4;
    const at = i * recordSize;

    let r;
    let g;
    let b;
    let a = 255;
    if (kind === 'map') {
      const index = (recordSize === 1 ? pixels[at] : pixels.readUInt16LE(at)) - cmapFirst;
      if (index < 0 || index >= cmapLength) bad('a TGA pixel points outside the colour map');
      r = palette[index * 4];
      g = palette[index * 4 + 1];
      b = palette[index * 4 + 2];
      a = palette[index * 4 + 3];
    } else if (kind === 'grey') {
      r = g = b = pixels[at];
      if (recordSize === 2) a = pixels[at + 1];
    } else if (recordSize === 2) {
      // ARRRRRGG GGGBBBBB, little-endian. The attribute bit only means
      // anything when the descriptor says there is one.
      const word = pixels.readUInt16LE(at);
      r = expand5((word >> 10) & 31);
      g = expand5((word >> 5) & 31);
      b = expand5(word & 31);
      if (depth === 16 && alphaBits === 1) a = (word & 0x8000) ? 255 : 0;
    } else {
      b = pixels[at];
      g = pixels[at + 1];
      r = pixels[at + 2];
      if (recordSize === 4) a = pixels[at + 3];
    }
    if (a > maxAlpha) maxAlpha = a;

    out[to] = r;
    out[to + 1] = g;
    out[to + 2] = b;
    out[to + 3] = a;
  }

  // Writers that store 32bpp but declare no attribute bits routinely leave the
  // alpha bytes at zero. Obeying that would flatten the whole picture to white,
  // and a genuinely invisible photo is not worth a page either, so an
  // all-transparent result means the alpha channel was never meant.
  if (!maxAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;

  return { width, height, data: out };
}

// ---------------------------------------------------------------- QOI

function decodeQoi(buf) {
  if (buf.toString('latin1', 0, 4) !== 'qoif') bad('not a QOI image');
  if (buf.length < 22) bad('the QOI file is too short'); // 14-byte header + 8-byte end marker
  const width = buf.readUInt32BE(4);
  const height = buf.readUInt32BE(8);
  const channels = buf[12];
  if (!width || !height) bad('the QOI header has no image size');
  if (width * height > MAX_PIXELS) bad('the QOI image is too large to open');
  if (channels !== 3 && channels !== 4) bad('the QOI image has an unsupported channel count');
  if (buf[13] > 1) bad('the QOI image has an unknown colour space');

  const count = width * height;
  const out = Buffer.allocUnsafe(count * 4);
  const index = new Uint8Array(64 * 4);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  let pos = 14;
  const end = buf.length - 8; // the 8-byte end marker is not pixel data
  let done = 0;
  while (done < count) {
    if (pos >= end) bad('the QOI image data ends early');
    const op = buf[pos++];
    let run = 1;
    if (op === 0xfe) {
      if (pos + 3 > end) bad('the QOI image data ends early');
      r = buf[pos++]; g = buf[pos++]; b = buf[pos++];
    } else if (op === 0xff) {
      if (pos + 4 > end) bad('the QOI image data ends early');
      r = buf[pos++]; g = buf[pos++]; b = buf[pos++]; a = buf[pos++];
    } else if (op < 0x40) {
      const at = (op & 0x3f) * 4;
      r = index[at]; g = index[at + 1]; b = index[at + 2]; a = index[at + 3];
    } else if (op < 0x80) {
      r = (r + ((op >> 4) & 3) - 2) & 0xff;
      g = (g + ((op >> 2) & 3) - 2) & 0xff;
      b = (b + (op & 3) - 2) & 0xff;
    } else if (op < 0xc0) {
      if (pos >= end) bad('the QOI image data ends early');
      const extra = buf[pos++];
      const dg = (op & 0x3f) - 32;
      r = (r + dg - 8 + ((extra >> 4) & 0x0f)) & 0xff;
      g = (g + dg) & 0xff;
      b = (b + dg - 8 + (extra & 0x0f)) & 0xff;
    } else {
      run = (op & 0x3f) + 1;
    }

    // Every chunk re-seeds the hash array, as the reference decoder does: for
    // a run or an index hit that is a no-op, except for a run of the initial
    // pixel, which is not in the array yet.
    const at = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    index[at] = r; index[at + 1] = g; index[at + 2] = b; index[at + 3] = a;

    if (done + run > count) bad('the QOI image holds more pixels than its header says');
    for (let i = 0; i < run; i++) {
      const to = (done + i) * 4;
      out[to] = r; out[to + 1] = g; out[to + 2] = b; out[to + 3] = a;
    }
    done += run;
  }
  // The marker has to sit exactly where the pixels stopped: that is what
  // catches a header claiming fewer pixels than the file actually encodes.
  // Bytes after it are somebody's padding and do no harm.
  const marker = buf.slice(pos, pos + 8);
  if (marker.length < 8 || marker.readUInt32BE(0) || marker.readUInt16BE(4) || marker[6] || marker[7] !== 1) {
    bad('the QOI image data does not end where its header says');
  }

  return { width, height, data: out };
}

// ---------------------------------------------------------------- Netpbm

function isSpace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

// Header fields are whitespace-separated with '#' comments allowed anywhere
// between them, including in the middle of the dimensions.
function pnmReader(buf, pos) {
  return {
    pos,
    skip() {
      for (;;) {
        while (this.pos < buf.length && isSpace(buf[this.pos])) this.pos++;
        if (buf[this.pos] !== 0x23) return;
        while (this.pos < buf.length && buf[this.pos] !== 0x0a) this.pos++;
      }
    },
    token(what) {
      this.skip();
      const start = this.pos;
      while (this.pos < buf.length && !isSpace(buf[this.pos]) && buf[this.pos] !== 0x23) this.pos++;
      if (this.pos === start) bad(`the PNM file ends early (expected a ${what})`);
      return buf.toString('latin1', start, this.pos);
    },
    number(what) {
      const text = this.token(what);
      if (!/^\d+$/.test(text)) bad(`the PNM ${what} is not a number`);
      return Number(text);
    }
  };
}

// The tuple types whose samples are grey, grey+alpha, RGB or RGBA in that
// order — i.e. the ones DEPTH alone describes correctly. A CMYK PAM has four
// samples too, and reading it as RGBA would silently invert the picture.
const PAM_TUPLES = new Set(['', 'BLACKANDWHITE', 'BLACKANDWHITE_ALPHA', 'GRAYSCALE', 'GRAYSCALE_ALPHA', 'RGB', 'RGB_ALPHA']);

// P7 (PAM) has a line-oriented header of KEY VALUE pairs ending at ENDHDR.
function pamHeader(buf) {
  const head = { depth: 0, maxval: 0, width: 0, height: 0, tuple: '' };
  let pos = 2;
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) bad('the PAM header has no ENDHDR');
    const line = buf.toString('latin1', pos, nl).trim();
    pos = nl + 1;
    if (line === 'ENDHDR') break;
    if (!line || line[0] === '#') continue;
    const m = /^(\w+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (key === 'WIDTH') head.width = Number(m[2]);
    else if (key === 'HEIGHT') head.height = Number(m[2]);
    else if (key === 'DEPTH') head.depth = Number(m[2]);
    else if (key === 'MAXVAL') head.maxval = Number(m[2]);
    else if (key === 'TUPLTYPE') head.tuple = m[2].toUpperCase();
  }
  head.dataStart = pos;
  return head;
}

function decodePnm(buf) {
  if (buf.length < 8 || buf[0] !== 0x50) bad('not a Netpbm image');
  const variant = buf[1] - 0x30;
  if (variant < 1 || variant > 7) bad('not a Netpbm image');

  let width;
  let height;
  let maxval = 1;
  let depth;
  let headerEnd;
  if (variant === 7) {
    const head = pamHeader(buf);
    width = head.width;
    height = head.height;
    maxval = head.maxval;
    depth = head.depth;
    headerEnd = head.dataStart - 1;
    if (depth < 1 || depth > 4) bad('the PAM image has an unsupported channel count');
    if (!PAM_TUPLES.has(head.tuple)) bad(`the PAM image holds ${head.tuple} samples, which are not colours we can read`);
  } else {
    const reader = pnmReader(buf, 2);
    width = reader.number('width');
    height = reader.number('height');
    if (variant !== 1 && variant !== 4) maxval = reader.number('maxval');
    depth = variant === 3 || variant === 6 ? 3 : 1;
    headerEnd = reader.pos;
  }
  // Exactly one whitespace byte separates a binary header from its samples;
  // ASCII samples are just more whitespace-separated tokens.
  const dataStart = headerEnd + 1;

  if (!width || !height) bad('the PNM header has no image size');
  if (width * height > MAX_PIXELS) bad('the PNM image is too large to open');
  if (maxval < 1 || maxval > 65535) bad('the PNM maxval is out of range');

  const count = width * height;
  const out = Buffer.allocUnsafe(count * 4);
  const wide = maxval > 255;
  const scale = v => (maxval === 255 ? v : Math.round((v * 255) / maxval));

  // In PBM a set bit is BLACK — the opposite of every other format here.
  if (variant === 1 || variant === 4) {
    if (variant === 4) {
      const stride = (width + 7) >> 3;
      if (buf.length - dataStart < stride * height) bad('the PBM file is truncated');
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = buf[dataStart + y * stride + (x >> 3)] & (0x80 >> (x & 7));
          const v = bit ? 0 : 255;
          const to = (y * width + x) * 4;
          out[to] = out[to + 1] = out[to + 2] = v;
          out[to + 3] = 255;
        }
      }
    } else {
      // ASCII bitmaps need no separators between the 0s and 1s.
      const reader = pnmReader(buf, headerEnd);
      for (let i = 0; i < count; i++) {
        reader.skip();
        const byte = buf[reader.pos++];
        if (byte !== 0x30 && byte !== 0x31) bad('the PBM file is truncated or holds junk');
        const v = byte === 0x31 ? 0 : 255;
        const to = i * 4;
        out[to] = out[to + 1] = out[to + 2] = v;
        out[to + 3] = 255;
      }
    }
    return { width, height, data: out };
  }

  const samples = new Array(count * depth);
  if (variant === 2 || variant === 3) {
    const reader = pnmReader(buf, headerEnd);
    for (let i = 0; i < samples.length; i++) {
      const v = reader.number('sample');
      if (v > maxval) bad('a PNM sample is larger than the maxval');
      samples[i] = v;
    }
  } else {
    const need = count * depth * (wide ? 2 : 1);
    if (buf.length - dataStart < need) bad('the PNM file is truncated');
    for (let i = 0; i < samples.length; i++) {
      samples[i] = wide ? buf.readUInt16BE(dataStart + i * 2) : buf[dataStart + i];
      if (samples[i] > maxval) bad('a PNM sample is larger than the maxval');
    }
  }

  for (let i = 0; i < count; i++) {
    const at = i * depth;
    const to = i * 4;
    if (depth >= 3) {
      out[to] = scale(samples[at]);
      out[to + 1] = scale(samples[at + 1]);
      out[to + 2] = scale(samples[at + 2]);
      out[to + 3] = depth === 4 ? scale(samples[at + 3]) : 255;
    } else {
      out[to] = out[to + 1] = out[to + 2] = scale(samples[at]);
      out[to + 3] = depth === 2 ? scale(samples[at + 1]) : 255;
    }
  }

  return { width, height, data: out };
}

// ---------------------------------------------------------------- ICO / CUR

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodeIco(buf) {
  if (buf.length < 22) bad('the icon file is too short');
  if (buf.readUInt16LE(0) !== 0) bad('not an icon file');
  const type = buf.readUInt16LE(2);
  if (type !== 1 && type !== 2) bad('not an icon file');
  const entries = buf.readUInt16LE(4);
  if (!entries) bad('the icon file contains no images');
  if (6 + entries * 16 > buf.length) bad('the icon directory is truncated');

  // Biggest picture wins; on a tie prefer the deeper one. In a CUR the
  // planes/bit-count fields hold the hotspot instead, so they only break ties.
  // A directory entry that points outside the file is skipped rather than
  // fatal — the other entries are usually fine.
  let best = null;
  for (let i = 0; i < entries; i++) {
    const at = 6 + i * 16;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (!size || offset < 6 || offset + size > buf.length) continue;
    const area = (buf[at] || 256) * (buf[at + 1] || 256);
    const bits = type === 1 ? buf.readUInt16LE(at + 6) : 0;
    if (!best || area > best.area || (area === best.area && bits > best.bits)) {
      best = { area, bits, size, offset };
    }
  }
  if (!best) bad('the icon file contains no usable images');

  const image = buf.slice(best.offset, best.offset + best.size);
  if (image.slice(0, 8).equals(PNG_MAGIC)) return { encoded: image };

  if (image.length < 40) bad('the icon image is truncated');
  const headerSize = image.readUInt32LE(0);
  if (headerSize < 40 || headerSize > image.length) bad('the icon image has a bad header');
  const width = image.readInt32LE(4);
  const storedHeight = image.readInt32LE(8);
  const bitCount = image.readUInt16LE(14);
  if (image.readUInt32LE(16) !== 0) bad('the icon image uses an unsupported compression');
  if (width < 1 || width > 4096 || !storedHeight) bad('the icon image has a bad size');
  if (bitCount !== 1 && bitCount !== 4 && bitCount !== 8 && bitCount !== 24 && bitCount !== 32) {
    bad('the icon image uses an unsupported colour depth');
  }

  // An icon DIB doubles its height to cover the 1-bit AND mask stapled
  // underneath the picture. A negative height means top-down rows.
  const bottomUp = storedHeight > 0;
  const doubled = Math.abs(storedHeight);
  const hasMask = bottomUp && doubled % 2 === 0;
  const height = hasMask ? doubled / 2 : doubled;

  let dataStart = headerSize;
  let colours = 0;
  let palette = null;
  if (bitCount <= 8) {
    colours = image.readUInt32LE(32) || (1 << bitCount);
    if (colours > 256) bad('the icon palette is too large');
    dataStart += colours * 4;
    palette = image.slice(headerSize, dataStart);
    if (palette.length < colours * 4) bad('the icon palette is truncated');
  }

  const stride = (((width * bitCount + 31) >> 5) << 2);
  if (image.length - dataStart < stride * height) bad('the icon image data is truncated');

  const maskStride = ((width + 31) >> 5) << 2;
  const maskStart = dataStart + stride * height;
  // Some icons simply omit the mask they promised; 32bpp ones do not need it.
  const mask = hasMask && image.length - maskStart >= maskStride * height ? maskStart : -1;

  const out = Buffer.allocUnsafe(width * height * 4);
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let y = 0; y < height; y++) {
    const row = dataStart + (bottomUp ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4;
      if (bitCount >= 24) {
        const at = row + x * (bitCount >> 3);
        out[to] = image[at + 2];
        out[to + 1] = image[at + 1];
        out[to + 2] = image[at];
        out[to + 3] = bitCount === 32 ? image[at + 3] : 255;
      } else {
        const perByte = 8 / bitCount;
        const shift = (perByte - 1 - (x % perByte)) * bitCount;
        const index = (image[row + ((x / perByte) | 0)] >> shift) & ((1 << bitCount) - 1);
        if (index >= colours) bad('an icon pixel points outside its palette');
        out[to] = palette[index * 4 + 2];
        out[to + 1] = palette[index * 4 + 1];
        out[to + 2] = palette[index * 4];
        out[to + 3] = 255;
      }
      if (out[to + 3] < minAlpha) minAlpha = out[to + 3];
      if (out[to + 3] > maxAlpha) maxAlpha = out[to + 3];
    }
  }

  // In a 32bpp icon the alpha channel is authoritative and the AND mask is
  // redundant. It is the other way round for the palette and 24-bit forms,
  // which have no alpha at all, and for the 32bpp icons some old editors wrote
  // with a uniform alpha channel (all zero, or all opaque) that says nothing.
  if (bitCount < 32 || !maxAlpha || minAlpha === 255) {
    for (let y = 0; y < height; y++) {
      const row = mask + (bottomUp ? height - 1 - y : y) * maskStride;
      for (let x = 0; x < width; x++) {
        const hidden = mask >= 0 && (image[row + (x >> 3)] & (0x80 >> (x & 7)));
        out[(y * width + x) * 4 + 3] = hidden ? 0 : 255;
      }
    }
  }

  return { width, height, data: out };
}

const DECODERS = { tga: decodeTga, qoi: decodeQoi, pnm: decodePnm, ico: decodeIco };

async function decode(buffer, ctx) {
  const decoder = DECODERS[ctx && ctx.format];
  if (!decoder) bad('not a TGA, QOI, Netpbm or icon file');
  return [decoder(buffer)];
}

module.exports = { formats: ['tga', 'qoi', 'pnm', 'ico'], decode };
