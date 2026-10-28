const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('batch settings menus support pointer, keyboard, canvas zoom and saved selections', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge',headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:1500}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'batch-select',nodes:[],connections:[],settings:{},logs:[]};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'batch-select.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/batch-select'){
            if(request.method() === 'PUT') saved = {...saved,...request.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture',name:'图片平台',enabled:true,image_models:['nano-banana-2.1','gpt-image-1'],chat_models:['text-model']
        }],comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://batch-select.test/static/smart-canvas.html?id=batch-select');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'batch-select');
    await page.evaluate(() => {
        const loop = createLoopNode(0,0,{batchUiMode:'paired'});
        loop.id = 'batch'; loop.batchAiProvider = 'fixture'; loop.batchAiModel = 'text-model';
        loop.batchImageSettings = {...smartLoopBatchImageSettings(loop),provider_id:'fixture',model:'nano-banana-2.1'};
        viewport = {x:80,y:60,scale:.85}; applyViewport(); render();
    });
    const batch = page.locator('[data-id="batch"]');
    const rhythm = batch.locator('[data-loop-commerce="rhythm"]');
    const menu = page.getByRole('listbox', {name:'色彩节奏',exact:true});
    const getOutput = key => batch.locator(`[data-loop-batch-image-param="${key}"]`);
    const columns = await batch.locator('[data-loop-batch-image-param]').evaluateAll(items => items.map(el => ({
        x:el.getBoundingClientRect().x,w:el.getBoundingClientRect().width,arrow:getComputedStyle(el).backgroundImage
    })));
    assert.equal(columns.length, 4);
    assert.equal(columns[0].w, columns[2].w);
    assert.equal(columns[1].x, columns[3].x);
    assert.ok(columns.every(column => column.arrow !== 'none'));
    await rhythm.click();
    await menu.getByRole('option', {name:'统一',exact:true}).click();
    assert.equal(await rhythm.inputValue(), '统一');
    assert.equal(await rhythm.evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    assert.equal(await rhythm.inputValue(), '统一', 'Escape preserves the committed value');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await rhythm.inputValue(), '明暗交替');
    await rhythm.click();
    await page.keyboard.press('Tab');
    assert.equal(await menu.count(), 0);
    assert.equal(await rhythm.evaluate(el => document.activeElement === el), false, 'Tab continues to the next control');
    await rhythm.click();
    await page.mouse.click(1200,100);
    assert.equal(await menu.count(), 0);
    await rhythm.click();
    await page.evaluate(() => render());
    assert.equal(await menu.count(), 0, 'rerender removes the portal');
    await rhythm.click();
    await page.evaluate(() => { viewport.scale=.6; applyViewport(); });
    assert.equal(await menu.count(), 0, 'zoom dismisses the portal');
    await rhythm.click();
    const triggerBox = await rhythm.boundingBox(), menuBox = await menu.boundingBox();
    assert.ok(Math.abs(triggerBox.x - menuBox.x) < 1);
    assert.ok(menuBox.y >= triggerBox.y + triggerBox.height);
    await menu.getByRole('option', {name:'错落',exact:true}).click();
    assert.equal(await page.evaluate(() => dragState), null);
    await getOutput('model').selectOption('gpt-image-1');
    assert.equal(await getOutput('quality').count(), 1, 'quality setting stays available for supported models');
    await getOutput('ratio').selectOption('custom');
    await getOutput('customRatioWidth').fill('5');
    await getOutput('customRatioWidth').dispatchEvent('change');
    await page.evaluate(async () => { await saveCanvas(); });
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && nodes.find(n => n.id === 'batch'));
    assert.equal(await rhythm.inputValue(), '错落');
    assert.equal(await getOutput('model').inputValue(), 'gpt-image-1');
    assert.equal(await getOutput('ratio').inputValue(), 'custom');
    assert.equal(await getOutput('customRatioWidth').inputValue(), '5');
});
