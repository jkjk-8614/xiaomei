const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('dropping an output port on the canvas keeps the node menu open and connects the chosen node', { timeout:60000 }, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-port-menu.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            if(fs.existsSync(file)) return route.fulfill({path:file});
            return route.fulfill({contentType:'application/javascript', body:''});
        }
        if(url.pathname === '/api/config'){
            return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        }
        if(url.pathname === '/api/canvases/port-menu-fixture'){
            return route.fulfill({json:{canvas:{
                id:'port-menu-fixture', title:'Port menu fixture', nodes:[], connections:[], logs:[],
                settings:{engine:'api', count:1}
            }}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });

    await page.goto('http://xiaomei-port-menu.test/static/smart-canvas.html?id=port-menu-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Port menu fixture');
    const sourceId = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const source = createNode(340, 220, [{url:'/output/source.png', name:'source.png', kind:'image'}], {
            nodeType:'smart-upload', select:false, skipUndo:true
        });
        render();
        return source.id;
    });

    const port = await page.locator(`.image-node[data-id="${sourceId}"] .node-port.port-out`).boundingBox();
    assert.ok(port, 'source node should expose an output port');
    const start = {x:port.x + port.width / 2, y:port.y + port.height / 2};
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 220, start.y + 150, {steps:8});
    await page.mouse.up();

    await page.waitForFunction(() => document.getElementById('createMenu')?.classList.contains('open'));
    assert.ok(await page.locator('#createMenu [data-create-type="paint"]').count());
    await page.locator('#createMenu [data-create-type="paint"]').click();

    const connected = await page.evaluate(sourceId => {
        const target = nodes.find(node => node.type === SMART_PAINT_NODE_TYPE);
        return {
            targetId:target?.id || '',
            linked:Boolean(target && canvas.connections.some(connection => (
                connection.from === sourceId
                && connection.to === target.id
                && (connection.kind || 'flow') === 'input'
            )))
        };
    }, sourceId);
    assert.ok(connected.targetId, 'choosing a paint node should create it');
    assert.equal(connected.linked, true);

    const groupSourceId = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const source = createNode(340, 220, [
            {url:'/output/original-a.png', name:'original-a.png', kind:'image'},
            {url:'/output/original-b.png', name:'original-b.png', kind:'image'}
        ], {nodeType:'smart-upload', select:false, skipUndo:true});
        const sink = createPaintNodeAt({x:1100, y:220}, {select:false, skipUndo:true});
        connectInputNode(source.id, sink.id);
        render();
        return {sourceId:source.id, sinkId:sink.id};
    });
    const groupPort = await page.locator(`.image-node[data-id="${groupSourceId.sourceId}"] .node-port.port-out`).boundingBox();
    assert.ok(groupPort, 'source node should expose an output port for group creation');
    const groupStart = {x:groupPort.x + groupPort.width / 2, y:groupPort.y + groupPort.height / 2};
    await page.mouse.move(groupStart.x, groupStart.y);
    await page.mouse.down();
    await page.mouse.move(groupStart.x + 220, groupStart.y + 150, {steps:8});
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('createMenu')?.classList.contains('open'));
    await page.locator('#createMenu [data-create-type="group"]').click();

    const grouped = await page.evaluate(({sourceId, sinkId}) => {
        const group = nodes.find(isSmartGroupNode);
        return {
            sourceRemoved:!nodes.some(node => node.id === sourceId),
            imageUrls:(group?.images || []).map(image => image.url).sort(),
            rerouted:Boolean(group && canvas.connections.some(connection => (
                connection.from === group.id
                && connection.to === sinkId
                && (connection.kind || 'flow') === 'input'
            )))
        };
    }, groupSourceId);
    assert.equal(grouped.sourceRemoved, true, 'group creation should move the original node contents');
    assert.deepEqual(grouped.imageUrls, ['/output/original-a.png', '/output/original-b.png']);
    assert.equal(grouped.rerouted, true, 'existing connections should follow the source into the group');
    assert.deepEqual(errors, []);
});
