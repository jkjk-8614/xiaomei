const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium, _electron} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('completed image tasks recover after undo restores a running snapshot', {timeout:60000}, async t => {
    const electron = process.env.CANVAS_TEST_ELECTRON === '1';
    const browser = electron
        ? await _electron.launch({executablePath:path.join(root, 'desktop/node_modules/electron/dist/electron.exe'), args:[path.join(__dirname, 'fixtures/canvas-render-host.cjs')]})
        : await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = electron ? await browser.firstWindow() : await browser.newPage({viewport:{width:1440, height:1000}});
    const errors = [], generationRequests = [];
    const completed = new Set();
    page.on('pageerror', error => errors.push(error.message));
    const png = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 288; c.height = 512;
        c.getContext('2d').fillRect(0, 0, 288, 512);
        return c.toDataURL('image/png').split(',')[1];
    });
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        if(url.hostname !== 'canvas-completion.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(pathname === '/api/canvas-image-tasks' || pathname === '/api/online-image'){
            generationRequests.push(pathname);
            return route.fulfill({status:500, json:{error:'Unexpected generation'}});
        }
        if(pathname.startsWith('/api/canvas-image-tasks/')){
            const id = pathname.split('/').pop();
            return route.fulfill({json:completed.has(id)
                ? {id, status:'succeeded', result:{images:[`/output/${id}.png`]}}
                : {id, status:'running', started_at:(Date.now() - 120000) / 1000}});
        }
        if(pathname === '/api/media-preview' || pathname.startsWith('/output/')){
            return route.fulfill({contentType:'image/png', body:Buffer.from(png, 'base64')});
        }
        if(pathname === '/api/canvases/completion-fixture' && request.method() === 'GET'){
            return route.fulfill({json:{canvas:{id:'completion-fixture', title:'Completion fixture', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[], api_providers:[]}});
    });
    await page.goto('http://canvas-completion.test/static/smart-canvas.html?id=completion-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Completion fixture');
    await page.evaluate(() => {
        const node = createNode(100, 100, [], {nodeType:'smart-paint', select:false});
        window.fixtureId = node.id;
        node.pending = 4;
        node.pendingTasks = Array.from({length:4}, (_, i) => ({taskId:`fixture-${i}`, kind:'image', status:'running'}));
        node.runStartedAt = Date.now() - 120000;
        node.manualSize = true; node.w = 320; node.h = 520;
        window.fixtureRun = resumeSmartPendingNode(node);
    });
    await assertGenerationBounds('four placeholders');
    completed.add('fixture-0');
    await page.waitForFunction(() => nodes.find(n => n.id === fixtureId)?.images.length === 1);
    await assertGenerationBounds('one completed');
    completed.add('fixture-1');
    await page.waitForFunction(() => nodes.find(n => n.id === fixtureId)?.images.length === 2);
    await assertGenerationBounds('two completed');
    completed.add('fixture-2');
    await page.waitForFunction(() => nodes.find(n => n.id === fixtureId)?.images.length === 3);
    await page.waitForFunction(() => {
        const ring = world.querySelector('.generation-progress-ring');
        return ring && ring.dataset.progressSource === 'indeterminate'
            && !ring.textContent.includes('%');
    });
    async function assertGenerationBounds(label){
        const bounds = await page.evaluate(() => {
            const element = world.querySelector(`[data-id="${fixtureId}"]`);
            const node = element.getBoundingClientRect();
            const grid = element.querySelector('.loading-skeleton,.result-image-grid');
            const cells = [...grid.children];
            const inside = (outer, inner) => inner.left >= outer.left - 1
                && inner.top >= outer.top - 1 && inner.right <= outer.right + 1
                && inner.bottom <= outer.bottom + 1;
            return {
                count:cells.length,
                gridInside:inside(node, grid.getBoundingClientRect()),
                cellsInside:cells.every(cell => inside(grid.getBoundingClientRect(), cell.getBoundingClientRect())),
                imagesInside:cells.every(cell => [...cell.querySelectorAll('img')]
                    .every(img => inside(cell.getBoundingClientRect(), img.getBoundingClientRect()))),
                rowCount:new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().top))).size,
                declaredRows:grid.classList.contains('loading-skeleton') ? grid.style.gridTemplateRows : null,
                equalHeights:Math.max(...cells.map(cell => cell.getBoundingClientRect().height))
                    - Math.min(...cells.map(cell => cell.getBoundingClientRect().height)) < 1,
                gridRect:grid.getBoundingClientRect().toJSON(),
                cellRects:cells.map(cell => cell.getBoundingClientRect().toJSON())
            };
        });
        assert.equal(bounds.count, 4, `${label}: four cells`);
        assert.equal(bounds.gridInside, true, `${label}: grid stays inside node`);
        assert.equal(bounds.cellsInside, true, `${label}: cells stay inside grid ${JSON.stringify(bounds)}`);
        assert.equal(bounds.imagesInside, true, `${label}: images stay inside cells`);
        assert.equal(bounds.rowCount, 2, `${label}: four cells stay in two rows`);
        if(bounds.declaredRows !== null) assert.match(bounds.declaredRows, /repeat\(2,/, `${label}: both rows have reserved space`);
        assert.equal(bounds.equalHeights, true, `${label}: cells have equal heights`);
    }
    await page.waitForFunction(() => [...world.querySelectorAll('.generation-complete-cell img')]
        .every(img => img.complete && img.naturalWidth > 0));
    await assertGenerationBounds('three completed');
    await page.evaluate(() => {
        const node = nodes.find(n => n.id === fixtureId);
        node.w = 229; node.h = 249;
        updateNodeElementDuringResize(node);
    });
    await page.waitForTimeout(100);
    await assertGenerationBounds('resized mixed node');
    await page.evaluate(() => {
        // Moving a node records the current three-images/one-pending snapshot.
        pushUndo();
        window.fixturePendingSnapshot = structuredClone({...canvas, nodes});
        nodes.find(n => n.id === fixtureId).x += 20;
        render();
    });
    completed.add('fixture-3');
    await page.evaluate(() => fixtureRun);
    await page.evaluate(() => {
        const node = nodes.find(n => n.id === fixtureId);
        addSmartGenerationLog({run:{nodeId:node.id, settings:{engine:'api', model:'fixture'}}, outputs:node.images});
        performUndo();
    });
    await page.waitForFunction(() => {
        const node = nodes.find(n => n.id === fixtureId);
        const element = world.querySelector(`[data-id="${fixtureId}"]`);
        return node.images.length === 4 && !node.pending && !smartPendingTasks(node).length
            && element.querySelectorAll('.result-image-tile').length === 4
            && !element.querySelector('.generation-progress-ring');
    }, null, {timeout:8000});
    assert.equal(await page.evaluate(() => canvas.logs[0].outputs.length), 4);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === fixtureId).x), 100);
    await page.evaluate(() => collabReplaceWithServerCanvas(fixturePendingSnapshot));
    await page.waitForFunction(() => {
        const node = nodes.find(n => n.id === fixtureId);
        return node.images.length === 4 && !node.pending && !smartPendingTasks(node).length
            && !world.querySelector('.generation-progress-ring');
    }, null, {timeout:8000});
    await page.waitForFunction(() => [...world.querySelectorAll('.node-body img')].every(img => img.complete && img.naturalWidth > 0));
    await assertGenerationBounds('all completed');
    assert.deepEqual(generationRequests, [], 'recovery only queries existing tasks');
    assert.deepEqual(errors, []);
});
