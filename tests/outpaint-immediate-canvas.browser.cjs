const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('outpaint returns to canvas while its base image uploads', {timeout:60000}, async t => {
    const installedEdge = process.platform === 'win32'
        ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync)
        : null;
    const browser = await chromium.launch(installedEdge ? {executablePath:installedEdge, headless:true} : {channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="red"/></svg>';
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'outpaint-fast.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/outpaint-fast-fixture'){
            return route.fulfill({json:{canvas:{id:'outpaint-fast-fixture',title:'Outpaint fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        }
        if(url.pathname === '/output/source.svg' || url.pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/svg+xml',body:source});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });

    await page.goto('http://outpaint-fast.test/static/smart-canvas.html?id=outpaint-fast-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Outpaint fixture');
    await page.evaluate(() => {
        window.outpaintSourceId = createNode(100,100,[
            {url:'/output/source.svg',name:'source.svg',kind:'image',natural_w:80,natural_h:60}
        ], {nodeType:'smart-image'}).id;
        window.outpaintUploadStarted = false;
        window.outpaintRunStarted = false;
        outpaintModelEntry = () => ({providerId:'fixture',model:'fixture-image',providerName:'Fixture'});
        uploadCroppedBlob = () => {
            outpaintUploadStarted = true;
            return new Promise(resolve => { window.finishOutpaintUpload = () => resolve({url:'/output/base.png',name:'base.png'}); });
        };
        runSmartNodeWithDependencies = async node => {
            outpaintRunStarted = node.images[0]?.url === '/output/base.png';
            return {ok:true};
        };
        openImageEditor(outpaintSourceId,0);
    });
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 80);
    await page.evaluate(() => setImageEditMode('outpaint',true));
    await page.locator('#outpaintRunBtn').click();
    await page.waitForFunction(() => outpaintUploadStarted);
    const pending = await page.evaluate(() => {
        const output = nodes.find(node => node.title === '扩图');
        return {
            modalOpen:imageEditModal.classList.contains('open'),
            visible:!!document.querySelector(`.image-node[data-id="${output?.id}"]`),
            queued:output?.queued === true,
            connected:canvas.connections.some(edge => edge.from === outpaintSourceId && edge.to === output?.id),
            runStarted:outpaintRunStarted
        };
    });
    assert.deepEqual(pending,{modalOpen:false,visible:true,queued:true,connected:true,runStarted:false});
    await page.evaluate(() => finishOutpaintUpload());
    await page.waitForFunction(() => outpaintRunStarted);
    await page.evaluate(() => {
        uploadCroppedBlob = async () => { throw new Error('模拟上传失败'); };
        openImageEditor(outpaintSourceId,0);
    });
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 80);
    await page.evaluate(() => setImageEditMode('outpaint',true));
    await page.locator('#outpaintRunBtn').click();
    await page.waitForFunction(() => nodes.some(node => node.runError === '模拟上传失败'));
    assert.equal(await page.evaluate(() => imageEditModal.classList.contains('open')),false);
    assert.deepEqual(errors,[]);
});
