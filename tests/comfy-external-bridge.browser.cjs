const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const scenario of ['missing', 'slow', 'busy', 'download-failed']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let installed = false, downloads = 0;
      const workflow = { nodes: [{ id: 7, type: 'TargetNode', pos: [0, 0] }] };
      await page.addInitScript(() => {
        const nativeTimeout = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 500 ? 10 : ms, ...args);
      });
      await page.route('http://127.0.0.1:8188/**', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><body>external ComfyUI<script>
          let attempts = 0;
          window.loadedWorkflow = null;
          addEventListener('message', event => {
            if (event.data?.type !== 'xiaomei-load-workflow') return;
            attempts += 1;
            if (${JSON.stringify(['missing', 'download-failed'].includes(scenario) && !installed)}) return;
            const pending = ${JSON.stringify(scenario === 'busy')} || (${JSON.stringify(scenario === 'slow')} && attempts < 36);
            if (pending) {
              event.source.postMessage({type:'xiaomei-workflow-loaded', nonce:event.data.nonce,
                error:'ComfyUI 仍在初始化，请稍后重试', retryable:true}, event.origin);
            } else {
              window.loadedWorkflow = event.data.workflow;
              event.source.postMessage({type:'xiaomei-workflow-loaded', nonce:event.data.nonce, ok:true}, event.origin);
            }
          });
        </script>`,
      }));
      await page.route('http://127.0.0.1:3000/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/comfyui/status') return route.fulfill({ json: {
          instances: [{ address: '127.0.0.1:8188', online: true }],
        } });
        if (url.pathname === '/api/comfy-apps/editor-bridge.zip') {
          downloads += 1;
          if (scenario === 'download-failed') return route.fulfill({ status: 503, json: { detail: '桥接插件文件不完整，请重新安装小美画布' } });
          return route.fulfill({ contentType: 'application/zip', body: Buffer.from('test archive'),
            headers: { 'Content-Disposition': 'attachment; filename="Xiaomei-ComfyUI-Bridge.zip"' } });
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { entries: [] } });
        const relative = url.pathname.replace(/^\/static\//, '');
        const candidates = ['ComfyUI/web', 'static'].map(root => path.join(__dirname, '..', root, relative));
        const file = candidates.find(name => fs.existsSync(name) && fs.statSync(name).isFile());
        return file ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://127.0.0.1:3000/static/comfyui.html');
      await page.getByText('本地服务在线 · 127.0.0.1:8188', { exact: true }).waitFor();
      await page.evaluate(source => window.comfyWorkspace.openWorkflow({
        id:'a'.repeat(32), entry_type:'app', title:'测试工作流', backend:'127.0.0.1:8188', source,
        report:{missing_models:[]},
      }), workflow);
      if (scenario === 'slow') {
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('已加载'));
        assert.equal(await page.locator('#report').isHidden(), true);
      } else if (scenario === 'busy') {
        await page.getByRole('heading', { name: '高级编辑器尚未就绪' }).waitFor();
        assert.equal(await page.getByRole('button', { name: '下载桥接插件' }).count(), 0);
        await page.getByRole('button', { name: '重新加载编辑器' }).waitFor();
      } else {
        await page.getByRole('heading', { name: '高级编辑器桥接未响应' }).waitFor();
        assert.match(await page.locator('#report').innerText(), /custom_nodes/);
        if (scenario === 'missing') {
          const output = path.join(__dirname, '..', 'logs', 'comfy-external-bridge.png');
          fs.mkdirSync(path.dirname(output), {recursive:true});
          await page.screenshot({path:output});
        }
        if (scenario === 'download-failed') {
          await page.getByRole('button', { name: '下载桥接插件' }).click();
          await page.getByRole('heading', { name: '操作未完成' }).waitFor();
          assert.match(await page.locator('#report').innerText(), /文件不完整/);
        } else {
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: '下载桥接插件' }).click();
          assert.equal((await download).suggestedFilename(), 'Xiaomei-ComfyUI-Bridge.zip');
          installed = true;
          await page.getByRole('button', { name: '安装后重试' }).click();
          await page.waitForFunction(() => document.getElementById('status').textContent.includes('已加载'));
          const frame = page.frames().find(f => f.url().startsWith('http://127.0.0.1:8188/'));
          assert.deepEqual(await frame.evaluate(() => window.loadedWorkflow), workflow);
        }
        assert.equal(downloads, 1);
      }
      assert.deepEqual(errors, []);
      await page.close();
      console.log('PASS external bridge:', scenario);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
