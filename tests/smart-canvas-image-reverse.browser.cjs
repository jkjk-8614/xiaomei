const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const image = {url:'/output/reverse-fixture.png', kind:'image', name:'测试图片.png', natural_w:300, natural_h:300};
const fixtureImage = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#f3f1ed"/><rect x="85" y="65" width="130" height="155" rx="20" fill="#b83b35"/><text x="150" y="266" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#292826">TEST IMAGE</text></svg>';
const providers = [
    {id:'vision-fixture', name:'测试视觉平台', enabled:true, chat_models:['vision-fixture-model'], image_models:[]},
    {id:'other-fixture', name:'其他视觉平台', enabled:true, chat_models:['other-vision-model'], image_models:[]},
];

async function fixture(t, {holdConfig=false}={}) {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    let saved = {id:'reverse-fixture', title:'反推提示词测试', nodes:[], connections:[], logs:[], settings:{}, viewport:{x:0,y:0,scale:1}};
    let releaseConfig;
    const configGate = holdConfig ? new Promise(resolve => {releaseConfig = resolve;}) : Promise.resolve();
    let reply = route => route.fulfill({json:{text:'白色背景上的红色陶瓷杯，居中构图，左侧柔光，细腻釉面质感。'}});
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'image-reverse.test') return route.abort();
        if(url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === image.url || (url.pathname === '/api/media-preview' && url.searchParams.get('url') === image.url)) {
            return route.fulfill({contentType:'image/svg+xml', body:fixtureImage});
        }
        if(url.pathname === '/api/config') {
            await configGate;
            return route.fulfill({json:{api_providers:providers, comfy_instances:[]}});
        }
        if(url.pathname === '/api/canvases/reverse-fixture') {
            if(request.method() === 'PUT') saved = {...saved, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:saved}});
        }
        if(url.pathname === '/api/canvas-llm') {
            calls.push(request.postDataJSON());
            return reply(route);
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://image-reverse.test/static/smart-canvas.html?id=reverse-fixture');
    await page.waitForFunction(() => canvas?.id === 'reverse-fixture');
    return {page, errors, calls, releaseConfig, saved:() => saved, reply:fn => {reply = fn;}};
}

async function capture(page, name) {
    const directory = process.env.XIAOMEI_REVERSE_ARTIFACT_DIR;
    if(!directory) return;
    fs.mkdirSync(directory, {recursive:true});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(directory, name), fullPage:true, animations:'disabled'});
}

