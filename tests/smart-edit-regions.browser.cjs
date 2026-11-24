const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

async function fixture(t, width=600, height=1000){
    const browser = await chromium.launch({channel:'msedge',headless:true});
    t.after(()=>browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[], requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    const png = await page.evaluate(([width,height])=>{
        const c=document.createElement('canvas');c.width=width;c.height=height;
        const g=c.getContext('2d');g.fillStyle='#d8d8c8';g.fillRect(0,0,600,1000);
        g.fillStyle='#fff';g.beginPath();g.arc(300,200,90,0,Math.PI*2);g.fill();
        g.fillStyle='#666';g.fillRect(270,290,60,250);g.fillStyle='#eee';g.fillRect(60,540,480,300);
        return c.toDataURL().split(',')[1];
    }, [width,height]);
    await page.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*', async route=>{
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        if(url.hostname!=='smart-edit.test')return route.abort();
        if(p.startsWith('/static/')){
            let file=path.resolve(root,'.'+decodeURIComponent(p));
            if(!fs.existsSync(file))file=path.resolve(root,'ComfyUI/web',p.slice('/static/'.length));
            assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404,body:''});
        }
        if(p==='/api/canvas-image-tasks' && req.method()==='POST'){
            requests.push(req.postDataJSON());
            return route.fulfill({json:{task_id:`edit-${requests.length}`,status:'queued'}});
        }
        if(p.startsWith('/api/canvas-image-tasks/'))return route.fulfill({json:{id:p.split('/').pop(),status:'succeeded',result:{images:['/output/result.png']}}});
        if(p==='/api/media-preview' || p.startsWith('/output/'))return route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')});
        if(p==='/api/canvases/edit-fixture' && req.method()==='GET')return route.fulfill({json:{canvas:{id:'edit-fixture',title:'Edit fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[{id:'fixture',name:'Fixture',enabled:true,protocol:'openai',image_models:['fixture-image'],chat_models:[],video_models:[]}]}});
    });
    await page.goto('http://smart-edit.test/static/smart-canvas.html?id=edit-fixture');
    await page.waitForFunction(()=>document.getElementById('smartTitle').textContent==='Edit fixture');
    await page.evaluate(()=>{
        const node=createNode(100,100,[{url:'/output/other.png',name:'Other'},{url:'/output/selected.png',name:'Selected'}],{nodeType:'smart-paint',select:true});
        window.sourceId=node.id;
        window.messages=[];const showToast=toast;window.toast=message=>{messages.push(message);showToast(message);};
        node.runSettings={...settings,engine:'api',apiKind:'image',provider_id:'fixture',model:'fixture-image',count:1};
        window.uploads=[];window.uploadMode='ok';
        window.uploadCroppedBlob=async (blob,name)=>{
            uploads.push({name,blob});
            if(uploadMode==='fail')throw new Error('测试上传失败');
            if(uploadMode==='wait')await new Promise(resolve=>{window.releaseUpload=resolve;});
            return {url:'/output/regions.png',name};
        };
        window.openFixture=()=>{openImageEditor(sourceId,1);setImageEditMode('smart-edit',true);};
        openFixture();
    });
    await page.waitForFunction(width=>document.getElementById('cropImage').naturalWidth===width, width);
    return {page,errors,requests};
}

async function draw(page,x,y,w,h){
    const r=await page.locator('#cropImage').boundingBox();
    await page.mouse.move(r.x+x*r.width,r.y+y*r.height);
    await page.mouse.down();
    await page.mouse.move(r.x+(x+w)*r.width,r.y+(y+h)*r.height,{steps:6});
    await page.mouse.up();
}
async function confirm(page,text){
    await page.locator('#smartEditRegionPrompt').fill(text);
    await page.locator('#smartEditRegionConfirmBtn').click();
}

test('two region instructions submit once with the exact selected original, retain source on rerun', {timeout:60000},async t=>{
    const {page,errors,requests}=await fixture(t);
    await draw(page,.32,.10,.36,.20);
    assert.equal(await page.locator('#smartEditRegionEditor').isVisible(),true);
    await page.locator('#smartEditRegionConfirmBtn').click();
    assert.equal(await page.locator('#smartEditRegionEditor').isVisible(),true,'blank instruction stays editable');
    await confirm(page,'换成红色');
    await draw(page,.90,.84,-.80,-.30);
    await page.locator('#smartEditRegionPrompt').fill('换成蓝色');
    await page.locator('#smartEditSubmitBtn').click();
    assert.equal(requests.length,0,'unconfirmed region cannot submit');
    await page.locator('#smartEditRegionConfirmBtn').click();
    assert.equal(requests.length,0,'confirm is not generation');
    assert.equal(await page.evaluate(()=>uploads.length),0,'confirm does not upload');
    assert.deepEqual(await page.locator('.smart-edit-marker-ref').allTextContents(),['区域 1 · 换成红色','区域 2 · 换成蓝色']);
    await page.locator('.smart-edit-marker-ref').first().click();
    await confirm(page,'换成亮红色');
    if(process.env.SMART_EDIT_SCREENSHOT){
        await page.locator('.smart-edit-marker-ref').last().click();
        await page.screenshot({path:process.env.SMART_EDIT_SCREENSHOT,animations:'disabled'});
        await page.getByRole('button',{name:'取消区域编辑'}).click();
    }
    await page.setViewportSize({width:1050,height:780});
    const aligned=await page.evaluate(()=>{
        const img=document.getElementById('cropImage').getBoundingClientRect();
        const r=document.querySelector('.smart-edit-region').getBoundingClientRect();
        return {x:(r.left-img.left)/img.width,w:r.width/img.width,ratio:img.width/img.height};
    });
    assert.ok(Math.abs(aligned.x-.32)<.01);
    assert.ok(Math.abs(aligned.w-.36)<.01);
    assert.ok(Math.abs(aligned.ratio-.6)<.005);
    await page.selectOption('#smartEditResolutionSelect','4k');
    await page.evaluate(()=>{uploadMode='wait';window.sendPromise=applyImageEdit();});
    await page.waitForFunction(()=>typeof releaseUpload==='function');
    await page.evaluate(()=>applyImageEdit());
    assert.equal(await page.evaluate(()=>uploads.length),1,'double submit only uploads once');
    await page.evaluate(()=>releaseUpload());
    await page.evaluate(()=>sendPromise);
    assert.equal(requests.length,1,await page.evaluate(()=>JSON.stringify({messages,nodes:nodes.map(n=>({title:n.title,error:n.runError,settings:n.runSettings}))})));
    assert.deepEqual(requests[0].reference_images.map(r=>r.url),['/output/selected.png','/output/regions.png']);
    assert.match(requests[0].prompt,/区域 1.*换成亮红色/);
    assert.match(requests[0].prompt,/区域 2.*换成蓝色/);
    assert.match(requests[0].prompt,/左上 192,100，右下 408,300/);
    assert.match(requests[0].prompt,/不要把框线、编号/);
    assert.equal(requests[0].aspect_ratio,'source');
    assert.equal(requests[0].resolution,'4k');
    const [requestWidth,requestHeight]=requests[0].size.split('x').map(Number);
    assert.equal(requestWidth%16,0,'4K 请求宽必须对齐 16');
    assert.equal(requestHeight%16,0,'4K 请求高必须对齐 16');
    assert.ok(Math.abs(requestWidth/requestHeight-.6)<.01,`4K 请求尺寸必须保持 600x1000 原图比例，实际为 ${requests[0].size}`);
    const result=await page.evaluate(async()=>{
        const output=nodes.find(n=>n.smartEditSource);
        const original=nodes.find(n=>n.id===sourceId);
        const bitmap=await createImageBitmap(uploads[0].blob);
        const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;
        const g=c.getContext('2d');g.drawImage(bitmap,0,0);
        const edge=Array.from(g.getImageData(192,180,1,1).data);
        return {source:original.images.map(i=>i.url),regions:output.smartEditRegions,refs:stableReferenceImagesFor(output).map(i=>i.url),size:[bitmap.width,bitmap.height],edge,images:output.images.map(i=>i.url)};
    });
    assert.deepEqual(result.source,['/output/other.png','/output/selected.png']);
    assert.equal(result.regions.length,2);
    assert.deepEqual(result.refs,['/output/selected.png','/output/regions.png']);
    assert.deepEqual(result.size,[600,1000]);
    assert.deepEqual(result.edge,[22,119,255,255]);
    assert.deepEqual(result.images,['/output/result.png']);
    await page.evaluate(()=>runGeneration());
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1].reference_images.map(r=>r.url),['/output/selected.png','/output/regions.png'],'rerun must not use other images or its own result');
    assert.deepEqual(errors,[]);
});

