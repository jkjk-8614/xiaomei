const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function fixture(t, scale = 0.65) {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1100}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let saved = {id:'resize-fixture',title:'Resize fixture',nodes:[],connections:[],logs:[],settings:{}};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'selection-resize.test') return route.abort();
        if(url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.endsWith('.svg')) return route.fulfill({contentType:'image/svg+xml',body:
            `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${url.pathname.includes('portrait') ? 400 : 300}"><rect width="100%" height="100%" fill="#b5cbbc"/></svg>`});
        if(url.pathname === '/api/canvases/resize-fixture') {
            if(route.request().method() === 'PUT') saved = {...saved, ...route.request().postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
    });
    await page.goto('http://selection-resize.test/static/smart-canvas.html?id=resize-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Resize fixture');
    const ids = await page.evaluate(scale => {
        viewport = {x:180,y:70,scale};
        canvasViewPrefs.autoAvoid = true;
        applyViewport();
        const image = (portrait=false) => ({url:portrait ? '/portrait.svg' : '/square.svg',kind:'image',natural_w:300,natural_h:portrait ? 400 : 300});
        const make = (x,y,images,w,h) => {
            const node = createNode(x,y,images,{nodeType:'smart-upload',select:false,skipUndo:true,autoAvoid:false});
            Object.assign(node,{w,h,manualSize:true,scale:1});
            return node;
        };
        const a = make(300,100,[image(true)],180,240);
        const b = make(280,390,[image()],180,180);
        const c = make(310,620,Array.from({length:4},() => image()),232,232);
        const outside = make(1100,400,[image()],180,180);
        canvas.connections = [{from:a.id,to:outside.id},{from:b.id,to:outside.id},{from:c.id,to:outside.id}];
        selectedId = '';
        selectedIds = [];
        undoStack.length = 0;
        render();
        return {selected:[a.id,b.id,c.id],outside:outside.id};
    }, scale);
    // Exercise the actual box-selection gesture, including the following click guard.
    const points = await page.evaluate(() => {
        const shellRect = shell.getBoundingClientRect();
        const p = (x,y) => ({x:shellRect.left+viewport.x+x*viewport.scale,y:shellRect.top+viewport.y+y*viewport.scale});
        return {start:p(240,60),end:p(580,890)};
    });
    await page.keyboard.down('r');
    await page.mouse.move(points.start.x,points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x,points.end.y,{steps:8});
    await page.mouse.up();
    await page.keyboard.up('r');
    await page.waitForFunction(() => selectedNodeIds().length === 3);
    await page.locator('.smart-selection-resize-handle').waitFor();
    return {page,ids};
}

async function read(page) {
    return page.evaluate(() => ({
        nodes:nodes.map(node => ({id:node.id,rect:nodeRect(node),images:JSON.parse(JSON.stringify(node.images))})),
        selected:selectedNodeIds(),connections:JSON.parse(JSON.stringify(canvas.connections)),undo:undoStack.length,
        viewport:{...viewport}
    }));
}

async function drag(page, dx, dy, selector='.smart-selection-resize-handle') {
    const rect = await page.locator(selector).boundingBox();
    assert.ok(rect);
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
    await page.mouse.down();
    await page.mouse.move(rect.x+rect.width/2+dx,rect.y+rect.height/2+dy,{steps:10});
    await page.mouse.up();
    await page.waitForFunction(() => !resizeState);
}

function checkScaled(before, after, ids, ratio) {
    const selected = before.nodes.filter(node => ids.selected.includes(node.id));
    const x = Math.min(...selected.map(node => node.rect.x));
    const y = Math.min(...selected.map(node => node.rect.y));
    for(const node of selected) {
        const next = after.nodes.find(item => item.id === node.id);
        for(const key of ['width','height']) assert.ok(Math.abs(next.rect[key]-node.rect[key]*ratio)<4,`${key}: ${JSON.stringify(next.rect)}`);
        assert.ok(Math.abs(next.rect.x-(x+(node.rect.x-x)*ratio))<1);
        assert.ok(Math.abs(next.rect.y-(y+(node.rect.y-y)*ratio))<1,JSON.stringify({ratio,before:node.rect,after:next.rect,viewport:before.viewport}));
        assert.deepEqual(next.images,node.images);
    }
    assert.deepEqual(after.nodes.find(node => node.id === ids.outside),before.nodes.find(node => node.id === ids.outside));
    assert.deepEqual(after.connections,before.connections);
    assert.deepEqual(after.selected,before.selected);
    assert.deepEqual(after.viewport,before.viewport);
}

