const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('smart canvas can save a selected workflow as a clean template', {timeout: 40000}, async t => {
    const browser = await chromium.launch({headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:900}});
    page.setDefaultTimeout(10000);
    const errors = [];
    let exportPayload = null;
    page.on('pageerror', error => errors.push(error.message));
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
            return route.fulfill({json:{library:{active_library_id:'default', libraries:[{id:'default', name:'默认收藏库', categories:[{id:'workflow', name:'工作流', type:'workflow', items:[]}]}]}}});
        }
        if(url.pathname === '/api/asset-url-library') return route.fulfill({json:{library:{items:[]}}});
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:[], tree:null}});
        if(url.pathname === '/api/canvas-workflows/export-to-library'){
            exportPayload = request.postDataJSON();
            return route.fulfill({json:{library:{active_library_id:'default', libraries:[{id:'default', name:'默认收藏库', categories:[{id:'workflow', name:'工作流', type:'workflow', items:[]}]}]}, item:{id:'wf_fixture', name:exportPayload.name, url:'/assets/library/template.zip', kind:'workflow', type:'workflow'}}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true, library:{libraries:[]}, items:[]}});
        return route.fulfill({status:404, body:''});
    });
    await page.goto('http://xiaomei-workflow.test/static/smart-canvas.html?id=template-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === '模板测试画布');
    await page.evaluate(() => { selectedIds = []; selectedId = ''; saveSelectedSmartWorkflowTemplate(); });
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
    const saving = page.evaluate(() => saveSelectedSmartWorkflowTemplate());
    await page.locator('.xiaomei-workflow-dialog [data-confirm]').click();
    await saving;
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(exportPayload);
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
    await page.evaluate(payload => insertSmartWorkflowIntoCanvas(payload), {nodes:exportPayload.nodes, connections:exportPayload.connections});
    assert.equal(await page.evaluate(() => nodes.length), beforeInsert + 2);
    assert.equal(await page.evaluate(() => canvas.connections.some(connection => connection.from && connection.to)), true);
});

