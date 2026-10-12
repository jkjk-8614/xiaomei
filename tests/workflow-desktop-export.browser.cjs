const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('workflow library exposes desktop export and reports save, cancellation and failure accurately', {timeout:40000}, async t => {
    const browser = await chromium.launch({headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let failFetch = false;
    let packed = null;
    await page.addInitScript(() => {
        window.savedWorkflows = [];
        window.nextSaveResult = {ok:true, path:'C:\\Desktop\\详情页.zip'};
        window.electronAPI = {saveWorkflowToDesktop:async payload => {
            window.savedWorkflows.push({filename:payload.filename, bytes:Array.from(new Uint8Array(payload.bytes))});
            return window.nextSaveResult;
        }};
    });
    const library = {libraries:[{id:'default', name:'工作流库', categories:[{id:'workflows', name:'详情页', type:'workflow', items:[
        {id:'zip', name:'详情页.zip', url:'/assets/library/workflow.zip', type:'workflow', kind:'workflow', node_count:15, connection_count:17, preview_status:'ready', preview_nodes:[], preview_connections:[]},
        {id:'json', name:'主图.json', url:'/assets/library/workflow.json', type:'workflow', kind:'workflow', preview_status:'ready', preview_nodes:[], preview_connections:[]},
    ]}]}]};
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'workflow-export.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return file.startsWith(root + path.sep) && fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/asset-library') return route.fulfill({json:{library}});
        if(url.pathname === '/api/canvas-assets/download'){
            packed = route.request().postDataJSON();
            return route.fulfill({body:Buffer.from([80, 75, 3, 4, 99]), contentType:'application/zip'});
        }
        if(url.pathname.startsWith('/assets/library/')) return route.fulfill({status:failFetch ? 404 : 200, body:url.pathname.endsWith('.json') ? '{"name":"中文模板"}' : Buffer.from([80, 75, 3, 4, 255])});
        return route.fulfill({json:{items:[], libraries:[], library:{libraries:[]}, providers:[], tree:null}});
    });
    await page.goto('http://workflow-export.test/static/asset-manager.html');
    await page.waitForFunction(() => assetLibrary.libraries.length > 0);
    await page.locator('[data-tab="workflows"]').click();
    await page.locator('[data-workflow-card="zip"]').click();
    const desktopButton = page.locator('[data-workflow-export-desktop="zip"]');
    await desktopButton.click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent.startsWith('已保存到'));
    assert.deepEqual(await page.evaluate(() => savedWorkflows[0]), {filename:'详情页.zip', bytes:[80,75,3,4,255]});
    await page.screenshot({path:path.join(os.tmpdir(), 'xiaomei-workflow-desktop-export.png')});
    await page.evaluate(() => { nextSaveResult = {ok:false, canceled:true}; });
    await desktopButton.click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent === '已取消导出');
    await page.evaluate(() => { nextSaveResult = {ok:false, message:'保存失败：目标目录只读'}; });
    await desktopButton.click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent.includes('目标目录只读'));
    failFetch = true;
    const beforeFailure = await page.evaluate(() => savedWorkflows.length);
    await desktopButton.click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent === '导出工作流失败');
    assert.equal(await page.evaluate(() => savedWorkflows.length), beforeFailure);
    failFetch = false;
    await page.evaluate(() => { nextSaveResult = {ok:true, path:'C:\\Desktop\\主图.json'}; });
    await page.locator('[data-workflow-card="json"]').click();
    await page.locator('[data-workflow-export-desktop="json"]').click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent.startsWith('已保存到'));
    assert.equal(await page.evaluate(() => savedWorkflows.at(-1).filename), '主图.json');
    assert.equal(Buffer.from(await page.evaluate(() => savedWorkflows.at(-1).bytes)).toString(), '{"name":"中文模板"}');
    await page.locator('[data-workflow-manage]').click();
    await page.locator('[data-workflow-select-all]').click();
    await page.locator('[data-workflow-export-desktop-selected]').click();
    await page.waitForFunction(() => savedWorkflows.at(-1).filename === 'workflows.zip');
    assert.equal(packed.items.length, 2);
    assert.deepEqual(await page.evaluate(() => savedWorkflows.at(-1).bytes), [80,75,3,4,99]);
    await page.evaluate(() => { window.electronAPI = null; });
    await page.locator('[data-workflow-export-desktop-selected]').click();
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent.includes('请重启小美画布桌面端'));
    assert.deepEqual(errors, []);
});
