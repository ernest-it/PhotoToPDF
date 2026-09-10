'use strict';

// Renderer: manages the ordered list of file paths and drives the main process.
// No Node access here — everything goes through window.api (see preload.js).

const PDF_RE = /\.pdf$/i;

// What we can open is decided in the main process (src/decode) — HEIC, AVIF,
// WebP, camera RAW and the rest of the long tail. Asking for the list keeps
// the drop filter from drifting away from the file dialogs, which is how
// .webp ended up being offered but never actually readable.
let accepted = new Set();
const acceptedReady = window.api.acceptedExtensions().then(list => { accepted = new Set(list); });

function isAccepted(p) {
  const m = /\.([^.\\/]+)$/.exec(p);
  return !!m && accepted.has(m[1].toLowerCase());
}

let files = []; // ordered array of absolute paths (photos and PDFs, mixed)

const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const filelist = $('filelist');
const countEl = $('count');
const clearBtn = $('clearBtn');
const createBtn = $('createBtn');
const resultEl = $('result');
const progressEl = $('progress');

function basename(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

async function addPaths(paths) {
  await acceptedReady;
  let added = 0;
  for (const p of paths) {
    if (!p || !isAccepted(p)) continue;
    if (files.includes(p)) continue; // no duplicates
    files.push(p);
    added++;
  }
  if (added) render();
}

function removeAt(i) { files.splice(i, 1); render(); }
function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= files.length) return;
  const tmp = files[i]; files[i] = files[j]; files[j] = tmp;
  render();
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function render() {
  filelist.innerHTML = files.map((p, i) => `
    <li>
      <span class="idx">${i + 1}</span>
      <span class="tag ${PDF_RE.test(p) ? 'pdf' : 'img'}">${PDF_RE.test(p) ? 'PDF' : 'PHOTO'}</span>
      <span class="name" title="${escapeHtml(p)}">${escapeHtml(basename(p))}</span>
      <span class="ord">
        <button class="btn small" data-up="${i}" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
        <button class="btn small" data-down="${i}" ${i === files.length - 1 ? 'disabled' : ''}>&#9660;</button>
      </span>
      <button class="btn small" data-remove="${i}" title="Remove">&#10005;</button>
    </li>`).join('');

  const pdfCount = files.filter(p => PDF_RE.test(p)).length;
  const imgCount = files.length - pdfCount;
  countEl.textContent = files.length === 0
    ? 'Nothing added yet'
    : (pdfCount === 0 ? `${plural(imgCount, 'photo')} ready`
      : imgCount === 0 ? `${plural(pdfCount, 'PDF')} ready`
      : `${plural(imgCount, 'photo')} + ${plural(pdfCount, 'PDF')} ready`);
  clearBtn.style.display = files.length ? '' : 'none';
  createBtn.disabled = files.length === 0;
  resultEl.textContent = '';
  resultEl.className = 'result';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- list actions (event delegation) ---
filelist.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.remove !== undefined) removeAt(+t.dataset.remove);
  else if (t.dataset.up !== undefined) move(+t.dataset.up, -1);
  else if (t.dataset.down !== undefined) move(+t.dataset.down, +1);
});

clearBtn.addEventListener('click', () => { files = []; render(); });

// --- add buttons ---
$('addImagesBtn').addEventListener('click', async () => addPaths(await window.api.openImages()));
$('addFolderBtn').addEventListener('click', async () => addPaths(await window.api.openFolder()));

// --- drag & drop ---
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', (e) => {
  const dropped = Array.from(e.dataTransfer.files || []);
  // Electron adds an absolute .path to dropped File objects.
  addPaths(dropped.map(f => f.path).filter(Boolean));
});
// Dropping anywhere in the window shouldn't navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// --- progress ---
window.api.onProgress((p) => {
  progressEl.textContent = `Processing ${p.index} of ${p.total}: ${p.file}`;
});

// --- create ---
createBtn.addEventListener('click', async () => {
  if (!files.length) return;
  createBtn.disabled = true;
  resultEl.textContent = '';
  resultEl.className = 'result';
  progressEl.textContent = 'Working…';

  const res = await window.api.buildPdf({
    paths: files.slice(),
    quality: $('quality').value,
    labels: $('labels').checked
  });

  progressEl.textContent = '';
  createBtn.disabled = files.length === 0;

  if (res.canceled) return; // user closed the save dialog
  if (!res.ok) {
    resultEl.className = 'result err';
    resultEl.textContent = res.error || 'Something went wrong.';
    return;
  }

  const sizeKB = Math.round(res.sizeBytes / 1024);
  const sizeText = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
  const parts = [];
  if (res.images) parts.push(plural(res.images, 'photo'));
  if (res.pdfs) parts.push(plural(res.pdfs, 'PDF'));
  let msg = `PDF saved — ${parts.join(' + ')}, ${plural(res.pages, 'page')}, ${sizeText}.`;
  if (res.skipped && res.skipped.length) {
    msg += ` ${res.skipped.length} file${res.skipped.length === 1 ? '' : 's'} skipped.`;
  }
  resultEl.className = 'result ok';
  resultEl.innerHTML = `${escapeHtml(msg)}
    <div class="actions row">
      <button class="btn small" id="openPdfBtn">Open PDF</button>
      <button class="btn small" id="showPdfBtn">Show in folder</button>
    </div>
    ${res.skipped && res.skipped.length ? `<div class="skiplist">Skipped: ${escapeHtml(res.skipped.map(s => `${basename(s.file)} (${s.reason})`).join(', '))}</div>` : ''}`;
  $('openPdfBtn').addEventListener('click', () => window.api.openPath(res.savedPath));
  $('showPdfBtn').addEventListener('click', () => window.api.showItem(res.savedPath));
});

render();
