const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const providers = [
    {
        id: 'alpha', name: '图片平台', base_url: 'https://alpha.example/v1', protocol: 'openai',
        enabled: true, has_key: true, image_models: ['legacy-image', 'shared'], chat_models: ['reasoner'],
        video_models: ['shared', 'video-a'], model_names: {shared: '现有显示名'},
        model_protocols: {shared: 'openai', 'legacy-image': 'gemini'},
    },
    {
        id: 'beta', name: '视频平台', base_url: 'https://beta.example/v1', protocol: 'openai',
        enabled: true, has_key: true, image_models: [], chat_models: [], video_models: [],
    },
];

async function open(t, models) {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1220, height: 850}});
    const errors = [], dialogs = [], saves = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname !== 'models.fixture.test') return route.abort();
        if (url.pathname === '/api/providers') {
            if (request.method() === 'PUT') {
                const update = request.postDataJSON();
                saves.push(update);
                return route.fulfill({json: {providers: update.map(({api_key, ...record}) => record)}});
            }
            return route.fulfill({json: {providers}});
        }
        if (['/api/providers/fetch-models', '/api/providers/test-connection'].includes(url.pathname)) {
            const result = await models(request.postDataJSON(), url.pathname);
            return route.fulfill({json: result}).catch(() => {});
        }
        if (url.pathname === '/api/provider-icon') return route.fulfill({status: 404});
        if (url.pathname.startsWith('/api/')) return route.fulfill({json: {}});
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        return file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()
            ? route.fulfill({path: file}) : route.fulfill({status: 404});
    });
    await page.goto('http://models.fixture.test/static/api-settings.html');
    await page.waitForFunction(() => document.body.classList.contains('show-recommend-mode') && providers.length === 2);
    await page.locator('[data-provider-id="alpha"]').click();
    return {page, errors, dialogs, saves};
}

const catalogue = {
    all: ['reasoner', 'nano-banana-new', 'shared', 'constructor', 'video-a', 'video-b'],
    image_models: ['shared', 'nano-banana-new'],
    chat_models: ['reasoner', 'constructor'],
    video_models: ['shared', 'video-a', 'video-b'],
    model_names: {'nano-banana-new': '商品合成模型', constructor: '扩展文本模型'},
    message: '由测试平台返回',
    total: 6,
};

test('模型按当前上游目录选择，搜索全选和手动编辑保留类别、名称与协议', {timeout: 30000}, async t => {
    const {page, errors, dialogs, saves} = await open(t, async () => catalogue);
    const picker = page.locator('#modelPickerOverlay');
    await page.locator('#fetchModelsBtn').click();
    await picker.waitFor({state: 'visible'});
    assert.equal(await picker.locator('#pickerSourceNote').textContent(), catalogue.message);
    assert.equal(await picker.getByRole('checkbox', {name: /现有显示名/}).isChecked(), true);
    assert.equal(await picker.locator('[data-cat="image"] .cat-count').textContent(), '1/2');
    assert.equal(await picker.locator('[data-cat="video"] .cat-count').textContent(), '1/2');
    assert.equal(await picker.getByText('legacy-image').count(), 0);

    await picker.locator('[data-cat="image"]').click();
    await picker.locator('#pickerFilter').fill('商品合成');
    assert.equal(await picker.getByRole('checkbox').count(), 1);
    await picker.locator('#pickerSelectAllBtn').click();
    assert.equal(await picker.getByRole('checkbox').isChecked(), true);
    assert.equal(await picker.locator('#pickerSelectAllBtn').isDisabled(), true);
    await picker.locator('#pickerFilter').fill('');
    await picker.locator('[data-cat="chat"]').click();
    const extra = picker.getByRole('checkbox', {name: /扩展文本模型/});
    await extra.focus();
    await page.keyboard.press('Space');
    assert.equal(await extra.isChecked(), true);
    assert.equal(await extra.evaluate(element => document.activeElement === element), true);

    await picker.locator('[data-apply-model-picker]').click();
    await picker.waitFor({state: 'hidden'});
    await page.waitForFunction(() => providerSavePromise === null && document.activeElement.id === 'fetchModelsBtn');
    const saved = saves.at(-1).find(entry => entry.id === 'alpha');
    assert.deepEqual(saved.image_models, ['nano-banana-new', 'shared']);
    assert.deepEqual(saved.chat_models, ['reasoner', 'constructor']);
    assert.deepEqual(saved.video_models, ['video-a']);
    assert.equal(saved.model_names.constructor, '扩展文本模型');
    assert.deepEqual(saved.model_protocols, {'nano-banana-new': 'gemini', shared: 'openai'});
    assert.match(await page.locator('#status').textContent(), /已移除 1 个/);

    const rows = page.locator('#imageModelList .model-row');
    await rows.first().locator('input').fill('nano-banana-custom');
    await page.waitForFunction(() => provider().image_models[0] === 'nano-banana-custom' && providerSavePromise === null);
    await page.waitForFunction(() => document.getElementById('status').textContent === '模型列表已实时同步');
    const renamed = saves.at(-1).find(entry => entry.id === 'alpha');
    assert.equal(renamed.model_names['nano-banana-custom'], '商品合成模型');
    assert.equal(renamed.model_protocols['nano-banana-custom'], 'gemini');
    const removal = page.waitForResponse(response => response.url().endsWith('/api/providers')
        && response.request().method() === 'PUT');
    await rows.first().locator('button').click();
    await removal;
    await page.waitForFunction(() => providerSavePromise === null && provider().image_models.length === 1);
    await page.waitForFunction(() => document.getElementById('status').textContent === '模型列表已实时同步');
    assert.deepEqual(saves.at(-1).find(entry => entry.id === 'alpha').image_models, ['shared']);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
});

