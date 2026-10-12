const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('viewport gestures restore the connection layer without changing tasks or connections', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'connection-viewport.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/fixture') return route.fulfill({json:{canvas:{
            id:'fixture', title:'Connection viewport fixture', nodes:[], connections:[], logs:[], settings:{}
        }}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://connection-viewport.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    await page.evaluate(() => {
        nodes = [
            {id:'source', type:'smart-paint', x:7000, y:6200, images:[], w:260, h:300},
            {id:'pending', type:'smart-paint', x:7460, y:6200, images:[], w:260, h:300, pending:4},
            {id:'target', type:'smart-paint', x:7920, y:6200, images:[], w:260, h:300}
        ];
        canvas.connections = [{from:'source', to:'pending', kind:'input'}, {from:'pending', to:'target', kind:'input'}];
        viewport = {x:-6750, y:-6000, scale:1};
        selectedId = '';
        applyViewport();
        render();
        window.savedConnectionFixture = JSON.stringify(canvas.connections);
    });
    await page.waitForTimeout(100);

    const disturbLayer = () => page.evaluate(() => {
        world.querySelectorAll('.conn-group').forEach(group => group.remove());
    });
    async function assertRestored(label){
        await page.waitForFunction(() => world.querySelectorAll('.conn-group').length === 2);
        const result = await page.evaluate(() => {
            const mapper = createClientToWorldMapper();
            const aligned = [...world.querySelectorAll('.conn-group')].every(group => {
                const target = world.querySelector(`[data-id="${group.dataset.connTo}"]`).getBoundingClientRect();
                const expected = mapper(target.left, target.top + target.height / 2);
                const line = group.querySelector('.conn-line');
                const end = line.getPointAtLength(line.getTotalLength());
                return Math.hypot(end.x - expected.x, end.y - expected.y) < 1;
            });
            return {aligned, unchanged:JSON.stringify(canvas.connections) === savedConnectionFixture,
                pending:nodes.find(node => node.id === 'pending').pending};
        });
        assert.deepEqual(result, {aligned:true, unchanged:true, pending:4}, label);
    }

    await disturbLayer();
    await page.mouse.move(650, 150);
    await page.mouse.wheel(0, 100);
    await assertRestored('wheel zoom');

    await disturbLayer();
    await page.mouse.move(650, 150);
    await page.mouse.down();
    await page.mouse.move(700, 180, {steps:4});
    await page.mouse.up();
    await assertRestored('canvas pan');

    await disturbLayer();
    await page.evaluate(() => setCanvasZoom(1.2));
    await assertRestored('toolbar zoom');
    assert.deepEqual(errors, []);
});
