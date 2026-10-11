const { contextBridge, ipcRenderer } = require('electron');

// The embedded chat needs only image clipboard access, not the main window API.
contextBridge.exposeInMainWorld('xiaomeiHarnessClipboard', {
  writeImage: (bytes) => ipcRenderer.invoke('clipboard:write-image', bytes),
});
