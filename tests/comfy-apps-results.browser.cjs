const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function readLayerRecords(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), '8BPS');
  let offset = 26;
  offset += 4 + buffer.readUInt32BE(offset);
  offset += 4 + buffer.readUInt32BE(offset);
  offset += 8;
  const count = Math.abs(buffer.readInt16BE(offset)); offset += 2;
  const layers = [];
  for (let i = 0; i < count; i++) {
    const top = buffer.readInt32BE(offset), left = buffer.readInt32BE(offset + 4), bottom = buffer.readInt32BE(offset + 8), right = buffer.readInt32BE(offset + 12);
    offset += 16;
    const channels = buffer.readUInt16BE(offset); offset += 2;
    const ids = [];
    for (let j = 0; j < channels; j++) { ids.push(buffer.readInt16BE(offset)); offset += 6; }
    assert(ids.includes(-1), 'PSD layer must contain alpha');
    offset += 12;
    const extraLength = buffer.readUInt32BE(offset); offset += 4;
    const end = offset + extraLength;
    offset += 4 + buffer.readUInt32BE(offset);
    offset += 4 + buffer.readUInt32BE(offset);
    const length = buffer[offset++];
    const name = buffer.toString('utf8', offset, offset + length);
    layers.push([name, left, top, right, bottom]); offset = end;
  }
  return { width: buffer.readUInt32BE(18), height: buffer.readUInt32BE(14), count, actual: layers };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const paid = [];
  page.on('request', request => { if (/\/api\/(ai\/generate|canvas-ai-tasks|runninghub)/.test(request.url())) paid.push(request.url()); });
  await page.goto((process.env.COMFY_APP_TEST_URL || 'http://127.0.0.1:3000') + '/static/comfyui.html');
  await page.locator('.app-card').filter({ hasText: 'SeeThrough' }).first().click();
  await page.locator('.app-task.succeeded').first().waitFor();
  const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
  const existing = page.getByRole('link', { name: '下载 PSD', exact: true }).first();
  if (await existing.count()) await existing.click();
  else await page.getByRole('button', { name: '下载分层 PSD' }).first().click();
  const download = await downloadPromise;
  await download.saveAs('logs/seethrough-acceptance.psd');
  const expected = await page.evaluate(async () => {
    const apps = await (await fetch('/api/comfy-apps')).json();
    const app = apps.apps.find(a => a.description.startsWith('SeeThrough'));
    const item = await (await fetch('/api/comfy-apps/' + app.id)).json();
    const task = item.tasks.find(t => t.result?.psd);
    return task.result.layers.layers.map(l => [l.name, l.left, l.top, l.right, l.bottom]);
  });
  const result = readLayerRecords(fs.readFileSync('logs/seethrough-acceptance.psd'));
  assert.equal(result.count, expected.length);
  assert.deepEqual(result.actual, expected);
  assert.equal(result.width, 1024); assert.equal(result.height, 1024);
  await page.reload();
  await page.getByRole('heading', { name: 'SeeThrough 图像分层' }).waitFor();
  await page.getByRole('link', { name: '下载 PSD', exact: true }).first().waitFor();
  await page.screenshot({ path: 'logs/comfy-apps-results.png', fullPage: true });
  assert.deepEqual(paid, []);
  console.log('PASS: PSD layer count/order/positions, dimensions, reload recovery, no paid-generation requests');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
