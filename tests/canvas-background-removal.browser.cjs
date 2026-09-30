const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

test('canvas batch background removal keeps source groups and processes images in order', { timeout: 60000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    const removalCalls = [];
    let engineStatusCalls = 0;
    let removalMode = 'success';
    let holdNextRemoval = false;
    let releaseRemoval = null;

    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if(url.hostname !== 'xiaomei-reference.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            if(!fs.existsSync(file)) return route.fulfill({contentType:'application/javascript', body:''});
            return route.fulfill({path:file});
        }
        if(pathname.includes('media-preview') || pathname.endsWith('.png')){
            return route.fulfill({contentType:'image/png', body:pixel});
        }
        if(pathname === '/api/background-removal/status'){
            engineStatusCalls += 1;
            return route.fulfill({json:{
                engine:{available:true, default_model_id:'bria-rmbg-2.0', device:'CPU', device_is_gpu:false, provider_verified:true},
                models:[{id:'bria-rmbg-2.0', name:'Fixture RMBG', available:true, downloaded:true, status:'downloaded'}]
            }});
        }
        if(pathname === '/api/image/background-removal'){
            const body = request.postDataJSON();
            removalCalls.push(body);
            if(holdNextRemoval){
                holdNextRemoval = false;
                await new Promise(resolve => { releaseRemoval = resolve; });
            }
            const source = String(body.source_url || '');
            const shouldFail = removalMode === 'all-fail' || (removalMode === 'partial' && source.includes('batch-b.png'));
            if(shouldFail){
                return route.fulfill({status:422, contentType:'application/json', body:JSON.stringify({detail:`模拟失败：${body.name || source}`} )});
            }
            const stem = path.basename(source).replace(/\.[^.]+$/, '') || 'image';
            return route.fulfill({json:{
                url:`/output/bg-${stem}.png`,
                name:`${stem}_透明底.png`,
                width:320,
                height:240,
                model_id:'bria-rmbg-2.0',
                backend:'onnx',
                derived_from:{url:source, operation:'background-removal'},
                background_removal:{model_id:'bria-rmbg-2.0', auto_center:true}
            }});
        }
        if(pathname === '/api/config'){
            return route.fulfill({json:{
                api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image'], video_models:[]}],
                comfy_instances:[]
            }});
        }
        if(pathname === '/api/canvases/reference-fixture'){
            return route.fulfill({json:{canvas:{
                id:'reference-fixture', title:'Background removal fixture', nodes:[], connections:[], logs:[],
                settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}
            }}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });

    await page.goto('http://xiaomei-reference.test/static/smart-canvas.html?id=reference-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Background removal fixture');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const resetCanvas = async () => {
        removalCalls.length = 0;
        engineStatusCalls = 0;
        await page.evaluate(() => {
            nodes = [];
            canvas.connections = [];
            selectedId = '';
            selectedIds = [];
            selectedImage = {nodeId:'', index:-1};
            render();
        });
        await wait(30);
    };
    const waitForOutput = async sourceId => {
        await page.waitForFunction(id => nodes.some(node => node.id !== id && node.title === '透明底'), sourceId);
        return page.evaluate(sourceId => {
            const source = nodes.find(node => node.id === sourceId);
            const output = nodes.find(node => node.id !== sourceId && node.title === '透明底');
            return {
                source,
                output,
                connections:(canvas.connections || []).filter(connection => connection.from === sourceId && connection.to === output?.id)
            };
        }, sourceId);
    };

    // 普通多图节点：按 images 顺序处理，并跳过视频。
    removalMode = 'success';
    await resetCanvas();
    const multiId = await page.evaluate(() => {
        const node = createNode(160, 160, [
            {url:'/output/batch-a.png', name:'batch-a.png', kind:'image', natural_w:100, natural_h:80},
            {url:'/output/batch-b.png', name:'batch-b.png', kind:'image', natural_w:120, natural_h:90},
            {url:'/output/preview.mp4', name:'preview.mp4', kind:'video'},
            {url:'/output/batch-c.png', name:'batch-c.png', kind:'image', natural_w:140, natural_h:100}
        ], {nodeType:'smart-paint', select:true});
        selectedId = node.id;
        render();
        return node.id;
    });
    const multiAction = page.locator(`[data-smart-node-action="background-remove"][data-node-id="${multiId}"]`);
    assert.equal(await multiAction.getAttribute('title'), '批量去背景');
    await multiAction.click();
    const multiResult = await waitForOutput(multiId);
    assert.deepEqual(removalCalls.map(call => call.source_url), [
        '/output/batch-a.png', '/output/batch-b.png', '/output/batch-c.png'
    ]);
    assert.deepEqual(multiResult.output.images.map(image => image.derived_from.url), removalCalls.map(call => call.source_url));
    assert.equal(multiResult.output.images.length, 3);
    assert.deepEqual(multiResult.output.images.map(image => [image.natural_w, image.natural_h]), [[320, 240], [320, 240], [320, 240]]);
    assert.equal(engineStatusCalls, 1);
    assert.deepEqual(multiResult.source.images.map(image => image.url), [
        '/output/batch-a.png', '/output/batch-b.png', '/output/preview.mp4', '/output/batch-c.png'
    ]);
    assert.equal(multiResult.connections.length, 1);

    // 智能分组：使用同一收集器和同一批处理入口，输出仍连接到分组本体。
    await resetCanvas();
    const groupId = await page.evaluate(() => {
        const group = createSmartGroupNode(180, 180, {select:true});
        group.images = [
            {url:'/output/group-a.png', name:'group-a.png', kind:'image', natural_w:100, natural_h:80},
            {url:'/output/group-a.mp3', name:'group-a.mp3', kind:'audio'},
            {url:'/output/group-b.png', name:'group-b.png', kind:'image', natural_w:120, natural_h:90}
        ];
        selectedId = group.id;
        render();
        return group.id;
    });
    const groupAction = page.locator(`[data-smart-group-action="background-remove"][data-node-id="${groupId}"]`);
    assert.equal(await groupAction.getAttribute('title'), '批量去背景');
    await groupAction.click();
    const groupResult = await waitForOutput(groupId);
    assert.deepEqual(removalCalls.map(call => call.source_url), ['/output/group-a.png', '/output/group-b.png']);
    assert.equal(groupResult.output.images.length, 2);
    assert.equal(groupResult.connections.length, 1);
    assert.deepEqual(groupResult.source.images.map(image => image.url), ['/output/group-a.png', '/output/group-a.mp3', '/output/group-b.png']);
    assert.equal(engineStatusCalls, 1);

    // 部分失败只输出成功图片，并在提示中列出失败文件和原因。
    removalMode = 'partial';
    await resetCanvas();
    const partialId = await page.evaluate(() => {
        const node = createNode(160, 160, [
            {url:'/output/batch-a.png', name:'batch-a.png', kind:'image'},
            {url:'/output/batch-b.png', name:'batch-b.png', kind:'image'},
            {url:'/output/batch-c.png', name:'batch-c.png', kind:'image'}
        ], {nodeType:'smart-upload', select:true});
        selectedId = node.id;
        render();
        return node.id;
    });
    await page.locator(`[data-smart-node-action="background-remove"][data-node-id="${partialId}"]`).click();
    const partialResult = await waitForOutput(partialId);
    assert.equal(partialResult.output.images.length, 2);
    assert.deepEqual(partialResult.output.images.map(image => image.derived_from.url), ['/output/batch-a.png', '/output/batch-c.png']);
    assert.match(await page.locator('#toast').textContent(), /成功 2 张/);
    assert.match(await page.locator('#toast').textContent(), /失败 1 张/);
    assert.match(await page.locator('#toast').textContent(), /batch-b\.png/);
    assert.match(await page.locator('#toast').textContent(), /模拟失败/);

    // 全部失败时不创建空透明底组。
    removalMode = 'all-fail';
    await resetCanvas();
    const allFailId = await page.evaluate(() => {
        const node = createNode(160, 160, [
            {url:'/output/all-a.png', name:'all-a.png', kind:'image'},
            {url:'/output/all-b.png', name:'all-b.png', kind:'image'}
        ], {nodeType:'smart-upload', select:true});
        selectedId = node.id;
        render();
        return node.id;
    });
    await page.locator(`[data-smart-node-action="background-remove"][data-node-id="${allFailId}"]`).click();
    await page.waitForFunction(id => smartBackgroundRemovalBusy === false, allFailId);
    const allFailResult = await page.evaluate(sourceId => ({
        nodeCount:nodes.length,
        sourceImages:nodes.find(node => node.id === sourceId)?.images?.map(image => image.url),
        transparentCount:nodes.filter(node => node.title === '透明底').length
    }), allFailId);
    assert.equal(allFailResult.nodeCount, 1);
    assert.deepEqual(allFailResult.sourceImages, ['/output/all-a.png', '/output/all-b.png']);
    assert.equal(allFailResult.transparentCount, 0);
    assert.match(await page.locator('#toast').textContent(), /成功 0 张/);

    // 忙碌时重复触发不会启动第二个批次。
    removalMode = 'success';
    await resetCanvas();
    const duplicateId = await page.evaluate(() => {
        const node = createNode(160, 160, [
            {url:'/output/duplicate-a.png', name:'duplicate-a.png', kind:'image'},
            {url:'/output/duplicate-b.png', name:'duplicate-b.png', kind:'image'}
        ], {nodeType:'smart-upload', select:true});
        selectedId = node.id;
        render();
        return node.id;
    });
    holdNextRemoval = true;
    await page.evaluate(id => {
        runSmartNodeToolbarAction(id, 'background-remove');
        runSmartNodeToolbarAction(id, 'background-remove');
    }, duplicateId);
    for(let attempt = 0; attempt < 100 && removalCalls.length < 1; attempt += 1) await wait(20);
    assert.equal(removalCalls.length, 1);
    await page.waitForFunction(() => document.getElementById('smartBackgroundRemovalStatusDetail')?.textContent.includes('第 1/2 张'));
    assert.ok(releaseRemoval, 'the first removal request should be held for duplicate-click verification');
    releaseRemoval();
    releaseRemoval = null;
    await waitForOutput(duplicateId);
    assert.equal(removalCalls.length, 2);

    // 单图工具栏继续使用“去背景”，并只提交当前图片。
    await resetCanvas();
    const singleId = await page.evaluate(() => {
        const node = createNode(160, 160, [{url:'/output/single.png', name:'single.png', kind:'image'}], {nodeType:'smart-upload', select:true});
        selectedId = node.id;
        render();
        return node.id;
    });
    const singleAction = page.locator(`[data-smart-node-action="background-remove"][data-node-id="${singleId}"]`);
    assert.equal(await singleAction.getAttribute('title'), '去背景');
    await singleAction.click();
    const singleResult = await waitForOutput(singleId);
    assert.deepEqual(removalCalls.map(call => call.source_url), ['/output/single.png']);
    assert.equal(singleResult.output.images.length, 1);
    assert.equal(singleResult.connections.length, 1);

    // 预览右键菜单仍走单图入口。
    await resetCanvas();
    const contextId = await page.evaluate(() => {
        const node = createNode(160, 160, [{url:'/output/context.png', name:'context.png', kind:'image'}], {nodeType:'smart-upload', select:true});
        selectedId = node.id;
        render();
        openImagePreview(node.id, 0);
        return node.id;
    });
    await page.locator('#previewCurrentImage').click({button:'right'});
    assert.equal(await page.locator('#previewImageContextMenu').isHidden(), false);
    await page.locator('#previewImageContextBackgroundRemove').click();
    const contextResult = await waitForOutput(contextId);
    assert.deepEqual(removalCalls.map(call => call.source_url), ['/output/context.png']);
    assert.equal(contextResult.output.images.length, 1);
    assert.equal(contextResult.connections.length, 1);

    assert.deepEqual(errors, []);
});
