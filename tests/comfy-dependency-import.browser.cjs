const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const id = 'a'.repeat(32), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const item = { id, title: '缺失依赖测试', description: '', state: 'blocked', entry_type: 'app',
      workflow_status: 'missing_models', readiness: { can_run: false }, source: { nodes: [] },
      fields: [], tasks: [], report: { reasons: ['需要导入模型'] } };
    const name = 'zimage-cos-NSFW-lora.safetensors';
    let imported = false;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/models/import')) {
        imported = true;
        assert.equal(route.request().postData()?.includes('name="replace"'), true);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: '已替换并完成复查', item: { ...item, report: { reasons: ['需要安装节点：LibLibVisionV2Seed'], missing_models: [] }, workflow_status: 'missing_nodes' } }) });
      }
      let response = {};
      if (path.endsWith('/catalog')) response = { entries: [item] };
      else if (path.endsWith('/' + id)) response = imported ? { ...item, report: { reasons: ['需要安装节点：LibLibVisionV2Seed'], missing_models: [] }, workflow_status: 'missing_nodes' } : item;
      else if (path.endsWith('/preparation')) {
        response = {
          models: [],
          preflight: {
            status: 'warning', hardware: {},
            dependencies: { manual: imported
              ? [{ kind: '节点', name: 'LibLibVisionV2Seed', detail: '需要节点来源' }]
              : [{ kind: '模型', name, category: 'loras', detail: '需要导入原文件' }] },
          },
        };
      }
      else if (path.endsWith('/status')) response = { instances: [] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.locator('.app-preparation-details > summary').click();
    const button = page.getByRole('button', { name: '导入此模型', exact: true });
    await button.waitFor();
    const row = page.locator('.app-dependency-row').filter({ has: button });
    assert.equal(await row.locator(':scope > strong').innerText(), 'LoRA · 风格 / 效果');
    assert.equal(await row.locator('.app-dependency-name').innerText(), name);
    assert(await page.locator('.app-preflight > :first-child').evaluate(n => n.classList.contains('app-dependency-section')));
    await page.screenshot({ path: 'logs/comfy-model-role-cards.png', fullPage: true });
    const width = await row.locator(':scope > span').evaluate(n => n.getBoundingClientRect().width);
    assert(width > 150, `模型名称被压缩：${width}px`);
    const chooser = page.waitForEvent('filechooser');
    await button.click();
    await (await chooser).setFiles({ name: 'wrong.safetensors', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
    await page.waitForFunction(() => document.querySelector('#app-notice')?.textContent.includes('已替换并完成复查'));
    assert.equal(await page.getByRole('button', { name: '导入此模型', exact: true }).count(), 0);
    assert.equal(await page.locator('body > input[type=file]:not([id])').count(), 0);
    await page.screenshot({ path: 'logs/comfy-dependency-import.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS dependency layout, file picker, renamed model auto replacement');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
