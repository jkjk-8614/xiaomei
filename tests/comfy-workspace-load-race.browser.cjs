const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const workflow = { nodes: [{ id: 7, type: 'TargetWorkflowNode', pos: [0, 0], size: [120, 80] }] };
    const item = {
      id: 'd'.repeat(32), title: '目标工作流', description: '高级编辑加载竞态测试',
      entry_type: 'app', source: workflow, fields: [], tasks: [], backend: '127.0.0.1:8190',
      state: 'ready', verified: true, environment_status: 'running',
      readiness: { environment: 'running', workflow: 'ready', can_run: true },
      workflow_status: 'ready', report: { missing_models: [] },
    };

    await page.route('http://127.0.0.1:8190/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>mock ComfyUI</body><script>
        window.xiaomeiLoadAttempts = 0;
        window.xiaomeiLoadedWorkflow = null;
        addEventListener('message', event => {
          if (event.data?.type !== 'xiaomei-load-workflow') return;
          window.xiaomeiLoadAttempts += 1;
          if (window.xiaomeiLoadAttempts === 1) {
            // Match the existing managed bridge response, which predates the
            // explicit retryable flag and used only the Chinese error text.
            event.source.postMessage({
              type: 'xiaomei-workflow-loaded',
              nonce: event.data.nonce,
              error: 'ComfyUI 仍在初始化，请稍后重试',
            }, event.origin);
            return;
          }
          window.xiaomeiLoadedWorkflow = event.data.workflow;
          event.source.postMessage({
            type: 'xiaomei-workflow-loaded',
            nonce: event.data.nonce,
            ok: true,
          }, event.origin);
        });
      </script></html>`,
    }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let response = {};
      if (path.endsWith('/api/comfyui/status')) response = { instances: [{ address: '127.0.0.1:8190', online: true }] };
      else if (path.endsWith('/api/comfy-apps/catalog')) response = { entries: [item] };
      else if (path.endsWith('/preparation')) response = { models: [], preflight: { dependencies: { auto_installable: [] } } };
      else if (path.endsWith('/' + item.id)) response = item;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    });

    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.locator('.app-card-actions button').getByText('打开', { exact: true }).click();
    await page.locator('#app-detail .app-heading').waitFor();
    await page.getByRole('button', { name: '打开高级编辑', exact: true }).click();
    await page.frameLocator('#editor').locator('body').waitFor();
    const frame = page.frames().find(candidate => candidate.url().startsWith('http://127.0.0.1:8190/'));
    await frame.waitForFunction(() => window.xiaomeiLoadedWorkflow?.nodes?.length === 1, null, { timeout: 10000 });
    const result = await frame.evaluate(() => ({ attempts: window.xiaomeiLoadAttempts, workflow: window.xiaomeiLoadedWorkflow }));
    assert.equal(result.attempts >= 2, true);
    assert.deepEqual(result.workflow, workflow);
    assert.equal(await page.locator('#report').isHidden(), true);
    assert.match(await page.locator('#status').innerText(), /已加载/);
    console.log('PASS: transient ComfyUI bridge load errors retry and load the selected workflow');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
