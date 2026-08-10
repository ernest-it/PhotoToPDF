# Changelog

All notable changes to this project are documented here.

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
