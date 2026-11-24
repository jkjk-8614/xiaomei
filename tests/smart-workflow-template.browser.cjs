const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function openFixture(t, favorite){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:900}});
    page.setDefaultTimeout(10000);
    const errors = [];
    const requests = {templates:[], archives:[], imports:[]};
    const library = {active_library_id:'default', libraries:[{
        id:'default', name:'默认收藏库', categories:[{id:'workflow', name:'工作流', type:'workflow', items:favorite ? [favorite.item] : []}]
    }]};
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'xiaomei-workflow.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if(!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({status:404, body:''});
            return route.fulfill({path:file});
        }
        if(url.pathname === '/api/canvases/template-fixture'){
            return route.fulfill({json:{canvas:{id:'template-fixture', title:'模板测试画布', nodes:[], connections:[], logs:[], settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1}}}});
        }
        if(url.pathname === '/api/config'){
            return route.fulfill({json:{api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image'], video_models:[]}], comfy_instances:[]}});
        }
        if(url.pathname === '/api/asset-library'){
            return route.fulfill({json:{library}});
        }
        if(favorite?.item.url === url.pathname) return route.fulfill({json:favorite.workflow});
        if(url.pathname === '/api/asset-url-library') return route.fulfill({json:{library:{items:[]}}});
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:[], tree:null}});
        if(url.pathname === '/api/canvas-workflows/export-to-library'){
            const exportPayload = request.postDataJSON();
            requests.templates.push(exportPayload);
            return route.fulfill({json:{library, item:{id:'wf_fixture', name:exportPayload.name, url:'/assets/library/template.zip', kind:'workflow', type:'workflow'}}});
        }
        if(url.pathname === '/api/canvas-workflows/export'){
            requests.archives.push(request.postDataJSON());
            return route.fulfill({contentType:'application/zip', body:Buffer.from('PK fixture')});
        }
        if(url.pathname === '/api/canvas-workflows/import'){
            const body = request.postDataBuffer().toString('utf8');
            const workflow = JSON.parse(body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--')));
            requests.imports.push(workflow);
            if(requests.holdImport) return requests.holdImport(route, workflow);
            return route.fulfill({json:{workflow, resource_map:requests.resources}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true, library:{libraries:[]}, items:[]}});
        return route.fulfill({status:404, body:''});
    });
    await page.goto('http://xiaomei-workflow.test/static/smart-canvas.html?id=template-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === '模板测试画布');
    await page.locator('#smartWorkflowToggle').click();
    return {page, requests, errors};
}

test('smart canvas can save a selected workflow as a clean template', {timeout: 40000}, async t => {
    const {page, requests, errors} = await openFixture(t);
    const save = page.locator('#smartWorkflowSaveTemplateBtn');
    await save.click();
    assert.equal(await page.locator('#toast').textContent(), '未选择节点，请先选中要收藏的组件');

    await page.evaluate(() => {
        const reference = createImageNodeAt({x:200, y:200}, [{url:'/assets/reference.png', name:'参考图.png', kind:'image'}], {select:false});
        const output = createPaintNodeAt({x:700, y:200}, {select:false});
        output.runPrompt = '保留产品外观，生成电商主图';
        output.promptDraftText = '保留产品外观，生成电商主图';
        output.runSettings = {engine:'api', provider_id:'fixture', model:'fixture-image', count:2};
        output.images = [{url:'/output/generated.png', name:'生成结果.png', kind:'image', generatedResult:true}];
        canvas.connections = [{from:reference.id, to:output.id, kind:'flow'}];
        selectedIds = [reference.id, output.id];
        selectedId = '';
        render();
    });
    await save.click();
    await page.locator('.xiaomei-workflow-dialog [data-confirm]').click();
    await page.waitForFunction(() => document.querySelector('#smartWorkflowSaveTemplateBtn').classList.contains('success'));
    assert.equal(errors.length, 0, errors.join('\n'));
    const [exportPayload] = requests.templates;
    assert.ok(exportPayload);
    assert.equal(exportPayload.format, 'xiaomei-canvas-workflow');
    assert.equal(exportPayload.name, '模板测试画布模板');
    assert.equal(exportPayload.nodes.length, 2);
    assert.equal(exportPayload.connections.length, 1);
    const reference = exportPayload.nodes.find(node => node.type === 'smart-upload');
    const output = exportPayload.nodes.find(node => node.type === 'smart-paint');
    assert.equal(reference.images[0].url, '/assets/reference.png');
    assert.deepEqual(output.images, []);
    assert.equal(output.runPrompt, '保留产品外观，生成电商主图');
    assert.equal(output.running, undefined);
    assert.equal(output.pending, undefined);
    const beforeInsert = await page.evaluate(() => nodes.length);
    await page.locator('#smartWorkflowImportInput').setInputFiles({
        name:'template.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(exportPayload))
    });
    await page.waitForFunction(count => nodes.length === count + 2, beforeInsert);
    assert.equal(await page.evaluate(() => nodes.length), beforeInsert + 2);
    assert.equal(await page.evaluate(() => canvas.connections.some(connection => connection.from && connection.to)), true);
});

