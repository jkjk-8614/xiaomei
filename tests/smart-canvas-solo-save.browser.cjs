const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('one editor queues overlapping saves without a node conflict', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'canvas-solo-save.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/solo-fixture' && route.request().method() === 'GET'){
            return route.fulfill({json:{canvas:{id:'solo-fixture', title:'单人画布', nodes:[], connections:[], logs:[], settings:{}, viewport:{x:0,y:0,scale:1}, updated_at:100}}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[], api_providers:[]}});
    });
    await page.goto('http://canvas-solo-save.test/static/smart-canvas.html?id=solo-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === '单人画布');
    const result = await page.evaluate(async () => {
        clearTimeout(saveTimer);
        const node = {id:'node-1', type:'smart-upload', title:'生成失败', x:0, y:0, w:446, h:516, images:[], _collab_updated_at:100};
        nodes = [node];
        canvas = {...canvas, nodes, updated_at:100};
        collabCaptureSnapshot(canvas, nodes);
        collabSocket = {readyState:WebSocket.OPEN};
        collabConnected = true;
        const requests = [];
        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        let serverCanvas = structuredClone(canvas);
        const originalFetch = window.fetch;
        window.fetch = async (url, options={}) => {
            if(String(url) !== '/api/canvases/solo-fixture/nodes' || options.method !== 'PATCH') return originalFetch(url, options);
            const body = JSON.parse(options.body);
            requests.push(body);
            if(requests.length === 1) await firstGate;
            const current = serverCanvas.nodes[0];
            if(current._collab_updated_at > body.changes[0].base_updated_at){
                return new Response(JSON.stringify({detail:{canvas:serverCanvas, conflicts:[{node_id:'node-1', local:body.changes[0].node, remote:current}]}}), {status:409, headers:{'Content-Type':'application/json'}});
            }
            const revision = serverCanvas.updated_at + 100;
            serverCanvas = {...serverCanvas, updated_at:revision, nodes:[{...body.changes[0].node, _collab_updated_at:revision}]};
            return new Response(JSON.stringify({canvas:serverCanvas}), {status:200, headers:{'Content-Type':'application/json'}});
        };
        node.x = 10;
        const firstSave = saveCanvas();
        while(requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
        node.x = 20;
        const secondSave = saveCanvas();
        const concurrentRequests = requests.length;
        releaseFirst();
        await Promise.all([firstSave, secondSave]);
        window.fetch = originalFetch;
        const remainingChanges = collabNodeDiff(canvasForStorage().nodes).changes.length;
        const remoteCanvas = structuredClone(serverCanvas);
        remoteCanvas.updated_at += 100;
        remoteCanvas.nodes[0].x = 30;
        remoteCanvas.nodes[0]._collab_updated_at = remoteCanvas.updated_at;
        applyMergedServerCanvas(remoteCanvas);
        canvas.nodes = nodes;
        return {
            concurrentRequests,
            requests:requests.map(body => ({x:body.changes[0]?.node.x, base:body.changes[0]?.base_updated_at})),
            finalX:serverCanvas.nodes[0].x,
            conflictDialog:Boolean(document.querySelector('.canvas-collab-conflict-backdrop')),
            remainingChanges,
            remoteChangeSubmitted:collabNodeDiff(canvasForStorage().nodes).changes.length
        };
    });
    assert.equal(result.concurrentRequests, 1);
    assert.deepEqual(result.requests, [{x:10, base:100}, {x:20, base:200}]);
    assert.equal(result.finalX, 20);
    assert.equal(result.conflictDialog, false);
    assert.equal(result.remainingChanges, 0);
    assert.equal(result.remoteChangeSubmitted, 0);
    assert.deepEqual(errors, []);
});
