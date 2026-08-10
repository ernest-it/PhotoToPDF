'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { buildPhotoPdf } = require('./pdfBuilder');

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp'];
const DOC_EXT = ['pdf'];
// Everything we accept, as '.ext', for folder scanning.
const ACCEPTED_EXT = new Set([...IMAGE_EXT, ...DOC_EXT].map(e => '.' + e));

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 720,
    minHeight: 560,
    title: 'Photos to PDF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: file selection ---

ipcMain.handle('dialog:openImages', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add photos or PDFs',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Photos and PDFs', extensions: [...IMAGE_EXT, ...DOC_EXT] },
      { name: 'Photos', extensions: IMAGE_EXT },
      { name: 'PDF', extensions: DOC_EXT }
    ]
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a folder of photos or PDFs',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return [];
  const dir = res.filePaths[0];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return entries
    .filter(name => ACCEPTED_EXT.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => path.join(dir, name));
});

// --- IPC: build the PDF, then prompt for where to save it ---

ipcMain.handle('pdf:build', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const paths = Array.isArray(payload && payload.paths) ? payload.paths : [];
  const quality = payload && payload.quality;
  const labels = !(payload && payload.labels === false);

  if (!paths.length) return { ok: false, error: 'No files selected.' };

  let result;
  try {
    result = await buildPhotoPdf(paths, {
      quality,
      labels,
      onProgress: (p) => { win.webContents.send('pdf:progress', p); }
    });
  } catch (e) {
    if (e && e.message === 'NO_USABLE_FILES') {
      return { ok: false, error: 'None of the selected files could be read as a photo or a PDF.' };
    }
    return { ok: false, error: (e && e.message) || 'Failed to build PDF.' };
  }

  // Default filename + default folder (alongside the first image).
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const defaultDir = path.dirname(paths[0]);
  const save = await dialog.showSaveDialog(win, {
    title: 'Save PDF',
    defaultPath: path.join(defaultDir, `Photos-${stamp}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (save.canceled || !save.filePath) {
    return { ok: false, canceled: true };
  }

  try {
    fs.writeFileSync(save.filePath, Buffer.from(result.bytes));
  } catch (e) {
    return { ok: false, error: 'Could not save the PDF: ' + ((e && e.message) || 'unknown error') };
  }

  return {
    ok: true,
    savedPath: save.filePath,
    used: result.used,
    images: result.images,
    pdfs: result.pdfs,
    pages: result.pages,
    skipped: result.skipped,
    sizeBytes: result.bytes.length
  };
});

ipcMain.handle('shell:openPath', async (event, filePath) => {
  return shell.openPath(filePath);
});

ipcMain.handle('shell:showItem', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});
