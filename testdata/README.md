# testdata

`npm test` exercises the core photo/PDF→PDF pipeline without the GUI:

```bash
npm test
```

It generates its own fixtures in `_fixtures/` (two images, a two‑page "estimate"
PDF, and a deliberately corrupt PDF), so it runs on a clean checkout. Any real
images (`.jpg` / `.png`) you drop in this folder are picked up as extra input.

The test builds at each quality preset, checks that added PDF pages land in the
right order at their original size and stay as vector text, checks the
skipped‑file and nothing‑usable behaviour, and writes `_sample-output.pdf` for you
to eyeball. Fixtures and sample output are ignored by git.
