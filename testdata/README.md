# testdata

Drop a few sample images (`.jpg` / `.png`) in this folder to exercise the core
image→PDF pipeline without the GUI:

```bash
npm test
```

The test reads every image here, builds a PDF at each quality preset, checks the
missing‑file and all‑missing behaviour, and writes `_sample-output.pdf` for you to
eyeball. Images placed here are ignored by git — use your own, they won't be
committed.