test('box-selected images scale together, undo/redo once, and survive save/reload', {timeout:40000}, async t => {
    const {page,ids} = await fixture(t);
    const before = await read(page);
    const bounds = await page.evaluate(() => selectionToolbarBounds());
    const dy = (bounds.maxY-bounds.minY)*0.65*0.25;
    await drag(page,0,dy);
    const enlarged = await read(page);
    checkScaled(before,enlarged,ids,1.25);
    await page.screenshot({path:path.join(require('node:os').tmpdir(),'xiaomei-selection-resize.png')});
    assert.equal(enlarged.undo,1);
    await page.keyboard.press('Control+z');
    assert.deepEqual((await read(page)).nodes,before.nodes);
    await page.keyboard.press('Control+Shift+z');
    assert.deepEqual((await read(page)).nodes,enlarged.nodes);
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes.length === 4);
    assert.deepEqual((await read(page)).nodes,enlarged.nodes);
});

test('selection and member handles shrink proportionally at different canvas zooms', {timeout:60000}, async t => {
    for(const scale of [0.25,1,1.5]) {
        const {page,ids} = await fixture(t,scale);
        // Reframe at high zoom so the lower-right selection corner remains visible.
        if(scale > 1) await page.evaluate(() => { viewport.y = -500; viewport.x = -100; applyViewport(); });
        const before = await read(page);
        const handle = await page.locator('.smart-selection-resize-handle').boundingBox();
        assert.ok(Math.abs(handle.width-24)<1,JSON.stringify(handle));
        const b = await page.evaluate(() => selectionToolbarBounds());
        const dx = -Math.round((b.maxX-b.minX)*scale*0.2);
        await drag(page,dx,0);
        const shrunk = await read(page);
        checkScaled(before,shrunk,ids,1+dx/((b.maxX-b.minX)*scale));
        await page.evaluate(() => performUndo());
        if(scale > 1) await page.evaluate(() => { viewport.y = 30; viewport.x = 30; applyViewport(); });
        const start = await read(page);
        const member = start.nodes.find(node => node.id === ids.selected[0]);
        const minX = Math.min(...start.nodes.filter(node => ids.selected.includes(node.id)).map(node => node.rect.x));
        const memberDx = Math.round((member.rect.x+member.rect.width-minX)*scale*0.2);
        await drag(page,memberDx,0,`.image-node[data-id="${member.id}"] .node-resize-handle`);
        checkScaled(start,await read(page),ids,1+memberDx/((member.rect.x+member.rect.width-minX)*scale));
        await page.close();
    }
});

test('no-op, minimum size, locks, read-only and mixed selections are safe', {timeout:40000}, async t => {
    const {page,ids} = await fixture(t);
    const before = await read(page);
    await drag(page,0,0);
    assert.deepEqual(await read(page),before);
    await page.evaluate(id => collabLocks.set(id,{member:{id:'other',name:'Fixture'}}),ids.selected[1]);
    await drag(page,20,20);
    assert.deepEqual(await read(page),before);
    await page.evaluate(() => collabLocks.clear());
    await drag(page,-800,-800);
    const minimum = await read(page);
    checkScaled(before,minimum,ids,96/232);
    for(const node of minimum.nodes.filter(node => ids.selected.includes(node.id))) {
        assert.ok(node.rect.width>=47 && node.rect.height>=47);
    }
    await page.evaluate(() => { performUndo(); sharedCanvasReadOnly=true; render(); });
    assert.equal(await page.locator('.smart-selection-resize-handle').count(),0);
    await page.evaluate(() => {
        sharedCanvasReadOnly=false;
        const prompt = createPromptNode(900,100,{select:false,skipUndo:true});
        selectedIds.push(prompt.id);
        render();
    });
    assert.equal(await page.locator('.smart-selection-resize-handle').count(),0);
});
