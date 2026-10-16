const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('local material moves by drag and by the single-item move option', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    let files = ['实木平角相框/黑色铝合金相框.png', '实木平角相框/黑色实木相框.png'];
    const moves = [];
    const tree = () => ({path:'',name:'全部上传',count:files.length,children:[
        {path:'实木平角相框',name:'实木平角相框',count:files.filter(file => file.startsWith('实木平角相框/')).length,children:[]},
        {path:'铝合金相框',name:'铝合金相框',count:files.filter(file => file.startsWith('铝合金相框/')).length,children:[]},
        {path:'水晶相框',name:'水晶相框',count:files.filter(file => file.startsWith('水晶相框/')).length,children:[]}
    ]});
    const items = () => files.map(file => ({id:file,file,name:path.posix.basename(file),folder:path.posix.dirname(file),kind:'image',size:1024,url:'/assets/'+file}));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.pathname === '/api/local-assets/move'){
            const body = route.request().postDataJSON();
            moves.push(body);
            if(body.folder === '铝合金相框' && body.names.some(name => name.includes('黑色实木'))){
                return route.fulfill({status:400,json:{detail:'目标文件夹不可用'}});
            }
            files = files.map(file => body.names.includes(file) ? [body.folder,path.posix.basename(file)].filter(Boolean).join('/') : file);
            return route.fulfill({json:{ok:true,moved:body.names.length,items:items(),tree:tree()}});
        }
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:items(),tree:tree()}});
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(__dirname,'..','.'+decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204,body:''});
    });
    await page.goto('http://local-asset-move.test/static/asset-manager.html');
    await page.waitForFunction(() => localAssetsLoaded);
    await page.locator('[data-tab="local"]').click();
    await page.locator('[data-localup-folder="实木平角相框"]').click();
    await page.locator('[data-localup-card="实木平角相框/黑色铝合金相框.png"]').dragTo(page.locator('[data-localup-folder="铝合金相框"]'));
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent === '已移动 1 个素材');
    assert.deepEqual(moves[0], {names:['实木平角相框/黑色铝合金相框.png'],folder:'铝合金相框'});
    assert.equal(await page.locator('[data-localup-folder="铝合金相框"] .tree-row-count').textContent(), '1');

    await page.locator('[data-localup-card="实木平角相框/黑色实木相框.png"]').click();
    await page.locator('[data-localup-card="实木平角相框/黑色实木相框.png"] [data-localup-move-one]').click();
    assert.equal(await page.locator('#localUploadMoveModal').isVisible(), true);
    assert.equal(await page.locator('[data-localup-move-target="实木平角相框"]').isDisabled(), true);
    await page.locator('[data-localup-move-target="铝合金相框"]').click();
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent === '目标文件夹不可用');
    assert.equal(await page.locator('#localUploadMoveModal').isVisible(), true);
    assert.equal(files[1], '实木平角相框/黑色实木相框.png');
    await page.locator('[data-localup-move-target=""]').click();
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent === '已移动 1 个素材');
    assert.equal(await page.locator('#localUploadMoveModal').isVisible(), false);
    assert.equal(files[1], '黑色实木相框.png');

    await page.locator('[data-localup-folder=""]').click();
    await page.locator('[data-localup-manage]').click();
    await page.locator('[data-localup-select-all]').click();
    await page.locator('[data-localup-move-selected]').click();
    await page.locator('[data-localup-move-target="水晶相框"]').click();
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent === '已移动 2 个素材');
    assert.equal(moves.at(-1).names.length, 2);
    assert.ok(files.every(file => file.startsWith('水晶相框/')));
});
