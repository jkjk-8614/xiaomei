const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const positive = Array.from({length:24}, (_, index) => `第${index + 1}屏：保留产品颜色与材质，突出一个卖点。`).join('\n');

async function openManager(t, {readonly = false, reused = false} = {}){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1640,height:1000}});
    const state = {requests:[], errors:[], failNextSave:false, beforeWrite:null};
    const library = {libraries:[{
        id:'system', name:'系统提示词库', readonly,
        categories:[{id:'commerce',name:'电商视觉'}],
        items:[
            {id:'duplicate',name:'详情页风格',category:'commerce',scene:positive,positive,negative:'模糊',params:{steps:20}},
            {id:'prefix-500',name:'截断说明',category:'commerce',scene:positive.slice(0,500),positive,favorite:true},
            {id:'prefix-whitespace',name:'截断与空白差异',category:'commerce',scene:' \n' + positive.slice(0,120).replace(/\n/g,' \n ') + '  ',positive,favorite:true},
            {id:'whitespace',name:'空白差异',category:'commerce',scene:'  保留产品\n  原貌  ',positive:'保留产品 原貌'},
            {id:'distinct',name:'独立说明',category:'commerce',scene:'适用于电商详情页',positive:'突出产品材质与细节。'},
            {id:'scene-only',name:'仅有说明',category:'commerce',scene:'保留已有用途说明',positive:''},
            {id:'positive-only',name:'仅有正文',category:'commerce',scene:'',positive:'保留已有正文'},
        ]
    },{
        id:'custom-lib',name:'自建提示词库',categories:[{id:'custom',name:'自定义'}],
        items:[{id:'custom-prefix',name:'自建模板',category:'custom',scene:positive.slice(0,500),positive,favorite:true}]
    }]};
    if(reused) library.libraries[1].items.push({
        id:'duplicate',name:'自建重号模板',category:'custom',scene:'单独说明',positive:'自建正文',favorite:true,
    });
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname.startsWith('/api/prompt-libraries/items') && request.method() !== 'GET'){
            const body = request.postData() ? request.postDataJSON() : null;
            state.requests.push({method:request.method(),path:url.pathname,body});
            if(state.failNextSave){
                state.failNextSave = false;
                return route.fulfill({status:500,json:{detail:'保存失败，请重试'}});
            }
            await state.beforeWrite?.({url,body,method:request.method()});
            await new Promise(resolve => setTimeout(resolve, 100));
            const owner = library.libraries.find(entry => entry.id === (body?.library_id || url.searchParams.get('library_id')));
            if(!owner) return route.fulfill({status:404,json:{detail:'找不到提示词库'}});
            if(request.method() === 'DELETE' || url.pathname.endsWith('/delete')){
                const ids = body?.ids || [decodeURIComponent(url.pathname.split('/').at(-1))];
                const removed = owner.items.filter(item => ids.includes(item.id)).length;
                owner.items = owner.items.filter(item => !ids.includes(item.id));
                return route.fulfill({json:{library,removed}});
            }
            let item;
            if(request.method() === 'POST'){
                item = {...body,id:'created'};
                owner.items.push(item);
            } else {
                const last = url.pathname.endsWith('/favorite') ? -2 : -1;
                item = owner.items.find(entry => entry.id === decodeURIComponent(url.pathname.split('/').at(last)));
                Object.assign(item, body);
            }
            return route.fulfill({json:{library,item}});
        }
        if(url.pathname === '/api/prompt-libraries') return route.fulfill({json:{library}});
        if(url.pathname === '/api/asset-library') return route.fulfill({json:{library:{libraries:[]}}});
        if(url.pathname.startsWith('/api/')) return route.fulfill({json:{items:[],providers:[],folders:[],collections:[],categories:[],projects:[],canvases:[]}});
        return route.fulfill({status:204,body:''});
    });
    await page.goto('http://prompt-editor.test/static/asset-manager.html');
    await page.waitForFunction(() => document.getElementById('assetStatus').textContent === '准备就绪');
    await page.locator('[data-tab="prompts"]').click();
    await page.locator('[data-prompt-row="duplicate"]').waitFor();
    return {page,state,library};
}

async function readPromptExport(page, button){
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return {filename:download.suggestedFilename(), text:fs.readFileSync(await download.path(), 'utf8')};
}

