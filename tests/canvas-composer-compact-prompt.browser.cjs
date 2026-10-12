const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const longPrompt = '保留原图的木色、木纹、边框宽度、整体尺寸、摆放角度和透视，仅替换相框截面结构。\n'.repeat(18).trim();

test('long composer prompts collapse after editing without losing text or references', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'compact-prompt.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/config') return route.fulfill({ json: {
            api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', image_models: ['fixture-image'], chat_models: [] }],
            comfy_instances: []
        } });
        if (url.pathname === '/api/canvases/compact-fixture') return route.fulfill({ json: { canvas: {
            id: 'compact-fixture', title: 'Compact prompt fixture', nodes: [], connections: [], logs: [],
            settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 1 }
        } } });
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://compact-prompt.test/static/smart-canvas.html?id=compact-fixture');
    await page.waitForFunction(() => smartConfigReady && canvas);
    await page.evaluate(() => {
        window.testPaint = createPaintNodeAt({ x: 400, y: 100 });
        render();
        updateComposer();
    });
    const editor = page.locator('#promptInput');
    const preview = page.locator('#promptCompactPreview');
    const collapsed = () => page.evaluate(() => promptInput.closest('.prompt-row').classList.contains('is-prompt-collapsed'));
    const leaveEditor = () => page.locator('#apiKindToggle [data-kind="image"]').click();

    await editor.fill('保留原图。');
    await leaveEditor();
    assert.equal(await collapsed(), false, 'short prompts stay editable');

    await editor.fill(longPrompt);
    assert.equal(await collapsed(), false, 'typing does not hide the active editor');
    await leaveEditor();
    assert.equal(await collapsed(), true, 'long prompts collapse when editing ends');
    assert.equal(await editor.isVisible(), false);
    assert.equal(await preview.isVisible(), true);
    assert.ok(await preview.evaluate(el => el.getBoundingClientRect().height) < 180, 'preview uses a compact height');
    assert.equal(await page.evaluate(() => promptPlainText()), longPrompt);

    await preview.locator('[data-composer-prompt-expand]').click();
    await editor.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement === promptInput);
    const edited = longPrompt + '\n不要改变照片内容。';
    await editor.fill(edited);
    await page.evaluate(() => updateComposer());
    assert.equal(await collapsed(), false, 'composer updates preserve active edits');
    await leaveEditor();
    assert.equal(await collapsed(), true, 'expanded prompts collapse again after editing');
    assert.equal(await page.evaluate(() => testPaint.promptDraftText), edited);
    assert.equal(await page.evaluate(() => buildPromptRequest(testPaint, []).prompt), edited);

    await preview.locator('[data-composer-prompt-preview-text]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === promptInput);
    await editor.fill('');
    await page.evaluate(text => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        promptInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, longPrompt);
    assert.equal(await collapsed(), false, 'pasting keeps the active editor visible');
    await leaveEditor();
    assert.equal(await collapsed(), true, 'pasted long prompts collapse on blur');
    assert.equal(await page.evaluate(() => promptPlainText()), longPrompt);

    await preview.locator('[data-composer-prompt-expand]').click();
    await page.waitForFunction(() => document.activeElement === promptInput);
    await page.evaluate(text => {
        const ref = { url: '/assets/fixture.png', name: '参考图', kind: 'image' };
        promptInput.innerHTML = mentionTokenHtml(ref) + escapeHtml(text);
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, longPrompt);
    await leaveEditor();
    assert.equal(await collapsed(), true);
    assert.equal(await editor.locator('.mention-image-token').count(), 1);
    const request = await page.evaluate(() => {
        const result = buildPromptRequest(testPaint, []);
        return { prompt: result.prompt, refs: result.refs.map(ref => ref.url) };
    });
    assert.ok(request.prompt.includes(longPrompt), 'generation retains the complete prompt');
    assert.deepEqual(request.refs, ['/assets/fixture.png']);

    await preview.locator('[data-composer-prompt-expand]').click();
    await page.waitForFunction(() => document.activeElement === promptInput);
    await page.keyboard.press('Tab');
    assert.equal(await collapsed(), true, 'keyboard focus changes also collapse long prompts');

    await preview.locator('[data-composer-prompt-expand]').click();
    await page.waitForFunction(() => document.activeElement === promptInput);
    await page.locator('#composerTemplateBtn').click();
    assert.equal(await page.locator('#promptTemplatePanel.open').count(), 1, 'template controls remain clickable while editing');
    await page.evaluate(() => closePromptTemplatePanel());

    await page.evaluate(() => {
        promptInput.focus();
        window.runClickCount = 0;
        runGeneration = async () => { window.runClickCount++; };
    });
    await page.locator('#runBtn').click();
    assert.equal(await page.evaluate(() => window.runClickCount), 1, 'collapsing does not move the run button before its click');
    assert.equal(await collapsed(), true);
    assert.equal(await editor.locator('.mention-image-token').count(), 1);

    await page.evaluate(() => {
        selectedId = '';
        selectedIds = [];
        updateComposer();
        selectedId = testPaint.id;
        updateComposer();
    });
    assert.equal(await collapsed(), true, 'restored long drafts start collapsed');
    assert.ok(await page.evaluate(() => promptPlainText()).then(text => text.includes(longPrompt)));
    assert.deepEqual(errors, []);
});
