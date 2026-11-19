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
const main = document.querySelector('main');
const grid = $('grid');
const gridTools = $('gridTools');
const dragHint = $('dragHint');
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

// Move the item at index `from` so it ends up at index `to`.
function moveTo(from, to) {
  if (from === to || to < 0 || to >= files.length) return;
  const [p] = files.splice(from, 1);
  files.splice(to, 0, p);
  render();
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- tiles ---
// One <li> per file, kept across renders (keyed by path) so a reorder just
// moves elements instead of rebuilding them, and a thumbnail is fetched once.
const tiles = new Map();  // path -> <li>
const thumbs = new Map(); // path -> thumbnail result from the main process

function tileFor(p) {
  let el = tiles.get(p);
  if (el) return el;
  el = document.createElement('li');
  el.className = 'tile';
  el.tabIndex = 0;
  el.dataset.path = p;
  el.innerHTML = `
    <div class="thumb loading"></div>
    <span class="num"></span>
    <button class="remove" title="Remove" aria-label="Remove ${escapeHtml(basename(p))}">&#10005;</button>
    <div class="name" title="${escapeHtml(p)}">${escapeHtml(basename(p))}</div>`;
  tiles.set(p, el);
  loadThumb(p, el);
  return el;
}

async function loadThumb(p, el) {
  let r = thumbs.get(p);
  if (!r) {
    try { r = await window.api.thumbnail(p); } catch (e) { r = null; }
    if (!r) r = { ok: false, kind: PDF_RE.test(p) ? 'pdf' : 'image', reason: 'could not preview' };
    thumbs.set(p, r);
  }
  const box = el.querySelector('.thumb');
  box.classList.remove('loading');
  if (!r.ok) {
    el.classList.add('unreadable');
    el.title = `This file will be skipped: ${r.reason}`;
    box.innerHTML = `<div class="bad"><b>&#9888;</b>${escapeHtml(r.reason)}</div>`;
  } else if (r.kind === 'pdf') {
    box.innerHTML = '<div class="doc">PDF</div>';
  } else {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = r.src;
    box.replaceChildren(img);
  }
  if (r.ok && r.pages > 1 && !el.querySelector('.pages')) {
    el.querySelector('.name').insertAdjacentHTML('beforebegin', `<span class="pages">${r.pages} pages</span>`);
  }
}

function render() {
  // Drop tiles for removed files, then put the rest in order. Elements that
  // are already in the right slot aren't touched.
  const present = new Set(files);
  for (const [p, el] of tiles) {
    if (!present.has(p)) { el.remove(); tiles.delete(p); }
  }
  files.forEach((p, i) => {
    const el = tileFor(p);
    el.querySelector('.num').textContent = i + 1;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });

  const pdfCount = files.filter(p => PDF_RE.test(p)).length;
  const imgCount = files.length - pdfCount;
  countEl.textContent = files.length === 0
    ? 'Nothing added yet'
    : (pdfCount === 0 ? `${plural(imgCount, 'photo')} ready`
      : imgCount === 0 ? `${plural(pdfCount, 'PDF')} ready`
      : `${plural(imgCount, 'photo')} + ${plural(pdfCount, 'PDF')} ready`);
  gridTools.style.display = files.length ? '' : 'none';
  dragHint.style.display = files.length > 1 ? '' : 'none';
  dropzone.classList.toggle('compact', files.length > 0);
  createBtn.disabled = files.length === 0;
  resultEl.textContent = '';
  resultEl.className = 'result';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const indexOfTile = (el) => files.indexOf(el.dataset.path);

// --- remove button ---
grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  const tile = btn.closest('.tile');
  const i = indexOfTile(tile);
  removeAt(i);
  const next = grid.children[Math.min(i, grid.children.length - 1)];
  if (next) next.focus();
});

