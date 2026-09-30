const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const scenario of ['ready', 'failure', 'timeout']) {
      const page = await browser.newPage();
      let started = false;
      if (scenario === 'timeout') await page.addInitScript(() => {
        const original = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => original(fn, ms === 135000 ? 100 : ms, ...args);
      });
      await page.route('http://127.0.0.1:3000/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/comfyui/start') {
          started = true;
          if (scenario === 'failure') return route.fulfill({ status: 409, json: {detail: '测试启动失败'} });
          return; // Keep the start response pending even when status becomes ready.
        }
        if (url.pathname === '/api/comfyui/status') return route.fulfill({json: {
          instances: [{address: '127.0.0.1:8190', managed: true, online: started && scenario === 'ready'}],
        }});
        if (url.pathname.startsWith('/api/')) return route.fulfill({json: {entries: []}});
        const relative = url.pathname.replace(/^\/static\//, '');
        const candidates = ['ComfyUI/web', 'static'].map(root => path.join(__dirname, '..', root, relative));
        const file = candidates.find(name => fs.existsSync(name) && fs.statSync(name).isFile());
        if (file) return route.fulfill({path: file});
        return route.fulfill({status: 404, body: ''});
      });
      await page.goto('http://127.0.0.1:3000/static/comfyui.html');
      await page.getByText('本地服务未连接', {exact: true}).waitFor();
      assert.equal(await page.locator('#editor-tab').isVisible(), false);
      await page.locator('.workspace-tools summary').click();
      await page.locator('#editor-tab').click();
      assert.equal(await page.locator('.workspace-tools').getAttribute('open'), null);
      await page.locator('#start-comfyui').click();
      if (scenario === 'ready') {
        await page.getByText('本地服务在线 · 127.0.0.1:8190', {exact: true}).waitFor();
        assert.equal(await page.locator('#offline').isHidden(), true);
      } else {
        await page.getByText('本地 ComfyUI 连接未完成', {exact: true}).waitFor();
        await page.waitForFunction(() => !document.getElementById('start-comfyui').disabled);
        assert.match(await page.locator('#report').innerText(), scenario === 'timeout' ? /等待启动超时/ : /测试启动失败/);
      }
      assert.equal(await page.locator('#start-comfyui').isDisabled(), false);
      console.log('PASS:', scenario);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
