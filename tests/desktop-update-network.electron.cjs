const { app, session, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { DesktopUpdater } = require('../desktop/updater.cjs');
const { createDesktopUpdateFetch } = require('../desktop/update-network.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-update-electron-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Update network test timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const bytes = Buffer.from('proxied installer fixture');
  const manifest = {
    version: '1.0.6', platform: process.platform, arch: process.arch,
    artifact: process.platform === 'darwin' ? 'zip' : 'nsis',
    fileName: process.platform === 'darwin' ? 'app.zip' : 'app.exe',
    installerUrl: 'http://updates.invalid/app', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const hits = [];
  const proxy = http.createServer((request, response) => {
    hits.push(request.url);
    assert.equal(request.headers.cookie, undefined);
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/hang') return;
    if (url.pathname === '/unsafe') { response.writeHead(302, { location: 'http://unsafe.invalid/manifest' }); response.end(); }
    else if (url.pathname === '/redirect') { response.writeHead(302, { location: 'http://updates.invalid/manifest' }); response.end(); }
    else if (url.pathname === '/manifest') response.end(JSON.stringify(manifest));
    else response.end(bytes);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const updateSession = session.fromPartition('xiaomei-updater');
  await updateSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxy.address().port}` });
  await updateSession.cookies.set({ url: 'http://updates.invalid', name: 'private-test-cookie', value: 'not-for-updates' });
  const configPath = path.join(temporary, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'manifest', manifestUrl: 'http://updates.invalid/redirect' }));
  const common = { app: { isPackaged: true, getVersion: () => '1.0.5' }, configPath, runtimeRoot: temporary, allowInsecure: true };
  const baseline = await new DesktopUpdater(common).check();
  assert.equal(baseline.status, 'unavailable', 'Node transport cannot reach the proxy-only host');
  const updater = new DesktopUpdater({ ...common, fetchImpl: createDesktopUpdateFetch(session, { allowInsecure: true }) });
  const result = await updater.check();
  assert.equal(result.status, 'available', JSON.stringify(result));
  assert.equal((await updater.download(result)).sha256, manifest.sha256);
  assert.equal(hits.length, 3, 'manifest redirect, manifest, artifact all pass through the proxy');
  console.log('PASS: Chromium proxy, redirects, omitted cookies, check and verified download; Node baseline fails');

  const strictSession = session.fromPartition('xiaomei-updater-strict-test');
  await strictSession.setProxy({ mode: 'direct' });
  const strictFetch = createDesktopUpdateFetch({ fromPartition: () => strictSession });
  await assert.rejects(strictFetch(`http://127.0.0.1:${proxy.address().port}/unsafe`, {}));
  assert.ok(!hits.some(url => url.includes('unsafe.invalid')), 'unsafe redirect never reaches its target');
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'manifest', manifestUrl: 'http://updates.invalid/hang' }));
  const started = Date.now();
  const stalled = await updater.check();
  assert.equal(stalled.code, 'timeout');
  assert.ok(Date.now() - started < 8500);
  console.log('PASS: Chromium abort stops a stalled response; unsafe redirects blocked');

  if (process.argv.includes('--live')) {
    const liveSession = { fromPartition: () => session.fromPartition('xiaomei-updater-live-test') };
    const live = new DesktopUpdater({ app: common.app, fetchImpl: createDesktopUpdateFetch(liveSession) });
    const started = Date.now();
    const result = await live.check();
    console.log(JSON.stringify({ liveCheck: result.status, version: result.version, elapsedMs: Date.now() - started, code: result.code }));
    assert.equal(result.status, 'available');
  }

  let retries = 0;
  let pages = 0;
  ipcMain.handle('app:update-retry', () => { retries++; return { ok: true }; });
  ipcMain.handle('app:update-open-download', () => { pages++; return { ok: true }; });
  const window = new BrowserWindow({ show: false, width: 500, height: 390, useContentSize: true, minWidth: 500, maxWidth: 500, minHeight: 390, maxHeight: 390, webPreferences: { preload: path.resolve(__dirname, '../desktop/update-preload.cjs'), sandbox: true, contextIsolation: true } });
  await window.loadFile(path.resolve(__dirname, '../desktop/update-window.html'), { query: { version: '1.06' } });
  window.webContents.send('app:update-state', { state: 'error', message: '下载更新长时间没有收到数据，请检查网络或系统代理后重试。' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('retry').hidden"), false);
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true, 'failure actions fit the update window');
  await window.webContents.executeJavaScript("document.getElementById('retry').click(); document.getElementById('manual').click();");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(retries, 1); assert.equal(pages, 1);
  window.webContents.send('app:update-state', { state: 'error', message: '连接更新服务器失败，请检查系统代理后重试。'.repeat(12) });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true, 'long failure messages keep recovery buttons visible');
  window.webContents.send('app:update-state', { state: 'downloading' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('retry').hidden && !document.getElementById('message').classList.contains('error') && document.getElementById('cancel').textContent === '取消'"), true);
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true, 'actions fit the update window');
  console.log('PASS: real sandboxed preload, retry/download buttons and retry state reset');
  window.destroy();
  proxy.closeAllConnections(); proxy.close();
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
