const { contextBridge, ipcRenderer } = require('electron');

// The shared page is remote (the host computer), so expose only the one
// desktop action it needs. Do not reuse the main app preload here: that would
// unnecessarily expose commerce or local-app controls to a shared document.
contextBridge.exposeInMainWorld('xiaomeiSharedCanvas', {
  close: () => ipcRenderer.send('canvas-share:close'),
});