test('cancel/delete, upload failure, close during upload and plain text editing', {timeout:60000},async t=>{
    const {page,errors,requests}=await fixture(t);
    await draw(page,.3,.1,0,0);
    assert.equal(await page.locator('#smartEditRegionEditor').isVisible(),false,'click is not a region');
    await draw(page,.32,.1,.36,.2);await confirm(page,'红色');
    await draw(page,.1,.54,.8,.3);await confirm(page,'蓝色');
    await page.locator('.smart-edit-marker-ref').first().click();
    await page.locator('#smartEditRegionPrompt').fill('未确认的编辑');
    await page.locator('#smartEditRegionPrompt').press('Escape');
    assert.match(await page.locator('.smart-edit-marker-ref').first().textContent(),/红色/);
    assert.equal(await page.locator('#imageEditModal').evaluate(el=>el.classList.contains('open')),true);
    await page.locator('.smart-edit-marker-ref').first().click();
    await page.getByRole('button',{name:'删除区域',exact:true}).click();
    assert.deepEqual(await page.locator('.smart-edit-marker-ref').allTextContents(),['区域 1 · 蓝色']);
    await page.evaluate(()=>{uploadMode='fail';return applyImageEdit();});
    assert.equal(requests.length,0);
    assert.equal(await page.locator('#smartEditSubmitBtn').isEnabled(),true);
    assert.equal(await page.locator('.smart-edit-marker-ref').count(),1,'failed upload retains instructions');
    assert.equal(await page.evaluate(()=>nodes.filter(n=>n.smartEditSource).length),0);
    await page.evaluate(()=>{uploadMode='wait';window.sendPromise=applyImageEdit();});
    await page.waitForFunction(()=>typeof releaseUpload==='function');
    await page.evaluate(()=>{closeImageEditor();openFixture();releaseUpload();});
    await page.evaluate(()=>sendPromise);
    assert.equal(requests.length,0,'closed session cannot generate after upload');
    assert.equal(await page.locator('.smart-edit-marker-ref').count(),0);
    await page.waitForFunction(()=>document.getElementById('cropImage').naturalWidth===600);
    await page.locator('#smartEditPrompt').fill('整体调亮');
    await page.evaluate(()=>applyImageEdit());
    assert.equal(requests.length,1,await page.evaluate(()=>JSON.stringify({messages,nodes:nodes.map(n=>({title:n.title,error:n.runError,settings:n.runSettings}))})));
    assert.deepEqual(requests[0].reference_images.map(r=>r.url),['/output/selected.png']);
    assert.match(requests[0].prompt,/整图补充要求：整体调亮/);
    await page.evaluate(()=>{openFixture();setImageEditMode('crop',true);});
    assert.equal(await page.locator('#imageEditModal').evaluate(el=>el.classList.contains('smart-edit-redesign')),false);
    assert.equal(await page.locator('#smartEditRegionEditor').isVisible(),false);
    assert.deepEqual(errors,[]);
});