// --- keyboard: arrows move focus, Alt/Ctrl+arrows move the item, Delete removes ---
grid.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target !== tile || drag) return;
  const i = indexOfTile(tile);
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeAt(i);
    const next = grid.children[Math.min(i, grid.children.length - 1)];
    if (next) next.focus();
    return;
  }
  // Up/down jump a whole row: count how many tiles share the first row.
  const top = grid.children[0].offsetTop;
  let perRow = 0;
  while (perRow < grid.children.length && grid.children[perRow].offsetTop === top) perRow++;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow, Home: -i, End: files.length - 1 - i }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  const j = Math.max(0, Math.min(files.length - 1, i + step));
  if (e.altKey || e.ctrlKey) moveTo(i, j);
  const target = (e.altKey || e.ctrlKey) ? tile : grid.children[j];
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
});

// --- click, hold and drag to reorder ---
// Pointer events rather than HTML5 drag-and-drop: the tile itself follows the
// cursor (with its picture), the others slide aside live to show where it
// will land, the list scrolls when you hold it near the edge, and Escape
// puts everything back. The window's file-drop handling is left untouched.
const DRAG_THRESHOLD = 5; // px of movement before a press becomes a drag
const EDGE = 60;          // px from the top/bottom of the list that auto-scrolls
let drag = null;

grid.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag) return;
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.remove')) return;
  e.preventDefault(); // no text selection; focus is set by hand below
  tile.focus({ preventScroll: true });
  tile.setPointerCapture(e.pointerId);
  drag = {
    tile, pointerId: e.pointerId, started: false,
    startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
    from: indexOfTile(tile)
  };
});

// On window, not the grid: moving the held tile in the DOM releases pointer
// capture, and the button may be let go outside the list.
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.started) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
    startDrag();
  }
  placeGhost();
  reposition();
});

window.addEventListener('pointerup', (e) => {
  if (drag && e.pointerId === drag.pointerId) endDrag(true);
});
window.addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.pointerId) endDrag(false);
});
window.addEventListener('keydown', (e) => {
  if (drag && drag.started && e.key === 'Escape') { e.preventDefault(); endDrag(false); }
});
window.addEventListener('blur', () => { if (drag) endDrag(false); });

function startDrag() {
  const { tile } = drag;
  const r = tile.getBoundingClientRect();
  drag.started = true;
  drag.offX = drag.startX - r.left;
  drag.offY = drag.startY - r.top;

  const ghost = tile.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.removeAttribute('tabindex');
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  // A little lift so it's obvious you've picked it up.
  ghost.animate([{ scale: 1, rotate: '0deg' }, { scale: 1.04, rotate: '2deg' }], { duration: 120, fill: 'forwards', easing: 'ease-out' });

  tile.classList.add('placeholder');
  document.body.classList.add('dragging');
  drag.raf = requestAnimationFrame(autoScroll);
}

function placeGhost() {
  drag.ghost.style.translate = `${drag.x - drag.offX}px ${drag.y - drag.offY}px`;
}

// Where would the held tile go if dropped now? Find the tile whose centre is
// nearest the cursor and slot in before or after it, depending on which half
// of it the cursor is over. Positions come from offsetLeft/Top (layout, not
// the mid-animation transforms), so tiles sliding past can't cause jitter.
function reposition() {
  const g = grid.getBoundingClientRect();
  const x = drag.x - g.left;
  const y = drag.y - g.top;
  let best = null, bestDist = Infinity;
  for (const el of grid.children) {
    const cx = el.offsetLeft + el.offsetWidth / 2;
    const cy = el.offsetTop + el.offsetHeight / 2;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestDist) { bestDist = d; best = el; }
  }
  if (!best || best === drag.tile) return;
  const after = x > best.offsetLeft + best.offsetWidth / 2;
  const ref = after ? best.nextElementSibling : best;
  if (ref === drag.tile || (ref === null && grid.lastElementChild === drag.tile)) return;
  if (ref && ref.previousElementSibling === drag.tile) return;

  // FLIP: note where everything is, move the placeholder, then animate each
  // tile from its old spot to its new one.
  const before = new Map();
  for (const el of grid.children) before.set(el, [el.offsetLeft, el.offsetTop]);
  grid.insertBefore(drag.tile, ref);
  for (const el of grid.children) {
    if (el === drag.tile) continue;
    const [ox, oy] = before.get(el);
    const dx = ox - el.offsetLeft, dy = oy - el.offsetTop;
    if (dx || dy) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }
  renumber();
}

