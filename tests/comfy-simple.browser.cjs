const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [], runs = []; let prepared = 0, uploaded = false;
  page.on('pageerror', error => errors.push(error.message));
  const id = 'a'.repeat(32), importedId = 'b'.repeat(32);
  const item = { id, title: '商品场景图', description: '商品图工作流', entry_type: 'app', state: 'ready', verified: true,
    workflow_status: 'ready', readiness: { can_run: true }, api: {}, tasks: [], source: {nodes: []},
    fields: [{ id: '1:image', name: '商品图', type: 'image' }, { id: '2:text', name: '提示词', type: 'textarea', default: '' },
      { id: '3:steps', name: '步数', type: 'number', advanced: true, default: 20, min: 1, max: 50 }] };
  const imported = { ...item, id: importedId, title: '导入测试', state: 'blocked', readiness: { can_run: false }, workflow_status: 'missing_models' };
  const prep = { models: [], preflight: { status: 'pass', hardware: {}, dependencies: { auto_installable: [], manual: [{ kind: '模型', name: 'unknown-style.safetensors', category: 'loras' }] } } };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let response = {};
    if (path.endsWith('/catalog')) response = { entries: [item, ...(prepared ? [imported] : [])] };
    else if (path.endsWith('/import')) response = imported;
    else if (path.endsWith('/preparation')) { await new Promise(resolve => setTimeout(resolve, 400)); response = prep; }
    else if (path.endsWith('/prepare')) {
      prepared++; imported.prepare_task = 'prepare-test';
      prep.task = { task_id: 'prepare-test', status: 'running', stage: '下载模型', progress: { value: 55, max: 100, detail: '下载 3%' } };
      prep.log = '正在续传文件'; response = { task_id: 'prepare-test' };
    }
    else if (path.endsWith('/upload')) { uploaded = true; response = { name: 'product.png' }; }
    else if (path.endsWith('/run')) { runs.push(route.request().postDataJSON()); response = { task_id: 'run-test' }; }
    else if (path.endsWith('/' + id)) response = item;
    else if (path.endsWith('/' + importedId)) response = imported;
    else if (path.endsWith('/models')) response = { models: [], summary: {} };
    else if (path.endsWith('/status')) response = { instances: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto('http://127.0.0.1:3000/static/comfyui.html');
  await page.locator('#app-run').waitFor();
  assert(await page.locator('#app-cards').isVisible());
  assert(!await page.locator('#editor').isVisible());
  const left = await page.locator('.app-run-panel').boundingBox(), right = await page.locator('.app-result-panel').boundingBox();
  assert(left.x + left.width <= right.x);
  await page.locator('#app-field-2\\:text').fill('白色背景，自然光，保留商品细节');
  await page.locator('#app-detail input[type=file]').setInputFiles({ name: '商品.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => !document.querySelector('#app-run').disabled);
  await page.getByText('生成参数', { exact: true }).click();
  await page.locator('#app-field-3\\:steps').fill('24');
  await page.locator('#app-run').click();
  await page.waitForTimeout(100);
  assert(uploaded); assert.equal(runs.length, 1);
  assert.equal(runs[0].fields['1:image'], 'product.png');
  assert.equal(runs[0].fields['3:steps'], 24);
  assert.equal(runs[0].fields['2:text'], '白色背景，自然光，保留商品细节');
  await page.screenshot({ path: 'logs/comfy-simple-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'logs/comfy-simple-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.locator('#app-file').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from('{"nodes":[]}') });
  await page.waitForFunction(() => document.querySelector('#app-notice').textContent.includes('自动准备'));
  assert.equal(prepared, 1);
  await page.locator('.app-prepare-live').waitFor();
  await page.locator('.app-prepare-log summary').click();
  await page.evaluate(() => {
    window.originalProgressPanel = document.querySelector('.app-prepare-live');
    window.originalResult = document.querySelector('.app-empty-result');
  });
  prep.task.progress.value = 62;
  await page.waitForFunction(() => document.querySelector('.app-prepare-live progress').value === 62);
  assert(await page.evaluate(() => window.originalProgressPanel === document.querySelector('.app-prepare-live') && window.originalProgressPanel.isConnected));
  assert(await page.evaluate(() => window.originalResult === document.querySelector('.app-empty-result')));
  assert(await page.locator('.app-prepare-log').evaluate(node => node.open));
  prep.task.status = 'failed'; prep.task.error = '连接超时';
  imported.readiness = { can_run: false, environment: 'failed', summary: '下载连接超时，请重试' };
  imported.environment_status = 'failed';
  await page.locator('.app-prepare-retry').waitFor({state:'visible'});
  assert.equal(await page.locator('.app-heading > .app-badge').innerText(), '环境未完成');
  await page.locator('#auto-download-models').uncheck();
  await page.locator('#app-file').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from('{"nodes":[]}') });
  await page.waitForFunction(() => !document.querySelector('#import-app').disabled);
  assert.equal(prepared, 1);
  await page.locator('.app-preparation-details > summary').click();
  await page.getByRole('button', { name: '自动寻找并下载缺失模型', exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: split layout, upload/prompt/parameters submission, mobile width, import automatic download toggle; mocked API, no model downloads.');
})().catch(error => { console.error(error); process.exit(1); });
