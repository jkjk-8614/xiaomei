const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('dragging a canvas image into the local asset panel saves it without moving the node', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:900}});
    const imports = [];
    const saved = [];
    const errors = [];
    const uploads = [];
    let releaseLocalImport;
    t.after(() => releaseLocalImport?.());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'canvas-asset-drop.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return file.startsWith(root + path.sep) && fs.existsSync(file)
                ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/local-assets/import-urls'){
            const request = JSON.parse(route.request().postData());
            imports.push(request);
            if(request.items.some(item => item.url === '/assets/missing.png')){
                return route.fulfill({json:{ok:true, count:0, files:[], items:[{ok:false, error:'本地素材不存在，请刷新后重试'}]}});
            }
            const files = request.items.map((item, index) => ({id:`saved-${saved.length + index}`, url:`/assets/saved-${saved.length + index}.png`, name:item.name}));
            saved.push(...files);
            return route.fulfill({json:{ok:true, count:files.length, files, items:files.map(file => ({ok:true, item:file}))}});
        }
        if(url.pathname === '/api/local-assets/upload'){
            uploads.push(route.request().postDataBuffer().toString());
            return route.fulfill({json:{files:[{name:'本地.png'}]}});
        }
        if(url.pathname === '/api/ai/import-local-image'){
            assert.deepEqual(route.request().postDataJSON(), {paths:['D:/中文 图片.png']});
            await new Promise(resolve => { releaseLocalImport = resolve; });
            return route.fulfill({json:{files:[{url:'/assets/local.png', name:'中文 图片.png'}]}});
        }
        if(url.pathname === '/api/canvases/asset-drop-fixture'){
            return route.fulfill({json:{canvas:{id:'asset-drop-fixture', title:'Asset drop', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{
            items:saved,
            tree:{
                id:'__root__', name:'全部上传', items:[],
                children:[
                    {path:'图片', name:'图片', items:[], children:[]},
                    {path:'frames', name:'相框', items:[], children:[
                        {path:'frames/图片', name:'图片', items:saved, children:[]},
                        {path:'frames/视频', name:'视频', items:[], children:[]},
                    ]},
                ],
            },
        }});
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204, body:''});
    });
    await page.goto('http://canvas-asset-drop.test/static/smart-canvas.html?id=asset-drop-fixture');
    await page.waitForFunction(() => typeof render === 'function' && canvas?.id === 'asset-drop-fixture');
    await page.evaluate(() => {
        nodes = [{id:'frame', type:'smart-upload', title:'Frame', x:180, y:200, images:[{url:'/assets/frame.png', name:'Frame'}]}];
        canvas.nodes = nodes;
        viewport = {x:0, y:0, scale:1};
        canvasViewPrefs.snap = false;
        applyViewport();
        render();
        toggleAssetLibrary(true);
    });
    await page.locator('#assetCategorySelect option[value="frames"]').waitFor({state:'attached'});
    await page.locator('#assetCategorySelect').selectOption('frames');
    const source = await page.locator('.image-node[data-id="frame"] .image-wrap img').boundingBox();
    const target = await page.locator('#assetDropZone').boundingBox();
    assert.ok(source && target);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(500);
    const position = await page.evaluate(() => ({x:nodes[0].x, y:nodes[0].y}));
    assert.deepEqual(imports.map(item => item.items.map(image => image.url)), [['/assets/frame.png']]);
    assert.equal(imports[0].folder, 'frames');
    assert.deepEqual(await page.locator('#assetCategorySelect option').evaluateAll(options => options.map(option => option.value)), ['__root__', 'frames']);
    await page.locator('#assetGrid .asset-item[data-asset-id="saved-0"]').waitFor();
    assert.deepEqual(position, {x:180, y:200});
    await page.evaluate(() => {
        nodes = [{id:'group', type:'smart-upload', title:'Frames', x:180, y:200, images:[
            {url:'/assets/first.png', name:'First'}, {url:'/assets/second.png', name:'Second'}
        ]}];
        canvas.nodes = nodes;
        render();
    });
    const tile = await page.locator('.image-node[data-id="group"] .thumb-item').first().boundingBox();
    assert.ok(tile);
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.deepEqual(imports.map(item => item.items.map(image => image.url)), [
        ['/assets/frame.png'], ['/assets/first.png']
    ]);
    const group = await page.evaluate(() => ({
        nodes:nodes.map(node => ({id:node.id, urls:node.images.map(image => image.url)})),
        undoEntries:undoStack.length
    }));
    assert.deepEqual(group.nodes, [{id:'group', urls:['/assets/first.png', '/assets/second.png']}]);
    assert.equal(group.undoEntries, 0);
    const groupBox = await page.locator('.image-node[data-id="group"]').boundingBox();
    assert.ok(groupBox);
    await page.mouse.move(groupBox.x + 6, groupBox.y + 6);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.deepEqual(imports.at(-1).items.map(item => item.url), ['/assets/first.png', '/assets/second.png']);
    assert.deepEqual(await page.evaluate(() => nodes[0].images.map(image => image.url)), ['/assets/first.png', '/assets/second.png']);
    await page.evaluate(() => {
        nodes = [{id:'missing', type:'smart-upload', x:180, y:200, images:[{url:'/assets/missing.png'}]}];
        canvas.nodes = nodes;
        render();
    });
    const missing = await page.locator('.image-node[data-id="missing"] .image-wrap img').boundingBox();
    assert.ok(missing);
    await page.mouse.move(missing.x + missing.width / 2, missing.y + missing.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('本地素材不存在'));
    assert.deepEqual(imports.at(-1).items.map(item => item.url), ['/assets/missing.png']);

    const drop = (type, text) => page.locator('#assetDropZone').evaluate((zone, {type, text}) => {
        const dataTransfer = new DataTransfer();
        if(type === 'file') dataTransfer.items.add(new File(['fixture'], text, {type:'image/png'}));
        else dataTransfer.setData(type, text);
        const event = name => new DragEvent(name, {bubbles:true, cancelable:true, dataTransfer});
        const handled = !zone.dispatchEvent(event('dragover'));
        const highlighted = zone.classList.contains('drag-over');
        const dropped = !zone.dispatchEvent(event('drop'));
        return {handled, highlighted, dropped, cleared:!zone.classList.contains('drag-over')};
    }, {type, text});

    const upload = page.waitForResponse(response => response.url().endsWith('/api/local-assets/upload'));
    assert.deepEqual(await drop('file', '本地.png'), {handled:true, highlighted:true, dropped:true, cleared:true});
    await upload;
    assert.match(uploads[0], /name="folder"\r\n\r\nframes/);
    assert.match(uploads[0], /filename="本地\.png"/);

    const signed = 'https://assets.example/encoded%2Fname.png?signature=x%2By%3D';
    const imported = page.waitForResponse(response => response.url().endsWith('/api/local-assets/import-urls'));
    await drop('text/uri-list', signed);
    await imported;
    assert.equal(imports.at(-1).items[0].url, signed);

    const local = page.waitForRequest(request => request.url().endsWith('/api/ai/import-local-image'));
    await drop('text/uri-list', 'file:///D:/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png');
    await local;
    await page.locator('#assetCategorySelect').selectOption('__root__');
    const savedLocal = page.waitForResponse(response => response.url().endsWith('/api/local-assets/import-urls'));
    releaseLocalImport();
    await savedLocal;
    assert.equal(imports.at(-1).folder, 'frames');
    assert.equal(imports.at(-1).items[0].url, '/assets/local.png');
    assert.equal(await page.locator('#assetCategorySelect').inputValue(), '__root__');
    assert.equal(await page.evaluate(() => nodes.length), 1);
    assert.deepEqual(errors, []);
});

