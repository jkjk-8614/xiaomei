const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1300,height:900}});
    page.setDefaultTimeout(8000);
    const errors = [], calls = [], uploads = [];
    t.after(() => assert.deepEqual(errors, []));
    page.on('pageerror', error => errors.push(error.message));
    let stored = {id:'documents',title:'文件接入',nodes:[],connections:[],logs:[],settings:{}};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'canvas-documents.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root,'.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/documents'){
            if(request.method() === 'PUT') stored = {...stored,...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(url.pathname === '/api/ai/upload'){
            const body = request.postDataBuffer().toString('utf8');
            const names = [...body.matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
            uploads.push(names);
            return route.fulfill({json:{files:names.map((name,index) => ({
                url:`/assets/input/fixture-${uploads.length}-${index}.${name.split('.').pop()}`,name,kind:/\.png$/.test(name) ? 'image' : 'file',
                ...(/\.png$/.test(name) ? {} : {document:{status:/\.wps$/.test(name) ? 'error' : 'ready',message:/\.wps$/.test(name) ? '请在 WPS 中另存为 .docx 后上传' : '已读取 20 字；文档内图片请另行上传',chars:20,truncated:false}})
            }))}});
        }
        if(url.pathname === '/api/canvas-documents/read'){
            const {url:source} = request.postDataJSON();
            const previewText = '工作表：📸 主图\n第一屏：原木相框\n  - 未命名主题\n第二屏：SKU尺寸\n  - 未命名主题\n<script>不是脚本</script>';
            const firstAnchor = previewText.indexOf('  - 未命名主题\n') + '  - 未命名主题\n'.length;
            const secondAnchor = previewText.lastIndexOf('  - 未命名主题\n') + '  - 未命名主题\n'.length;
            const images = source.endsWith('.xmind') ? [
                {index:0,title:'详情页 › 相框 › 主图参考 › 未命名主题',after_char:Array.from(previewText.slice(0,firstAnchor)).length},
                {index:1,title:'详情页 › 相框 › SKU参考 › 未命名主题',after_char:Array.from(previewText.slice(0,secondAnchor)).length}
            ] : [];
            return route.fulfill({json:source.endsWith('.wps') ? {status:'error',message:'请在 WPS 中另存为 .docx 后上传',text:''} : {status:'ready',message:`已读取文字；可预览 ${images.length} 张内嵌图片`,text:previewText,images}});
        }
        if(url.pathname === '/api/canvas-documents/image') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="100%" height="100%" fill="#ac6342"/></svg>'});
        if(url.pathname === '/api/canvas-llm'){
            calls.push(request.postDataJSON());
            return route.fulfill({json:{text:'按运营策划整理的提示词'}});
        }
        if(url.pathname.startsWith('/assets/') || url.pathname === '/api/media-preview') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="100%" height="100%" fill="#aabbcc"/></svg>'});
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',chat_models:['fixture-chat'],image_models:['fixture-image']}],comfy_instances:[]}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://canvas-documents.test/static/smart-canvas.html?id=documents');
    await page.waitForFunction(() => canvas?.id === 'documents');
    await page.addStyleTag({content:'#composer {display:none !important}'});
    await page.evaluate(() => {
        nodes = [{id:'upload',type:'smart-upload',x:100,y:140,images:[]},{id:'agent',type:'smart-agent',x:500,y:120,w:440,h:650,images:[],userPrompt:'按文件策划输出',agentProvider:'fixture',agentModel:'fixture-chat'}];
        canvas.connections = [{from:'upload',to:'agent',kind:'input'}];
        canvasUsesConnections = true;
        viewport = {x:0,y:0,scale:1}; selectedId = ''; selectedIds = [];
        applyViewport(); render();
    });
    return {page,calls,uploads,stored:() => stored};
}

