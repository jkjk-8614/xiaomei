const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('left-dragging the canvas outside the composer closes it', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;
        if(url.hostname !== 'xiaomei-pan.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path:file }) : route.fulfill({ status:404, body:'' });
        }
        if(pathname === '/api/config') return route.fulfill({ json:{
            api_providers:[{ id:'fixture', name:'Fixture', enabled:true, protocol:'openai', image_models:['fixture-image'], chat_models:[], video_models:[] }],
            comfy_instances:[]
        } });
        if(pathname === '/api/canvases/pan-fixture') return route.fulfill({ json:{ canvas:{
            id:'pan-fixture', title:'Pan fixture', nodes:[], connections:[], logs:[],
            settings:{ engine:'api', provider_id:'fixture', model:'fixture-image', count:1 }
        } } });
        return route.fulfill({ json:{ skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[] } });
    });

    await page.goto('http://xiaomei-pan.test/static/smart-canvas.html?id=pan-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Pan fixture');
    await page.evaluate(() => {
        createPaintNodeAt({ x:550, y:200 });
        viewport = { x:100, y:80, scale:1 };
        applyViewport();
        updateComposer();
    });
    await page.locator('#composer.open').waitFor({ state:'visible' });

    const position = () => page.evaluate(() => {
        const rect = composer.getBoundingClientRect();
        return { left:rect.left, top:rect.top, styleLeft:composer.style.left, styleTop:composer.style.top, frozen:panComposerPosition, pan:panState, zoom:composer.style.zoom, parent:composer.parentElement.id, shellTransform:getComputedStyle(shell).transform, worldTransform:getComputedStyle(world).transform, viewportX:viewport.x, viewportY:viewport.y };
    });
    const before = await position();
    await page.evaluate(() => {
        shell.dispatchEvent(new MouseEvent('mousedown', { button:0, clientX:1200, clientY:750, bubbles:true, cancelable:true }));
        window.onmousemove(new MouseEvent('mousemove', { clientX:1400, clientY:810, bubbles:true }));
    });
    await page.waitForTimeout(50);
    const during = await position();
    assert.equal(await page.locator('#composer').evaluate(el => el.classList.contains('open')), false, 'composer stayed open while panning');
    await page.evaluate(() => window.onmouseup(new MouseEvent('mouseup', { button:0, clientX:1400, clientY:810, bubbles:true })));
    const after = await position();

    assert.ok(Math.abs(during.viewportX - before.viewportX) > 100, 'canvas did not pan');
    assert.ok(Math.abs(after.viewportX - before.viewportX) > 100, 'canvas did not keep the panned position');
    assert.equal(await page.locator('#composer').evaluate(el => el.classList.contains('open')), false, 'composer stayed open during panning');
    const afterDragClick = await page.evaluate(() => {
        shell.dispatchEvent(new MouseEvent('click', { button:0, clientX:1400, clientY:810, bubbles:true }));
        return { open:composer.classList.contains('open'), selectedId };
    });
    assert.equal(afterDragClick.open, false);
    assert.equal(afterDragClick.selectedId, '');
    await page.evaluate(() => {
        selectedId = nodes[0]?.id || '';
        updateComposer();
    });
    assert.equal(await page.locator('#composer').evaluate(el => el.classList.contains('open')), true, 'reselecting should reopen the composer');
    assert.deepEqual(errors, []);
});
