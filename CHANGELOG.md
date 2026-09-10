# Changelog

All notable changes to this project are documented here.

## [1.2.0] — 2026-09-10

**Photos to PDF now reads the formats your phone and camera actually produce.**

- **HEIC / HEIF** — iPhone photos work directly, no conversion step. Canon and
  Sony `.HIF` files too.
- **AVIF** and **WebP** — the two formats modern phones and browsers save.
- **Camera RAW** — CR2, CR3, NEF, NRW, ARW, SR2, DNG, ORF, RAF, RW2, PEF, SRW,
  3FR, IIQ, MRW, X3F and more. The app uses the full-size JPEG preview the camera
  embedded in the file, so it stays fast and needs no RAW converter.
- **Multi-page TIFF** — a scanned or faxed TIFF now becomes one PDF page per TIFF
  page, in order, each captioned with its page number.
- **Photoshop PSD**, plus TGA, QOI, PNM/PBM/PGM/PPM and ICO.
- **Fixed: WebP files were never actually readable.** `.webp` had been offered in
  the file dialog since 1.0.0, but every WebP was silently skipped as "not a
  readable image". It now decodes properly.
- **Files are identified by their contents, not their name.** A `.jpg` that is
  really a PNG, or an Android `.heic` that is really AVIF, now opens instead of
  being skipped. Unknown files are checked for an embedded preview image before
  giving up, which is what makes the rarer camera formats work.
- Skip reasons are more specific: "JPEG XL is not supported yet" or "no preview
  image inside this RAW file" instead of a blanket "not a readable image".
- Sideways photos still come out upright — orientation is now handled for HEIC and
  RAW containers as well as JPEG.

Everything stays offline and pure JavaScript/WebAssembly — no native binaries, no
extra tools to install. HEIC and AVIF decoding uses libheif (LGPL-3.0) via
libheif-js; see the README for the notice.

## [1.1.2] — 2026-08-17

- The **Windows installer now shows the license** and asks you to accept it before
  installing. The text is generated from `LICENSE` at build time, so it can't drift
  from the real terms.
- No changes to the app itself.

## [1.1.1] — 2026-08-14

No functional changes from 1.1.0 — this release exists to ship the new license.

- **License changed from MIT to the [PolyForm Noncommercial License 1.0.0](LICENSE).**
  Use, modification and free redistribution are still allowed for noncommercial
  purposes, and nonprofits, schools and government bodies may use it in their work
  — but the software may not be sold, and commercial use needs permission. Releases
  1.0.0 and 1.1.0 went out under MIT; copies obtained under those terms remain MIT.

## [1.1.0] — 2026-08-10

- **Add existing PDFs to the document.** Estimates, invoices and reports can now be
  mixed in with the photos and ordered anywhere in the list.
- Added PDFs are copied page‑for‑page at their original page size and rotation —
  no re‑compression, and their text stays selectable and searchable.
- File list tags each row **PHOTO** or **PDF**; folder scans and the file picker
  pick up `.pdf` alongside images.
- Skipped files now explain why (file not found, password‑protected PDF, not a
  readable image, …) instead of only being counted.

## [1.0.0] — 2026-07-22

Initial release.

- Combine local images into a single, compressed PDF (one photo per page).
- Drag & drop, add individual images, or add a whole folder.
- Reorder and remove photos before exporting.
- Three size presets: Smaller files, Balanced (default), Higher detail.
- Automatic EXIF orientation so sideways phone photos come out upright.
- Optional file‑name caption under each photo.
- Fully offline — no server, no account.
- Packaged for Windows (installer + portable) and Linux (AppImage).