test('workflow files keep grouped and folded nodes and insert legacy graphs with fresh IDs', {timeout:40000}, async t => {
    const {page, requests, errors} = await openFixture(t);
    await page.evaluate(() => {
        const image = {kind:'image', url:'/assets/reference.png', natural_w:240, natural_h:320};
        nodes = [
            {id:'group', type:'smart-group', items:['prompt'], images:[image], x:40, y:50},
            {id:'prompt', type:'smart-prompt', text:'组内提示词', x:80, y:120},
            {id:'stack', type:'smart-upload', title:'Group', collapsed:true, images:[image], x:440, y:50,
                inputNodeIds:['group', 'unselected'], inputRefOrder:['group|0', 'unselected|1', 'url|/assets/reference.png'],
                collapsedNodes:[{id:'folded', type:'smart-upload', x:450, y:70, images:[image]}],
                collapsedConnections:[{id:'old-fold', from:'group', to:'folded', kind:'input'}]},
            {id:'unselected', type:'smart-prompt', text:'画布外部节点', x:800, y:120}
        ];
        canvas.connections = [
            {id:'old-edge', from:'group', to:'stack', kind:'input', input_slot:'reference'},
            {id:'old-external', from:'unselected', to:'stack', kind:'input'}
        ];
        selectedIds = ['group', 'stack'];
        selectedId = '';
        render();
    });
    const panel = page.locator('#smartWorkflowTransferModal');
    assert.equal(await page.locator('#smartWorkflowExportMeta').textContent(), '已选择 3 个节点，1 条连线');
    const json = page.waitForEvent('download');
    await page.locator('[data-smart-workflow-export="json"]').click();
    const file = await json;
    assert.match(file.suggestedFilename(), /^模板测试画布-workflow-\d+\.json$/);
    const workflow = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    assert.equal(workflow.format, 'xiaomei-canvas-workflow');
    assert.equal(workflow.canvas_type, 'smart');
    assert.deepEqual(workflow.nodes.map(node => node.id), ['group', 'prompt', 'stack']);
    assert.deepEqual(workflow.nodes[2].inputNodeIds, ['group']);
    assert.deepEqual(workflow.nodes[2].inputRefOrder, ['group|0', 'url|/assets/reference.png']);
    assert.deepEqual(workflow.connections.map(edge => edge.id), ['old-edge']);

    const zip = page.waitForEvent('download');
    await page.locator('[data-smart-workflow-export="zip"]').click();
    assert.match((await zip).suggestedFilename(), /\.zip$/);
    assert.equal(requests.archives[0].include_resources, true);
    assert.deepEqual(requests.archives[0].nodes, workflow.nodes);

    const legacy = {...workflow, format:'infinite-smart-canvas-workflow'};
    legacy.connections.push({from:'unselected', to:'stack', kind:'input'});
    requests.resources = {'/assets/reference.png':'/api/storage-files/upload/fixture-reference.png'};
    const upload = {name:'legacy.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(legacy))};
    await page.locator('#smartWorkflowImportInput').setInputFiles(upload);
    await page.waitForFunction(() => nodes.length === 7);
    assert.equal(await panel.evaluate(element => element.classList.contains('open')), false);
    const result = await page.evaluate(() => {
        const [group, prompt, stack] = nodes.slice(-3);
        const edge = canvas.connections.at(-1);
        return {
            originalIds:nodes.slice(0, 4).map(node => node.id), imported:[group.id, prompt.id, stack.id],
            members:group.items, input:stack.inputNodeIds, order:stack.inputRefOrder,
            edge, folded:stack.collapsedNodes[0], foldedEdge:stack.collapsedConnections[0],
            offsets:[prompt.x - group.x, prompt.y - group.y, stack.x - group.x, stack.y - group.y],
            edges:canvas.connections.length, undo:undoStack.length
        };
    });
    const [group, prompt, stack] = result.imported;
    assert.ok(result.imported.every(id => !result.originalIds.includes(id)));
    assert.deepEqual(result.members, [prompt]);
    assert.deepEqual(result.input, [group]);
    assert.deepEqual(result.order, [group + '|0', 'url|/api/storage-files/upload/fixture-reference.png']);
    assert.deepEqual(result.offsets, [40, 70, 400, 0]);
    assert.deepEqual([result.edge.from, result.edge.to, result.edge.input_slot], [group, stack, 'reference']);
    assert.notEqual(result.edge.id, 'old-edge');
    assert.notEqual(result.folded.id, 'folded');
    assert.deepEqual([result.foldedEdge.from, result.foldedEdge.to], [group, result.folded.id]);
    assert.equal(result.edges, 3);
    assert.equal(result.undo, 1);
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(() => nodes.length), 4);

    await page.locator('#smartWorkflowToggle').click();
    const blocked = new Promise(resolve => {
        requests.holdImport = (route, workflow) => resolve(() => route.fulfill({json:{workflow}}));
    });
    await page.locator('#smartWorkflowImportInput').setInputFiles(upload);
    const release = await blocked;
    await page.evaluate(() => { canvas = {...canvas, id:'other-canvas'}; });
    await release();
    await page.waitForFunction(() => !document.querySelector('#smartWorkflowTransferSub').textContent.includes('正在导入'));
    assert.equal(await page.evaluate(() => nodes.length), 4);
    assert.deepEqual(errors, []);
});

