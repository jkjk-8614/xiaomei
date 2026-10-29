const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=';

test('overview deletes its results, preserves batch inputs, persists and supports undo', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:1100}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let stored = {id:'overview-delete', title:'Overview delete', logs:[], connections:[], nodes:[{
        id:'batch', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true,
        x:20, y:20, batchSourceNodeId:'local', batchSourceText:'产品资料与现成文案',
        batchVisualGuide:'保留统一视觉要求', batchCommerce:{productName:'测试产品', language:'中文'},
        batchAiTargetCount:3, batchAiProvider:'fixture', batchAiModel:'fixture-chat',
        batchImageSettings:{provider_id:'fixture', model:'gpt-image-2', ratio:'square', resolution:'1k'},
        manualInputRefs:[{url:pixel, name:'product.png', referenceId:'product-ref'}],
        aiSplitPrompts:[{title:'首屏', prompt:'第一屏提示词'}, {title:'细节', prompt:'第二屏提示词'}, {title:'尾屏', prompt:'第三屏提示词'}],
        variablePrompts:['第一屏提示词', '第二屏提示词', '第三屏提示词'], batchOverviewStarted:true
    }]};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'overview-delete.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/overview-delete'){
            if(request.method() === 'PUT') stored = {...stored, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2'], chat_models:['fixture-chat']
        }], comfy_instances:[]}});
        if(url.pathname === '/api/canvas-llm') return route.fulfill({json:{text:JSON.stringify({screens:[
            {title:'新首屏', prompt:'新第一屏'}, {title:'新细节', prompt:'新第二屏'}, {title:'新尾屏', prompt:'新第三屏'}
        ]})}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    const ready = () => page.waitForFunction(() => smartConfigReady && nodes.some(n => n.id === 'batch'));
    await page.goto('http://overview-delete.test/static/smart-canvas.html?id=overview-delete');
    await ready();
    const original = await page.evaluate(pixel => {
        const owner = nodes.find(n => n.id === 'batch');
        const paints = smartLoopDetailPaintNodes(owner);
        paints[0].images = [{url:pixel, name:'result.png', w:1, h:1}];
        paints[1].runError = {message:'测试失败'};
        paints[2].batchOverviewOnly = false;
        nodes.push({id:'result-history', type:'smart-image', historyFor:paints[0].id, x:1800, y:1000, images:[{url:pixel}]});
        nodes.push({id:'unrelated', type:'smart-image', x:1800, y:0, images:[{url:pixel}]});
        nodes.push({id:'consumer', type:'smart-paint', x:2200, y:0, inputNodeIds:[paints[0].id, 'unrelated'], images:[]});
        canvas.connections.push({from:paints[0].id, to:'consumer', kind:'input'}, {from:'unrelated', to:'consumer', kind:'input'});
        selectedId = paints[0].id; selectedIds = [paints[0].id]; selectedImage = {nodeId:paints[0].id, index:0};
        viewport = {x:0, y:50, scale:0.75};
        owner.batchOverviewOffset = {x:500, y:0};
        render(); applyViewport();
        undoStack.length = 0; redoStack.length = 0;
        return {paintIds:paints.map(n => n.id), settings:owner.batchImageSettings, refs:owner.manualInputRefs, commerce:owner.batchCommerce};
    }, pixel);
    const button = page.getByRole('button', {name:'删除结果总览', exact:true});
    assert.equal(await button.count(), 1);
    assert.equal(await button.isEnabled(), true);
    // The header controls remain usable at the supported minimum panel width.
    await page.evaluate(() => { nodes.find(n => n.id === 'batch').batchOverviewSize = {width:360, height:740}; render(); });
    const contained = await button.evaluate(element => {
        const button = element.getBoundingClientRect(), header = element.closest('header').getBoundingClientRect();
        return button.left >= header.left && button.right <= header.right && button.bottom <= header.bottom;
    });
    assert.equal(contained, true);
    await button.click();
    const read = () => page.evaluate(() => {
        const owner = nodes.find(n => n.id === 'batch');
        return {ids:nodes.map(n => n.id), source:owner.batchSourceText, guide:owner.batchVisualGuide,
            settings:owner.batchImageSettings, commerce:owner.batchCommerce, refs:owner.manualInputRefs,
            prompts:owner.aiSplitPrompts, paints:smartLoopDetailPaintNodes(owner).length,
            overview:world.querySelectorAll('.loop-batch-overview').length,
            consumer:nodes.find(n => n.id === 'consumer').inputNodeIds,
            connections:canvas.connections, undo:undoStack.length,
            selectedId, selectedIds, selectedImage,
            boundsMatch:JSON.stringify(smartBatchVisualRect(owner)) === JSON.stringify(nodeRect(owner))};
    });
    const deleted = await read();
    assert.deepEqual(deleted.ids.sort(), ['batch', 'consumer', 'unrelated']);
    assert.equal(deleted.overview, 0);
    assert.equal(deleted.paints, 0);
    assert.deepEqual(deleted.prompts, []);
    assert.equal(deleted.source, '产品资料与现成文案');
    assert.equal(deleted.guide, '保留统一视觉要求');
    assert.deepEqual(deleted.settings, original.settings);
    assert.deepEqual(deleted.commerce, original.commerce);
    assert.deepEqual(deleted.refs, original.refs);
    assert.deepEqual(deleted.consumer, ['unrelated']);
    assert.deepEqual(deleted.connections, [{from:'unrelated', to:'consumer', kind:'input'}]);
    assert.equal(deleted.undo, 1, 'deleting the entire overview is one undo operation');
    assert.equal(deleted.selectedId, '');
    assert.deepEqual(deleted.selectedIds, []);
    assert.equal(deleted.selectedImage.nodeId, '');
    assert.equal(deleted.boundsMatch, true, 'deleted panel no longer expands canvas bounds');
    await page.evaluate(() => performUndo());
    assert.equal((await read()).overview, 1);
    assert.equal((await read()).paints, 3);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === smartLoopDetailPaintNodes(nodes.find(n => n.id === 'batch'))[0].id).images[0].name), 'result.png');
    await page.evaluate(() => performRedo());
    assert.equal((await read()).overview, 0);
    await page.evaluate(() => saveCanvas());
    assert.deepEqual(stored.nodes.map(n => n.id).sort(), ['batch', 'consumer', 'unrelated']);
    await page.reload();
    await ready();
    assert.equal((await read()).overview, 0, 'reload must not recreate deleted results');
    assert.equal((await read()).paints, 0);
    await page.evaluate(() => runSmartLoopAiSplit('batch'));
    assert.equal((await read()).overview, 1, 'the preserved batch can produce a new overview');
    assert.equal((await read()).paints, 3);
    assert.ok((await read()).ids.every(id => !original.paintIds.includes(id)), 'new split gets new screen nodes');

    // Both the UI and the mutation guard protect active tasks and collaboration locks.
    for(const mode of ['split', 'batch', 'screen', 'stitch', 'readonly', 'locked']){
        const result = await page.evaluate(mode => {
            const owner = nodes.find(n => n.id === 'batch');
            const target = smartLoopDetailPaintNodes(owner)[0];
            if(mode === 'split') owner.aiSplitRunning = true;
            if(mode === 'batch') smartCascadeRuns.set(owner.id, {loopId:owner.id});
            if(mode === 'screen') target.pending = 1;
            if(mode === 'stitch') detailStitchInFlight.add(owner.id);
            if(mode === 'readonly') sharedCanvasReadOnly = true;
            if(mode === 'locked') collabLocks.set(target.id, {member:{id:'other-member', name:'其他成员'}});
            render();
            const disabled = world.querySelector('[data-batch-delete-overview]').disabled;
            const before = nodes.length, undo = undoStack.length;
            deleteSmartBatchOverview(owner);
            const unchanged = nodes.length === before && undoStack.length === undo && owner.aiSplitPrompts.length === 3;
            owner.aiSplitRunning = false;
            smartCascadeRuns.delete(owner.id); target.pending = 0; detailStitchInFlight.delete(owner.id);
            sharedCanvasReadOnly = false; collabLocks.delete(target.id);
            render();
            return {disabled, unchanged};
        }, mode);
        assert.equal(result.unchanged, true, `${mode} must prevent partial deletion`);
        if(!['readonly', 'locked'].includes(mode)) assert.equal(result.disabled, true, `${mode} disables the delete button`);
    }
    assert.deepEqual(errors, []);
});
