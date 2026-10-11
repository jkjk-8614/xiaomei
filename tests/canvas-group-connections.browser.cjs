const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('image groups connect by dragging and pass every reference to painting and LLM nodes', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-group.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({body:''});
        }
        if(url.pathname.endsWith('.png') || url.pathname.includes('media-preview')){
            return route.fulfill({contentType:'image/png', body:pixel});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        if(url.pathname === '/api/canvases/group-fixture') return route.fulfill({json:{canvas:{
            id:'group-fixture', title:'Group fixture', nodes:[], connections:[], logs:[], settings:{}
        }}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://xiaomei-group.test/static/smart-canvas.html?id=group-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Group fixture');
    await page.evaluate(() => {
        nodes = [
            {id:'group', type:'smart-group', x:100, y:100, items:[], images:Array.from({length:6}, (_, i) => ({
                url:`/output/reference-${i}.png`, kind:'image', natural_w:100, natural_h:100
            }))},
            {id:'paint', type:'smart-paint', x:900, y:150, images:[{url:'/output/existing.png', kind:'image'}]},
            {id:'prompt', type:'smart-prompt', x:900, y:500}
        ];
        canvas.connections = [];
        canvasUsesConnections = true;
        selectedId = 'group';
        selectedIds = ['group'];
        viewport = {x:0, y:0, scale:0.8};
        render();
        applyViewport();
    });
    const sourcePort = page.locator('.image-node[data-id="group"] .node-port[data-port="out"]');
    const targetPort = page.locator('.image-node[data-id="paint"] .node-port[data-port="in"]');
    const from = await sourcePort.boundingBox(), to = await targetPort.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + from.width/2, from.y + from.height/2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width/2, to.y + to.height/2, {steps:12});
    await page.mouse.up();
    const result = await page.evaluate(() => {
        const group = nodes.find(node => node.id === 'group');
        const paint = nodes.find(node => node.id === 'paint');
        const prompt = nodes.find(node => node.id === 'prompt');
        const dragConnected = canvas.connections.some(conn => conn.from === group.id && conn.to === paint.id && conn.kind === 'input');
        const paintRefs = inputImagesFor(paint).map(ref => ref.url);
        const promptConnected = connectInputNode(group.id, prompt.id);
        connectInputNode(group.id, paint.id);
        const empty = {id:'empty', type:'smart-group', items:[], images:[]};
        const memberGroup = {id:'members', type:'smart-group', items:[prompt.id]};
        const audio = {id:'audio', type:'smart-group', items:[], images:[{url:'/output/voice.wav', kind:'audio'}]};
        const mixed = {...audio, id:'mixed', items:[prompt.id]};
        const timeline = {id:'timeline', type:'smart-timeline'};
        const canConnect = window.SmartCanvasDataVideo.canConnect;
        nodes.push(empty, audio);
        const before = canvas.connections.length;
        return {
            dragConnected, paintRefs, promptConnected,
            promptRefs:inputImagesFor(prompt).map(ref => ref.url),
            edgeCount:before, paintInputs:paint.inputNodeIds,
            emptyRejected:!connectInputNode(empty.id, paint.id),
            audioRejected:!connectInputNode(audio.id, paint.id),
            rejectionKeepsEdges:canvas.connections.length === before,
            memberConnects:canConnect(memberGroup, paint), mixedConnects:canConnect(mixed, paint),
            memberTimeline:canConnect(memberGroup, timeline),
            imageTimeline:canConnect(group, timeline), audioTimeline:canConnect(audio, timeline),
            imagesIntact:group.images.length === 6 && paint.images[0].url === '/output/existing.png'
        };
    });
    assert.equal(result.dragConnected, true);
    const refs = Array.from({length:6}, (_, i) => `/output/reference-${i}.png`);
    assert.deepEqual(result.paintRefs, refs);
    assert.equal(result.promptConnected, true);
    assert.deepEqual(result.promptRefs, refs);
    assert.equal(result.edgeCount, 2);
    assert.deepEqual(result.paintInputs, ['group']);
    for(const key of ['emptyRejected','audioRejected','rejectionKeepsEdges','memberConnects','mixedConnects','memberTimeline','imageTimeline','audioTimeline','imagesIntact']){
        assert.equal(result[key], true, key);
    }
    assert.deepEqual(errors, []);
});
