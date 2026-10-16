const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('local material folders drag into sibling order and keep it after reload', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1200,height:900}});
    const names = ['ps相框', '实木平角相框', '曲目斜角相框', '水晶相框'];
    let order = [...names];
    const tree = () => ({path:'',name:'全部上传',count:0,children:order.map(name => ({path:name,name,count:0,children:[]}))});
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.pathname === '/api/local-assets/folders/reorder'){
            const body = request.postDataJSON();
            assert.equal(body.parent, '');
            assert.deepEqual([...body.paths].sort(), [...names].sort());
            order = body.paths;
            return route.fulfill({json:{ok:true,tree:tree(),items:[]}});
        }
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:[],tree:tree()}});
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(__dirname,'..','.'+decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204,body:''});
    });
    const openLocal = async () => {
        await page.goto('http://local-folder-order.test/static/asset-manager.html');
        await page.waitForFunction(() => localAssetsLoaded);
        await page.locator('[data-tab="local"]').click();
    };
    await openLocal();
    const folders = page.locator('[data-localup-folder][draggable="true"]');
    assert.deepEqual(await folders.locator('.tree-row-name').allTextContents(), names);
    await page.locator('[data-localup-folder="实木平角相框"]').dragTo(page.locator('[data-localup-folder="曲目斜角相框"]'), {targetPosition:{x:40,y:21}});
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent === '文件夹顺序已保存');
    assert.deepEqual(order, ['ps相框', '曲目斜角相框', '实木平角相框', '水晶相框']);
    assert.deepEqual(await folders.locator('.tree-row-name').allTextContents(), order);
    await openLocal();
    assert.deepEqual(await folders.locator('.tree-row-name').allTextContents(), order);
});