async function pointerClick(page, locator) {
    const box = await locator.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('reverse preset starts from the creation menu, uses dynamic models and persists editable text', {timeout:45000}, async t => {
    const f = await fixture(t, {holdConfig:true}), {page} = f;
    await page.evaluate(() => openCreateMenu({clientX:140, clientY:40}, {point:{x:650,y:350}}));
    await capture(page, 'image-reverse-menu.png');
    await page.locator('#createMenu [data-create-type="image-reverse"]').click();
    const id = await page.evaluate(() => nodes.find(node => node.promptPreset === 'image-reverse').id);
    const card = page.locator(`.image-node[data-id="${id}"]`);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).llmEnabled, id), true);
    assert.equal(await card.locator('.prompt-llm-toggle').count(), 0);
    assert.equal(await card.locator('.prompt-reverse-ref-btn').count(), 0);
    assert.equal(await card.locator('.prompt-llm-provider').isVisible(), true);
    assert.equal(await card.locator('.prompt-llm-model').isVisible(), true);
    assert.equal(await card.locator('.prompt-llm-instruction').isVisible(), false);
    assert.match(await card.locator('.prompt-llm-instruction').inputValue(), /中文提示词/);
    assert.equal(await card.locator('.prompt-node-run').innerText(), '反推');
    assert.deepEqual(await page.evaluate(id => {
        const node = nodes.find(node => node.id === id);
        return [node.llmProvider, node.llmModel];
    }, id), ['', ''], 'creation before config loads must not save a guessed model');
    assert.equal(f.calls.length, 0, 'creating a preset does not start a paid request');
    f.releaseConfig();
    await page.waitForFunction(() => smartConfigReady);
    assert.equal(await card.locator('.prompt-llm-provider').inputValue(), 'vision-fixture');
    assert.equal(await card.locator('.prompt-llm-model').inputValue(), 'vision-fixture-model');

    await card.locator('.prompt-node-run').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.promptRunError, id);
    assert.match(await card.locator('.prompt-node-run-status').innerText(), /请先连接或选择一张要反推的图片/);
    assert.equal(f.calls.length, 0);
    await page.evaluate(({id, image}) => {
        const source = createNode(160, 200, [image], {nodeType:SMART_UPLOAD_NODE_TYPE, skipUndo:true, select:false});
        connectInputNode(source.id, id);
        const target = nodes.find(node => node.id === id);
        target.x = 620; target.y = 150;
        render();
    }, {id, image});

    let releaseReply;
    const replyGate = new Promise(resolve => {releaseReply = resolve;});
    const longReverseText = '图1：\n电商产品展示摄影与家居实景海报。画面主体为一个放置在深棕色实木柜面上的圆角长方形金色金属相框摆件，呈平视微俯视居中视角。相框内为白色背景的家庭新年照片拼图：上方为大幅全家福照片，八位家庭成员老少同堂身穿红色喜庆毛衣，手持红包和红色灯笼，背景为由立体红色长毛绒材质构成的“2026”数字造型；相框下方并排三张正方形照片，依次展示身穿红衣手持金元宝的一对夫妻、身穿米白色毛衣微笑侧首的两个儿童、以及三位家庭成员的亲密合影；相框右上方留白处竖排印有红色毛笔行楷书法字“家和萬事興”，字间点缀一枚微小红色印章图案。相框左侧台面上摆放着一本白色精装书与金色高脚细长蜡烛台（插有白色长蜡烛）；相框右侧摆放着一盏米白色陶瓷底座搭配锥形布艺灯罩的床头台灯，背景为干净整洁的浅暖米色墙面，柔和自然侧光营造温馨节日氛围，高清商业静物摄影质感。';
    f.reply(async route => {
        await replyGate;
        return route.fulfill({json:{text:longReverseText}});
    });
    const heightBeforeRun = (await card.boundingBox()).height;
    await card.locator('.prompt-node-run').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.running, id);
    assert.equal(await card.locator('.prompt-node-run').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('.prompt-node-run-status')?.textContent.includes('正在反推'));
    const duplicate = page.evaluate(id => runPromptLLMNodeDirect(id), id);
    releaseReply();
    assert.equal((await duplicate).ok, true);
    await page.waitForFunction(id => !nodes.find(node => node.id === id)?.running, id);
    assert.equal(f.calls.length, 1, 'a repeated run shares the active request');
    assert.deepEqual(f.calls[0].images, [image.url]);
    assert.equal(f.calls[0].provider, 'vision-fixture');
    assert.equal(f.calls[0].model, 'vision-fixture-model');
    assert.match(f.calls[0].message, /主体外观/);
    assert.match(await card.locator('.prompt-node-text').inputValue(), /电商产品展示摄影/);
    await page.waitForFunction(id => {
        const el = document.querySelector(`.image-node[data-id="${id}"] .prompt-node-text`);
        return el && el.scrollHeight <= el.clientHeight + 2;
    }, id);
    const heightAfterRun = (await card.boundingBox()).height;
    assert.ok(heightAfterRun > heightBeforeRun + 80, `long reverse prompt should auto-grow node height (${heightBeforeRun} -> ${heightAfterRun})`);
    await capture(page, 'image-reverse-autofit-light.png');
    await card.locator('.prompt-node-text').fill('用户修改后的杯子提示词');
    const heightAfterShortEdit = (await card.boundingBox()).height;
    assert.ok(heightAfterShortEdit < heightAfterRun - 60, `shortening text should shrink auto-fitted node height (${heightAfterRun} -> ${heightAfterShortEdit})`);
    const downstream = await page.evaluate(id => {
        const target = createPaintNodeAt({x:1150,y:200}, {skipUndo:true, select:false});
        connectInputNode(id, target.id);
        target.x = 1150; target.y = 200;
        const source = nodes.find(node => node.type === SMART_UPLOAD_NODE_TYPE);
        source.x = 160; source.y = 200;
        return {text:promptTextItemsForNode(nodes.find(node => node.id === id)), refs:outputImagesForNode(nodes.find(node => node.id === id))};
    }, id);
    assert.deepEqual(downstream, {text:['用户修改后的杯子提示词'], refs:[]});
    await card.locator('.prompt-llm-provider').focus();
    await card.locator('.prompt-llm-provider').selectOption('other-fixture');
    assert.equal(await card.locator('.prompt-llm-model').inputValue(), 'other-vision-model');
    await pointerClick(page, card.locator('.prompt-reverse-settings-toggle'));
    assert.equal(await card.locator('.prompt-reverse-settings').evaluate(element => element.open), true);
    assert.equal(await card.locator('.prompt-reverse-reset-instruction').isDisabled(), true);
    await card.locator('.prompt-llm-instruction').fill('按图片反推一段写实摄影提示词，只输出中文正文。');
    assert.equal(await card.locator('.prompt-reverse-reset-instruction').isDisabled(), false);
    await page.evaluate(() => saveCanvas());
    assert.equal(f.saved().nodes.find(node => node.id === id).promptPreset, 'image-reverse');
    await page.reload();
    await page.waitForFunction(id => smartConfigReady && nodes.some(node => node.id === id), id);
    assert.equal(await card.locator('.prompt-llm-provider').inputValue(), 'other-fixture');
    assert.equal(await card.locator('.prompt-llm-instruction').inputValue(), '按图片反推一段写实摄影提示词，只输出中文正文。');
    assert.equal(await card.locator('.prompt-node-text').inputValue(), '用户修改后的杯子提示词');
    assert.equal(await card.locator('.prompt-node-run').innerText(), '反推');
    await page.keyboard.press('Escape');
    await capture(page, 'image-reverse-light.png');
    await page.evaluate(() => StudioAppearance.apply({skin:'dark'}));
    await capture(page, 'image-reverse-dark.png');
    assert.deepEqual(f.errors, []);
});

