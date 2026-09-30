const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:3002/static/comfyui.html');
  const original = await page.evaluate(async () => (await (await fetch('/api/comfy-apps')).json()).apps.find(a => a.verified && a.description.startsWith('SeeThrough')));
  assert(original);
  await page.locator('#app-file').setInputFiles({ name: 'SeeThrough导入验收.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original.source)) });
  await page.getByRole('button', { name: '准备运行环境', exact: true }).waitFor();
  await page.getByRole('button', { name: '准备运行环境', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#app-run') && !document.querySelector('#app-run').disabled, null, { timeout: 240000 });
  assert.equal(await page.locator('#app-detail input[type=file]').count(), 1);
  const selected = await page.evaluate(() => sessionStorage.getItem('comfy-app-selected'));
  const response = await page.request.get('http://127.0.0.1:3002/api/comfy-apps/' + selected);
  const item = await response.json();
  assert.equal(item.state, 'ready');
  assert.equal(item.backend, '127.0.0.1:8190');
  assert(item.source.nodes.length > Object.keys(item.api).length);
  assert.equal(item.api['9'].inputs.resolution, 1024);
  assert.equal(item.api['5'].inputs.resolution_depth, 720);
  assert(!item.api['24']);
  console.log('PASS: UI file picker import → prepare → native bridge → automatic single-image form', selected);
  await page.screenshot({ path: 'logs/comfy-apps-import.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
