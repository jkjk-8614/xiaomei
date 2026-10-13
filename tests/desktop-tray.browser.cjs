const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('desktop sidebar invokes tray bridge and reports errors; browser hides the entry', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'tray.test') return route.abort();
    if (url.pathname.startsWith('/static/')) {
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (file.endsWith('.html') && url.pathname !== '/static/index.html') return route.fulfill({ contentType: 'text/html', body: '<p>Test workspace</p>' });
      return file.startsWith(root + path.sep) && fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ json: { providers: [], items: [], updates: [], version: '1.0' } });
  });
  const desktop = await context.newPage();
  const errors = [];
  desktop.on('pageerror', error => errors.push(error.message));
  await desktop.addInitScript(() => {
    window.trayCalls = 0;
    window.trayFailure = false;
    window.electronAPI = { hideToTray: async () => {
      window.trayCalls++;
      return window.trayFailure ? { ok: false, message: '托盘图标未能创建，请退出并重新启动小美画布。' } : { ok: true };
    } };
  });
  await desktop.goto('http://tray.test/static/index.html?page=canvas');
  await desktop.locator('#sidebarLogoToggle').click();
  if (await desktop.locator('#settings-fold-toggle').getAttribute('aria-expanded') === 'false') await desktop.locator('#settings-fold-toggle').click();
  const entry = desktop.locator('#desktop-hide-to-tray');
  await entry.waitFor({ state: 'visible' });
  await entry.click();
  assert.equal(await desktop.evaluate(() => window.trayCalls), 1);
  assert.equal(await entry.isEnabled(), true);
  await desktop.evaluate(() => { window.trayFailure = true; });
  let message = '';
  desktop.once('dialog', async dialog => { message = dialog.message(); await dialog.dismiss(); });
  await entry.click();
  assert.match(message, /托盘图标未能创建/);
  assert.equal(await entry.isEnabled(), true);
  await desktop.waitForTimeout(350);
  const settingsBounds = await desktop.locator('#settings-fold-group').boundingBox();
  const appearanceBounds = await desktop.locator('[onclick="openAppearanceSettings()"]').boundingBox();
  assert.ok(appearanceBounds.y + appearanceBounds.height <= settingsBounds.y + settingsBounds.height + 1, 'appearance settings stays inside expanded group');
  await desktop.screenshot({ path: path.join(os.tmpdir(), 'xiaomei-tray-sidebar.png') });
  assert.deepEqual(errors, []);
  const web = await context.newPage();
  await web.goto('http://tray.test/static/index.html?page=canvas');
  assert.equal(await web.locator('#desktop-hide-to-tray').isVisible(), false);
});
