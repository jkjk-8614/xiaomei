const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

for (const deviceScaleFactor of [1, 1.25]) {
    test(`composer text uses layout zoom at DPR ${deviceScaleFactor}`, {timeout:40000}, async t => {
        const browser = await chromium.launch({channel:'msedge',headless:true});
        t.after(() => browser.close());
        const page = await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor});
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.routeWebSocket('**/*', socket => socket.close());
        await page.addInitScript(() => localStorage.setItem('studio_appearance', JSON.stringify({skin:'warm',font:'sans',fontSize:'normal'})));
        await page.route('**/*', route => {
            const url = new URL(route.request().url()), p = url.pathname;
            if (url.hostname !== 'composer-text.test') return route.abort();
            if (p.startsWith('/static/')) {
                const file = path.resolve(root, '.' + decodeURIComponent(p));
                assert.ok(file.startsWith(root + path.sep));
                return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
            }
            if (p === '/api/config') return route.fulfill({json:{api_providers:[
                {id:'fixture',name:'测试平台',enabled:true,protocol:'openai',image_models:['gpt-image-2','gpt-image-2-high'],chat_models:[]},
                {id:'second',name:'另一个平台',enabled:true,protocol:'openai',image_models:['fixture-model'],chat_models:[]}
            ],comfy_instances:[]}});
            if (p === '/api/canvases/text-fixture') return route.fulfill({json:{canvas:{id:'text-fixture',title:'Text fixture',nodes:[],connections:[],logs:[],settings:{engine:'api',provider_id:'fixture',model:'gpt-image-2',count:1}}}});
            return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
        });
        await page.goto('http://composer-text.test/static/smart-canvas.html?id=text-fixture');
        await page.waitForFunction(() => smartConfigReady && canvas);
        await page.evaluate(() => {
            const n = createNode(600,140,[],{nodeType:SMART_PAINT_NODE_TYPE,select:true});
            n.w=300; n.h=180; n.manualSize=true;
            render(); updateComposer();
            promptInput.textContent='保留画面中的商品细节和文字，检查模型菜单与底部参数的文字清晰度。';
        });
        for (const scale of [0.65,1,1.15,1.35,1.8]) {
            await page.evaluate(scale => {viewport={x:-100.25,y:30.3,scale}; applyViewport();}, scale);
            await page.locator('.image-model-trigger').click();
            await page.waitForTimeout(200);
            const sample = await page.evaluate(() => {
                const panel = composer.getBoundingClientRect();
                const style = getComputedStyle(composer);
                const menu = document.querySelector('.image-model-popover');
                const ms = getComputedStyle(menu);
                const node = world.querySelector('.image-node.selected').getBoundingClientRect();
                return {zoom:Number(style.zoom),scale:style.scale,transform:style.transform,
                    width:panel.width,logicalWidth:composer.offsetWidth,gap:panel.top-node.bottom,
                    left:panel.left,top:panel.top,filter:ms.backdropFilter,visibility:ms.visibility};
            });
            assert.equal(sample.zoom,Math.max(1,scale));
            assert.equal(sample.scale,'none');
            assert.equal(sample.transform,'none');
            assert.equal(sample.filter,'none');
            assert.equal(sample.visibility,'visible');
            assert.ok(Math.abs(sample.width-sample.logicalWidth*sample.zoom)<1);
            assert.ok(Math.abs(sample.gap-20)<1);
            for(const coordinate of [sample.left,sample.top]) assert.ok(Math.abs(coordinate*deviceScaleFactor-Math.round(coordinate*deviceScaleFactor))<0.05);
            if (scale === 1.35) await page.screenshot({path:path.join(os.tmpdir(),`xiaomei-composer-text-${deviceScaleFactor}.png`)});
            await page.locator('[data-smart-param="model"][data-smart-value="gpt-image-2-high"]').click();
            await page.waitForFunction(() => settings.model === 'gpt-image-2-high');
            await page.evaluate(() => closeAllSmartPopovers());
        }
        await page.evaluate(() => {viewport={x:0,y:0,scale:1.35}; applyViewport();});
        await page.locator('#promptInput').fill('输入测试');
        assert.equal(await page.locator('#promptInput').innerText(),'输入测试');
        const before = await page.evaluate(() => viewport.scale);
        await page.locator('#promptInput').hover();
        await page.mouse.wheel(0,80);
        assert.equal(await page.evaluate(() => viewport.scale),before);
        await page.locator('.image-model-trigger').click();
        await page.locator('[data-smart-param="provider_id"][data-smart-value="second"]').click();
        await page.waitForFunction(() => settings.provider_id === 'second');
        assert.deepEqual(errors,[]);
    });
}