// Keep the page numbers right while dragging, so you can see "this goes 3rd".
function renumber() {
  Array.from(grid.children).forEach((el, i) => { el.querySelector('.num').textContent = i + 1; });
  if (drag && drag.ghost) drag.ghost.querySelector('.num').textContent = indexOfSlot(drag.tile) + 1;
}

function indexOfSlot(el) {
  return Array.prototype.indexOf.call(grid.children, el);
}

function autoScroll() {
  if (!drag || !drag.started) return;
  const m = main.getBoundingClientRect();
  let dy = 0;
  if (drag.y < m.top + EDGE) dy = -Math.ceil((m.top + EDGE - drag.y) / 4);
  else if (drag.y > m.bottom - EDGE) dy = Math.ceil((drag.y - (m.bottom - EDGE)) / 4);
  if (dy) {
    const was = main.scrollTop;
    main.scrollTop += Math.max(-20, Math.min(20, dy));
    if (main.scrollTop !== was) reposition();
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag(commit) {
  const d = drag;
  drag = null;
  if (d.tile.hasPointerCapture(d.pointerId)) d.tile.releasePointerCapture(d.pointerId);
  if (!d.started) return; // just a click: the tile is focused, nothing moved

  cancelAnimationFrame(d.raf);
  document.body.classList.remove('dragging');

  // Cancelled: `files` still holds the old order, and render() restores it.
  if (commit) files = Array.from(grid.children, el => el.dataset.path);
  render();

  // Glide the ghost into the slot, then swap it for the real tile.
  const r = d.tile.getBoundingClientRect();
  const anim = d.ghost.animate(
    [{ translate: d.ghost.style.translate, scale: 1.04, rotate: '2deg' }, { translate: `${r.left}px ${r.top}px`, scale: 1, rotate: '0deg' }],
    { duration: 140, easing: 'ease-out', fill: 'forwards' });
  const finish = () => { d.ghost.remove(); d.tile.classList.remove('placeholder'); };
  anim.onfinish = finish;
  anim.oncancel = finish;
  d.tile.focus({ preventScroll: true });
}

// --- preview size ---
const tileSize = $('tileSize');
function applyTileSize() { grid.style.setProperty('--tile', `${tileSize.value}px`); }
try { const saved = localStorage.getItem('tileSize'); if (saved) tileSize.value = saved; } catch (e) { /* storage unavailable */ }
applyTileSize();
tileSize.addEventListener('input', () => {
  applyTileSize();
  try { localStorage.setItem('tileSize', tileSize.value); } catch (e) { /* storage unavailable */ }
});

clearBtn.addEventListener('click', () => { files = []; render(); });


// --- add buttons ---
$('addImagesBtn').addEventListener('click', async () => addPaths(await window.api.openImages()));
$('addFolderBtn').addEventListener('click', async () => addPaths(await window.api.openFolder()));

// --- drag & drop ---
// Files can be dropped anywhere in the main area — once photos are in, the
// drop strip is small and the grid is the obvious place to aim for. Enter and
// leave fire for every child element, hence the counter.
let dragDepth = 0;
main.addEventListener('dragenter', (e) => {
  e.preventDefault(); dragDepth++; dropzone.classList.add('drag');
});
main.addEventListener('dragover', (e) => { e.preventDefault(); });
main.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.remove('drag'); }
});
main.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('drag');
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