test('favorites and the asset-manager inbox use the same workflow import', {timeout:40000}, async t => {
    const item = {id:'favorite', name:'收藏的提示词', url:'/assets/library/favorite.json', format:'json', favorite:true};
    const workflow = {format:'infinite-smart-canvas-workflow', nodes:[{
        id:'favorite-prompt', type:'smart-prompt', text:'保留收藏的提示词'
    }]};
    const {page, requests, errors} = await openFixture(t, {item, workflow});
    await page.locator('#smartWorkflowFavoriteList [data-smart-workflow-insert="favorite"]').click();
    await page.waitForFunction(() => nodes.length === 1);
    assert.equal(await page.evaluate(() => nodes[0].text), workflow.nodes[0].text);
    await page.locator('#smartWorkflowToggle').click();
    await page.locator('#smartWorkflowRecentList [data-smart-workflow-insert="favorite"]').waitFor();

    const sendFromLibrary = () => page.evaluate(({name, url}) => {
        const payload = {name, url, ts:Date.now()};
        localStorage.setItem('smart_canvas_workflow_inbox_v1', JSON.stringify(payload));
        window.postMessage({type:'smart-workflow-inbox', payload}, location.origin);
    }, item);
    requests.holdImport = route => route.fulfill({status:400, json:{detail:'无法读取工作流文件'}});
    await sendFromLibrary();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '无法读取工作流文件');
    assert.equal(await page.evaluate(() => nodes.length), 1);
    assert.ok(await page.evaluate(() => localStorage.getItem('smart_canvas_workflow_inbox_v1')));

    requests.holdImport = null;
    await sendFromLibrary();
    await page.waitForFunction(() => nodes.length === 2 && !localStorage.getItem('smart_canvas_workflow_inbox_v1'));
    assert.deepEqual(requests.imports, [workflow, workflow, workflow]);
    assert.deepEqual(errors, []);
});

test('a stalled favorite download or import releases the button for retry', {timeout:40000}, async t => {
    const item = {id:'favorite', name:'收藏的工作流', url:'/assets/library/favorite.json', format:'json', favorite:true};
    const workflow = {nodes:[{id:'prompt', type:'smart-prompt', text:'测试重试'}]};
    const {page, requests, errors} = await openFixture(t, {item, workflow});
    await page.evaluate(() => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = ms => timeout(ms === 60000 ? 1000 : ms);
    });
    const insert = page.locator('#smartWorkflowFavoriteList [data-smart-workflow-insert="favorite"]');
    const assetPattern = '**' + item.url;
    await page.route(assetPattern, () => {});

    async function expectTimeout() {
        await insert.click();
        await page.waitForFunction(() => document.querySelector('#toast').textContent === '工作流导入超时，请重试');
        assert.equal(await insert.isEnabled(), true);
        assert.equal(await page.evaluate(() => nodes.length), 0);
    }

    await expectTimeout();
    assert.equal(requests.imports.length, 0);
    await page.unroute(assetPattern);
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    requests.holdImport = () => {};
    await expectTimeout();
    assert.equal(requests.imports.length, 1);

    requests.holdImport = null;
    await insert.click();
    await page.waitForFunction(() => nodes.length === 1);
    assert.equal(await page.evaluate(() => nodes[0].text), '测试重试');
    assert.deepEqual(errors, []);
});

