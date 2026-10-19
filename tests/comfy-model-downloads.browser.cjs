const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const screenshots = process.env.XIAOMEI_MODEL_SCREENSHOTS_DIR || path.join(os.tmpdir(), 'xiaomei-model-management');
  fs.mkdirSync(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [], actions = []; let tasks = [], submitted = 0, savedMetadata = null;
    const modelId = 'a'.repeat(32), taskId = 'b'.repeat(32);
    const metadata = { display_name: '电商产品布光 LoRA', version: '产品摄影 v2', source_url: 'https://civitai.com/models/1', trigger_words: ['studio light'] };
    const model = { id: modelId, name: 'product-lighting-v2.safetensors', category: 'loras', root_label: '主 ComfyUI 模型', relative_path: 'loras/product-lighting-v2.safetensors', size: 157286400, users: ['产品摄影工作流'], protected: true, modified_at: 1800000000, metadata };
    function resolved(version = '11') {
      return { title: '电商产品布光', source_url: 'https://civitai.com/models/1', version,
        versions: [{ id: '11', name: '产品摄影 v1' }, { id: '12', name: '产品摄影 v2' }],
        files: [
          { selection_id: version + '-fp16', name: 'product-lighting-fp16.safetensors', variant: 'SafeTensor · fp16', category: 'loras', size_bytes: 157286400, sha256: 'a'.repeat(64), eligible: true },
          { selection_id: version + '-q4', name: 'product-lighting-Q4_K_M.gguf', variant: 'GGUF · Q4_K_M', category: 'diffusion_models', size_bytes: 78643200, sha256: 'c'.repeat(64), eligible: true },
          { selection_id: 'unverified', name: 'unverified.bin', category: 'diffusion_models', size_bytes: 1024, eligible: false, disabled_reason: '来源没有提供 SHA-256，请到来源页面下载后导入' },
        ] };
    }
    await page.route('http://127.0.0.1:3000/**', async route => {
      const request = route.request(), url = new URL(request.url()), name = url.pathname;
      if (name.startsWith('/api/')) {
        let response = {};
        if (name.endsWith('/catalog')) response = { entries: [] };
        else if (name === '/api/comfyui/status') response = { instances: [] };
        else if (name === '/api/comfy-apps/models') response = { roots: [{ exists: true }], models: [model], total_size: model.size };
        else if (name.endsWith('/download-settings')) response = { concurrency: 2, has_civitai_key: true, has_hf_token: false, has_proxy: false };
        else if (name.endsWith('/models/resolve')) response = resolved(request.postDataJSON().version || '11');
        else if (name.endsWith('/models/downloads')) {
          if (request.method() === 'POST') {
            const payload = request.postDataJSON(); assert.equal(payload.files.length, 1); assert.equal(payload.files[0].selection_id, '12-q4'); assert.equal(payload.files[0].category, 'loras'); submitted++;
            tasks = [{ id: taskId, name: 'product-lighting-Q4_K_M.gguf', category: 'loras', origin: '链接下载', status: 'downloading', downloaded: 15728640, total: 78643200, progress: 20, speed: 3145728, detail: '正在下载模型', source_url: 'https://civitai.com/models/1', destination: 'D:\\小美画布\\ComfyUI\\models\\loras\\product-lighting-Q4_K_M.gguf', version: '产品摄影 v2' }];
          }
          response = { tasks, concurrency: 2 };
        } else if (/\/downloads\/[^/]+\/(pause|resume|retry|cancel)$/.test(name)) {
          const action = name.split('/').pop(); actions.push(action);
          tasks[0].status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'downloading'; tasks[0].speed = 0; tasks[0].error = ''; tasks[0].detail = action === 'pause' ? '已暂停，点击继续可断点续传' : '正在下载模型'; response = tasks[0];
        } else if (name === '/api/comfy-apps/models/metadata/' + modelId) {
          savedMetadata = request.postDataJSON(); Object.assign(metadata, savedMetadata); response = metadata;
        } else if (name.endsWith('/identify')) response = metadata;
        return route.fulfill({ json: response });
      }
      const relative = name.replace(/^\/static\//, '');
      const candidates = ['ComfyUI/web', 'static'].map(root => path.join(__dirname, '..', root, relative));
      const file = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      return file ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.locator('#models-tab').click();
    await page.locator('#model-list .model-row').waitFor();
    await page.locator('#model-add-download').click();
    await page.locator('#model-link-input').fill('https://civitai.com/models/1?modelVersionId=11');
    await page.locator('#model-link-resolve').click();
    await page.locator('.model-file-choice').first().waitFor();
    assert.equal(submitted, 0, 'Parsing must not enqueue models');
    assert.equal(await page.getByRole('checkbox', { name: '下载 unverified.bin', exact: true }).isDisabled(), true);
    await page.getByRole('combobox', { name: '电商产品布光 版本', exact: true }).selectOption('12');
    const q4 = page.locator('.model-file-choice').filter({ hasText: 'product-lighting-Q4_K_M.gguf' });
    await q4.getByRole('checkbox').check(); await q4.getByRole('combobox').selectOption('loras');
    await page.locator('#model-download-selected').click();
    await page.locator('.model-download-row').waitFor(); assert.equal(submitted, 1);
    const task = page.locator(`[data-task-id="${taskId}"]`);
    assert.match(await task.innerText(), /3.0 MB\/s/);
    await task.getByRole('button', { name: '暂停', exact: true }).click();
    await task.getByRole('button', { name: '继续', exact: true }).waitFor();
    await page.reload(); await page.locator('#models-tab').click(); await page.locator('#model-view-downloads').click();
    await task.getByRole('button', { name: '继续', exact: true }).click();
    assert.deepEqual(actions, ['pause', 'resume']);
    tasks[0] = { ...tasks[0], status: 'failed', progress: 42, detail: '下载失败，可重试', error: '网络连接中断，请检查代理后重试' };
    await page.evaluate(() => window.comfyModelDownloads.refresh());
    assert.match(await task.innerText(), /网络连接中断/);
    await task.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(actions.at(-1), 'retry');
    tasks.push({ ...tasks[0], id: 'c'.repeat(32), name: 'product-lighting-fp16.safetensors', status: 'succeeded', progress: 100, downloaded: 157286400, total: 157286400, error: '', detail: '下载完成，模型已写入对应目录', verification: 'sha256' });
    await page.evaluate(() => window.comfyModelDownloads.refresh());
    await page.locator('#model-browser-help').evaluate(el => { el.open = true; });
    await page.screenshot({ path: path.join(screenshots, 'downloads-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 480, height: 1000 });
    await page.screenshot({ path: path.join(screenshots, 'downloads-narrow.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Download view must fit narrow screens');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('#model-view-local').click();
    await page.locator('.model-metadata-panel summary').click();
    await page.getByLabel('显示名称', { exact: true }).fill('产品摄影 · 棚拍光线');
    await page.getByLabel('触发词（每行一个）', { exact: true }).fill('studio lighting\nclean background');
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await page.getByText('模型资料已保存。', { exact: true }).waitFor();
    assert.equal(savedMetadata.display_name, '产品摄影 · 棚拍光线'); assert.deepEqual(savedMetadata.trigger_words, ['studio lighting', 'clean background']);
    assert.match(await page.locator('.model-source-summary').innerText(), /产品摄影 · 棚拍光线/);
    await page.locator('#model-search').fill('clean background'); assert.equal(await page.locator('.model-row').count(), 1);
    await page.locator('.model-metadata-panel summary').click();
    await page.screenshot({ path: path.join(screenshots, 'local-models-desktop.png'), fullPage: true });
    await page.goto('http://127.0.0.1:3000/static/comfyui.html#model-download=' + encodeURIComponent('https://civitai.com/models/1'));
    await page.locator('.model-file-choice').first().waitFor();
    assert.equal(await page.locator('#model-download-panel').isVisible(), true);
    assert.equal(submitted, 1, 'Browser handoff must require file selection');
    assert.equal(page.url().includes('#'), false);
    assert.deepEqual(errors, []);

    const popup = await browser.newPage();
    await popup.addInitScript(() => {
      window.sentLinks = [];
      window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } },
        tabs: { query: async () => [{ url: 'https://civitai.com/models/1?modelVersionId=12&fileId=72&token=private-test-only' }], create: async value => window.sentLinks.push(value.url) } };
    });
    await popup.route('http://127.0.0.1:3000/**', route => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = path.join(__dirname, '../tools/chrome-model-downloader', name);
      return route.fulfill({ path: file });
    });
    await popup.goto('http://127.0.0.1:3000/popup.html');
    await popup.locator('#send').waitFor({ state: 'visible' });
    await popup.locator('#receiver').fill('https://external.example'); await popup.locator('#send').click();
    assert.equal(await popup.evaluate(() => sentLinks.length), 0);
    await popup.locator('#receiver').fill('http://127.0.0.1:3002'); await popup.locator('#send').click();
    const links = await popup.evaluate(() => sentLinks);
    assert.equal(links.length, 1); assert(links[0].startsWith('http://127.0.0.1:3002/static/comfyui.html#model-download='));
    assert(!links[0].includes('private-test-only')); assert(decodeURIComponent(links[0]).includes('fileId=72'));
    console.log('PASS: exact version/file choice, pause/reload/resume, retry, narrow layout, metadata editing, browser receiver and extension sender');
    console.log('Screenshots:', screenshots);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
