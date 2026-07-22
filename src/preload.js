'use strict';

// Bridge between the sandboxed renderer and the main process. The renderer
// never touches Node/fs directly — it calls these typed helpers.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  buildPdf: (payload) => ipcRenderer.invoke('pdf:build', payload),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  onProgress: (cb) => {
    const listener = (_event, p) => cb(p);
    ipcRenderer.on('pdf:progress', listener);
    return () => ipcRenderer.removeListener('pdf:progress', listener);
  }
});
