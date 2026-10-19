const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

async function fixture(t, { chatModels = ['fixture-chat'], generation = false } = {}) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1850, height: 1012 } });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [], imageRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname !== 'canvas-agent-send.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.png') || url.pathname.includes('media-preview')) {
            return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (url.pathname === '/api/config') return route.fulfill({ json: {
            api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', chat_models: chatModels, image_models: ['fixture-image'] }],
            comfy_instances: []
        } });
        if (url.pathname === '/api/canvases/send-fixture') return route.fulfill({ json: { canvas: {
            id: 'send-fixture', title: 'Send fixture', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 1 }
        } } });
        if (url.pathname === '/api/canvas-agent-action') {
            requests.push(request.postDataJSON());
            return route.fulfill({ json: generation
                ? { can_apply: true, prompt: '参考三张图片生成电商海报', summary: '已整理生成提示词。' }
                : { no_generation: true, can_apply: false, summary: '已分析参考图片。' } });
        }
        if (url.pathname === '/api/canvas-image-tasks' && request.method() === 'POST') {
            imageRequests.push(request.postDataJSON());
            return route.fulfill({ json: { task_id: `image-${imageRequests.length}`, status: 'queued' } });
        }
        if (url.pathname.startsWith('/api/canvas-image-tasks/')) return route.fulfill({ json: {
            status: 'succeeded', result: { images: ['/fixtures/generated.png'] }
        } });
        return route.fulfill({ json: { skills: [], categories: [], items: [], workflows: [], batches: [], runs: [] } });
    });
    await page.goto('http://canvas-agent-send.test/static/smart-canvas.html?id=send-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Send fixture');
    await page.evaluate(() => {
        const refs = [1, 2, 3].map(index => ({ url: `/fixtures/reference-${index}.png`, name: `reference-${index}.png`, kind: 'image', natural_w: 100, natural_h: 100 }));
        const source = createNode(50, 50, refs, { select: false });
        const target = createPaintNodeAt({ x: 700, y: 300 });
        connectInputNode(source.id, target.id);
        window.sendFixture = { source, target };
        render();
    });
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.querySelectorAll('#canvasAgentComposerAttachments img').length === 3);
    return { page, errors, requests, imageRequests };
}

async function assertNotSent(page, detail) {
    const status = page.locator('#canvasAgentComposerStatus');
    assert.equal(await status.isVisible(), true, 'send failure remains visible above the input');
    assert.equal(await page.locator('#canvasAgentComposerStatusText').textContent(), '未发送');
    assert.match(await page.locator('#canvasAgentComposerStatusDetail').textContent(), detail);
    assert.equal(await page.locator('#canvasAgentSend').isVisible(), true);
    assert.equal(await page.locator('#canvasAgentSend').isEnabled(), true);
    assert.equal(await status.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, 'the failure is not hidden behind another panel');
    if (process.env.XIAOMEI_AGENT_SEND_QA_DIR) {
        fs.mkdirSync(process.env.XIAOMEI_AGENT_SEND_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.XIAOMEI_AGENT_SEND_QA_DIR, 'send-feedback.png') });
    }
}

test('Agent sends three references with generation preferences open and accepts another turn', { timeout: 30000 }, async t => {
    const { page, errors, requests } = await fixture(t);
    await page.locator('#canvasAgentComposerGenerationToggle').click();
    assert.equal(await page.locator('#canvasAgentGenerationSettings').isVisible(), true);
    for (const text of ['只分析这三张参考图，不要生成图片', '只分析图3的排版，不要生成图片']) {
        await page.locator('#canvasAgentInput').fill(text);
        await page.locator('#canvasAgentSend svg').click();
        await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled && !document.getElementById('canvasAgentInput').value);
        assert.equal(requests.at(-1).message, text);
        assert.deepEqual(requests.at(-1).images, [1, 2, 3].map(index => `/fixtures/reference-${index}.png`));
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
});