test('reverse node keeps the canvas compact and exposes model settings, editing and copying on demand', {timeout:45000}, async t => {
    const f = await fixture(t), {page} = f;
    await page.setViewportSize({width:1100, height:720});
    await page.waitForFunction(() => smartConfigReady);
    const id = await page.evaluate(image => {
        const source = createNode(120, 140, [image], {nodeType:SMART_UPLOAD_NODE_TYPE, skipUndo:true, select:false});
        const node = createPromptNode(530, 190, {preset:'image-reverse'});
        connectInputNode(source.id, node.id);
        source.x = 120; source.y = 140;
        source.scale = 0.65;
        node.x = 530; node.y = 190;
        selectedId = node.id;
        render();
        return node.id;
    }, image);
    const card = page.locator(`.image-node[data-id="${id}"]`);
    const text = card.locator('.prompt-node-text');
    assert.equal(await text.getAttribute('placeholder'), '连接一张图片，点下方「反推」');
    assert.equal(await card.locator('.prompt-node-top,.prompt-node-tools').count(), 0);
    assert.equal(await card.locator('.prompt-reverse-ref-btn').count(), 0);
    assert.equal(await card.locator('.prompt-llm-provider').isVisible(), true);
    assert.equal(await card.locator('.prompt-llm-model').isVisible(), true);
    assert.equal(await card.locator('.prompt-llm-instruction').isVisible(), false);
    assert.equal(await card.locator('.smart-node-input-thumbs').isVisible(), false);
    const bounds = await card.boundingBox(), output = await text.boundingBox();
    assert.ok(output.width >= bounds.width - 4 && output.height >= bounds.height - 4, 'text fills the node');
    const dock = await card.locator('.prompt-reverse-dock').boundingBox();
    const providerBox = await card.locator('.prompt-llm-provider').boundingBox();
    const modelBox = await card.locator('.prompt-llm-model').boundingBox();
    const settingsBox = await card.locator('.prompt-reverse-settings-toggle').boundingBox();
    const run = await card.locator('.prompt-node-run').boundingBox();
    assert.ok(dock.y >= bounds.y + bounds.height, 'reverse dock sits below the text');
    assert.ok(Math.abs(dock.x - bounds.x) < 3 && Math.abs(dock.width - bounds.width) < 3, 'reverse dock matches node width');
    assert.ok(Math.abs(providerBox.y - run.y) < 3 && Math.abs(modelBox.y - run.y) < 3 && Math.abs(settingsBox.y - run.y) < 3, 'all reverse controls stay on a single row');
    assert.ok(run.y >= bounds.y + bounds.height, 'reverse action sits below the text');
    assert.ok(run.x + run.width <= dock.x + dock.width && run.x + run.width >= dock.x + dock.width - 14, 'reverse action aligns to the right edge of the dock');
    await capture(page, 'image-reverse-compact-light.png');
    await page.evaluate(() => StudioAppearance.apply({skin:'dark'}));
    assert.equal(await card.locator('.prompt-node-run').isDisabled(), false);
    await capture(page, 'image-reverse-compact-dark.png');

    await pointerClick(page, card.locator('.prompt-reverse-settings-toggle'));
    assert.equal(await card.locator('.prompt-llm-instruction').isVisible(), true);
    await capture(page, 'image-reverse-compact-settings.png');
    await page.keyboard.press('Escape');
    assert.equal(await card.locator('.prompt-llm-instruction').isVisible(), false);
    await pointerClick(page, card.locator('.prompt-reverse-settings-toggle'));
    await page.mouse.click(400, 80);
    assert.equal(await card.locator('.prompt-llm-instruction').isVisible(), false, 'clicking outside settings closes them');
    await pointerClick(page, card.locator('.prompt-reverse-settings-toggle'));
    await card.locator('.prompt-llm-instruction').fill('临时修改的反推指令');
    await pointerClick(page, card.locator('.prompt-reverse-reset-instruction'));
    assert.match(await card.locator('.prompt-llm-instruction').inputValue(), /主体外观/);
    await page.keyboard.press('Escape');
    await pointerClick(page, text);
    await page.keyboard.insertText('手动编辑的提示词\n保留换行与产品细节');
    assert.equal(await card.locator('.prompt-reverse-copy').isDisabled(), false);
    await page.evaluate(() => {
        window.reverseClipboard = [];
        Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => window.reverseClipboard.push(text)}});
    });
    await pointerClick(page, card.locator('.prompt-reverse-copy'));
    assert.deepEqual(await page.evaluate(() => window.reverseClipboard), ['手动编辑的提示词\n保留换行与产品细节']);
    await pointerClick(page, card.locator('.prompt-reverse-edit'));
    assert.equal(await text.evaluate(field => field === document.activeElement), true);
    assert.equal(f.calls.length, 0, 'settings and text editing do not start model requests');

    const title = await card.locator('.prompt-reverse-title').boundingBox();
    const origin = await page.evaluate(id => {
        const node = nodes.find(node => node.id === id);
        return {x:node.x, y:node.y, scale:viewport.scale};
    }, id);
    await page.mouse.move(title.x + 4, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x + 44, title.y + title.height / 2 + 20, {steps:6});
    await page.mouse.up();
    const moved = await page.evaluate(id => {
        const node = nodes.find(node => node.id === id);
        return {x:node.x, y:node.y};
    }, id);
    assert.notEqual(moved.x, origin.x, 'dragging the title moves the node horizontally');
    assert.notEqual(moved.y, origin.y, 'dragging the title moves the node vertically');
    const handle = await card.locator('.node-resize-handle').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 150, handle.y - 200, {steps:8});
    await page.mouse.up();
    const small = await card.boundingBox(), smallText = await text.boundingBox();
    assert.ok(Math.abs(small.width - 260) < 3 && Math.abs(small.height - 220) < 3, 'compact nodes resize to their own minimum');
    assert.ok(smallText.height >= small.height - 4);
    await capture(page, 'image-reverse-compact-small-dark.png');

    await page.evaluate(() => { sharedCanvasReadOnly = true; document.activeElement.blur(); render(); });
    assert.equal(await text.getAttribute('readonly'), '');
    assert.equal(await card.locator('.prompt-llm-provider').isDisabled(), true);
    assert.equal(await card.locator('.prompt-llm-model').isDisabled(), true);
    assert.equal(await card.locator('.prompt-node-run').isDisabled(), true);
    await page.evaluate(() => { sharedCanvasReadOnly = false; render(); });
    await pointerClick(page, text);
    await pointerClick(page, card.locator('.node-delete'));
    assert.equal(await page.evaluate(id => nodes.some(node => node.id === id), id), false);
    assert.deepEqual(f.errors, []);
});

