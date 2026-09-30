const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  writeImageToClipboard: (bytes) => ipcRenderer.invoke('clipboard:write-image', bytes),
  showGenerationNotification: (payload) => ipcRenderer.invoke('generation:notify', payload || {}),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', String(url || '')),
  openSharedCanvas: (url) => ipcRenderer.invoke('canvas-share:open', String(url || '')),
  openProduct: (url, tabId) => ipcRenderer.invoke('commerce:open-product', url, tabId),
  openLogin: (site, tabId, returnUrl) => ipcRenderer.invoke('commerce:open-login', site, tabId, String(returnUrl || '')),
  openSeller: (site, tabId) => ipcRenderer.invoke('commerce:open-seller', site, tabId),
  activateProductTab: (tabId, options) => ipcRenderer.invoke('commerce:activate-tab', tabId, options || {}),
  setCommercePageActive: (active) => ipcRenderer.send('commerce:set-page-active', Boolean(active)),
  setCommerceOverlayActive: (active) => ipcRenderer.send('commerce:set-overlay-active', Boolean(active)),
  navigateBack: (tabId) => ipcRenderer.invoke('commerce:navigate-back', tabId || ''),
  navigateForward: (tabId) => ipcRenderer.invoke('commerce:navigate-forward', tabId || ''),
  reloadProduct: (tabId, options) => ipcRenderer.invoke('commerce:reload-product', tabId || '', options || {}),
  stopProduct: (tabId) => ipcRenderer.invoke('commerce:stop-product', tabId || ''),
  translateProductPage: (tabId) => ipcRenderer.invoke('commerce:translate-page', tabId || ''),
  closeProductTab: (tabId) => ipcRenderer.invoke('commerce:close-tab', tabId || ''),
  changeBrowserZoom: (action, tabId) => ipcRenderer.invoke('commerce:browser-zoom', action || '', tabId || ''),
  toggleBrowserFullscreen: () => ipcRenderer.invoke('commerce:toggle-fullscreen'),
  captureProduct: (options) => ipcRenderer.invoke('commerce:capture-product', options || {}),
  stopCollection: () => ipcRenderer.invoke('commerce:stop-collection'),
  capturePageContext: (options) => ipcRenderer.invoke('commerce:capture-page-context', options || {}),
  captureAssistantContext: (options) => ipcRenderer.invoke('commerce:capture-assistant-context', options || {}),
  setProductBounds: (bounds, tabId) => ipcRenderer.send('commerce:set-product-bounds', bounds, tabId),
  setProductVisible: (visible, tabId) => ipcRenderer.send('commerce:set-product-visible', Boolean(visible), tabId),
  captureOperations: () => ipcRenderer.invoke('commerce:capture-operations'),
  captureMerchantReport: (kind) => ipcRenderer.invoke('commerce:capture-merchant-report', String(kind || 'operations')),
  importMerchantReport: (kind) => ipcRenderer.invoke('commerce:import-merchant-report', String(kind || 'operations')),
  getCommerceSession: () => ipcRenderer.invoke('commerce:session-status'),
  clearCommerceSession: () => ipcRenderer.invoke('commerce:clear-session'),
  executeAgentAction: (action) => ipcRenderer.invoke('commerce:agent-action', action),
  getDesktopStatus: () => ipcRenderer.invoke('commerce:status'),
  onSurfaceState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('commerce:surface-state', listener);
    return () => ipcRenderer.removeListener('commerce:surface-state', listener);
  },
  onBrowserShortcut: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('commerce:browser-shortcut', listener);
    return () => ipcRenderer.removeListener('commerce:browser-shortcut', listener);
  },
  onNewTabRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('commerce:new-tab-request', listener);
    return () => ipcRenderer.removeListener('commerce:new-tab-request', listener);
  },
  onOperationsCaptured: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('commerce:operations-captured', listener);
    return () => ipcRenderer.removeListener('commerce:operations-captured', listener);
  },
  onCollectionProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('commerce:collection-progress', listener);
    return () => ipcRenderer.removeListener('commerce:collection-progress', listener);
  },
});
