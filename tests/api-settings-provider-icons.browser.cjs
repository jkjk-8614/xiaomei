const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

// 1x1 透明 PNG：只要能被浏览器解码成图片即可。
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

const providers = [
    {id: 'with-icon', name: '有图标平台', base_url: 'https://icon.example/v1', protocol: 'openai',
     enabled: true, primary: true, image_models: ['image-a'], chat_models: [], video_models: []},
    {id: 'no-icon', name: '取不到图标平台', base_url: 'https://missing.example/v1', protocol: 'openai',
     enabled: true, image_models: [], chat_models: [], video_models: []},
    {id: 'no-url', name: '未配置地址', base_url: '', protocol: 'openai',
     enabled: true, image_models: [], chat_models: [], video_models: []},
];

async function open(t, migrateOnSave = false, records = providers) {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const state = {iconRequests: [], errors: [], saves:[], failNextSave:false};
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/providers') {
            if(request.method() === 'PUT'){
                state.saves.push(request.postDataJSON());
                if(state.failNextSave){
                    state.failNextSave = false;
                    return route.fulfill({status:500, json:{detail:'fixture save failed'}});
                }
                if(!migrateOnSave){
                    return route.fulfill({json:{providers:request.postDataJSON().map(item => {
                        const {api_key, ...publicItem} = item;
                        return {...publicItem, has_key:!!api_key};
                    })}});
                }
            }
            const result = migrateOnSave && request.method() === 'PUT'
                ? records.map(item => item.id === 'no-icon' ? {...item, id:'scnet', legacy_ids:['no-icon']} : item)
                : records;
            return route.fulfill({json: {providers:result}});
        }
        if (url.pathname === '/api/provider-icon') {
            const target = url.searchParams.get('url') || '';
            state.iconRequests.push(target);
            if (target.includes('icon.example')) return route.fulfill({status: 200, contentType: 'image/png', body: PNG});
            return route.fulfill({status: 404, contentType: 'text/plain', body: ''});
        }
        if (url.pathname.startsWith('/api/')) return route.fulfill({json: {}});
        const file = path.join(root, decodeURIComponent(url.pathname));
        if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return route.fulfill({path: file});
        }
        return route.fulfill({status: 404, contentType: 'text/plain', body: ''});
    });
    await page.goto('http://127.0.0.1:3000/static/api-settings.html');
    await page.waitForSelector('.provider-card');
    await page.waitForTimeout(1200);
    return {page, state};
}

test('保存后平台 ID 迁移仍保留选中平台', async t => {
    const {page, state} = await open(t, true);
    const selected = await page.evaluate(async () => {
        selectProvider('no-icon');
        const saved = await saveProviders();
        return {saved, id:selectedId, preview:document.getElementById('idPreview').textContent};
    });
    assert.deepEqual(selected, {saved:true, id:'scnet', preview:'scnet'});
    assert.deepEqual(state.errors, []);
});

test('新增任意 API 网站首次保存 Key 使用网站 ID，保存后改名改地址保持 ID', async t => {
    const {page, state} = await open(t);
    await page.evaluate(() => addProvider());
    await page.locator('#nameInput').fill('新的中文平台');
    await page.locator('#baseInput').fill('https://api.fresh-platform.example/v1');
    assert.equal(await page.locator('#idPreview').innerText(), 'fresh-platform-example');
    await page.locator('#keyInput').fill('fixture-new-platform-key');
    await page.evaluate(() => saveKeyOnly());
    const saved = state.saves.at(-1).find(item => item.name === '新的中文平台');
    assert.equal(saved.id, 'fresh-platform-example');
    assert.equal(saved.api_key, 'fixture-new-platform-key');
    assert.equal(await page.evaluate(() => selectedId), saved.id);
    await page.locator('#nameInput').fill('改后的名字');
    await page.locator('#baseInput').fill('https://different.example/v2');
    assert.equal(await page.locator('#idPreview').innerText(), saved.id);
    assert.equal(await page.evaluate(() => saveProviders()), true);
    assert.equal(state.saves.at(-1).find(item => item.name === '改后的名字').id, saved.id);
    assert.deepEqual(state.errors, []);
});

