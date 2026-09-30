const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('ungroup keeps smart-group connections and restores their original targets', { timeout:60000 }, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-ungroup.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            if(!fs.existsSync(file)) return route.fulfill({contentType:'application/javascript', body:''});
            return route.fulfill({path:file});
        }
        if(url.pathname.endsWith('.png')) return route.fulfill({contentType:'image/png', body:pixel});
        if(url.pathname === '/api/config'){
            return route.fulfill({json:{
                api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image'], video_models:[]}],
                comfy_instances:[]
            }});
        }
        if(url.pathname === '/api/canvases/ungroup-fixture'){
            return route.fulfill({json:{canvas:{
                id:'ungroup-fixture', title:'Ungroup fixture', nodes:[], connections:[], logs:[],
                settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}
            }}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });

    await page.goto('http://xiaomei-ungroup.test/static/smart-canvas.html?id=ungroup-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Ungroup fixture');

    const exact = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const make = (x, y, url) => createNode(x, y, [{url, name:url.split('/').pop(), kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const sourceA = make(80, 120, '/output/source-a.png');
        const sourceB = make(80, 420, '/output/source-b.png');
        const imageA = make(480, 120, '/output/image-a.png');
        const imageB = make(480, 420, '/output/image-b.png');
        const sink = make(920, 260, '/output/sink.png');
        connectInputNode(sourceA.id, imageA.id);
        connectInputNode(sourceB.id, imageB.id);
        connectInputNode(imageA.id, imageB.id);
        connectInputNode(imageA.id, sink.id);
        connectInputNode(imageB.id, sink.id);
        selectedIds = [imageA.id, imageB.id];
        groupSelectedNodes();
        const group = nodes.find(isSmartGroupNode);
        const collapsedConnections = canvas.connections.map(connection => ({...connection}));
        // 模拟一次保存和重新打开，确保精确回接所需的来源记录不是只存在内存里。
        canvas.nodes = nodes;
        const stored = JSON.parse(JSON.stringify(canvasForStorage()));
        canvas = stored;
        nodes = stored.nodes.map(normalizeLegacySmartNode).filter(Boolean);
        canvas.connections = stored.connections || [];
        const persistedGroup = nodes.find(isSmartGroupNode);
        const rememberedCount = persistedGroup?._smartGroupOriginConnections?.length || 0;
        ungroupNode(persistedGroup.id);
        const restoredA = nodes.find(node => node.images?.[0]?.url === '/output/image-a.png');
        const restoredB = nodes.find(node => node.images?.[0]?.url === '/output/image-b.png');
        const has = (from, to) => canvas.connections.some(connection => connection.from === from && connection.to === to && (connection.kind || 'flow') === 'input');
        return {
            groupRemoved:!nodes.some(isSmartGroupNode),
            collapsedConnections,
            rememberedCount,
            restored:[
                has(sourceA.id, restoredA.id),
                has(sourceB.id, restoredB.id),
                has(restoredA.id, restoredB.id),
                has(restoredA.id, sink.id),
                has(restoredB.id, sink.id)
            ],
            crossed:[has(sourceA.id, restoredB.id), has(sourceB.id, restoredA.id)],
            restoredAInputs:restoredA.inputNodeIds || [],
            restoredBInputs:restoredB.inputNodeIds || [],
            sinkInputs:nodes.find(node => node.id === sink.id)?.inputNodeIds || [],
            restoredIds:[restoredA.id, restoredB.id],
            sourceIds:[sourceA.id, sourceB.id]
        };
    });
    assert.equal(exact.groupRemoved, true);
    assert.equal(exact.rememberedCount, 5);
    assert.ok(exact.collapsedConnections.length < exact.rememberedCount, 'grouping should collapse duplicate container edges');
    assert.deepEqual(exact.restored, [true, true, true, true, true]);
    assert.deepEqual(exact.crossed, [false, false]);
    assert.deepEqual(exact.restoredAInputs, [exact.sourceIds[0]]);
    assert.deepEqual(new Set(exact.restoredBInputs), new Set([exact.sourceIds[1], exact.restoredIds[0]]));
    assert.deepEqual(new Set(exact.sinkInputs), new Set(exact.restoredIds));

    const legacy = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const source = createNode(80, 180, [{url:'/output/legacy-source.png', kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const group = createSmartGroupNode(420, 180, {select:false, skipUndo:true});
        group.images = [
            {url:'/output/legacy-a.png', kind:'image'},
            {url:'/output/legacy-b.png', kind:'image'}
        ];
        const sink = createNode(900, 180, [{url:'/output/legacy-sink.png', kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        connectInputNode(source.id, group.id);
        connectInputNode(group.id, sink.id);
        ungroupNode(group.id);
        const restored = nodes.filter(node => ['/output/legacy-a.png', '/output/legacy-b.png'].includes(node.images?.[0]?.url));
        return {
            restoredCount:restored.length,
            incoming:restored.every(node => canvas.connections.some(connection => connection.from === source.id && connection.to === node.id)),
            outgoing:restored.every(node => canvas.connections.some(connection => connection.from === node.id && connection.to === sink.id)),
            sinkInputs:sink.inputNodeIds || [],
            restoredIds:restored.map(node => node.id),
            hasContainerEdge:canvas.connections.some(connection => connection.from === group.id || connection.to === group.id)
        };
    });
    assert.equal(legacy.restoredCount, 2);
    assert.equal(legacy.incoming, true);
    assert.equal(legacy.outgoing, true);
    assert.deepEqual(new Set(legacy.sinkInputs), new Set(legacy.restoredIds));
    assert.equal(legacy.hasContainerEdge, false);
    assert.deepEqual(errors, []);
});