test('Agent send starts generation with all three references and recovers after completion', { timeout: 30000 }, async t => {
    const { page, errors, requests, imageRequests } = await fixture(t, { generation: true });
    await page.locator('#canvasAgentComposerGenerationToggle').click();
    for (let turn = 0; turn < 2; turn++) {
        await page.locator('#canvasAgentInput').fill(`参考图1和图2的卖点，按图3的排版生成一张海报，方案${turn + 1}`);
        await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(() => {
            const target = sendFixture.target;
            return target.runFinishedAt && !target.running && !target.pending && target.images.length;
        });
        await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled && !document.getElementById('canvasAgentInput').value);
        assert.equal(imageRequests.length, turn + 1, 'each click submits exactly one generation');
        assert.deepEqual(requests.at(-1).images, [1, 2, 3].map(index => `/fixtures/reference-${index}.png`));
        assert.equal(await page.locator('#canvasAgentComposerStop').isVisible(), false);
    }
    assert.deepEqual(errors, []);
});

test('missing Agent model gives visible feedback and keeps the prompt for retry', { timeout: 30000 }, async t => {
    const { page, errors, requests } = await fixture(t, { chatModels: [] });
    const text = '只分析参考图，不要生成图片';
    await page.locator('#canvasAgentInput').fill(text);
    await page.locator('#canvasAgentSend').click();
    await assertNotSent(page, /Agent.*模型/);
    assert.equal(await page.locator('#canvasAgentInput').inputValue(), text);
    assert.equal(requests.length, 0);
    await page.evaluate(() => {
        apiProviders[0].chat_models = ['fixture-chat'];
    });
    await page.locator('#canvasAgentSend').click();
    await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled && !document.getElementById('canvasAgentInput').value);
    assert.equal(requests.length, 1, 'retry reads models that have finished loading');
    assert.deepEqual(errors, []);
});

test('invalid reference identifies its image number and can be removed before retry', { timeout: 30000 }, async t => {
    const { page, errors, requests } = await fixture(t);
    await page.evaluate(() => {
        CanvasAgentReferenceBridge.add({ url: '/fixtures/missing.png', name: 'missing.png', nodeId: 'deleted-source', sourceImageId: '/fixtures/missing.png', kind: 'image' });
        CanvasAgentReferenceBridge.sync();
    });
    const text = '只分析参考图，不要生成图片';
    await page.locator('#canvasAgentInput').fill(text);
    await page.locator('#canvasAgentSend').click();
    await assertNotSent(page, /图\s*4.*失效/);
    assert.equal(await page.locator('#canvasAgentInput').inputValue(), text);
    assert.equal(requests.length, 0);
    await page.locator('[data-agent-composer-remove-reference="3"]').click();
    await page.locator('#canvasAgentSend').click();
    await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled && !document.getElementById('canvasAgentInput').value);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].images.length, 3);
    assert.deepEqual(errors, []);
});

test('unexpected preparation error is visible and does not disable the next send', { timeout: 30000 }, async t => {
    const { page, errors, requests } = await fixture(t);
    await page.evaluate(() => {
        const original = window.canvasTaskScopeSnapshot;
        window.canvasTaskScopeSnapshot = () => { throw new Error('任务范围暂时无法读取'); };
        window.restoreSendFixture = () => { window.canvasTaskScopeSnapshot = original; };
    });
    const text = '只分析参考图，不要生成图片';
    await page.locator('#canvasAgentInput').fill(text);
    await page.locator('#canvasAgentSend').click();
    await assertNotSent(page, /任务范围暂时无法读取/);
    assert.equal(await page.locator('#canvasAgentInput').inputValue(), text);
    assert.equal(requests.length, 0);
    await page.evaluate(() => restoreSendFixture());
    await page.locator('#canvasAgentInput').press('Control+Enter');
    await page.waitForFunction(() => !document.getElementById('canvasAgentSend').disabled && !document.getElementById('canvasAgentInput').value);
    assert.equal(requests.length, 1);
    assert.deepEqual(errors, []);
});

test('sending an empty prompt edit shows its reason and preserves the editor', { timeout: 30000 }, async t => {
    const { page, errors, requests } = await fixture(t);
    await page.locator('#canvasAgentInput').fill('只分析参考图，不要生成图片');
    await page.locator('#canvasAgentSend').click();
    await page.locator('[data-agent-edit-message="0"]').click();
    await page.locator('[data-agent-message-editor="0"]').fill('');
    await page.locator('#canvasAgentSend').click();
    await assertNotSent(page, /提示词不能为空/);
    assert.equal(await page.locator('[data-agent-message-editor="0"]').isVisible(), true);
    assert.equal(requests.length, 1, 'invalid edits do not make another request');
    assert.deepEqual(errors, []);
});
