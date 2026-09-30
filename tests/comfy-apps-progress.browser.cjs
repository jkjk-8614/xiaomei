const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    let mode = 'running';
    await page.route('**/api/comfy-apps/*', async route => {
      const response = await route.fetch();
      const data = await response.json();
      if (Array.isArray(data.tasks)) {
        data.prepare_task = null;
        const sample = data.tasks.find(t => t.status === 'succeeded');
        data.tasks = [
          { task_id: 'progress-fixture', status: mode, stage: '正在生成透明图层', created_at: Date.now() / 1000 - 65,
            progress: mode === 'running' ? {value: 7, max: 30} : null },
          {...sample, task_id: 'past-one'}, {...sample, task_id: 'past-two'}
        ];
        await route.fulfill({response, json: data});
      } else await route.fulfill({response});
    });
    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.locator('.app-card').first().click();
    await page.locator('progress').waitFor();
    assert.equal(await page.locator('progress').getAttribute('value'), String(7 / 30 * 100));
    assert.equal(await page.locator('.app-result-preview:visible').count(), 0);
    await page.getByText('已等待 / 运行', {exact:false}).waitFor();
    await page.locator('.app-history > summary').click();
    await page.locator('.app-history-item').first().waitFor();
    assert.equal(await page.locator('.app-history-item').count(), 2);
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('.app-history[open]').count(), 1, 'poll must preserve expanded history');
    mode = 'queued';
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('progress').getAttribute('value'), null);
    await page.getByText('正在等待本机执行，请勿重复提交。').waitFor();
    console.log('PASS: node progress, elapsed timer, indeterminate queue, folded history, expansion survives polling');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
