const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('failed image retries in place and preserves another composer', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'canvas-retry.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!fs.existsSync(file)) file = path.join(root, 'ComfyUI/web', url.pathname.slice(8));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/retry-fixture' && route.request().method() === 'GET'){
            return route.fulfill({json:{canvas:{id:'retry-fixture', title:'Retry fixture', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, image_models:['gpt-image-2']
        }], comfy_instances:[]}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://canvas-retry.test/static/smart-canvas.html?id=retry-fixture');
    await page.waitForFunction(() => smartConfigReady && canvas?.title === 'Retry fixture');
    await page.evaluate(() => {
        const base = {...settings, engine:'api', apiKind:'image', provider_id:'fixture', model:'gpt-image-2', count:1, ratio:'story', resolution:'1k'};
        nodes = [
            {id:'reference', type:'smart-upload', x:30, y:50, images:[{url:'/output/reference.png', kind:'image', natural_w:720, natural_h:1280}]},
            {id:'failed', type:'smart-paint', x:330, y:50, images:[], runError:'没有返回图片', runFinishedAt:100,
                runSettings:{...base}, inputNodeIds:['reference'], promptDraftText:'保留产品，重新生成竖图', promptDraftHtml:'保留产品，重新生成竖图'},
            {id:'other', type:'smart-paint', x:700, y:50, images:[], runSettings:{...base, ratio:'square', resolution:'2k', count:4}}
        ];
        canvas.connections = [{from:'reference', to:'failed', kind:'input'}];
        selectedId = 'other';
        selectedIds = [];
        activeComposerSubject = null;
        lastComposerNodeId = '';
        updateComposer();
        promptInput.textContent = '正在编辑的另一个节点';
        ensureGenerationNotificationPermission = () => {};
        runApiGeneration = async (prompt, refs, imageSettings) => {
            window.retryRequest = {prompt, refs, settings:{...imageSettings}, nodeId:selectedId};
            return {taskIds:['retry-task'], providerId:'fixture', model:'gpt-image-2'};
        };
        pollSmartCanvasTask = () => new Promise((resolve, reject) => {
            window.finishRetry = resolve;
            window.failRetry = reject;
        });
        viewport = {x:0, y:0, scale:1};
        render(); applyViewport();
    });
    await page.locator('[data-id="failed"] [data-image-rerun]').click();
    await page.waitForFunction(() => !!window.finishRetry);
    const pending = await page.evaluate(() => ({
        nodeIds:nodes.map(node => node.id), connections:canvas.connections,
        request:window.retryRequest,
        failed:nodes.find(node => node.id === 'failed'), other:nodes.find(node => node.id === 'other'),
        showsFailure:world.querySelector('[data-id="failed"] .generation-failed-cell') !== null
    }));
    assert.deepEqual(pending.nodeIds, ['reference', 'failed', 'other']);
    assert.equal(pending.request.nodeId, 'failed');
    assert.equal(pending.request.settings.ratio, 'story');
    assert.equal(pending.request.settings.resolution, '1k');
    assert.match(pending.request.prompt, /保留产品/);
    assert.equal(pending.request.refs[0].url, '/output/reference.png');
    assert.equal(pending.other.runSettings.ratio, 'square');
    assert.equal(pending.other.runSettings.count, 4);
    assert.equal(pending.other.promptDraftText, '正在编辑的另一个节点');
    assert.equal(pending.showsFailure, false);
    assert.equal(pending.failed.pending, 1);
    assert.equal(pending.failed.x, 330);
    assert.equal(pending.failed.y, 50);
    assert.deepEqual(pending.connections, [{from:'reference', to:'failed', kind:'input'}]);
    await page.evaluate(() => window.failRetry(new Error('模拟上游失败')));
    await page.waitForFunction(() => nodes.find(node => node.id === 'failed')?.runError === '模拟上游失败');
    assert.equal(await page.evaluate(() => nodes.length), 3);
    await page.locator('[data-id="failed"] [data-image-rerun]').click();
    await page.waitForFunction(() => nodes.find(node => node.id === 'failed')?.pending === 1);
    await page.evaluate(() => window.finishRetry({image_items:[{url:'/output/replacement.png', kind:'image', natural_w:720, natural_h:1280}]}));
    await page.waitForFunction(() => nodes.find(node => node.id === 'failed')?.images?.[0]?.url === '/output/replacement.png');
    const finished = await page.evaluate(() => ({ids:nodes.map(node => node.id), node:nodes.find(node => node.id === 'failed'), connections:canvas.connections}));
    assert.deepEqual(finished.ids, ['reference', 'failed', 'other']);
    assert.equal(finished.node.pending, 0);
    assert.equal(finished.node.runError, undefined);
    assert.equal(finished.node.images.length, 1);
    assert.equal(finished.node.x, 330);
    assert.equal(finished.node.y, 50);
    assert.deepEqual(finished.connections, pending.connections);

    // Exercise the batch retry path while its previous error is still stored.
    await page.evaluate(() => {
        const target = nodes.find(node => node.id === 'failed');
        target.runError = '上一次详情页失败';
        const loop = {id:'detail-loop', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true};
        const originalOutputs = outputImagesForNode;
        outputImagesForNode = (node, ...args) => node.id === loop.id
            ? [{url:'/output/reference.png', name:'产品图', kind:'image', nodeId:'reference', imageIndex:0}]
            : originalOutputs(node, ...args);
        nodes.push(
            {id:'old-screen-history', type:'smart-image', x:330, y:500, isHistoryGroup:true, historyFor:'failed', images:[{url:'/output/old-screen.png'}]},
            {id:'other-history', type:'smart-image', x:700, y:500, isHistoryGroup:true, historyFor:'other', images:[{url:'/output/other-old.png'}]}
        );
        canvas.connections.push({from:'failed', to:'old-screen-history', kind:'history'}, {from:'other', to:'other-history', kind:'history'});
        const originalSubmit = runApiGeneration;
        runApiGeneration = (...args) => new Promise(resolve => {
            window.submitBatchRetry = async () => {
                runApiGeneration = originalSubmit;
                resolve(await originalSubmit(...args));
            };
        });
        window.finishRetry = null;
        window.batchRetry = runLoopRoundIntoSlot(loop, target, target, 1, {index:1, total:1})
            .catch(error => { window.batchRetryError = error.message; });
    });
    await page.waitForFunction(() => !!window.submitBatchRetry);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'failed').images), []);
    assert.equal(await page.locator('[data-id="old-screen-history"]').count(), 0);
    assert.equal(await page.evaluate(() => canvas.connections.some(conn => conn.to === 'old-screen-history')), false);
    assert.equal(await page.locator('[data-id="other-history"]').count(), 1);
    await page.evaluate(() => window.submitBatchRetry());
    await page.waitForFunction(() => !!window.finishRetry);
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'failed').runError), undefined);
    assert.equal(await page.locator('[data-id="failed"] .generation-failed-cell').count(), 0);
    await page.evaluate(async () => {
        window.failRetry(new Error('详情页重试失败'));
        await window.batchRetry;
    });
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'failed').runError), '详情页重试失败');
    assert.equal(await page.locator('[data-id="failed"] [data-image-rerun]').count(), 1);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'failed').images), []);
    assert.equal(await page.evaluate(() => nodes.filter(node => node.historyFor === 'failed').length), 0);

    await page.evaluate(() => {
        const owner = {
            id:'detail-owner', type:'smart-loop', x:30, y:360, imageInput:true, showPrompt:true,
            batchDetailModeV2:true, batchUiMode:'paired', count:1, loopStart:1,
            aiSplitPrompts:[{title:'首屏', prompt:'详情页首屏提示词'}],
            batchImageSettings:{engine:'api', apiKind:'image', provider_id:'fixture', model:'gpt-image-2', ratio:'story', resolution:'1k', count:1}
        };
        nodes.push(owner);
        canvas.connections.push({from:'reference', to:owner.id, kind:'input'});
        const target = nodes.find(item => item.id === 'failed');
        target.batchDetailOwnerId = owner.id;
        target.batchDetailScreenIndex = 1;
        target.runError = '详情批量重试失败';
        target.images = [{url:'/output/old-detail.png', natural_w:720, natural_h:1280}];
        nodes.push({id:'detail-retry-history', type:'smart-image', x:330, y:500, isHistoryGroup:true, historyFor:'failed', images:[{url:'/output/older-detail.png'}]});
        canvas.connections.push({from:'failed', to:'detail-retry-history', kind:'history'});
        window.finishRetry = null;
        target.promptDraftText = '详情页首屏提示词';
        target.promptDraftHtml = '详情页首屏提示词';
        render();
    });
    await page.locator('[data-id="failed"] [data-image-rerun]').click();
    await page.waitForFunction(() => !!window.finishRetry);
    const detailRetry = await page.evaluate(() => ({
        request:window.retryRequest,
        failed:nodes.find(item => item.id === 'failed')
    }));
    assert.equal(detailRetry.request.nodeId, 'failed');
    assert.equal(detailRetry.request.settings.provider_id, 'fixture');
    assert.equal(detailRetry.request.settings.ratio, 'story');
    assert.equal(detailRetry.failed.pending, 1);
    assert.deepEqual(detailRetry.failed.images, []);
    assert.equal(await page.locator('[data-id="detail-retry-history"]').count(), 0);
    await page.evaluate(() => window.finishRetry({image_items:[{url:'/output/detail-replacement.png', kind:'image', natural_w:720, natural_h:1280}]}));
    await page.waitForFunction(() => nodes.find(node => node.id === 'failed')?.images?.[0]?.url === '/output/detail-replacement.png');
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'failed')?.runError), undefined);
    assert.equal(await page.evaluate(() => nodes.filter(node => node.historyFor === 'failed').length), 0);

    // A successful detail screen can also be rerun from its composer.
    await page.evaluate(() => {
        const target = nodes.find(node => node.id === 'failed');
        nodes.push({id:'composer-history', type:'smart-image', x:330, y:500, isHistoryGroup:true, historyFor:target.id, images:[{url:'/output/composer-old.png'}]});
        canvas.connections.push({from:target.id, to:'composer-history', kind:'history'});
        selectedId = target.id;
        activeComposerSubject = null;
        lastComposerNodeId = '';
        updateComposer();
        window.finishRetry = null;
        window.composerRetry = runGeneration();
    });
    await page.waitForFunction(() => !!window.finishRetry);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'failed').images), []);
    assert.equal(await page.locator('[data-id="composer-history"]').count(), 0);
    await page.evaluate(async () => {
        window.finishRetry({image_items:[{url:'/output/composer-replacement.png', kind:'image', natural_w:720, natural_h:1280}]});
        await window.composerRetry;
    });
    assert.equal(await page.evaluate(() => nodes.find(node => node.id === 'failed').images[0].url), '/output/composer-replacement.png');
    assert.equal(await page.evaluate(() => nodes.filter(node => node.historyFor === 'failed').length), 0);
    assert.equal(await page.locator('[data-id="other-history"]').count(), 1);
    assert.deepEqual(errors, []);
});
