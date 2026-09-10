# testdata

`npm test` exercises the core photo/PDF→PDF pipeline and every image decoder
without the GUI:

```bash
npm test
```

`test/run.js` runs each `*.test.js` in its own process: one suite per format
family (`heif`, `webp`, `rawPreview`, `tiffPsd`, `simple`) plus `build.test.js`,
the end-to-end check, which runs last.

## What lives here

- **`samples/`** — small committed fixtures, one or more per supported format,
  with the reference PNGs (`*-src*.png`) the decoders are pixel-compared against.
  `build.test.js` builds a PDF from every file in here, so a format that stops
  working fails the suite by name. See `samples/README.md` for provenance.
  - Files with **`-bad-`** in the name are deliberately broken (truncated
    previews, random bytes wearing a camera extension) and files with
    **`-unsupported-`** are valid but in a variant we can't read (CMYK PSD).
    Both are asserted to be *skipped with a reason*, never to render and never
    to crash.
- **`_fixtures/`** — generated at run time (two images, a two-page "estimate"
  PDF, a deliberately corrupt PDF, and small images for the pooled-buffer
  regression check), so the suite runs on a clean checkout. Gitignored.
- Any real images (`.jpg` / `.png`) you drop in this folder are picked up as
  extra input to the image-only builds.

`build.test.js` builds at each quality preset, checks that added PDF pages land
in the right order at their original size and stay as vector text, checks the
skipped-file and nothing-usable behaviour, and writes `_sample-output.pdf` for
you to eyeball. Fixtures and sample output are ignored by git.
