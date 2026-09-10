'use strict';

// Photoshop documents. We only ever want the flattened composite Photoshop
// stores at the end of the file — the same picture the user sees — never the
// layer stack, which we would have to blend ourselves.
//
// ag-psd does the reading. It rejects some documents outright, so we read the
// 26-byte header first and turn those cases into a skip reason the user can
// act on, rather than letting a library message reach them.

const agPsd = require('ag-psd');

// Bitmap, greyscale, indexed and RGB are the modes ag-psd can flatten to RGBA.
const READABLE_MODES = [0, 1, 2, 3];
const MODE_NAMES = { 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };
const NO_COMPOSITE = 'this PSD has no flattened preview — re-save it with "Maximise Compatibility" turned on';

// ag-psd allocates pixel buffers through a browser canvas. There is no DOM in
// the Electron main process, so hand it a plain typed array instead. Deferred
// to first use because it mutates ag-psd's module state.
let canvasReady = false;
function useTypedArrays() {
  if (canvasReady) return;
  agPsd.initializeCanvas(
    () => { throw new Error('PSD decoding never needs a canvas'); },
    undefined,
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
  );
  canvasReady = true;
}

// Photoshop always appends the composite after the colour-mode, image-resource
// and layer sections. A document saved without "Maximise Compatibility" ends
// where the layer section ends, and that is what we look for. PSB writes the
// layer section's length as 8 bytes rather than 4; no real file fills the high
// word, so we read the low one either way.
function hasComposite(buffer, large) {
  let offset = 26;
  for (const lengthBytes of [4, 4, large ? 8 : 4]) {
    if (offset + lengthBytes > buffer.length) return false;
    offset += lengthBytes + buffer.readUInt32BE(offset + lengthBytes - 4);
  }
  return offset + 2 < buffer.length;
}

/**
 * @param buffer  the whole .psd or .psb file
 * @returns       a single Frame holding the flattened composite
 */
async function decode(buffer) {
  if (buffer.length < 26) throw new Error('this PSD is cut short');
  const large = buffer.readUInt16BE(4) === 2;   // 1 = PSD, 2 = PSB
  const depth = buffer.readUInt16BE(22);
  const colorMode = buffer.readUInt16BE(24);

  if (depth !== 8 && depth !== 1) {
    throw new Error(`this PSD is ${depth} bits per channel — save a copy as 8-bit, or as JPEG or PNG`);
  }
  if (!READABLE_MODES.includes(colorMode)) {
    throw new Error(`this PSD is in ${MODE_NAMES[colorMode] || 'an unsupported'} colour mode — save a copy as RGB, or as JPEG or PNG`);
  }
  if (!hasComposite(buffer, large)) throw new Error(NO_COMPOSITE);

  useTypedArrays();
  let psd;
  try {
    psd = agPsd.readPsd(buffer, {
      skipLayerImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      useImageData: true
    });
  } catch (e) {
    throw new Error(`this PSD could not be read: ${e.message}`);
  }

  const composite = psd.imageData;
  if (!composite) throw new Error(NO_COMPOSITE);
  return [{ width: composite.width, height: composite.height, data: composite.data }];
}

module.exports = { formats: ['psd'], decode };
