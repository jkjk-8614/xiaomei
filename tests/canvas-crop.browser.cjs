const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('crop replaces local image references, reopens the cropped pixels, and keeps failed uploads editable', {timeout:60000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());

    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="red"/><rect x="30" width="30" height="40" fill="blue"/></svg>';
    let uploads = 0;
    let failUpload = true;
    let savedPng = null;
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if(url.hostname !== 'canvas-crop.test') return route.abort();
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/canvases/crop-fixture') return route.fulfill({json:{canvas:{id:'crop-fixture',title:'Crop fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        if(pathname === '/api/ai/upload'){
            uploads++;
            if(failUpload) return route.fulfill({status:500,json:{detail:'上传暂时失败'}});
            const multipart = request.postDataBuffer();
            const start = multipart.indexOf(Buffer.from('\x89PNG\r\n\x1a\n','latin1'));
            const end = multipart.indexOf(Buffer.from('IEND'),start) + 8;
            assert.ok(start >= 0 && end > start);
            savedPng = multipart.subarray(start, end);
            return route.fulfill({json:{files:[{url:'/output/cropped.png',name:'cropped.png',kind:'image'}]}});
        }
        if(pathname === '/output/cropped.png' && savedPng) return route.fulfill({contentType:'image/png',body:savedPng});
        if(pathname === '/output/source.png' || pathname === '/api/media-preview') return route.fulfill({contentType:'image/svg+xml',body:source});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });

    await page.goto('http://canvas-crop.test/static/smart-canvas.html?id=crop-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Crop fixture');
    await page.evaluate(() => {
        const node = createNode(200,200,[{
            url:'https://example.test/remote-original.png',
            originalLocalUrl:'/output/source.png',
            localUrl:'/output/source.png',
            sourceUrl:'/output/source.png',
            local_url:'/output/source.png',
            source_url:'/output/source.png',
            name:'source.png', kind:'image', natural_w:60, natural_h:40
        }],{nodeType:'smart-image',select:true});
        window.cropFixtureId = node.id;
        openImageEditor(node.id,0);
        setImageEditMode('crop',true);
    });
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 60 && cropState?.w > 0);
    await page.evaluate(() => {
        cropState.x = 0; cropState.y = 0;
        cropState.w = document.getElementById('cropImage').clientWidth / 2;
        cropState.h = document.getElementById('cropImage').clientHeight / 2;
        renderCropBox();
    });
    const undoBeforeCrop = await page.evaluate(() => undoStack.length);

    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('裁剪保存失败'));
    assert.equal(uploads,1);
    assert.equal(await page.locator('#imageEditModal').evaluate(el => el.classList.contains('open')),true);
    assert.equal(await page.evaluate(() => nodes.find(n => n.id === cropFixtureId).images[0].url),'https://example.test/remote-original.png');

    failUpload = false;
    await page.locator('#imageEditApplyBtn').click();
    await page.waitForFunction(() => nodes.find(n => n.id === cropFixtureId).images[0].url === '/output/cropped.png');
    assert.equal(uploads,2);
    assert.equal(savedPng.readUInt32BE(16),30);
    assert.equal(savedPng.readUInt32BE(20),20);
    const result = await page.evaluate(() => {
        const node = nodes.find(n => n.id === cropFixtureId);
        return {
            image:node.images[0],
            display:imageForDisplay(node.images[0]).url,
            rendered:[...document.querySelectorAll('.image-node')].find(el => el.dataset.id === cropFixtureId)?.querySelector('.node-body img')?.dataset.originalSrc,
            undoCount:undoStack.length
        };
    });
    for(const key of ['url','originalLocalUrl','localUrl','sourceUrl','local_url','source_url']) assert.equal(result.image[key],'/output/cropped.png');
    assert.equal(result.display,'/output/cropped.png');
    assert.equal(result.rendered,'/output/cropped.png');
    assert.equal(result.image.natural_w,30);
    assert.equal(result.image.natural_h,20);
    assert.equal(result.undoCount,undoBeforeCrop + 1);

    await page.evaluate(() => { openImageEditor(cropFixtureId,0); setImageEditMode('crop',true); });
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 30);
    assert.equal(await page.evaluate(() => document.getElementById('cropImage').naturalHeight),20);
    const urlsAfterUndoRedo = await page.evaluate(() => {
        closeImageEditor();
        performUndo();
        const undoUrl = nodes.find(n => n.id === cropFixtureId).images[0].url;
        performRedo();
        return [undoUrl,nodes.find(n => n.id === cropFixtureId).images[0].url];
    });
    assert.deepEqual(urlsAfterUndoRedo,['https://example.test/remote-original.png','/output/cropped.png']);
    const legacyDisplay = await page.evaluate(() => {
        const legacy = {
            url:'/output/cropped.png', name:'source_crop.png', kind:'image',
            originalLocalUrl:'/output/source.png', localUrl:'/output/source.png',
            sourceUrl:'/output/source.png', local_url:'/output/source.png', source_url:'/output/source.png'
        };
        return imageForDisplay(legacy).url;
    });
    assert.equal(legacyDisplay,'/output/cropped.png');
    assert.deepEqual(errors,[]);
});
