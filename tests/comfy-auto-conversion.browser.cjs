const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const id = 'c'.repeat(32), errors = [];
    let scans = 0, conversions = 0;
    page.on('pageerror', error => errors.push(error.message));
    const item = { id, title: '已准备工作流', description: '', entry_type: 'app', managed: true,
      backend: '127.0.0.1:8190', source: { nodes: [{ id: 1, type: 'SaveImage' }] },
      fields: [], tasks: [], report: { backend_available: true, missing_nodes: ['stale-node'] },
      readiness: { environment: 'ready', can_run: false }, workflow_status: 'missing_nodes' };
    await page.route('http://127.0.0.1:8190/**', route => route.fulfill({ contentType: 'text/html', body: `
      <script>addEventListener('message', e => {
        if (e.data.type === 'xiaomei-ping') e.source.postMessage({type:'xiaomei-ready',nonce:e.data.nonce,ready:true},e.origin);
        if (e.data.type === 'xiaomei-convert') e.source.postMessage({type:'xiaomei-converted',nonce:e.data.nonce,prompt:{'1':{class_type:'SaveImage',inputs:{}}}},e.origin);
      });</script>` }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let response = {};
      if (path.endsWith('/catalog')) response = { entries: [item] };
      else if (path.endsWith('/rescan')) {
        scans++;
        item.report.missing_nodes = [];
        item.workflow_status = item.api ? 'ready' : 'needs_conversion';
        response = item;
      } else if (path.endsWith('/convert')) {
        conversions++;
        assert.equal(route.request().postDataJSON().prompt['1'].class_type, 'SaveImage');
        item.api = { '1': { class_type: 'SaveImage', inputs: {} } };
        item.readiness.can_run = true;
        item.workflow_status = 'ready';
        response = item;
      } else if (path.endsWith('/' + id)) response = item;
      else if (path.endsWith('/preparation')) response = { models: [], preflight: { status: 'pass', hardware: {}, dependencies: {} } };
      else if (path.endsWith('/status')) response = { instances: [] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.waitForFunction(() => document.querySelector('#app-run')?.disabled === false).catch(async error => {
      console.error({ scans, conversions, errors, text: await page.locator('body').innerText() });
      throw error;
    });
    assert(scans >= 1);
    assert.equal(conversions, 1);
    assert.equal(await page.locator('#editor').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: refresh stale node report and convert in simplified view without opening advanced editor');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
