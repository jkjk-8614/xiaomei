const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-1688-live-')));
const home = 'https://www.1688.com/';
const login = `https://login.1688.com/member/signin.htm?from=sm&redirectType=topRedirect&Done=${encodeURIComponent(home)}`;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const partition = `live-1688-${Date.now()}`;
  const commerceSession = session.fromPartition(partition);
  const window = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(view);
  const events = [];
  const record = (name, payload = {}) => {
    events.push({ name, ...payload, at: Date.now() });
    console.log(JSON.stringify({ name, ...payload }));
  };
  view.webContents.setUserAgent(view.webContents.getUserAgent().replace(/\s+Electron\/[^\s]+/i, '').replace(/\s{2,}/g, ' '));
  view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => record('did-start-navigation', { url, isInPlace, isMainFrame }));
  view.webContents.on('will-navigate', (event, url) => record('will-navigate', { url, eventUrl: event.url, eventMain: event.isMainFrame }));
  view.webContents.on('will-frame-navigate', (event) => record('will-frame-navigate', { url: event.url, isMainFrame: event.isMainFrame, eventUrl: event.url }));
  view.webContents.on('will-redirect', (event, url, isInPlace, isMainFrame) => record('will-redirect', { url, isInPlace, isMainFrame, eventUrl: event.url, eventMain: event.isMainFrame }));
  view.webContents.on('did-navigate', (_event, url) => record('did-navigate', { url }));
  view.webContents.on('dom-ready', () => record('dom-ready', { url: view.webContents.getURL() }));
  view.webContents.on('did-finish-load', () => record('did-finish-load', { url: view.webContents.getURL(), title: view.webContents.getTitle() }));
  view.webContents.on('did-stop-loading', () => record('did-stop-loading', { url: view.webContents.getURL() }));
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => record('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }));
  const load = async (label, url) => {
    record('load-start', { label, url });
    try {
      await view.webContents.loadURL(url);
      record('load-resolved', { label, url: view.webContents.getURL(), title: view.webContents.getTitle() });
    } catch (error) {
      record('load-rejected', { label, url: view.webContents.getURL(), message: String(error?.message || error) });
    }
    await wait(2500);
  };
  await load('home', home);
  await load('login', login);
  console.log(JSON.stringify({ finalUrl: view.webContents.getURL(), title: view.webContents.getTitle(), events }, null, 2));
  window.destroy();
  await commerceSession.clearStorageData();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
