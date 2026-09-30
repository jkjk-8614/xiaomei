const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const svg = (width, height, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`;

test('comparison fits portrait and landscape images and keeps the wide preview', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;
        if(url.hostname !== 'xiaomei-compare.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            if(!fs.existsSync(file) || !file.startsWith(root + path.sep)) return route.fulfill({ status:404, body:'' });
            return route.fulfill({ path:file });
        }
        if(pathname.startsWith('/fixture/')){
            const landscape = pathname.includes('landscape');
            return route.fulfill({ contentType:'image/svg+xml', body:svg(landscape ? 960 : 540, landscape ? 540 : 960, pathname.includes('one') ? '#965437' : '#477b8e') });
        }
        if(pathname === '/api/canvases/compare-fixture') return route.fulfill({ json:{ canvas:{
            id:'compare-fixture', title:'Compare fixture',
            nodes:[
                {id:'source-one', type:'smart-upload', x:60, y:60, images:[{url:'/fixture/portrait-one.png', name:'One', kind:'image', natural_w:540, natural_h:960}]},
                {id:'source-two', type:'smart-upload', x:440, y:60, images:[{url:'/fixture/portrait-two.png', name:'Two', kind:'image', natural_w:540, natural_h:960}]},
                {id:'comparison', type:'smart-compare', x:850, y:60, w:460, h:560, compareMode:'side-by-side', comparePosition:50}
            ],
            connections:[
                {from:'source-one', to:'comparison', kind:'input'},
                {from:'source-two', to:'comparison', kind:'input'}
            ],
            logs:[], settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}
        } } });
        if(pathname === '/api/config' || pathname === '/api/providers') return route.fulfill({ json:{
            api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', image_models:['fixture-image'], chat_models:['fixture-chat'], video_models:[]}],
            comfy_instances:[]
        } });
        if(pathname.startsWith('/api/')) return route.fulfill({ json:{} });
        return route.fulfill({ status:204, body:'' });
    });

    await page.goto('http://xiaomei-compare.test/static/smart-canvas.html?id=compare-fixture');
    const compare = page.locator('.smart-compare-node');
    await compare.locator('.smart-compare-media').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.smart-compare-frame-overlay img')?.naturalWidth > 0);
    const portrait = await page.evaluate(() => {
        const node = document.querySelector('.smart-compare-node');
        const stage = node.querySelector('.smart-compare-stage');
        return {nodeWidth:node.getBoundingClientRect().width, stageWidth:stage.clientWidth, stageHeight:stage.clientHeight,
            legacyMode:nodes.find(item => item.id === 'comparison').compareMode};
    });
    assert.equal(portrait.legacyMode, undefined);
    assert.ok(portrait.nodeWidth <= 330, `portrait node is ${portrait.nodeWidth}px wide`);
    assert.ok(Math.abs(portrait.stageWidth / portrait.stageHeight - 540 / 960) < 0.04);
    assert.equal(await compare.locator('[data-compare-mode], .smart-compare-stage-side-by-side').count(), 0);
    const stageBox = await compare.locator('[data-compare-stage]').boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width * 0.5, stageBox.y + stageBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width * 0.7, stageBox.y + stageBox.height * 0.5);
    await page.mouse.up();
    const sliderPosition = await page.evaluate(() => nodes.find(item => item.id === 'comparison').comparePosition);
    assert.ok(sliderPosition > 65 && sliderPosition < 75, `slider stopped at ${sliderPosition}%`);

    await compare.locator('[data-compare-open-preview]').click();
    await page.waitForFunction(() => document.querySelector('#previewCurrentImage')?.naturalWidth > 0
        && document.querySelector('.compare-node-preview #previewFrame')?.clientWidth > 0);
    const previewWidth = await page.evaluate(() => document.querySelector('.compare-node-preview .image-edit-panel').getBoundingClientRect().width);
    assert.ok(previewWidth >= 1400, `preview panel is only ${previewWidth}px wide`);
    await page.evaluate(() => closeImageEditor());

    const landscape = await page.evaluate(() => {
        for(const node of nodes.filter(item => item.id.startsWith('source-'))){
            node.images[0].url = `/fixture/landscape-${node.id === 'source-one' ? 'one' : 'two'}.png`;
            node.images[0].natural_w = 960;
            node.images[0].natural_h = 540;
        }
        render();
        const node = document.querySelector('.smart-compare-node');
        const stage = node.querySelector('.smart-compare-stage');
        return {nodeWidth:node.getBoundingClientRect().width, stageWidth:stage.clientWidth, stageHeight:stage.clientHeight};
    });
    assert.ok(landscape.nodeWidth >= 450);
    assert.ok(Math.abs(landscape.stageWidth / landscape.stageHeight - 960 / 540) < 0.04);
    await page.evaluate(() => {
        for(const node of nodes.filter(item => item.id.startsWith('source-'))){
            node.images[0].url = `/fixture/missing-size-${node.id === 'source-one' ? 'one' : 'two'}.png`;
            delete node.images[0].natural_w;
            delete node.images[0].natural_h;
        }
        render();
    });
    await page.waitForFunction(() => document.querySelector('.smart-compare-node')?.getBoundingClientRect().width <= 330);
    assert.deepEqual(errors, []);
});
