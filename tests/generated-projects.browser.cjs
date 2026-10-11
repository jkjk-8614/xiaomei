const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('generated materials includes project and canvas navigation with existing asset actions', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:960}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=';
    const index = {
        projects:[{id:'default',name:'水晶相框',order:0},{id:'wedding',name:'婚纱相框',order:1},{id:'empty',name:'空项目',order:2}],
        canvases:[{id:'a',title:'主图',kind:'smart',project:'default'},{id:'b',title:'详情页',kind:'smart',project:'wedding'},{id:'c',title:'旧画布',kind:'classic',project:'wedding'}],
        items:[
            {id:'a1',name:'水晶.png',url:image,kind:'image',canvas_id:'a',canvas_title:'主图',canvas_kind:'smart',project:'default'},
            {id:'b1',name:'婚纱.png',url:image,kind:'image',canvas_id:'b',canvas_title:'详情页',canvas_kind:'smart',project:'wedding'},
            {id:'b2',name:'细节.png',url:image+'#detail',kind:'image',canvas_id:'b',canvas_title:'详情页',canvas_kind:'smart',project:'wedding'},
            {id:'c1',name:'旧图.png',url:image,kind:'image',canvas_id:'c',canvas_title:'旧画布',canvas_kind:'classic',project:'wedding'},
        ],
    };
    const files = [{id:'generated-image',name:'生成.png',url:image,kind:'image',rel:'生成.png',size:10},{id:'generated-video',name:'视频.mp4',url:'/fixtures/video.mp4',kind:'video',rel:'视频.mp4',size:10}];
    let refreshFailure = false;
    let downloadItems;
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.pathname === '/api/canvas-assets/download'){
            downloadItems = request.postDataJSON().items;
            return route.fulfill({body:'fixture zip',contentType:'application/zip'});
        }
        assert.equal(request.method(), 'GET');
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(__dirname,'..','.'+decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvas-assets') return route.fulfill(refreshFailure ? {status:503,json:{detail:'读取失败，请重试'}} : {json:index});
        if(url.pathname === '/api/storage-files'){
            const filters = JSON.parse(url.searchParams.get('filters') || '{}');
            const items = files.filter(item => (!url.searchParams.get('media_type') || item.kind === url.searchParams.get('media_type')) && (!filters.kind || item.kind === filters.kind));
            return route.fulfill({json:{items,total:items.length,all_total:2,media_counts:{image:1,video:1},has_more:false}});
        }
        if(url.pathname === '/api/image-space/collections') return route.fulfill({json:{collections:[{id:'saved',name:'图片合集',source:'generated',folder:'',filters:{kind:'image'}}]}});
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204,body:''});
    });
    await page.goto('http://generated-projects.test/static/asset-manager.html');
    await page.waitForFunction(() => canvasAssetsData.projects.length === 3);
    assert.equal(await page.locator('[data-tab="canvas-assets"]').count(), 0);
    await page.locator('[data-tab="generated"]').click();
    await page.waitForFunction(() => generatedAssetsState.loaded);
    assert.equal(await page.locator('[data-generated-card]').count(), 2);
    assert.deepEqual(await page.locator('[data-canvas-asset-project] .tree-row-name').allTextContents(), ['水晶相框','婚纱相框','空项目']);
    await page.locator('[data-canvas-asset-project="wedding"]').click();
    assert.equal(await page.evaluate(() => activeTab), 'generated');
    assert.equal(await page.locator('[data-tab="generated"]').getAttribute('class'), 'active');
    assert.equal(await page.locator('#assetTabAssets').getAttribute('class'), 'active');
    assert.equal(await page.locator('#imageSpaceSubtabs').isVisible(), true);
    assert.equal(await page.locator('[data-canvas-asset-card]').count(), 2);
    assert.equal(await page.locator('[data-canvas-asset-project="wedding"] .tree-row-count').innerText(), '2');
    assert.match(await page.locator('.detail-meta-grid').innerText(), /婚纱相框/);
    await page.locator('[data-canvas-asset-canvas="b"]').click();
    assert.equal(await page.evaluate(() => activeCanvasAssetCanvasId), 'b');
    await page.locator('#canvasAssetSearch').fill('细节');
    await page.waitForFunction(() => document.querySelectorAll('[data-canvas-asset-card]').length === 1);
    assert.equal(await page.locator('[data-canvas-asset-card]').getAttribute('data-canvas-asset-card'), 'b2');
    await page.locator('#canvasAssetSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('[data-canvas-asset-card]').length === 2);
    await page.locator('[data-canvas-asset-manage]').click();
    await page.locator('[data-canvas-asset-card="b2"]').click();
    assert.equal(await page.locator('[data-canvas-asset-download-selected]').isEnabled(), true);
    await page.locator('[data-canvas-asset-select-all]').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-canvas-asset-download-selected]').click();
    await download;
    assert.equal(downloadItems.length, 2);
    assert.deepEqual(downloadItems.map(item => item.name).sort(), ['婚纱.png','细节.png']);
    await page.locator('[data-canvas-asset-project="empty"]').click();
    assert.equal(await page.locator('[data-canvas-asset-card]').count(), 0);
    assert.match(await page.locator('.empty-state').innerText(), /当前项目/);
    await page.locator('[data-generated-type="image"]').click();
    await page.waitForFunction(() => !generatedAssetsState.loading && generatedAssetsState.mediaType === 'image');
    assert.equal(await page.locator('[data-generated-card]').count(), 1);
    assert.equal(await page.locator('[data-generated-card]').getAttribute('data-generated-card'), 'generated-image');
    await page.locator('[data-generated-type="video"]').click();
    await page.waitForFunction(() => !generatedAssetsState.loading && generatedAssetsState.mediaType === 'video');
    assert.equal(await page.locator('[data-generated-card]').getAttribute('data-generated-card'), 'generated-video');
    await page.locator('[data-canvas-asset-project="default"]').click();
    await page.locator('[data-generated-type="all"]').click();
    await page.waitForFunction(() => !generatedAssetsState.loading);
    assert.equal(await page.locator('[data-generated-card]').count(), 2);
    await page.locator('[data-canvas-asset-project="wedding"]').click();
    await page.locator('[data-generated-fav-filter]').click();
    assert.equal(await page.evaluate(() => isCanvasAssetView()), false);
    assert.match(await page.locator('.content-heading').innerText(), /我的收藏/);
    await page.locator('[data-canvas-asset-project="wedding"]').click();
    await page.locator('[data-space-collection="saved"]').click();
    await page.waitForFunction(() => !generatedAssetsState.loading && imageSpaceState.collectionId === 'saved');
    assert.equal(await page.evaluate(() => isCanvasAssetView()), false);
    assert.equal(await page.locator('[data-generated-card]').count(), 1);
    await page.locator('[data-canvas-asset-project="wedding"]').click();
    if(process.env.XIAOMEI_TEST_SCREENSHOT) await page.screenshot({path:process.env.XIAOMEI_TEST_SCREENSHOT,fullPage:true});
    refreshFailure = true;
    await page.locator('[data-canvas-asset-refresh]').click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent.includes('读取失败'));
    assert.equal(await page.locator('[data-canvas-asset-card]').count(), 2);
    assert.deepEqual(errors, []);
});
