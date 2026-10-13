const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('OCR requires platform/model selection and manual start, and supports editing and cancellation', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge',headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:960}});
    const errors = [];
    let hold = false, release, failed = false, requests = 0;
    const recognitionRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const items = [
        {text:'榻榻米床垫子\n0胶水0异味',x:.1,y:.1,width:.5,height:.18,source_boxes:[{x:.1,y:.1,width:.5,height:.08},{x:.1,y:.2,width:.4,height:.08}]},
        {text:'防螨\n护脊',x:.75,y:.7,width:.15,height:.2}
    ];
    await page.route('**/*', async route => {
        const request=route.request(), url=new URL(request.url()), p=url.pathname;
        if(url.hostname !== 'xiaomei-ocr.test') return route.abort();
        if(p.startsWith('/static/')){
            const file=path.resolve(root,'.'+decodeURIComponent(p));
            assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({body:''});
        }
        if(p === '/api/config') return route.fulfill({json:{api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',image_models:['fixture-image'],chat_models:['fixture-vision','other-vision']},{id:'unconfigured',name:'No key',enabled:true,has_key:false,protocol:'openai',chat_models:['missing-key-model']},{id:'cli-fixture',name:'GPT CLI',enabled:true,has_key:false,protocol:'codex',chat_models:['cli-model']},{id:'gemini-fixture',name:'Antigravity CLI',enabled:true,has_key:false,protocol:'gemini-cli',chat_models:['gemini-model']},{id:'disabled-cli',enabled:false,has_key:false,protocol:'codex',chat_models:['disabled-model']}],comfy_instances:[]}});
        if(p === '/api/canvases/ocr-fixture') return route.fulfill({json:{canvas:{id:'ocr-fixture',title:'OCR fixture',nodes:[],connections:[],settings:{}}}});
        if(p === '/api/image-ocr'){
            requests++;
            const payload=request.postDataJSON();
            recognitionRequests.push(payload);
            assert.ok(payload.data.startsWith('data:image/'));
            assert.ok(({fixture:['fixture-vision','other-vision'],'cli-fixture':['cli-model'],'gemini-fixture':['gemini-model']}[payload.provider] || []).includes(payload.model));
            if(hold){hold=false;await new Promise(resolve => {release=resolve;});}
            if(failed) return route.fulfill({status:503,json:{detail:'模拟识别失败，请重试'}});
            return route.fulfill({json:{success:true,items,engine:'api',model:request.postDataJSON().model}}).catch(()=>{});
        }
        if(p.endsWith('.png') || p.includes('media-preview')) return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="100%" height="100%" fill="#dfdbd1"/></svg>'});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],cases:[],batches:[]}});
    });
    await page.goto('http://xiaomei-ocr.test/static/smart-canvas.html?id=ocr-fixture');
    await page.waitForFunction(()=>document.getElementById('smartTitle')?.textContent==='OCR fixture');
    const id=await page.evaluate(()=>{
        const node=createNode(220,180,[{url:'/output/source.png',name:'主图.png',kind:'image',natural_w:1000,natural_h:800}],{nodeType:'smart-image',select:true});
        render(); openImageEditor(node.id,0);setImageEditMode('ocr',true);return node.id;
    });
    await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth>0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(requests,0,'Opening OCR and loading the image must not start recognition');
    assert.equal(await page.locator('#ocrModelToggle').getAttribute('aria-expanded'),'true');
    assert.deepEqual(await page.locator('#ocrRecognitionProviderSelect option').allTextContents(),['请选择 API 平台','Fixture','GPT CLI','Antigravity CLI']);
    assert.equal(await page.locator('#ocrRecognitionProviderSelect').inputValue(),'');
    assert.ok(await page.locator('#ocrRecognitionModelSelect').isDisabled());
    assert.ok(await page.locator('#ocrRecognizeBtn').isDisabled());
    await page.locator('#ocrRecognitionProviderSelect').selectOption('fixture');
    assert.deepEqual(await page.locator('#ocrRecognitionModelSelect option').allTextContents(),['请选择识字模型','fixture-vision','other-vision']);
    assert.ok(await page.locator('#ocrRecognizeBtn').isDisabled());
    await page.locator('#ocrRecognitionModelSelect').selectOption('fixture-vision');
    assert.equal(requests,0,'Selecting a platform or model must not start recognition');
    if(process.env.XIAOMEI_OCR_SCREENSHOT) await page.screenshot({path:process.env.XIAOMEI_OCR_SCREENSHOT});
    await page.locator('#ocrRecognizeBtn').click();
    await page.waitForFunction(()=>imageOcrItems.length===2 && !ocrRequestController);
    assert.equal(requests,1);
    assert.equal(await page.locator('#ocrModelSelect option').count(),1);
    for(const [provider,model] of [['cli-fixture','cli-model'],['gemini-fixture','gemini-model']]){
        const count=requests;
        await page.locator('#ocrRecognitionProviderSelect').selectOption(provider);
        assert.equal(await page.locator('#ocrRecognitionModelSelect').inputValue(),'');
        assert.deepEqual(await page.locator('#ocrRecognitionModelSelect option').allTextContents(),['请选择识字模型',model]);
        assert.ok(await page.locator('#ocrRecognizeBtn').isDisabled());
        await page.locator('#ocrRecognitionModelSelect').selectOption(model);
        assert.equal(requests,count);
        await page.locator('#ocrRecognizeBtn').click();
        await page.waitForFunction(()=>imageOcrItems.length===2 && !ocrRequestController);
        assert.equal(requests,count+1);
        assert.equal(recognitionRequests.at(-1).provider,provider);
        assert.equal(recognitionRequests.at(-1).model,model);
        assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('xiaomei_ocr_model_v1'))),{provider_id:provider,model});
    }
    await page.locator('#ocrRecognitionProviderSelect').selectOption('fixture');
    await page.locator('#ocrRecognitionModelSelect').selectOption('other-vision');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('xiaomei_ocr_model_v1')).model),'other-vision');
    const fields=page.locator('[data-ocr-replacement]');
    assert.equal(await fields.nth(0).inputValue(),'榻榻米床垫子\n0胶水0异味');
    await fields.nth(1).focus();
    const layer=page.locator(`.image-node[data-id="${id}"] .ocr-node-region-layer`);
    assert.ok(await layer.locator('[data-ocr-region="1"]').evaluate(el=>el.classList.contains('is-active')));
    await layer.locator('[data-ocr-region="0"]').click({position:{x:10,y:10}});
    assert.equal(await page.evaluate(()=>ocrActiveRegion),0);
    const before=await page.evaluate(()=>({...imageOcrItems[0]}));
    const box=await layer.locator('[data-ocr-region="0"]').boundingBox();
    await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+50,box.y+35,{steps:4});await page.mouse.up();
    await page.waitForFunction(start=>imageOcrItems[0].x>start.x,before);
    const moved=await page.evaluate(()=>({...imageOcrItems[0]}));
    assert.ok(moved.y>before.y);
    assert.ok(Math.abs((moved.source_boxes[0].x-before.source_boxes[0].x)-(moved.x-before.x))<1e-6);
    const handle=await layer.locator('[data-ocr-region="0"] [data-ocr-resize]').boundingBox();
    await page.mouse.move(handle.x+5,handle.y+5);await page.mouse.down();await page.mouse.move(handle.x+25,handle.y+20,{steps:4});await page.mouse.up();
    await page.waitForFunction(start=>imageOcrItems[0].width>start.width,moved);
    await fields.nth(0).fill('替换标题');
    assert.ok(await page.locator('#ocrGenerateBtn').isEnabled());
    await page.locator('[data-ocr-delete="0"]').click();
    assert.ok(await page.locator('#ocrGenerateBtn').isDisabled());
    assert.equal(await page.locator('#ocrCountLabel').textContent(),'识别 1 组 · 已改 0 组');

    failed=true;
    await page.locator('#ocrRecognizeBtn').click();
    await page.waitForFunction(()=>document.getElementById('ocrStatus').textContent.includes('模拟识别失败'));
    assert.equal(await fields.count(),1);
    assert.ok(await page.locator('#ocrRecognizeBtn').isEnabled());
    failed=false;hold=true;
    await page.locator('#ocrRecognizeBtn').click();
    await page.waitForFunction(()=>!!ocrRequestController);
    assert.ok(await page.locator('#ocrRecognitionProviderSelect').isDisabled());
    assert.ok(await page.locator('#ocrRecognitionModelSelect').isDisabled());
    assert.ok(await page.locator('#ocrGenerateBtn').isDisabled());
    await page.evaluate(()=>closeImageEditor());
    await page.waitForFunction(()=>!ocrRequestController);
    release();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>imageOcrItems.length),0);
    const lastRequestCount=requests;
    await page.evaluate(()=>{openImageEditor(nodes[0].id,0);setImageEditMode('ocr',true);});
    await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth>0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#ocrRecognitionProviderSelect').inputValue(),'fixture');
    assert.equal(await page.locator('#ocrRecognitionModelSelect').inputValue(),'other-vision');
    assert.equal(requests,lastRequestCount,'Reopening OCR with a saved model must not start recognition');
    await page.evaluate(()=>closeImageEditor());
    await page.evaluate(()=>{ apiProviders=[];ocrRecognitionSelection={provider_id:'',model:''};openImageEditor(nodes[0].id,0);setImageEditMode('ocr',true); });
    assert.deepEqual(await page.locator('#ocrRecognitionProviderSelect option').allTextContents(),['暂无可用平台']);
    assert.equal(requests,lastRequestCount);
    assert.ok(await page.locator('#ocrRecognitionProviderSelect').isDisabled());
    assert.ok(await page.locator('#ocrRecognitionModelSelect').isDisabled());
    assert.ok(await page.locator('#ocrRecognizeBtn').isDisabled());
    assert.deepEqual(errors,[]);
});
