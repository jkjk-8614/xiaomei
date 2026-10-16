const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('Ctrl and right mouse drag erases crossed connections without copying nodes', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1200, height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'erase-gesture.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/fixture') return route.fulfill({json:{canvas:{
            id:'fixture', title:'Erase fixture', nodes:[], connections:[], logs:[], settings:{}
        }}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[]}});
    });
    await page.goto('http://erase-gesture.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    await page.evaluate(() => {
        nodes = [
            {id:'source', type:'smart-agent', x:7000, y:6100, w:300, h:680, images:[]},
            ...Array.from({length:6}, (_, index) => ({
                id:`target-${index + 1}`, type:'smart-paint', x:7550,
                y:5950 + index * 200, w:240, h:240, images:[]
            }))
        ];
        canvas.connections = nodes.slice(1).map(node => ({from:'source', to:node.id, kind:'input'}));
        viewport = {x:-4420, y:-3770, scale:.65};
        applyViewport();
        render();
    });
    await page.waitForTimeout(180);
    const copiedDuringErase = await page.evaluate(() => {
        connectionEraseState = {indices:new Set()};
        const source = world.querySelector('.image-node[data-id="source"]');
        source.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0, altKey:true}));
        connectionEraseState = null;
        return nodes.length !== 7;
    });
    assert.equal(copiedDuringErase, false);
    const stroke = await page.evaluate(() => {
        const points = [...world.querySelectorAll('.conn-hit')].map(path => {
            const point = path.getPointAtLength(path.getTotalLength() * .5);
            const matrix = path.getScreenCTM();
            return {x:matrix.a * point.x + matrix.c * point.y + matrix.e,
                y:matrix.b * point.x + matrix.d * point.y + matrix.f};
        });
        return {x:points[0].x, top:Math.min(...points.map(point => point.y)) - 50,
            bottom:Math.max(...points.map(point => point.y)) + 50, points};
    });
    await page.keyboard.down('Control');
    await page.mouse.move(stroke.x, stroke.top);
    await page.mouse.down({button:'right'});
    const hits = await page.evaluate(points => ({
        cached:connectionEraseState?.geometryCache?.paths?.map(path => path.indices),
        pointHits:points.map(point => [...connectionIndicesNearClientPoint(point.x, point.y)])
    }), stroke.points);
    assert.ok(hits.pointHits.every((indices, index) => indices.includes(index)), JSON.stringify({stroke,hits}));
    await page.mouse.move(stroke.x, stroke.bottom);
    await page.mouse.up({button:'right'});
    await page.keyboard.up('Control');
    const result = await page.evaluate(() => ({
        connections:canvas.connections.length,
        nodeIds:nodes.map(node => node.id),
        renderedNodeIds:[...world.querySelectorAll('.image-node[data-id]')].map(node => node.dataset.id),
        erasing:!!connectionEraseState,
        remaining:canvas.connections.map(conn => conn.to)
    }));
    assert.deepEqual(result, {connections:0,
        nodeIds:['source', ...Array.from({length:6}, (_, index) => `target-${index + 1}`)],
        renderedNodeIds:['source', ...Array.from({length:6}, (_, index) => `target-${index + 1}`)],
        erasing:false, remaining:[]}, JSON.stringify({stroke,hits}));
    assert.deepEqual(errors, []);
});
