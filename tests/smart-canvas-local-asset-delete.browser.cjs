const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const files = ['相框/白色相框.png', '相框/黑色相框.png'];
const items = files.map(file => ({id:file, file, folder:'相框', name:path.posix.basename(file), kind:'image', url:`/assets/${file}`}));
const localAssets = () => ({
    items,
    tree:{id:'__root__', name:'全部上传', items:[], count:items.length, children:[
        {id:'相框', path:'相框', name:'相框', items, count:items.length, children:[]}
    ]}
});

test('canvas asset deletion removes the card immediately, skips a second full listing, and restores failures', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400, height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let localAssetReads = 0;
    let releaseDelete;
    let deletionCount = 0;
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return file.startsWith(root + path.sep) && fs.existsSync(file)
                ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/canvases/delete-fixture'){
            return route.fulfill({json:{canvas:{id:'delete-fixture', title:'Delete fixture', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        if(url.pathname === '/api/local-assets'){
            localAssetReads += 1;
            return route.fulfill({json:localAssets()});
        }
        if(url.pathname === '/api/local-assets/delete'){
            deletionCount += 1;
            const body = route.request().postDataJSON();
            await new Promise(resolve => { releaseDelete = resolve; });
            return deletionCount === 1
                ? route.fulfill({json:{deleted:body.names, trashed_asset_ids:['asset_first']}})
                : route.fulfill({status:409, json:{detail:'该素材仍被画布引用'}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204, body:''});
    });
    await page.goto('http://asset-delete.test/static/smart-canvas.html?id=delete-fixture');
    await page.waitForFunction(() => typeof toggleAssetLibrary === 'function' && canvas?.id === 'delete-fixture');
    await page.evaluate(() => toggleAssetLibrary(true));
    await page.locator('#assetGrid .asset-item').first().waitFor();
    await page.locator('#assetCategorySelect').selectOption('相框');
    assert.equal(await page.locator('#assetGrid .asset-item').count(), 2);
    const initialReads = localAssetReads;

    await page.locator('[data-delete-local-asset="相框/白色相框.png"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-delete-local-asset="相框/白色相框.png"]'));
    assert.equal(await page.locator('#assetGrid .asset-item').count(), 1);
    releaseDelete();
    await page.waitForFunction(() => localAssetLibrary.items.length === 1);
    assert.equal(localAssetReads, initialReads);
    assert.equal(await page.evaluate(() => localAssetLibrary.tree.children[0].count), 1);

    await page.locator('[data-delete-local-asset="相框/黑色相框.png"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-delete-local-asset="相框/黑色相框.png"]'));
    releaseDelete();
    await page.locator('[data-delete-local-asset="相框/黑色相框.png"]').waitFor();
    assert.equal(await page.locator('#assetGrid .asset-item').count(), 1);
    assert.equal(localAssetReads, initialReads);
    assert.deepEqual(errors, []);
});