test('image output port creates a connected reverse preset; failures preserve output and ordinary prompts stay unchanged', {timeout:45000}, async t => {
    const f = await fixture(t), {page} = f;
    await page.waitForFunction(() => smartConfigReady);
    const sourceId = await page.evaluate(image => createNode(240, 200, [image], {
        nodeType:SMART_UPLOAD_NODE_TYPE, skipUndo:true, select:false,
    }).id, image);
    const port = await page.locator(`.image-node[data-id="${sourceId}"] .node-port.port-out`).boundingBox();
    const start = {x:port.x + port.width / 2, y:port.y + port.height / 2};
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 240, start.y + 130, {steps:8});
    await page.mouse.up();
    await page.locator('#createMenu.open [data-create-type="image-reverse"]').click();
    const id = await page.evaluate(sourceId => {
        const node = nodes.find(node => node.promptPreset === 'image-reverse');
        if(!canvas.connections.some(link => link.from === sourceId && link.to === node.id)) throw new Error('missing image connection');
        node.x = 620; node.y = 150; node.text = '保留原来的提示词'; render();
        return node.id;
    }, sourceId);
    const card = page.locator(`.image-node[data-id="${id}"]`);
    f.reply(route => route.fulfill({status:502, json:{detail:'视觉模型暂时不可用，请稍后重试'}}));
    await card.locator('.prompt-node-run').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id)?.promptRunError, id);
    assert.equal(f.calls.length, 1);
    assert.equal(await card.locator('.prompt-node-text').inputValue(), '保留原来的提示词');
    assert.match(await card.locator('.prompt-node-run-status').innerText(), /视觉模型暂时不可用/);
    await capture(page, 'image-reverse-error.png');

    await page.evaluate(({id, sourceId}) => {
        const source = nodes.find(node => node.id === sourceId);
        source.images = [{url:'/output/video.mp4', kind:'video', name:'video.mp4'}];
        render();
        return runPromptLLMNodeDirect(id);
    }, {id, sourceId});
    assert.equal(f.calls.length, 1, 'video-only references cannot trigger reverse prompting');
    assert.equal(await card.locator('.prompt-node-text').inputValue(), '保留原来的提示词');
    assert.match(await card.locator('.prompt-node-run-status').innerText(), /请先连接或选择一张要反推的图片/);

    f.reply(route => route.fulfill({json:{text:'普通文本节点仍可生成提示词'}}));
    const normal = await page.evaluate(async () => {
        const node = createPromptNode(1100, 100);
        const enabledByDefault = node.llmEnabled;
        node.llmInstruction = '写一段普通提示词';
        return {enabledByDefault, preset:node.promptPreset || '', result:await runPromptLLMNodeDirect(node.id)};
    });
    assert.equal(normal.enabledByDefault, false);
    assert.equal(normal.preset, '');
    assert.equal(normal.result.ok, true);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].images, []);
    assert.deepEqual(f.errors, []);
});
