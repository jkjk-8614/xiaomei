const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const providers = [
    { id: 'antigravity', name: 'Antigravity CLI', enabled: true, image_models: ['gemini-image'], chat_models: ['gemini-chat'] },
    { id: 'relay', name: '6789API', enabled: true, image_models: ['gpt-image-2', 'nano-banana-2'], chat_models: ['gpt-chat'] },
    { id: 'codex', name: 'GPT CLI', enabled: true, image_models: ['gpt-image-cli'], chat_models: ['gpt-chat'] },
    { id: 'disabled', name: 'Disabled', enabled: false, image_models: ['hidden-image'], chat_models: [] }
];

test('Agent image model picker follows the canvas platform and model choices', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'agent-model-picker.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return route.fulfill({ path: file });
        }
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: providers, comfy_instances: [] } });
        if (url.pathname === '/api/canvases/model-picker') return route.fulfill({ json: { canvas: {
            id: 'model-picker', title: 'Model picker', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'antigravity', model: 'gemini-image' }
        } } });
        return route.fulfill({ json: { providers: [], skills: [], categories: [], workflows: [], items: [] } });
    });

    await page.goto('http://agent-model-picker.test/static/smart-canvas.html?id=model-picker');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Model picker');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#canvasAgentGenerationModelTrigger').click();
    const menu = page.locator('#canvasAgentGenerationModelMenu');
    assert.equal(await menu.locator('.image-model-picker').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 2);
    assert.deepEqual(await menu.locator('[data-agent-generation-provider] span').allTextContents(),
        ['Antigravity CLI', '6789API', 'GPT CLI']);
    assert.deepEqual(await menu.locator('[data-agent-generation-model] span').allTextContents(), ['gemini-image']);

    await menu.locator('[data-agent-generation-provider="relay"]').click();
    assert.deepEqual(await menu.locator('[data-agent-generation-model] span').allTextContents(),
        ['gpt-image-2', 'nano-banana-2']);
    await menu.locator('[data-agent-generation-model]').last().click();
    assert.equal(await page.locator('#canvasAgentGenerationModelLabel').textContent(), 'nano-banana-2');
    assert.deepEqual(await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('xiaomei_canvas_agent_generation_v1'));
        return [saved.auto, saved.imageProvider, saved.imageModel];
    }), [false, 'relay', 'nano-banana-2']);

    await page.evaluate(() => {
        apiProviders = apiProviders.filter(provider => provider.id !== 'relay');
        window.dispatchEvent(new CustomEvent('smart-canvas-config-ready'));
    });
    await page.locator('#canvasAgentGenerationModelTrigger').click();
    assert.deepEqual(await menu.locator('[data-agent-generation-provider] span').allTextContents(),
        ['Antigravity CLI', 'GPT CLI']);
    assert.equal(await page.locator('#canvasAgentGenerationModelLabel').textContent(), 'gemini-image');
    assert.deepEqual(await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('xiaomei_canvas_agent_generation_v1'));
        return [saved.imageProvider, saved.imageModel];
    }), ['antigravity', 'gemini-image']);

    await page.evaluate(() => {
        apiProviders = [];
        window.dispatchEvent(new CustomEvent('smart-canvas-config-ready'));
    });
    assert.equal(await page.locator('#canvasAgentGenerationModelTrigger').isDisabled(), true);
    assert.match(await menu.textContent(), /请先在 API 设置中配置图片模型/);
    assert.deepEqual(errors, []);
});
