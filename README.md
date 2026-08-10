<div align="center">

# Photos to PDF

**Combine a pile of photos — and your existing PDFs — into one small, emailable PDF.**

Drag in your images and any PDFs (estimates, invoices, reports), pick a size, get a
single compressed document. No internet, no account, no upload. Everything happens
on your computer.

![Photos to PDF](docs/screenshot.png)

</div>

---

## Why

Phone photos are huge. A single 12‑megapixel shot is often 8–12 MB, and email
providers cap a message around 25 MB — so you can't attach more than a few before
it bounces. **Photos to PDF** shrinks each image (a damage photo becomes a few
hundred KB and is still perfectly legible) and bundles them into one PDF you can
actually send.

It started as a feature inside a body‑shop management app and was pulled out into
this standalone tool so it works anywhere, on any folder of images.

## Features

- **Drag & drop**, or add individual files or a whole folder.
- **Mix photos and PDFs** — drop an estimate in front of the damage photos and ship
  one document.
- **Reorder** everything and remove any you don't want before exporting.
- **Three size presets** — pick the balance of quality vs. file size you need.
- **One photo per page**, auto‑oriented (sideways phone photos come out upright),
  with the file name printed underneath (optional).
- **PDFs pass through untouched** — every page, at its original size and rotation,
  with its text still selectable and searchable. Nothing is re‑compressed.
- **Completely offline.** Your photos never leave the machine.
- **Cross‑platform** — Windows and Linux.

### Size presets

| Preset | Longest edge | Roughly per photo | Photos under a 25 MB email |
| --- | --- | --- | --- |
| Smaller files | 1200 px | 150–300 KB | ~50+ |
| **Balanced** (default) | 1600 px | 300–600 KB | ~25–40 |
| Higher detail | 2048 px | 700 KB–1.2 MB | ~12–18 |

## Download & install

Grab the latest build from the [**Releases**](../../releases) page.

- **Windows** — run `Photos to PDF Setup <version>.exe` to install, or use the
  `Photos to PDF <version>.exe` **portable** version (no install, just run it).
  > The app is currently **unsigned**, so Windows SmartScreen may warn about an
  > "unknown publisher" the first time. Click **More info → Run anyway**.
- **Linux** — download the `.AppImage`, make it executable (`chmod +x`), and
  double‑click or run it. Nothing to install.

## Using it

1. Launch the app.
2. Drag photos and PDFs onto the window, or use **Add files…** / **Add a folder…**.
3. Reorder with ▲ ▼, remove anything with ✕. Each row is tagged **PHOTO** or **PDF**
   so you can see what you're shipping.
4. Choose a **PDF image size** (Balanced is a good default). This only affects
   photos — added PDFs are never touched.
5. Click **Create PDF** and choose where to save it.
6. **Open PDF** or **Show in folder** — done.

Missing or unreadable files are skipped and reported with the reason; they won't
stop the rest. Password‑protected PDFs can't be merged — remove the password first.

## Build from source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install         # install dependencies
npm start           # run the app locally (needs a desktop)
npm test            # verify the image→PDF core, no GUI
```

Build installers:

```bash
npm run dist:linux  # → dist/Photos to PDF-<ver>.AppImage
npm run dist:win    # → dist/Photos to PDF Setup <ver>.exe  + portable .exe
npm run dist        # both
```

electron‑builder can build the **Windows** installers from Linux too — it bundles
its own NSIS, so no Wine is needed for an unsigned build. Signed builds require a
code‑signing certificate.

## How it works

```
src/
  pdfBuilder.js      core: photos + PDFs → one PDF (jimp + pdf-lib)
  main.js            Electron main process: window, file dialogs, save
  preload.js         the only bridge the UI has to the system (locked down)
  renderer/          the interface (index.html + renderer.js)
test/build.test.js   headless check of the core, no GUI
```

The whole pipeline is **pure JavaScript** — [`jimp`](https://github.com/jimp-dev/jimp)
downscales and re‑encodes each photo (and applies EXIF rotation), and
[`pdf-lib`](https://github.com/Hopding/pdf-lib) lays them out one per page. Added
PDFs take a different route: `pdf-lib` copies their pages object‑for‑object into
the output, so vector text and embedded fonts survive intact. No native binaries,
which is exactly what lets one codebase package cleanly for both Windows and Linux.

The renderer runs sandboxed (`contextIsolation` on, `nodeIntegration` off) and can
only reach the system through the small, explicit API defined in `preload.js`.

## Tech

Electron · jimp · pdf-lib · electron‑builder

## License

[MIT](LICENSE)
