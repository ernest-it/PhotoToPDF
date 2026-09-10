# Decoder fixtures

Small, committed input files for the `test/*.test.js` suites. Everything here
is generated locally unless listed under "Downloaded" below — the tests must
never call an external tool, so the encoded bytes live in the repo.

This file documents the HEIC and AVIF fixtures, which are the only ones with
third-party provenance. The WebP, camera RAW, TIFF, PSD, TGA, QOI, PNM and ICO
fixtures are all generated locally, and each suite's own header comment says
what its files cover and how they were made. `*-src*.png` files are the
reference images the decoders are pixel-compared against; `*-bad-*` and
`*-unsupported-*` files are expected to be skipped with a reason.

## HEIC / AVIF (`test/heif.test.js`)

| file | what it covers |
| --- | --- |
| `heic-rgb.heic` | a plain HEVC-coded HEIC with four different corners; 452x462 cropped to 451x461 by a `clap` property |
| `heic-alpha.heic` | HEIC with a real alpha channel: transparent corners, opaque white middle |
| `heic-irot90.heic` | container rotation libheif applies itself, so the frame must *not* also carry an orientation |
| `avif-rgb.avif` | plain 8-bit AVIF, four different corners |
| `avif-alpha.avif` | AVIF with an alpha channel: opaque left half, transparent right half |
| `avif-10bit.avif` | 10-bit AV1, which must still arrive as 8-bit RGBA |
| `avif-irot90.avif` | container rotation libavif does *not* apply, so the frame carries orientation 8 |
| `avif-imir.avif` | container mirror, likewise: orientation 4 |
| `avif-anim.avif` | an image sequence (`avis` brand), which contributes its first frame |
| `avif-bad-truncated.avif` | the first 320 bytes of `avif-rgb.avif` — must be skipped with a reason, never rendered |

Generated locally with ImageMagick 6.9 from a synthetic four-quadrant image:
`avif-rgb.avif` and `avif-alpha.avif` (`convert src.png out.avif`) and
`avif-10bit.avif` (`convert src.png -depth 10 out.avif`).

`avif-irot90.avif` and `avif-imir.avif` are derived from `avif-rgb.avif` by
overwriting the primary item's 19-byte `colr` property in place with a padded
`irot` (angle 1 = 90° counter-clockwise) or `imir` (axis 0 = flip top to
bottom) box. Same length, so the `ipma` property indices and every `iloc`
offset stay valid. ImageMagick writes neither transform itself.

### Downloaded

`heic-rgb.heic` and `heic-alpha.heic` are verbatim copies of test data from the
libheif project, which we already ship as `libheif-js`:

* `heic-rgb.heic` — `tests/data/rainbow-451x461.heic`
* `heic-alpha.heic` — `tests/data/with-alpha-512x512.heic`
* from <https://github.com/strukturag/libheif>, LGPL-3.0 (the repository's
  `COPYING`), same licence as the `libheif-js` dependency itself.

`heic-irot90.heic` is derived from `heic-rgb.heic`: its 40-byte `clap` property
was overwritten in place with a padded `irot` box, the same trick as the AVIF
pair above. Same source and licence.

No HEIC encoder exists in pure JS or WASM, and ImageMagick cannot write HEIC
(`convert in.png out.heic` silently writes a PNG), so these three could not be
generated locally.

`avif-anim.avif` is a verbatim copy of `testFiles/Netflix/avis/alpha_video.avif`
from <https://github.com/AOMediaCodec/av1-avif>, © Netflix Inc., licensed
[CC BY-NC-ND 4.0](http://creativecommons.org/licenses/by-nc-nd/4.0/). Nothing
on this machine can encode an AVIF image sequence. Delete it if you would
rather not carry it — `test/heif.test.js` prints a `skipped:` line instead.
