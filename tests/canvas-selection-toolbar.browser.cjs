const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('selection toolbar stays above its frame during zoom and pan', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const root = path.resolve(__dirname, '..');
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'selection.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/fixture.svg') return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="180" height="300"><rect width="180" height="300" fill="#c7d9cc"/></svg>'});
        if(url.pathname === '/api/canvases/selection-fixture') return route.fulfill({json:{canvas:{
            id:'selection-fixture', title:'Selection fixture', nodes:[], connections:[], logs:[], settings:{}
        }}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://selection.test/static/smart-canvas.html?id=selection-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Selection fixture');
    await page.evaluate(() => {
        const ids = [];
        for(let i = 0; i < 5; i++){
            const node = createNode(800 + (i % 3) * 400, 600 + Math.floor(i / 3) * 500,
                [{url:'/fixture.svg', kind:'image', natural_w:180, natural_h:300}],
                {nodeType:SMART_UPLOAD_NODE_TYPE, select:false});
            ids.push(node.id);
        }
        selectedId = '';
        selectedIds = ids;
        viewport = {x:-100, y:-50, scale:0.4};
        applyViewport();
        // Select after zooming, without another viewport update.
        syncSelectionUi();
    });
    const sample = () => page.evaluate(() => {
        const toolbar = world.querySelector('.smart-selection-toolbar');
        const frame = world.querySelector('.smart-selection-frame');
        const a = toolbar.getBoundingClientRect();
        const b = frame?.getBoundingClientRect() || null;
        const batchPort = world.querySelector('.smart-selection-batch-port')?.getBoundingClientRect() || null;
        return {
            width:a.width, height:a.height,
            hasFrame:Boolean(frame),
            centerDelta:b ? (a.left + a.width / 2) - (b.left + b.width / 2) : null,
            gap:b ? b.top - a.bottom : null,
            visible:getComputedStyle(toolbar).opacity,
            individualVisible:[...world.querySelectorAll('.smart-node-floating-menu')].some(el => getComputedStyle(el).opacity !== '0'),
            count:world.querySelectorAll('.smart-selection-toolbar').length,
            batchCenterDelta:b && batchPort ? batchPort.top + batchPort.height / 2 - (b.top + b.height / 2) : null,
            batchGap:b && batchPort ? batchPort.left + batchPort.width / 2 - b.right : null,
            scale:viewport.scale
        };
    });
    const batchPortState = await page.evaluate(() => ({
        count:world.querySelectorAll('.smart-selection-batch-port').length,
        individualOutputVisible:[...world.querySelectorAll('.image-node.selected .node-port.port-out')].some(el => {
            const style = getComputedStyle(el);
            return style.visibility !== 'hidden' && style.opacity !== '0' && style.pointerEvents !== 'none';
        }),
        toolbarText:world.querySelector('.smart-selection-toolbar')?.textContent || ''
    }));
    assert.equal(batchPortState.count, 1);
    assert.equal(await page.evaluate(() => {
        const port = world.querySelector('.smart-selection-batch-port');
        if(!port) return false;
        const style = getComputedStyle(port);
        return style.visibility === 'visible' && style.pointerEvents === 'auto' && getComputedStyle(port, '::after').opacity === '1';
    }), true);
    const batchSinkId = await page.evaluate(() => createPaintNodeAt({x:2200, y:1200}, {select:false, skipUndo:true}).id);
    const batchPort = await page.locator('.smart-selection-batch-port').boundingBox();
    const batchSinkPort = await page.locator(`.image-node[data-id="${batchSinkId}"] .node-port.port-in`).boundingBox();
    assert.ok(batchPort && batchSinkPort, 'multi-selection should expose a draggable batch output port');
    await page.mouse.move(batchPort.x + batchPort.width / 2, batchPort.y + batchPort.height / 2);
    await page.mouse.down();
    await page.mouse.move(batchSinkPort.x + batchSinkPort.width / 2, batchSinkPort.y + batchSinkPort.height / 2, {steps:8});
    await page.mouse.up();
    const batchConnections = await page.evaluate(batchSinkId => canvas.connections.filter(connection => connection.to === batchSinkId), batchSinkId);
    assert.equal(batchConnections.length, 5);
    const selectedSources = await page.evaluate(() => selectedNodeIds());
    const outputPort = await page.locator('.smart-selection-batch-port').boundingBox();
    await page.mouse.move(outputPort.x + outputPort.width / 2, outputPort.y + outputPort.height / 2);
    await page.mouse.down();
    await page.mouse.move(1100, 620, {steps:8});
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('createMenu')?.classList.contains('open'));
    await page.locator('#createMenu [data-create-type="paint"]').click();
    assert.equal(await page.evaluate(sourceIds => {
        const targetId = selectedId;
        return canvas.connections.filter(connection => connection.to === targetId && sourceIds.includes(connection.from)).length;
    }, selectedSources), 5, 'the new paint node should receive all selected uploads');
    await page.evaluate(ids => { selectedId = ''; selectedIds = ids; syncSelectionUi(); }, selectedSources);
    assert.equal(batchPortState.individualOutputVisible, false);
    assert.equal(batchPortState.toolbarText.includes('发送到对话'), false);
    assert.equal(batchPortState.toolbarText.includes('保存到素材库'), false);
    const samples = [await sample()];
    for(const scale of [0.25, 0.5, 1, 2]){
        await page.evaluate(scale => {
            viewport = {x:220 - 776 * scale, y:180 - 576 * scale, scale};
            applyViewport();
        }, scale);
        samples.push(await sample());
    }
    for(const value of samples){
        assert.equal(value.count, 1);
        assert.equal(value.hasFrame, true);
        assert.equal(value.visible, '1');
        assert.equal(value.individualVisible, false);
        assert.ok(Math.abs(value.centerDelta) < 1, JSON.stringify(value));
        assert.ok(Math.abs(value.gap - 10) < 1, JSON.stringify(value));
        assert.ok(Math.abs(value.batchCenterDelta) < 1, JSON.stringify(value));
        assert.ok(Math.abs(value.batchGap - 24 * value.scale) < 1, JSON.stringify(value));
        assert.ok(Math.abs(value.width - samples[0].width) < 3, JSON.stringify(value));
        assert.ok(Math.abs(value.height - samples[0].height) < 1, JSON.stringify(value));
    }
    await page.locator('[data-smart-selection-arrange-toggle]').click();
    const arrangeMenuLayout = await page.evaluate(() => [...world.querySelectorAll('.smart-selection-arrange-menu [data-smart-selection-action]')].map(el => {
        const rect = el.getBoundingClientRect();
        return {x:rect.left, y:rect.top, width:rect.width};
    }));
    assert.equal(arrangeMenuLayout.length, 3);
    assert.ok(arrangeMenuLayout.every(item => Math.abs(item.x - arrangeMenuLayout[0].x) < 1));
    assert.ok(arrangeMenuLayout.every(item => Math.abs(item.width - arrangeMenuLayout[0].width) < 1));
    assert.ok(arrangeMenuLayout[1].y > arrangeMenuLayout[0].y && arrangeMenuLayout[2].y > arrangeMenuLayout[1].y);
    await page.locator('[data-smart-selection-action="arrange-horizontal"]').click();
    assert.equal(await page.evaluate(() => selectedNodeIds().length), 5);
    const afterArrange = await sample();
    assert.ok(Math.abs(afterArrange.centerDelta) < 1);
    assert.ok(Math.abs(afterArrange.gap - 10) < 1);
    const batchSourceCount = await page.evaluate(() => {
        const sourceId = selectedNodeIds()[0];
        return portDragPreviewSourceIds({fromId:sourceId, fromPort:'out', hoverTargetId:'target'}).length;
    });
    assert.equal(batchSourceCount, 5);
    await page.evaluate(() => { clearSelection(); syncSelectionUi(); });
    assert.equal(await page.locator('.smart-selection-toolbar').count(), 0);
    assert.equal(await page.locator('.smart-selection-frame').count(), 0);
    assert.equal(await page.locator('.smart-selection-batch-port').count(), 0);
    const multiImageId = await page.evaluate(() => {
        viewport = {x:0, y:0, scale:0.5};
        applyViewport();
        const images = Array.from({length:5}, () => ({url:'/fixture.svg', kind:'image', natural_w:180, natural_h:300}));
        return createNode(600, 500, images, {nodeType:SMART_UPLOAD_NODE_TYPE, select:true}).id;
    });
    await page.evaluate(() => { clearSelection(); syncSelectionUi(); });
    await page.locator(`.image-node[data-id="${multiImageId}"]`).click({position:{x:7, y:7}});
    await page.waitForFunction(() => {
        const port = world.querySelector('.image-node.group-node.selected .node-port.port-out');
        return port && getComputedStyle(port).opacity === '1';
    });
    const multiImage = await sample();
    assert.equal(multiImage.count, 1);
    assert.equal(multiImage.hasFrame, false);
    assert.equal(multiImage.centerDelta, null);
    assert.equal(multiImage.gap, null);
    assert.equal(multiImage.individualVisible, false);
    const singleGroupPorts = await page.evaluate(() => {
        const group = world.querySelector('.image-node.group-node.selected');
        const port = group.querySelector('.node-port.port-out');
        return {
            inputs:group.querySelectorAll('.node-port.port-in').length,
            visibility:getComputedStyle(port).visibility,
            pointerEvents:getComputedStyle(port).pointerEvents,
            plusOpacity:getComputedStyle(port, '::after').opacity
        };
    });
    assert.equal(singleGroupPorts.inputs, 0);
    assert.equal(singleGroupPorts.visibility, 'visible');
    assert.equal(singleGroupPorts.pointerEvents, 'auto');
    assert.equal(singleGroupPorts.plusOpacity, '1');
    assert.equal(await page.locator('.smart-selection-batch-port').count(), 0);
    assert.equal(await page.evaluate(() => composer.classList.contains('open')), false);
    await page.evaluate(multiImageId => {
        selectedIds = [multiImageId, nodes.find(node => node.id !== multiImageId).id];
        selectedId = '';
        syncSelectionUi();
    }, multiImageId);
    const mixedSelectionPortState = await page.evaluate(multiImageId => [...world.querySelectorAll('.image-node.selected')].map(node => {
        const port = node.querySelector('.node-port.port-out');
        const style = getComputedStyle(port);
        return {isGroup:node.dataset.id === multiImageId, visible:style.visibility === 'visible' && style.pointerEvents === 'auto'};
    }), multiImageId);
    assert.equal(mixedSelectionPortState.find(item => item.isGroup)?.visible, true);
    assert.equal(mixedSelectionPortState.filter(item => !item.isGroup).every(item => item.visible === false), true);
    assert.deepEqual(errors, []);
});
