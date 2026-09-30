const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:3002/static/comfyui.html');
  await page.locator('.app-card').first().waitFor();
  assert(await page.locator('#library').isVisible());
  assert(!await page.locator('#editor').isVisible());
  await page.locator('.app-card').filter({ hasText: 'SeeThrough' }).first().click();
  const item = await page.evaluate(async () => (await (await fetch('/api/comfy-apps')).json()).apps.find(a => a.description.startsWith('SeeThrough')));
  const frame = await browser.newPage();
  await frame.goto('http://127.0.0.1:8190');
  await frame.waitForFunction(() => window.comfyAPI?.app?.app?.graph, { timeout: 60000 });
  await frame.waitForFunction(() => window.LiteGraph?.registered_node_types?.SeeThrough_GenerateLayers);
  await frame.waitForTimeout(3000);
  const workflow = item.source;
  const converted = await frame.evaluate(async source => {
    const app = window.comfyAPI.app.app;
    await app.loadGraphData(source);
    return await app.graphToPrompt();
  }, workflow);
  const response = await page.request.post(`http://127.0.0.1:3002/api/comfy-apps/${item.id}/convert`, { data: { prompt: converted.output } });
  const result = await response.json();
  console.log('conversion', response.status(), JSON.stringify(result.report || result));
  assert.equal(response.status(), 200);
  assert.equal(result.fields.filter(f => f.type === 'image').length, 1);
  await page.reload();
  await page.getByRole('heading', { name: item.title, exact: true }).waitFor();
  await page.screenshot({ path: 'logs/comfy-apps-browser.png', fullPage: true });
  assert.deepEqual(errors, []);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
