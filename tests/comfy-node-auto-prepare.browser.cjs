const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const downloadModels of [false, true]) {
      const page = await browser.newPage();
      await page.addInitScript(value => localStorage.setItem('comfy-auto-download', String(value)), downloadModels);
      const id = 'a'.repeat(32), calls = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const item = { id, title: '节点自动安装', entry_type: 'app', description: '',
        state: 'blocked', workflow_status: 'missing_nodes', fields: [], tasks: [],
        source: { nodes: [{ id: 1, type: 'LatentNoised' }] },
        report: { missing_nodes: ['LatentNoised'], reasons: ['需要安装节点：LatentNoised'] } };
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        let body = {};
        if (path.endsWith('/import') || path.endsWith('/' + id)) body = item;
        else if (path.endsWith('/catalog')) body = { entries: [] };
        else if (path.endsWith('/preparation')) body = { models: [], preflight: { status: 'warning', hardware: {},
          dependencies: { auto_installable: [{ kind: '节点包', name: 'RES4LYF' }], manual: [] } } };
        else if (path.endsWith('/prepare') || path.endsWith('/install-nodes')) calls.push(path);
        else if (path.endsWith('/status')) body = { instances: [] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto('http://127.0.0.1:3000/static/comfyui.html');
      await page.locator('#app-file').setInputFiles({ name: '节点.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(item.source)) });
      for (let attempt = 0; attempt < 100 && !calls.length; attempt++) await page.waitForTimeout(100);
      assert.deepEqual(calls, ['/api/comfy-apps/' + id + (downloadModels ? '/prepare' : '/install-nodes')], await page.locator('#app-notice').innerText());
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: imported nodes auto-install with model downloads enabled and disabled');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
