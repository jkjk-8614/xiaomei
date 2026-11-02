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

async function open(t, migrateOnSave = false) {
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
                ? providers.map(item => item.id === 'no-icon' ? {...item, id:'scnet', legacy_ids:['no-icon']} : item)
                : providers;
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