test('assets copied from the manager paste once with their IDs and sizes', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1550,height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const items = ['商品.png', '细节.png'].map((name, index) => ({
        id:`upload:${name}`, rel:name, name, kind:'image', size:240, created_at:1000 + index,
        url:'/api/storage-files/upload/' + encodeURIComponent(name),
        asset_id:`asset_${index}`, asset_uris:{volcengine:`asset://approved-${index}`},
        natural_w:360, natural_h:240,
    }));
    let stored = {id:'asset-paste', title:'Asset paste', nodes:[], connections:[], logs:[], settings:{}};
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'canvas-asset-paste.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/storage-files' && url.searchParams.get('kind') === 'upload'){
            return route.fulfill({json:{items,total:2,all_total:2,has_more:false,folders:[],projects:[],canvases:[],media_counts:{image:2}}});
        }
        if(url.pathname.startsWith('/api/storage-files/upload/') || url.pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="#84a7ba"/></svg>'});
        }
        if(url.pathname === '/api/canvases/asset-paste'){
            if(request.method() === 'PUT') stored = {...stored, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        return route.fulfill({json:{items:[],libraries:[],projects:[],entries:[],workflows:[]}});
    });
    const origin = 'http://canvas-asset-paste.test';
    await page.goto(origin + '/static/asset-manager.html');
    await page.locator('[data-space-file-manage]').click();
    const cards = page.locator('[data-space-file-card] .asset-card-body');
    await cards.nth(0).click();
    await cards.nth(1).click();
    await page.locator('[data-space-file-canvas]').click();
    const key = 'smart_canvas_asset_inbox';
    const copied = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.equal(copied.items.length, 2);
    assert.deepEqual(copied.items.map(item => item.asset_ref_id).sort(), ['asset_0','asset_1']);

    await page.goto(origin + '/static/smart-canvas.html?id=asset-paste');
    await page.waitForFunction(() => smartCanvasReady && canvas?.id === 'asset-paste');
    const paste = () => page.evaluate(() => !document.body.dispatchEvent(new ClipboardEvent('paste', {
        bubbles:true, cancelable:true, clipboardData:new DataTransfer(),
    })));
    await page.evaluate(() => { sharedCanvasReadOnly = true; });
    assert.equal(await paste(), true);
    assert.equal(await page.evaluate(() => nodes.length), 0);
    assert.equal(await page.evaluate(key => Boolean(localStorage.getItem(key)), key), true);

    await page.evaluate(() => { sharedCanvasReadOnly = false; lastMouseWorld = {x:530,y:325}; });
    const saved = page.waitForResponse(response => response.request().method() === 'PUT'
        && response.request().postDataJSON()?.nodes?.length === 2);
    assert.equal(await paste(), true);
    await saved;
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    assert.equal(await paste(), false);
    const [first, second] = stored.nodes;
    assert.equal(second.x - first.x, 260);
    assert.equal(await page.evaluate(() => smartRectsOverlapWithGap(nodeRect(nodes[0]), nodeRect(nodes[1]))), false);
    const byUrl = new Map(items.map(item => [item.url, item]));
    for(const node of stored.nodes){
        const [image] = node.images;
        const source = byUrl.get(image.url);
        assert.ok(source);
        assert.equal(image.name, source.name);
        assert.equal(image.asset_ref_id, source.asset_id);
        assert.deepEqual(image.asset_uris, source.asset_uris);
        assert.deepEqual([image.natural_w, image.natural_h], [360,240]);
    }
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => nodes.length === 0);
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => nodes.length === 2);
    await page.evaluate(key => {
        localStorage.setItem(key, JSON.stringify({items:[{url:'/assets/expired.png'}], ts:Date.now() - 31*60000}));
    }, key);
    assert.equal(await paste(), false);
    assert.deepEqual(errors, []);
});


