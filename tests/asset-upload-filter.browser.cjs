const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('upload directory accepts files and the filter shows design choices first', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:960}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let uploaded = false;
    let uploadCount = 0;
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(__dirname, '..', '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/asset-library') return route.fulfill({json:{library:{libraries:[{id:'default',name:'默认资产库',categories:[]}]}}});
        if(url.pathname === '/api/prompt-libraries') return route.fulfill({json:{library:{libraries:[]}}});
        if(url.pathname === '/api/storage-files'){
            const items = uploaded ? [{id:'uploaded',name:'测试图片.png',url:'/api/storage-files/upload/test.png',kind:'image',width:1200,height:800,size:68}] : [];
            return route.fulfill({json:{items,total:items.length,has_more:false,projects:[],canvases:[],unassigned_count:items.length}});
        }
        if(url.pathname === '/api/ai/upload'){
            uploadCount++;
            uploaded = true;
            return route.fulfill({json:{files:[{name:'测试图片.png',url:'/api/storage-files/upload/test.png'}]}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204,body:''});
    });
    await page.goto('http://asset-upload.test/static/asset-manager.html');
    await page.waitForFunction(() => uploadAssetsState.loaded && !uploadAssetsState.loading);
    assert.equal(await page.locator('[data-asset-library-view]').count(), 0);
    assert.equal(await page.locator('#assetDrop').isEnabled(), true);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#assetDrop').click();
    await (await chooser).setFiles({name:'测试图片.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')});
    await page.waitForFunction(() => uploadAssetsState.view === 'disk' && uploadAssetsState.items.some(item => item.id === 'uploaded'));
    assert.equal(uploadCount, 1);
    assert.equal(await page.locator('[data-upload-card="uploaded"]').count(), 1);
    await page.locator('#imageSpaceSubtabs [data-tab="assets"]').click();
    assert.equal(await page.locator('[data-upload-card="uploaded"]').count(), 1);
    await page.locator('[data-tab="generated"]').last().click();
    await page.locator('[data-space-toggle]').click();
    assert.deepEqual(await page.locator('[data-space-form] > .space-filter-fields [data-space-filter]').evaluateAll(els => els.map(el => el.dataset.spaceFilter)), ['kind','shape','color','style']);
    assert.equal(await page.locator('[data-space-filter="color"]').isDisabled(), true);
    assert.equal(await page.locator('[data-space-filter="style"]').isDisabled(), true);
    await page.locator('[data-space-filter="shape"]').selectOption('landscape');
    await page.locator('[data-space-form] button[type="submit"]').click();
    assert.equal(await page.evaluate(() => imageSpaceState.filters.generated.shape), 'landscape');
    assert.deepEqual(errors, []);
});