test('重复网站和 Key 环境变量同名的平台自动分配独立 ID', async t => {
    const {page, state} = await open(t);
    await page.evaluate(() => {
        providers.push({id:'fresh_platform_example', name:'Existing', base_url:'https://existing.example'});
        addProvider();
    });
    await page.locator('#baseInput').fill('https://api.fresh-platform.example/v1');
    assert.equal(await page.locator('#idPreview').innerText(), 'fresh-platform-example-2');
    await page.evaluate(() => saveProviders());
    await page.evaluate(() => addProvider());
    await page.locator('#baseInput').fill('https://api.fresh-platform.example/v1');
    assert.equal(await page.locator('#idPreview').innerText(), 'fresh-platform-example-3');
    await page.evaluate(() => saveProviders());
    const ids = state.saves.at(-1).map(item => item.id.replace(/-/g, '_'));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(state.errors, []);
});

test('首次保存失败后修改网站并重试，以最终地址生成 ID', async t => {
    const {page, state} = await open(t);
    await page.evaluate(() => addProvider());
    await page.locator('#baseInput').fill('https://first.example/v1');
    state.failNextSave = true;
    assert.equal(await page.evaluate(() => saveProviders()), false);
    await page.locator('#baseInput').fill('https://final.example/v1');
    assert.equal(await page.locator('#idPreview').innerText(), 'final-example');
    assert.equal(await page.evaluate(() => saveProviders()), true);
    assert.equal(await page.evaluate(() => selectedId), 'final-example');
    assert.deepEqual(state.errors, []);
});

async function markOf(page, name) {
    return page.evaluate((label) => {
        const card = [...document.querySelectorAll('.provider-card')]
            .find(node => (node.innerText || '').includes(label));
        if (!card) return null;
        const mark = card.querySelector('.provider-mark');
        const img = mark?.querySelector('img');
        const svg = mark?.querySelector('svg');
        return {
            imgSrc: img?.getAttribute('src') || '',
            imgLoaded: !!img && img.classList.contains('is-loaded'),
            imgDisplay: img ? getComputedStyle(img).display : 'none',
            svgDisplay: svg ? getComputedStyle(svg).display : 'none',
        };
    }, name);
}

test('平台列表自动使用站点图标，取不到时保留默认图标', async t => {
    const {page, state} = await open(t);
    const good = await markOf(page, '有图标平台');
    assert.ok(good, '平台卡片应存在');
    assert.match(good.imgSrc, /^\/api\/provider-icon\?url=/);
    assert.equal(good.imgLoaded, true, '站点图标应加载完成');
    assert.equal(good.imgDisplay, 'block', '加载成功后显示站点图标');
    assert.equal(good.svgDisplay, 'none', '站点图标加载后隐藏默认链条图标');

    const bad = await markOf(page, '取不到图标平台');
    assert.equal(bad.imgLoaded, false);
    assert.equal(bad.svgDisplay, 'block', '取不到图标时保留默认链条图标');

    const empty = await markOf(page, '未配置地址');
    assert.equal(empty.imgSrc, '', '没有 base_url 时不请求站点图标');
    assert.equal(empty.svgDisplay, 'block');

    assert.ok(state.iconRequests.some(url => url.includes('icon.example')), '应按 base_url 请求站点图标');
    assert.ok(state.iconRequests.some(url => url.includes('missing.example')));
    assert.deepEqual(state.errors, []);
});