test('prompt previews show repeated content once and retain distinct descriptions', {timeout:30000}, async t => {
    const {page,state} = await openManager(t);
    assert.equal(await page.locator('[data-prompt-row="duplicate"] .prompt-row-scene').count(), 0);
    assert.equal(await page.locator('[data-prompt-row="duplicate"] .prompt-row-text').textContent(), positive);
    assert.equal(await page.locator('.prompt-detail-scene').count(), 0);
    assert.equal(await page.locator('.prompt-block-body').first().inputValue(), positive);
    assert.equal(await page.locator('[data-prompt-row="whitespace"] .prompt-row-scene').count(), 0);
    assert.equal(await page.locator('[data-prompt-row="scene-only"] .prompt-row-scene').textContent(), '保留已有用途说明');
    assert.equal(await page.locator('[data-prompt-row="positive-only"] .prompt-row-scene').count(), 0);
    await page.locator('[data-prompt-row="distinct"]').click();
    assert.equal(await page.locator('.prompt-detail-scene').textContent(), '适用于电商详情页');
    assert.equal(await page.locator('.prompt-block-body').first().inputValue(), '突出产品材质与细节。');
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('truncated prompt excerpts are hidden in lists, details and editors without changing saved data', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t);
    const before = JSON.stringify(library);
    for(const id of ['prefix-500','prefix-whitespace']){
        const row = page.locator(`[data-prompt-row="${id}"]`);
        assert.equal(await row.locator('.prompt-row-scene').count(), 0);
        assert.equal(await row.locator('.prompt-row-text').textContent(), positive);
        await row.click();
        assert.equal(await page.locator('.prompt-detail-scene').count(), 0);
        assert.equal(await page.locator('.prompt-block-body').first().inputValue(), positive);
        await page.locator('[data-prompt-edit-start]').click();
        assert.equal(await page.locator('#promptEditScene').inputValue(), '');
        assert.equal(await page.locator('#promptEditPositive').inputValue(), positive);
        await page.keyboard.press('Escape');
    }
    assert.equal(JSON.stringify(library), before);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('custom libraries and all shared prompt collection views use the same excerpt rule', {timeout:30000}, async t => {
    const {page,state} = await openManager(t);
    await page.locator('[data-prompt-lib="custom-lib"]').click();
    assert.equal(await page.locator('[data-prompt-row="custom-prefix"] .prompt-row-scene').count(), 0);
    assert.equal(await page.locator('.prompt-detail-scene').count(), 0);
    for(const view of ['system','mine','favorites']){
        const id = view === 'system' ? 'prefix-500' : 'custom-prefix';
        await page.evaluate(({view,id}) => {
            activeTab = 'prompt-hub';
            hubView = view === 'favorites' ? 'favorites' : 'prompts';
            hubPromptView = view;
            selectedPromptId = id;
            render();
        }, {view,id});
        const row = page.locator(`[data-prompt-row="${id}"]`);
        assert.equal(await row.locator('.prompt-row-text').textContent(), positive);
        assert.equal(await row.locator('.prompt-row-scene').count(), 0);
        assert.equal(await page.locator('.prompt-detail-scene').count(), 0);
        assert.equal(await page.locator('.prompt-block-body').first().inputValue(), positive);
    }
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('wide editor cancels safely, preserves failed drafts and saves the exact fields once', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t);
    await page.locator('[data-prompt-edit-start]').click();
    const dialog = page.locator('#promptEditorDialog');
    assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
    const bounds = await dialog.boundingBox();
    const textBounds = await page.locator('#promptEditPositive').boundingBox();
    assert.ok(bounds.width >= 1100);
    assert.ok(textBounds.width > 700 && textBounds.height > 450);
    assert.equal(await page.locator('#promptEditPositive').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#promptEditScene').inputValue(), '');
    await page.locator('#promptEditPositive').fill('尚未保存的修改');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(library.libraries[0].items[0].positive, positive);
    assert.equal(await page.locator('[data-prompt-edit-start]').evaluate(element => element === document.activeElement), true);
    assert.deepEqual(state.requests, []);

    await page.locator('[data-prompt-edit-start]').click();
    const updated = '保留段落与空格。\n\n  第二段：<产品 & 材质>，不丢失换行。';
    await page.locator('#promptEditName').fill('修改后的详情页');
    await page.locator('#promptEditScene').fill('独立的用途说明');
    await page.locator('#promptEditPositive').fill(updated);
    await page.locator('#promptEditNegative').fill('模糊、变形\n多余文字');
    assert.equal(await page.locator('#promptEditorCount').textContent(), `${updated.length} 字符`);
    state.failNextSave = true;
    await page.locator('[data-prompt-edit-save]').click();
    await page.waitForFunction(() => document.getElementById('promptEditorStatus')?.textContent.includes('保存失败'));
    assert.equal(await page.locator('#promptEditPositive').inputValue(), updated);
    assert.equal(await page.locator('[data-prompt-edit-save]').isEnabled(), true);
    await page.locator('#promptEditPositive').focus();
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Control+Enter');
    await dialog.waitFor({state:'detached'});
    assert.equal(state.requests.length, 2);
    assert.deepEqual(state.requests[1].body, {
        library_id:'system',name:'修改后的详情页',positive:updated,
        negative:'模糊、变形\n多余文字',category:'commerce',scene:'独立的用途说明'
    });
    assert.equal(library.libraries[0].items[0].params.steps, 20);
    await page.locator('[data-prompt-edit-start]').click();
    assert.equal(await page.locator('#promptEditPositive').inputValue(), updated);
    await page.locator('[data-prompt-edit-save]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(state.errors, []);
});

test('new prompts use the wide editor with validation and narrow screen layouts', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t);
    await page.locator('[data-prompt-new]').click();
    assert.equal(await page.locator('#promptEditName').evaluate(element => element === document.activeElement), true);
    await page.locator('[data-prompt-create-save]').click();
    assert.equal(await page.locator('#promptEditorStatus').textContent(), '请输入名称和提示词内容');
    assert.deepEqual(state.requests, []);
    await page.locator('#promptEditName').fill('新建模板');
    await page.locator('#promptEditScene').fill('仅填写用途说明也能保存');
    await page.locator('[data-prompt-create-save]').click();
    await page.locator('#promptEditorDialog').waitFor({state:'detached'});
    assert.equal(state.requests[0].method, 'POST');
    assert.equal(library.libraries[0].items.at(-1).positive, '仅填写用途说明也能保存');
    assert.equal(await page.locator('[data-prompt-row="created"] .prompt-row-scene').count(), 0);

    for(const width of [1366, 900, 640, 390]){
        await page.setViewportSize({width,height:720});
        await page.locator('[data-prompt-edit-start]').click();
        const bounds = await page.locator('#promptEditorDialog').boundingBox();
        const footer = await page.locator('.prompt-editor-footer').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `dialog fits ${width}px`);
        assert.ok(footer.y >= 0 && footer.y + footer.height <= 720, `save stays visible at ${width}px`);
        await page.locator('#promptEditPositive').fill('窄屏仍可编辑');
        await page.locator('.prompt-editor-footer [data-prompt-edit-cancel]').click();
    }
    assert.equal(state.requests.length, 1);
    assert.deepEqual(state.errors, []);
});

test('read-only libraries retain preview and disable editing', {timeout:30000}, async t => {
    const {page,state} = await openManager(t, {readonly:true});
    assert.equal(await page.locator('[data-prompt-edit-start]').isDisabled(), true);
    assert.equal(await page.locator('[data-prompt-new]').isDisabled(), true);
    assert.equal(await page.locator('#promptEditorDialog').count(), 0);
    assert.equal(await page.locator('.prompt-block-body').first().inputValue(), positive);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('single prompt export downloads the full text and resolves the owner from favorites', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t, {reused:true});
    const before = JSON.stringify(library);
    const button = page.getByRole('button', {name:'导出', exact:true});
    const system = await readPromptExport(page, button);
    assert.equal(system.filename, '提示词-详情页风格.txt');
    assert.equal(system.text, `详情页风格\n\n正向提示词\n${positive}\n\n负向提示词\n模糊\n\n参数\n{\n  "steps": 20\n}\n`);

    await page.evaluate(() => {
        activeTab = 'prompt-hub';
        hubView = 'favorites';
        render();
    });
    await page.locator('[data-prompt-row="duplicate"][data-prompt-owner="custom-lib"]').click();
    const favorite = await readPromptExport(page, button);
    assert.equal(favorite.filename, '提示词-自建重号模板.txt');
    assert.equal(favorite.text, '自建重号模板\n\n用途说明\n单独说明\n\n正向提示词\n自建正文\n');
    assert.equal(JSON.stringify(library), before);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('batch prompt export uses selected entries and works in read-only and custom libraries', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t, {readonly:true, reused:true});
    const before = JSON.stringify(library);
    const button = page.getByRole('button', {name:'导出所选', exact:true});
    await page.locator('[data-prompt-manage]').click();
    assert.equal(await button.isDisabled(), true);
    await page.locator('[data-prompt-check="distinct"]').click();
    await page.locator('[data-prompt-check="duplicate"]').click();
    assert.equal(await page.locator('[data-prompt-delete-selected]').isDisabled(), true);

    await page.evaluate(() => {
        const createObjectURL = URL.createObjectURL;
        URL.createObjectURL = () => {
            URL.createObjectURL = createObjectURL;
            throw new Error('模拟下载失败');
        };
    });
    await button.click();
    await page.locator('#assetStatus').filter({hasText:'导出提示词失败，请重试'}).waitFor();
    assert.equal(await page.locator('[data-prompt-check="distinct"]').isChecked(), true);
    const batch = await readPromptExport(page, button);
    assert.equal(batch.filename, '提示词-批量导出.txt');
    assert.ok(batch.text.startsWith(`详情页风格\n\n正向提示词\n${positive}`));
    assert.ok(batch.text.endsWith('独立说明\n\n用途说明\n适用于电商详情页\n\n正向提示词\n突出产品材质与细节。\n'));
    assert.doesNotMatch(batch.text, /截断说明|自建重号模板/);

    await page.locator('[data-prompt-clear-selection]').click();
    assert.equal(await button.isDisabled(), true);
    await page.locator('#promptSearch').fill('截断');
    await page.locator('[data-prompt-row="distinct"]').waitFor({state:'detached'});
    await page.locator('[data-prompt-select-all]').click();
    const filtered = await readPromptExport(page, button);
    assert.ok(filtered.text.includes('截断说明\n') && filtered.text.includes('截断与空白差异\n'));
    assert.doesNotMatch(filtered.text, /用途说明|详情页风格|独立说明/);

    await page.locator('[data-prompt-lib="custom-lib"]').click();
    assert.equal(await button.isDisabled(), true);
    await page.locator('#promptSearch').fill('');
    await page.locator('[data-prompt-row="duplicate"]').waitFor();
    await page.locator('[data-prompt-select-all]').click();
    const custom = await readPromptExport(page, button);
    assert.match(custom.text, /自建模板/);
    assert.match(custom.text, /自建重号模板/);
    assert.doesNotMatch(custom.text, /详情页风格/);
    assert.equal(JSON.stringify(library), before);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.errors, []);
});