test('local asset sidebar keeps folder, reference metadata and newer rename results', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const legacy = {
        id:'frame-id', file:'相框/旧图.png', folder:'相框', name:'旧图.png', kind:'image',
        url:'/assets/uploads/%E7%9B%B8%E6%A1%86/%E6%97%A7%E5%9B%BE.png', natural_w:1200, natural_h:800,
        asset_ref_id:'asset_frame', asset_uris:{volcengine:'asset://approved-frame'},
    };
    const renamed = {...legacy, id:'renamed-id', file:'相框/新图.png', name:'新图.png', url:'/assets/uploads/%E7%9B%B8%E6%A1%86/%E6%96%B0%E5%9B%BE.png'};
    let item = legacy;
    let pauseListing = false;
    let resumeListing;
    let finishRename;
    let renameBody;
    const folderWrites = [];
    let folder = null;
    const listing = () => ({
        items:[item], tree:{id:'__root__', name:'全部上传', children:[
            {id:'相框', name:'相框', items:[item], children:folder ? [folder] : []}, {id:'其它', name:'其它', items:[]},
        ]},
    });
    t.after(() => { resumeListing?.(); finishRename?.(); });
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'canvas-local-sidebar.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return file.startsWith(root + path.sep) && fs.existsSync(file)
                ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/local-assets'){
            const snapshot = listing();
            if(pauseListing){
                pauseListing = false;
                await new Promise(resolve => { resumeListing = resolve; });
            }
            return route.fulfill({json:snapshot});
        }
        if(url.pathname === '/api/local-assets/items'){
            renameBody = request.postDataJSON();
            await new Promise(resolve => { finishRename = resolve; });
            item = renamed;
            return route.fulfill({json:{...listing(), item, old_path:legacy.file}});
        }
        if(url.pathname === '/api/local-assets/folders'){
            const body = request.postDataJSON();
            folderWrites.push({method:request.method(), body});
            folder = {path:`相框/${body.name}`, name:body.name, items:[], children:[]};
            return route.fulfill({json:{...listing(), folder}});
        }
        if(url.pathname === '/api/asset-library'){
            return route.fulfill({json:{library:{active_library_id:'first', libraries:[
                {id:'first', name:'收藏一', categories:[{id:'first-folder', items:[{url:'/assets/remote-one.png'}]}]},
                {id:'second', name:'收藏二', categories:[{id:'second-folder', items:[{url:'/assets/remote-two.png'}]}]},
            ]}}});
        }
        if(url.pathname === '/api/canvases/sidebar-fixture'){
            return route.fulfill({json:{canvas:{id:'sidebar-fixture', title:'Sidebar', nodes:[
                {id:'frame', type:'smart-upload', x:180, y:200, images:[{url:legacy.url, name:legacy.name}]},
            ], connections:[], logs:[], settings:{}}}});
        }
        return route.fulfill({json:{}});
    });
    await page.goto('http://canvas-local-sidebar.test/static/smart-canvas.html?id=sidebar-fixture');
    await page.waitForFunction(() => canvas?.id === 'sidebar-fixture');
    await page.evaluate(() => toggleAssetLibrary(true));
    const folders = page.locator('#assetCategorySelect');
    await folders.selectOption('相框');
    const card = page.locator('#assetGrid [data-asset-id="frame-id"]');
    await card.locator('.asset-thumb').hover();
    await page.locator('#assetHoverPreview').waitFor();
    assert.equal(await page.locator('#assetHoverPreview .asset-hover-name').textContent(), legacy.name);
    const payload = await card.evaluate(element => {
        const dataTransfer = new DataTransfer();
        element.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer}));
        return JSON.parse(dataTransfer.getData('application/x-smart-asset'));
    });
    assert.equal(payload.url, legacy.url);
    assert.equal(payload.asset_ref_id, 'asset_frame');
    assert.deepEqual(payload.asset_uris, legacy.asset_uris);
    assert.deepEqual([payload.natural_w, payload.natural_h], [1200, 800]);
    await page.locator('#assetHoverPreview').waitFor({state:'hidden'});
    await page.evaluate(() => {
        createNode(400, 100, [], {nodeType:SMART_PAINT_NODE_TYPE, select:true});
    });
    const prompt = page.locator('#promptInput');
    await prompt.fill('@');
    const menu = page.locator('#mentionPicker.open');
    await menu.locator('[data-mention-library]').selectOption('second');
    await menu.locator('.mention-option').click();
    assert.equal(await prompt.locator('.mention-image-token').getAttribute('data-url'), '/assets/remote-two.png');
    assert.equal(await folders.inputValue(), '相框');

    const listRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/local-assets');
    pauseListing = true;
    const oldListing = page.evaluate(() => loadAssetLibrary());
    await listRequest;
    await card.locator('.asset-name').click();
    const editor = card.locator('.asset-rename-input');
    await editor.fill('新图');
    const renameRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/api/local-assets/items'));
    await editor.press('Enter');
    await renameRequest;
    await folders.selectOption('其它');
    finishRename();
    await page.waitForFunction(url => nodes.find(node => node.id === 'frame')?.images?.[0]?.url === url, renamed.url);
    resumeListing();
    await oldListing;
    assert.deepEqual(renameBody, {path:legacy.file, name:'新图'});
    assert.equal(await folders.inputValue(), '其它');
    assert.equal(await page.evaluate(() => activeAssetLibraryId), 'second');
    await folders.selectOption('相框');
    assert.equal(await page.locator('#assetGrid [data-asset-id="renamed-id"] .asset-name').textContent(), renamed.name);

    const dialog = page.locator('#assetDialogBackdrop');
    const name = dialog.locator('textarea');
    await page.locator('#assetAddCategoryBtn').click();
    await name.fill('新 相框');
    await name.dispatchEvent('keydown', {key:'Enter', isComposing:true});
    assert.equal(await dialog.isVisible(), true);
    assert.equal(folderWrites.length, 0);
    await name.press('Enter');
    await page.waitForFunction(() => document.querySelector('#assetCategorySelect')?.value === '相框/新 相框');
    await page.locator('#assetRenameCategoryBtn').click();
    await name.fill('不会保存');
    await name.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(folderWrites.length, 1);
    await page.locator('#assetRenameCategoryBtn').click();
    await name.fill('新名称');
    await dialog.locator('#assetDialogOk').click();
    await page.waitForFunction(() => document.querySelector('#assetCategorySelect')?.value === '相框/新名称');
    assert.deepEqual(folderWrites, [
        {method:'POST', body:{parent:'相框',name:'新 相框'}},
        {method:'PATCH', body:{path:'相框/新 相框',name:'新名称'}},
    ]);
    assert.deepEqual(errors, []);
});