test('smart edits show the mapped source dimensions and retain exact pixel output on rerun', {timeout:60000},async t=>{
    const {page,errors,requests}=await fixture(t,1920,800);
    await page.locator('#smartEditPrompt').fill('去除右边的脚轮');
    await page.selectOption('#smartEditResolutionSelect','custom');
    await page.evaluate(()=>applyImageEdit());
    assert.equal(requests[0]?.output_size,'1920x800');
    assert.equal(requests[0]?.aspect_ratio,'source');

    const trigger = page.locator('#dynamicParams .generation-settings-trigger');
    await trigger.click();
    const panel = page.locator('#generationSettingsPopover');
    const width = panel.getByRole('spinbutton',{name:'输出宽度（px）'});
    const height = panel.getByRole('spinbutton',{name:'输出高度（px）'});
    assert.equal(await width.inputValue(),'1920');
    assert.equal(await height.inputValue(),'800');

    await panel.locator('[data-smart-param="resolution"][data-smart-value="2k"]').click();
    assert.match(await panel.locator('[data-mapped-resolution="2k"]').textContent(),/2048 × 848/);
    await panel.getByRole('button',{name:'自定义',exact:true}).click();
    await panel.locator('[data-param="customRatioWidth"]').fill('3');
    await panel.locator('[data-param="customRatioHeight"]').fill('2');
    assert.match(await panel.locator('[data-mapped-resolution="2k"]').textContent(),/2048 × 1360/);

    await panel.getByRole('button',{name:'自定义尺寸',exact:true}).click();
    await width.fill('8193');
    await panel.getByRole('button',{name:'关闭参数面板'}).click();
    await page.evaluate(()=>runGeneration());
    assert.equal(requests.length,1,'invalid size cannot submit another task');
    assert.match(await page.evaluate(()=>messages.at(-1)),/整数宽高/);
    assert.deepEqual(await page.evaluate(()=>nodes.find(node=>node.smartEditSource).images.map(image=>image.url)),['/output/result.png']);

    await trigger.click();
    await width.fill('1440');
    await height.fill('600');
    await height.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    await page.evaluate(()=>runGeneration());
    assert.equal(requests[1]?.size,'1440x600');
    assert.equal(requests[1]?.output_size,'1440x600');
    assert.equal(requests[1]?.aspect_ratio,'12:5');
    assert.deepEqual(requests[1]?.reference_images.map(r=>r.url),['/output/selected.png']);
    assert.deepEqual(errors,[]);
});