test('template edits and deletions keep their library through refreshes and late replies', {timeout:30000}, async t => {
    const {page,state,library} = await openManager(t, {reused:true});
    const dialog = page.locator('#promptEditorDialog');
    const name = dialog.locator('#promptEditName');
    const system = library.libraries[0];
    const own = library.libraries[1];
    await page.locator('[data-prompt-edit-start]').click();
    await name.fill('保留刷新中的草稿');
    await page.evaluate(() => render());
    assert.equal(await name.inputValue(), '保留刷新中的草稿');
    assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
    await dialog.locator('#promptEditPositive').dispatchEvent('keydown', {key:'Enter',ctrlKey:true,isComposing:true});
    assert.deepEqual(state.requests, []);
    await dialog.locator('[data-prompt-edit-save]').click();
    await dialog.waitFor({state:'detached'});
    assert.equal(system.items[0].scene, positive);
    assert.equal(state.requests[0].body.scene, positive);
    assert.equal(await page.locator('.prompt-detail-scene').count(), 0);

    await page.evaluate(() => {
        activeTab = 'prompt-hub';
        hubView = 'favorites';
        selectedPromptId = '';
        render();
    });
    const reused = page.locator('[data-prompt-row="duplicate"][data-prompt-owner="custom-lib"]');
    await reused.click();
    assert.equal(await page.locator('.prompt-detail-title').innerText(), '自建重号模板');
    await page.locator('[data-prompt-edit-start]').click();
    await name.fill('只修改自建重号模板');
    await dialog.locator('[data-prompt-edit-save]').click();
    await dialog.waitFor({state:'detached'});
    assert.equal(system.items[0].name, '保留刷新中的草稿');
    assert.equal(own.items.find(item => item.id === 'duplicate').name, '只修改自建重号模板');

    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    state.beforeWrite = async ({url}) => {
        if(!url.pathname.endsWith('/delete')) return;
        started.resolve();
        await release.promise;
    };
    await page.locator('[data-tab="prompts"]').click();
    await page.locator('[data-prompt-lib="custom-lib"]').click();
    await page.locator('[data-prompt-manage]').click();
    await page.locator('[data-prompt-row="duplicate"] .prompt-row-title').click();
    await page.locator('[data-prompt-delete-selected]').click();
    assert.equal(state.requests.length, 2);
    await page.locator('[data-prompt-lib="system"]').click();
    await page.locator('[data-prompt-row="duplicate"] .prompt-row-title').click();
    await page.locator('[data-prompt-delete-selected]').click();
    assert.equal(state.requests.length, 2);
    await page.locator('[data-prompt-lib="custom-lib"]').click();
    await page.locator('[data-prompt-row="duplicate"] .prompt-row-title').click();
    await page.locator('[data-prompt-delete-selected]').click();
    await page.locator('[data-prompt-delete-selected]').click();
    await started.promise;
    await page.locator('[data-prompt-lib="system"]').click();
    await page.locator('[data-prompt-row="duplicate"] .prompt-row-title').click();
    release.resolve();
    await page.locator('#assetStatus').filter({hasText:'已删除 1 条提示词'}).waitFor();
    assert.equal(await page.locator('[data-prompt-check="duplicate"]').isChecked(), true);
    assert.deepEqual(state.requests.at(-1).body, {library_id:'custom-lib',ids:['duplicate']});
    assert.equal(own.items.some(item => item.id === 'duplicate'), false);
    assert.equal(system.items.some(item => item.id === 'duplicate'), true);
    assert.deepEqual(state.errors, []);
});