test('深色侧栏保留当前入口、键盘焦点、列表滚动和拖拽排序', async t => {
    const {page, state} = await open(t);
    await page.evaluate(() => StudioScale.set('100'));
    await page.setViewportSize({width: 960, height: 640});
    await page.evaluate(() => {
        StudioAppearance.set({skin: 'dark'});
        for (let index = 0; index < 12; index++) {
            providers.push({
                id: 'extra-' + index, name: '测试平台 ' + index, base_url: '',
                protocol: 'openai', enabled: true, image_models: [], chat_models: [], video_models: [],
            });
        }
        renderProviderList();
    });

    const list = page.locator('#providerList');
    const selected = list.locator('[data-provider-id="with-icon"]');
    const another = list.locator('[data-provider-id="no-icon"]');
    const recommend = page.locator('.api-link-btn');
    const background = locator => locator.evaluate(button => getComputedStyle(button).backgroundColor);
    const recommended = await background(recommend);
    const currentInRecommendations = await background(selected);
    await selected.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.body.classList.contains('show-recommend-mode'));
    assert.notEqual(await background(selected), currentInRecommendations);
    assert.notEqual(await background(recommend), recommended);
    assert.equal(await selected.evaluate(button => document.activeElement === button), true);
    assert.equal(await selected.evaluate(button => getComputedStyle(button).borderRadius), '13px');

    const dragEvents = await page.evaluateHandle(() => {
        const events = [];
        for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
            document.getElementById('providerList').addEventListener(type, event => {
                events.push([event.type, event.target.closest('.provider-card')?.dataset.providerId]);
            }, true);
        }
        return events;
    });
    await another.locator('.provider-drag-handle').dragTo(selected.locator('.provider-drag-handle'));
    await page.waitForFunction(() => providerSavePromise === null);
    const events = await dragEvents.jsonValue();
    assert.ok(events.some(([type, id]) => type === 'drop' && id === 'with-icon'), JSON.stringify(events));
    assert.equal(await list.locator('.provider-card').first().getAttribute('data-provider-id'), 'no-icon');
    assert.equal(state.saves.at(-1)[0].id, 'no-icon');

    const afterRender = await list.evaluate(node => {
        node.scrollTop = 135;
        const before = node.scrollTop;
        renderProviderList();
        return {before, after: node.scrollTop};
    });
    assert.ok(afterRender.before > 0);
    assert.equal(afterRender.after, afterRender.before);

    assert.equal(await page.locator('#openWebSearch, #webSearchDialog').count(), 0);
    assert.equal(await page.getByRole('button', {name: '联网搜索', exact: true}).count(), 0);
    assert.deepEqual(state.errors, []);
});

test('保存其他平台时不重传 RunningHub 目录或凭证', async t => {
    const seed = '18446744073709551615';
    const catalog = {
        id: 'runninghub', name: 'RunningHub', protocol: 'runninghub',
        base_url: 'https://www.runninghub.cn', has_key: true, has_wallet_key: true,
        rh_apps: [{
            id: 'app-a', appId: 'app-a', title: '旧应用', enabled: true,
            fields: [{
                id: '1::sampler', nodeId: '1', fieldName: 'sampler', fieldValue: 'euler',
                fieldType: 'TEXT', enabled: true, options: [], sourceFromUpstream: true,
            }],
        }],
        rh_workflows: [{
            id: 'wf-a', workflowId: 'wf-a', title: '旧工作流', optionalImageMode: 'prune-workflow',
            fields: [{
                nodeId: '2', fieldName: 'seed', fieldType: 'SLIDER', fieldValue: seed,
                enabled: true, min: 0, max: seed, step: 1, random_enabled: true,
            }],
            workflowJson: {'2': {inputs: {seed, image: ['7', 0]}}},
        }, {
            id: 'wf-hidden', workflowId: 'wf-hidden', title: '旧隐藏工作流', hidden: true,
            enabled: false, updatedAt: 1700000000000,
        }],
    };
    const {page, state} = await open(t, false, [...providers, catalog]);
    assert.equal(await page.locator('[data-provider-id="runninghub"]').count(), 0);
    await page.locator('[data-provider-id="with-icon"]').click();
    await page.locator('#nameInput').fill('普通平台改名');
    const response = page.waitForResponse(result =>
        new URL(result.url()).pathname === '/api/providers' && result.request().method() === 'PUT'
    );
    await page.locator('.api-page-save-btn').click();
    assert.equal((await response).ok(), true);
    await page.waitForFunction(() => !providerSavePromise);
    const saved = state.saves.at(-1);
    assert.equal(saved.find(item => item.id === 'with-icon').name, '普通平台改名');
    const runninghub = saved.find(item => item.id === catalog.id);
    assert.equal(Object.hasOwn(runninghub, 'rh_apps'), false);
    assert.equal(Object.hasOwn(runninghub, 'rh_workflows'), false);
    assert.equal(runninghub.clear_key, false);
    assert.equal(runninghub.clear_wallet_key, false);
    assert.equal(Object.hasOwn(runninghub, 'api_key'), false);
    assert.equal(Object.hasOwn(runninghub, 'wallet_api_key'), false);
    assert.deepEqual(state.errors, []);
});