test('导入 APIMart 图片模型时沿用平台协议', {timeout: 30000}, async t => {
    const model = 'gemini-3.1-flash-lite-image-ext';
    const {page, errors, saves} = await open(t, async () => ({
        total: 1, all: [model], image_models: [model], protocol: 'apimart',
    }));
    const address = page.locator('#baseInput');
    await address.fill('https://api.apimart.ai/v1');
    await address.blur();
    assert.equal(await page.locator('#imageModelList .model-protocol-select').count(), 0);
    await page.locator('#fetchModelsBtn').click();
    const picker = page.locator('#modelPickerOverlay');
    await picker.getByRole('checkbox', {name: new RegExp(model)}).check();
    await picker.locator('[data-apply-model-picker]').click();
    await page.waitForFunction(() => providerSavePromise === null && provider().image_models.length === 1);
    const saved = saves.at(-1).find(entry => entry.id === 'alpha');
    assert.deepEqual(saved.image_models, [model]);
    assert.deepEqual(saved.model_protocols, {});
    assert.deepEqual(errors, []);
});

test('切换平台或编辑地址后，延迟返回的模型目录和协议不会覆盖当前表单', {timeout: 30000}, async t => {
    const started = Promise.withResolvers(), allow = Promise.withResolvers();
    const verification = Promise.withResolvers(), completeVerification = Promise.withResolvers();
    t.after(() => { allow.resolve(); completeVerification.resolve(); });
    const {page, errors, dialogs} = await open(t, async (request, route) => {
        if (request.provider_id === 'alpha') {
            started.resolve();
            await allow.promise;
            return {...catalogue, protocol: 'gemini'};
        }
        if (route.endsWith('test-connection')) {
            verification.resolve();
            await completeVerification.promise;
            return {...catalogue, ok: true, protocol: 'gemini'};
        }
        return {all: ['beta-video'], video_models: ['beta-video'], total: 1};
    });
    const fetch = page.locator('#fetchModelsBtn');
    await fetch.click();
    await started.promise;
    await page.locator('[data-provider-id="beta"]').click();
    assert.equal(await fetch.isEnabled(), true);
    await fetch.click();
    const picker = page.locator('#modelPickerOverlay');
    await picker.waitFor({state: 'visible'});
    assert.deepEqual(await picker.locator('.picker-model-label').allTextContents(), ['beta-video']);
    allow.resolve();
    await page.keyboard.press('Escape');
    await picker.waitFor({state: 'hidden'});
    assert.equal(await page.locator('#protocolInput').inputValue(), 'openai');
    assert.equal(await page.locator('#openPickerBtn').isEnabled(), true);

    await page.evaluate(() => { void testConnection(); });
    await verification.promise;
    await page.locator('#baseInput').fill('https://new-beta.example/v1');
    completeVerification.resolve();
    assert.equal(await page.locator('#testUrlBtn').isEnabled(), true);
    assert.equal(await page.locator('#openPickerBtn').isDisabled(), true);
    assert.equal(await page.locator('#verifyResult').isVisible(), false);
    assert.equal(await page.locator('#protocolInput').inputValue(), 'openai');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
});