test('upload node chooses documents, previews text and submits files separately from images after reopening', {timeout:45000}, async t => {
    const {page,calls,uploads,stored} = await fixture(t);
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-id="upload"] .node-drop').click();
    const chooser = await chooserPromise;
    assert.ok(await chooser.element().evaluate(el => el.accept.includes('.xmind') && el.accept.includes('.wps') && el.multiple));
    await chooser.setFiles({name:'商品策划.xmind',mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});
    await page.waitForFunction(() => nodes.find(node=>node.id==='upload').images.length === 1);
    assert.deepEqual(uploads[0],['商品策划.xmind']);
    const card = page.locator('[data-id="upload"] .media-file-card');
    await card.waitFor({state:'visible'});
    assert.match(await card.innerText(),/商品策划.xmind/);
    assert.equal(await page.locator('[data-id="upload"] img:not(.smart-document-icon)').count(),0,'documents are not rendered as broken images');
    assert.equal(await card.locator('[data-document-icon="xmind"]').count(),1);
    await page.waitForFunction(() => document.querySelector('[data-id="upload"] .smart-document-icon')?.naturalWidth > 0);
    assert.equal(await card.locator('.image-resolution-badge').count(),0);
    assert.equal(await page.evaluate(()=>Boolean(nodes.find(node=>node.id==='upload').images[0].natural_w)),false,'a software icon must not become the document dimensions');
    const references = page.locator('[data-id="agent"] .smart-node-input-thumb');
    assert.equal(await references.count(),1);
    assert.equal(await references.locator('[data-document-icon="xmind"]').count(),1);
    assert.equal(await references.locator('.smart-node-input-badge').innerText(),'文件');
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-upload-document-node.png')});
    await card.locator('[data-document-preview-url]').click();
    const dialog = page.locator('#smartDocumentPreview');
    await dialog.waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('#smartDocumentPreview pre')?.textContent.includes('原木相框'));
    assert.equal(await dialog.locator('script').count(),0,'document content is displayed as text');
    assert.match(await dialog.locator('.smart-document-flow').innerText(),/<script>不是脚本<\/script>/);
    const picture = dialog.locator('.smart-document-picture');
    assert.equal(await picture.count(),2);
    assert.deepEqual(await dialog.locator('.smart-document-flow').evaluate(el => [...el.children].map(child => child.className || child.tagName)),['PRE','smart-document-inline-images','PRE','smart-document-inline-images','PRE']);
    assert.match(await dialog.locator('.smart-document-flow pre').nth(0).innerText(),/📸 主图[\s\S]*第一屏：原木相框/);
    assert.match(await dialog.locator('.smart-document-flow pre').nth(1).innerText(),/第二屏：SKU尺寸/);
    assert.equal((await dialog.locator('.smart-document-flow').innerText()).includes('未命名主题'),false);
    assert.deepEqual(await dialog.locator('figcaption').allTextContents(),['主图参考','SKU参考']);
    await page.waitForFunction(() => document.querySelector('#smartDocumentPreview .smart-document-picture img')?.naturalWidth > 0);
    await picture.first().click();
    assert.equal(await picture.first().evaluate(element => element.classList.contains('is-expanded')),true);
    await page.screenshot({path:path.join(os.tmpdir(),'xiaomei-upload-document-preview.png')});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal((await page.evaluate(()=>runAgentNode('agent'))).ok,true);
    assert.equal(calls.at(-1).attachments.length,1);
    assert.deepEqual(calls.at(-1).images,[]);
    await page.evaluate(() => saveCanvas());
    assert.equal(stored().nodes.find(node=>node.id==='upload').images[0].document.status,'ready');
    await page.reload();
    await page.waitForFunction(() => nodes.some(node=>node.id==='agent'));
    assert.equal(await references.count(),1);
    await page.locator('[data-id="upload"] [data-document-preview-url]').click();
    await page.waitForFunction(() => document.querySelector('#smartDocumentPreview .smart-document-picture img')?.naturalWidth > 0);
    assert.equal(await page.locator('#smartDocumentPreview .smart-document-picture').count(),2);
    await page.keyboard.press('Escape');
    assert.equal((await page.evaluate(()=>runAgentNode('agent'))).ok,true);
    assert.equal(calls.at(-1).attachments[0].name,'商品策划.xmind');
    // Mixed media preserves the numbering of actual images sent to the model.
    await page.evaluate(() => { nodes.find(node=>node.id==='upload').images.push({url:'/assets/product.png',name:'商品图',kind:'image'}); render(); });
    assert.deepEqual(await references.locator('.smart-node-input-badge').allTextContents(),['文件','图1']);
    assert.equal((await page.evaluate(()=>runAgentNode('agent'))).ok,true);
    assert.deepEqual(calls.at(-1).images,['/assets/product.png']);
    assert.equal(calls.at(-1).attachments.length,1);
    await references.first().hover();
    await references.first().locator('[data-node-input-remove]').click();
    assert.equal((await page.evaluate(()=>runAgentNode('agent'))).ok,true);
    assert.deepEqual(calls.at(-1).attachments,[]);
    assert.equal(await page.evaluate(()=>nodes.find(node=>node.id==='upload').images.length),2,'removing an Agent reference retains the source file');
});

test('dragging multiple files to an upload node retains them and exposes unreadable WPS text', {timeout:40000}, async t => {
    const {page,uploads} = await fixture(t);
    const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        for(const name of ['SKU.xlsx','主图.docx','旧策划.wps']) data.items.add(new File(['fixture'],name,{type:'application/octet-stream'}));
        return data;
    });
    await page.locator('[data-id="upload"]').dispatchEvent('drop',{dataTransfer:transfer});
    await page.waitForFunction(() => nodes.find(node=>node.id==='upload').images.length===3);
    assert.deepEqual(uploads[0],['SKU.xlsx','主图.docx','旧策划.wps']);
    assert.equal(await page.locator('[data-id="agent"] .file-thumb').count(),3);
    const icons = page.locator('[data-id="agent"] .smart-document-icon');
    assert.deepEqual(await icons.evaluateAll(items=>items.map(item=>item.getAttribute('alt'))),['Excel','Word','WPS']);
    await page.waitForFunction(() => [...document.querySelectorAll('.smart-document-icon')].every(icon=>icon.complete && icon.naturalWidth > 0));
    assert.match(await page.locator('[data-id="upload"] .media-file-warning').innerText(),/未读取/);
    await page.locator('[data-id="agent"] [data-document-preview-url]').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#smartDocumentPreview .smart-document-note')?.textContent.includes('另存为'));
    assert.match(await page.locator('#smartDocumentPreview').innerText(),/docx/);
    await page.keyboard.press('Escape');
});
