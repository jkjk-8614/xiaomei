const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLzYQAAAABJRU5ErkJggg==', 'base64');
const classify = {summary:'商品图片', tags:['产品'], categories:{color:['蓝色']}, flat:[{dimension:'color',label:'色彩',tag:'蓝色'}]};
const files = {
    upload:{id:'upload:上传.png',rel:'上传.png',name:'上传.png',url:'/api/storage-files/upload/%E4%B8%8A%E4%BC%A0.png',kind:'upload',size:240,created_at:1000,classification:classify,references:[]},
    generated:{id:'generated:生成.png',rel:'生成.png',name:'生成.png',url:'/api/storage-files/generated/%E7%94%9F%E6%88%90.png',kind:'generated',size:300,created_at:2000,classification:classify},
    local:{id:'本地.png',file:'本地.png',name:'本地.png',url:'/api/storage-files/local/%E6%9C%AC%E5%9C%B0.png',kind:'image',size:200,created_at:3000,classification:classify},
    localUnassigned:{id:'未归属.png',file:'未归属.png',name:'未归属.png',url:'/api/storage-files/local/%E6%9C%AA%E5%BD%92%E5%B1%9E.png',kind:'image',size:150,created_at:3001},
};

test('three material views expose the same management actions and dispatch by source', {timeout:45000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1640,height:1000}});
    const errors = [], requests = [];
    let localProject = 'project_a';
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/api/storage-files/') && route.request().method() === 'GET') return route.fulfill({body:png,contentType:'image/png'});
        if(url.pathname === '/api/storage-files'){
            const kind = url.searchParams.get('kind') || 'generated';
            const item = files[kind];
            return route.fulfill({json:{items:item ? [item] : [],total:item ? 1 : 0,all_total:item ? 1 : 0,has_more:false,media_counts:{image:item ? 1 : 0,video:0,audio:0},folders:[{path:'分组',name:'分组',count:0},{path:'第二组',name:'第二组',count:0}],projects:[],canvases:[],unassigned_count:item ? 1 : 0}});
        }
        if(url.pathname === '/api/local-assets') return route.fulfill({json:{items:[files.local,files.localUnassigned],tree:{path:'',name:'全部上传',count:2,children:[]}}});
        if(url.pathname === '/api/asset-library') return route.fulfill({json:{library:{libraries:[{id:'default',name:'默认资产库',categories:[{id:'products',name:'产品',type:'image',items:[]}]}]}}});
        if(url.pathname === '/api/prompt-libraries') return route.fulfill({json:{library:{libraries:[]}}});
        if(url.pathname === '/api/canvas-assets') return route.fulfill({json:{items:[{url:files.local.url,project:localProject,canvas_id:'canvas_a',canvas_title:'商品画布'}],categories:[],canvases:[{id:'canvas_a',project:localProject,title:'商品画布'}],projects:[{id:'project_a',name:'商品项目'},{id:'project_b',name:'空项目'}]}});
        if(url.pathname === '/api/asset-favorites') return route.fulfill({json:{items:[]}});
        if(url.pathname === '/api/image-space/collections' && route.request().method() === 'GET') return route.fulfill({json:{collections:[]}});
        if(url.pathname.startsWith('/api/') && route.request().method() !== 'GET'){
            requests.push({path:url.pathname,body:route.request().postDataJSON?.() || null});
            if(url.pathname === '/api/storage-files/organize') return route.fulfill({json:{ok:true,items:[{from:'生成.png',to:'新名字.png'}],moved:1}});
            if(url.pathname === '/api/asset-library/items/batch') return route.fulfill({json:{items:[{}],library:{libraries:[{id:'default',name:'默认资产库',categories:[{id:'products',name:'产品',type:'image',items:[]}]}]}}});
            return route.fulfill({json:{ok:true,removed:1,count:1,items:[]}});
        }
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
        return route.fulfill({status:204,body:''});
    });
    await page.goto('http://asset-parity.test/static/asset-manager.html');
    await page.waitForFunction(() => uploadAssetsState.loaded && !uploadAssetsState.loading);

    assert.equal(await page.locator('[data-space-toggle]').count(), 1);
    assert.equal(await page.locator('[data-space-save]').count(), 1);
    assert.equal(await page.locator('[data-upload-fav-filter]').count(), 1);
    assert.equal(await page.locator('[data-space-file-card]').count(), 1);
    await page.locator('[data-space-file-manage]').click();
    assert.equal(await page.locator('[data-space-file-download]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-canvas]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-import]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-classify]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-caption]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-background]').isVisible(), true);
    await page.locator('[data-space-file-card] .asset-card-body').click();
    assert.equal(await page.locator('[data-space-file-check]').isChecked(), true);
    await page.locator('[data-space-file-import]').click();
    assert.equal(requests.at(-1).path, '/api/asset-library/items/batch');
    await page.locator('[data-space-file-cut]').click();
    await page.locator('[data-space-folder="分组"]').click();
    await page.locator('[data-space-file-paste]').click();
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent?.includes('已移动'));
    assert.deepEqual(requests.find(request => request.path === '/api/storage-files/organize')?.body, {kind:'upload',action:'move',items:['上传.png'],folder:'分组'});

    await page.locator('#imageSpaceSubtabs [data-tab="generated"]').click();
    await page.waitForFunction(() => generatedAssetsState.loaded && !generatedAssetsState.loading);
    assert.equal(await page.locator('[data-space-toggle]').count(), 1);
    assert.equal(await page.locator('[data-space-save]').count(), 1);
    assert.equal(await page.locator('[data-space-file-card]').count(), 1);
    await page.locator('[data-space-file-manage]').click();
    assert.equal(await page.locator('[data-space-file-move]').isVisible(), true);
    assert.equal(await page.locator('[data-space-file-delete]').isVisible(), true);
    await page.locator('[data-space-file-card]').dragTo(page.locator('[data-space-folder="分组"]'));
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent?.includes('已移动'));
    assert.ok(requests.some(request => request.path === '/api/storage-files/organize' && request.body?.kind === 'generated' && request.body?.action === 'move'));
    await page.locator('[data-space-folder="第二组"]').dragTo(page.locator('[data-space-folder="分组"]'));
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent?.includes('文件夹顺序已保存'));
    assert.ok(requests.some(request => request.path === '/api/storage-files/folders/reorder' && request.body?.kind === 'generated'));
    await page.locator('[data-space-file-rename]').click();
    await page.locator('[data-space-file-inline-name]').fill('新名字.png');
    await page.locator('[data-space-file-inline-name]').press('Tab');
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent?.includes('已重命名'));
    assert.ok(requests.some(request => request.path === '/api/storage-files/organize' && request.body?.kind === 'generated' && request.body?.action === 'rename'));

    await page.locator('#imageSpaceSubtabs [data-tab="local"]').click();
    assert.equal(await page.locator('[data-localup-type="image"]').count(), 1);
    assert.equal(await page.locator('[data-space-toggle]').count(), 1);
    assert.equal(await page.locator('[data-space-save]').count(), 1);
    await page.locator('[data-localup-manage]').click();
    for(const selector of ['[data-localup-download-selected]','[data-localup-canvas-selected]','[data-localup-import-selected]','[data-local-classify-run]','[data-local-caption-run]','[data-localup-background-selected]']){
        assert.equal(await page.locator(selector).isVisible(), true, selector);
    }
    await page.locator('[data-localup-project="project_a"]').click();
    assert.equal(await page.locator('[data-localup-card]').count(), 1);
    assert.equal(await page.locator('[data-localup-card]').getAttribute('data-localup-card'), files.local.id);
    await page.locator('[data-localup-canvas="canvas_a"]').click();
    assert.equal(await page.locator('[data-localup-card]').count(), 1);
    await page.locator('[data-localup-project="project_b"]').click();
    assert.equal(await page.locator('[data-localup-card]').count(), 0);
    localProject = 'project_b';
    await page.locator('[data-localup-refresh]').click();
    await page.waitForFunction(() => document.querySelector('#assetStatus')?.textContent?.includes('本地素材已刷新'));
    assert.equal(await page.locator('[data-localup-card]').count(), 1);
    await page.locator('[data-localup-project="__unassigned__"]').click();
    assert.equal(await page.locator('[data-localup-card]').getAttribute('data-localup-card'), files.localUnassigned.id);
    await page.locator('[data-localup-project=""]').click();
    assert.equal(await page.locator('[data-localup-card]').count(), 2);
    if(process.env.ASSET_PARITY_SHOTS){
        fs.mkdirSync(process.env.ASSET_PARITY_SHOTS, {recursive:true});
        await page.setViewportSize({width:1180,height:760});
        for(const tab of ['assets','generated','local']){
            await page.locator(`#imageSpaceSubtabs [data-tab="${tab}"]`).click();
            await page.waitForFunction(tab => document.querySelector(`#imageSpaceSubtabs [data-tab="${tab}"]`)?.classList.contains('active'), tab);
            await page.waitForTimeout(250);
            await page.screenshot({path:path.join(process.env.ASSET_PARITY_SHOTS, `${tab}.png`)});
        }
        await page.setViewportSize({width:820,height:760});
        await page.screenshot({path:path.join(process.env.ASSET_PARITY_SHOTS, 'local-narrow.png')});
    }
    assert.deepEqual(errors, []);
});
