const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium, _electron} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const testTimeout = process.env.CANVAS_TEST_ELECTRON === '1' ? 60000 : 30000;
const image = name => ({url:`/output/${name}.svg`, kind:'image', natural_w:240, natural_h:320});
const upload = (id, x=100) => ({id, type:'smart-upload', x, y:180, images:[image(id)]});

async function openFixture(t){
    const useElectron = process.env.CANVAS_TEST_ELECTRON === '1';
    const browser = useElectron
        ? await _electron.launch({executablePath:path.join(root, 'desktop/node_modules/electron/dist/electron.exe'),
            args:[path.join(__dirname, 'fixtures/canvas-render-host.cjs')]})
        : await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = useElectron ? await browser.firstWindow()
        : await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let stored = {id:'collapse-fixture', title:'图片折叠回归', nodes:[], connections:[], logs:[], settings:{}};
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'image-collapse.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/output/') || url.pathname.includes('media-preview')){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#c7d9cc"/><circle cx="120" cy="160" r="64" fill="#69877a"/></svg>'});
        }
        if(url.pathname === '/api/canvases/collapse-fixture'){
            if(route.request().method() === 'PUT') stored = {...stored, ...route.request().postDataJSON(), updated_at:Date.now()};
            return route.fulfill({json:{canvas:stored}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[], api_providers:[]}});
    });
    await page.goto('http://image-collapse.test/static/smart-canvas.html?id=collapse-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === '图片折叠回归');
    return {page, errors, stored:() => structuredClone(stored)};
}

async function setNodes(page, fixtureNodes, selected, connections=[]){
    await page.evaluate(({fixtureNodes, selected, connections}) => {
        clearTimeout(saveTimer);
        nodes = fixtureNodes;
        canvas.nodes = nodes;
        canvas.connections = connections;
        canvasUsesConnections = true;
        nodes.filter(isSmartColorNode).forEach(node => {
            if((node.images || []).some(image => image?.url)) node.colorRunKey = smartColorInputSignature(node);
        });
        selectedId = selected.length === 1 ? selected[0] : '';
        selectedIds = selected.length > 1 ? selected : [];
        selectedImage = {nodeId:'', index:-1};
        sharedCanvasReadOnly = false;
        collabLocks.clear();
        undoStack.length = 0;
        redoStack.length = 0;
        viewport = {x:20, y:20, scale:0.6};
        render();
        applyViewport();
    }, {fixtureNodes, selected, connections});
}

async function state(page){
    return page.evaluate(() => ({
        nodes:nodes.map(node => ({
            id:node.id, type:node.type, x:node.x, y:node.y, w:node.w ?? null, h:node.h ?? null,
            scale:node.scale ?? null, manualSize:node.manualSize === true,
            items:node.items || [], images:(node.images || []).map(image => image.local_db_id ? `indexeddb:${image.local_db_id}` : image.url),
            comparePosition:node.comparePosition ?? null, colorIntensity:node.colorIntensity ?? null,
            preserveLuminance:node.preserveLuminance ?? null,
            runPrompt:node.runPrompt || '', runSettings:node.runSettings || null,
            origins:node._smartGroupOriginConnections || []
        })).sort((a, b) => a.id.localeCompare(b.id)),
        connections:canvas.connections.map(connection => JSON.stringify(connection)).sort()
    }));
}

async function waitForFold(page){
    await page.waitForFunction(() => !smartFoldAnimationRunning && nodes.some(node => node.collapsed));
}

async function expand(page){
    if(!await page.locator('.collapsed-stack-node.selected').count()){
        await page.locator('.collapsed-stack-node').click({position:{x:12, y:12}});
    }
    await page.locator('[data-smart-node-action="uncollapse"]').click();
    await page.waitForFunction(() => !smartFoldAnimationRunning && nodes.every(node => !node.collapsed));
}

test('mixed images and image groups fold, undo, save and reopen with all original nodes and connections', {timeout:testTimeout}, async t => {
    const {page, errors, stored} = await openFixture(t);
    const connections = [
        {from:'outside', to:'upload', kind:'input'},
        {from:'upload', to:'paint', kind:'input'},
        {from:'upload', to:'paint', kind:'flow'},
        {from:'paint', to:'group', kind:'input'},
        {from:'group', to:'sink', kind:'input', input_slot:'reference-0'},
        {from:'member', to:'sink', kind:'input', input_slot:'reference-1'}
    ];
    await setNodes(page, [
        upload('outside', -650),
        upload('upload'),
        {...upload('paint', 550), type:'smart-paint', runPrompt:'保留生成参数', runSettings:{engine:'api', model:'fixture-model'}},
        {id:'group', type:'smart-group', x:1050, y:180, w:420, h:400, items:['member'], images:[image('group-a'), image('upload')],
            _smartGroupOriginConnections:[{from:'group-origin', to:'sink', kind:'input'}]},
        upload('member', 1100),
        {...upload('sink', 1700), type:'smart-paint', inputNodeIds:['group', 'member']}
    ], ['upload', 'paint', 'group', 'member'], connections);
    const before = await state(page);
    const collapse = page.locator('[data-smart-selection-action="collapse"]');
    assert.equal(await collapse.isEnabled(), true);
    await collapse.click();
    await waitForFold(page);
    const folded = await page.evaluate(() => {
        const stack = nodes.find(node => node.collapsed);
        return {
            id:stack.id, images:stack.images.map(image => image.url), originals:stack.collapsedNodes.map(node => node.id),
            live:nodes.map(node => node.id), connections:canvas.connections,
            rendered:world.querySelectorAll('.collapsed-stack-card').length
        };
    });
    assert.equal(folded.images.length, 5);
    assert.equal(folded.images.filter(url => url === '/output/upload.svg').length, 2, 'repeated images keep their positions in the group');
    assert.deepEqual(folded.originals, ['upload', 'paint', 'group', 'member']);
    assert.deepEqual(folded.live.sort(), ['outside', 'sink', folded.id].sort());
    assert.equal(folded.rendered, 5);
    assert.equal(folded.connections.length, 3, 'internal edges are stored and external input slots stay distinct');
    assert.ok(folded.connections.every(edge => folded.live.includes(edge.from) && folded.live.includes(edge.to)));
    await page.evaluate(() => performUndo());
    assert.deepEqual(await state(page), before);
    await page.evaluate(() => performRedo());
    await waitForFold(page);
    assert.equal(await page.evaluate(async () => { clearTimeout(saveTimer); return saveCanvas(); }), true);
    assert.equal(stored().nodes.find(node => node.collapsed).collapsedNodes.length, 4);
    await page.reload();
    await page.waitForSelector('[data-smart-node-action="uncollapse"]');
    assert.equal(await page.locator('.collapsed-stack-card').count(), 5);
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'sink').inputNodeIds.sort()), ['group', 'member']);
    assert.deepEqual(errors, []);
});

test('folded images stay centered inside the selection after panning and zooming', {timeout:testTimeout}, async t => {
    const {page, errors} = await openFixture(t);
    const views = [
        {x:180, y:90, scale:0.45, sourceX:100, sourceY:650},
        {x:-1400, y:-500, scale:0.9, sourceX:1850, sourceY:1000},
        {x:1250, y:900, scale:1.4, sourceX:-750, sourceY:-500}
    ];
    for(const {sourceX, sourceY, ...view} of views){
        await setNodes(page, [
            {...upload('one', sourceX), y:sourceY},
            {...upload('two', sourceX + 320), y:sourceY},
            {...upload('three', sourceX + 320), y:sourceY + 260},
            {...upload('outside', sourceX + 850), y:sourceY - 250}
        ], ['one', 'two', 'three']);
        await page.evaluate(view => { viewport = view; shell.scrollTo(0, 0); applyViewport(); }, view);
        const before = await state(page);
        const frame = await page.locator('.smart-selection-frame').boundingBox();
        assert.ok(frame);
        // 避免自动滚动隐藏的画布容器，保留测量时的视口。
        await page.locator('[data-smart-selection-action="collapse"]').evaluate(button => button.click());
        await waitForFold(page);
        const stack = await page.locator('.collapsed-stack-node').boundingBox();
        assert.ok(stack);
        assert.ok(Math.abs(stack.x + stack.width / 2 - frame.x - frame.width / 2) < 1.5,
            `the stack keeps the selection's horizontal center at scale ${view.scale}: ${JSON.stringify({frame, stack})}`);
        assert.ok(Math.abs(stack.y + stack.height / 2 - frame.y - frame.height / 2) < 1.5,
            `the stack keeps the selection's vertical center at scale ${view.scale}: ${JSON.stringify({frame, stack})}`);
        assert.ok(stack.x >= frame.x && stack.y >= frame.y
            && stack.x + stack.width <= frame.x + frame.width
            && stack.y + stack.height <= frame.y + frame.height,
            'the folded stack stays within the original selection frame');
        assert.equal(await page.locator('.smart-selection-frame').count(), 0,
            'the original frame is removed after folding');
        await expand(page);
        assert.deepEqual(await state(page), before);
    }
    assert.deepEqual(errors, []);
});

test('color and compare nodes fold with images and groups and restore their controls and input slots', {timeout:testTimeout}, async t => {
    const {page, errors, stored} = await openFixture(t);
    await setNodes(page, [
        upload('outside', -650), upload('upload'),
        {...upload('paint', 450), type:'smart-paint', runPrompt:'保留提示词与生成参数', runSettings:{engine:'api', model:'fixture-model', requestMode:'async', videoTempShLinks:[]}},
        {id:'group', type:'smart-group', x:800, y:180, items:[], images:[image('one'), image('two')]},
        {id:'color', type:'smart-color', x:1200, y:180, w:380, h:490, colorIntensity:63, preserveLuminance:false, images:[image('restored')]},
        {id:'compare', type:'smart-compare', x:1650, y:180, w:350, h:440, comparePosition:37, images:[]},
        {...upload('sink', 2300), type:'smart-paint', inputNodeIds:['color', 'compare']}
    ], ['upload', 'paint', 'group', 'color', 'compare'], [
        {from:'outside', to:'upload', kind:'input'},
        {from:'paint', to:'color', kind:'input', input_slot:'target'},
        {from:'group', to:'color', kind:'input', inputSlot:'reference'},
        {from:'paint', to:'compare', kind:'input'},
        {from:'color', to:'compare', kind:'input'},
        {from:'color', to:'sink', kind:'input', input_slot:'reference-0'},
        {from:'compare', to:'sink', kind:'input', input_slot:'reference-1'}
    ]);
    const before = await state(page);
    assert.equal(await page.locator('[data-smart-selection-action="collapse"]').isEnabled(), true);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.collapsed).images.map(image => image.url)), [
        '/output/upload.svg', '/output/paint.svg', '/output/one.svg', '/output/two.svg', '/output/restored.svg',
        '/output/paint.svg', '/output/restored.svg'
    ], 'the compare preview is collected before its inputs are folded');
    await page.evaluate(() => performUndo());
    assert.deepEqual(await state(page), before);
    await page.evaluate(() => performRedo());
    await waitForFold(page);
    assert.equal(await page.evaluate(async () => { clearTimeout(saveTimer); return saveCanvas(); }), true);
    assert.equal(stored().nodes.find(node => node.collapsed).collapsedNodes.find(node => node.id === 'compare').images.length, 0);
    await page.reload();
    await page.waitForSelector('[data-smart-node-action="uncollapse"]');
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.equal(await page.locator('.smart-compare-stage-slider').getAttribute('aria-valuenow'), '37');
    assert.deepEqual(await page.evaluate(() => {
        const inputs = smartColorInputNodes(nodes.find(node => node.id === 'color'));
        return {target:inputs.target?.id, reference:inputs.reference?.id};
    }), {target:'paint', reference:'group'});

    await page.evaluate(() => { selectedId = ''; selectedIds = ['color', 'compare']; render(); });
    assert.equal(await page.locator('[data-smart-selection-action="collapse"]').isEnabled(), true);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.collapsed).collapsedNodes.map(node => node.id)), ['color', 'compare']);
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.deepEqual(errors, []);
});

test('folded local color results rehydrate from IndexedDB after saving and reopening', {timeout:testTimeout}, async t => {
    const {page, errors, stored} = await openFixture(t);
    const results = await page.evaluate(async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#86a79c"/></svg>';
        const blob = new Blob([svg], {type:'image/svg+xml'});
        return Promise.all(['first', 'second'].map(name => window.SmartColorNode.saveResult(blob, {name:`${name}.svg`, width:240, height:320})));
    });
    assert.ok(results.every(image => image.local_db_id && image.url.startsWith('blob:')));
    await setNodes(page, [
        upload('target', -700), upload('reference', -350),
        {id:'first', type:'smart-color', x:100, y:180, colorIntensity:48, preserveLuminance:false, images:[results[0]]},
        {id:'second', type:'smart-color', x:550, y:180, colorIntensity:91, preserveLuminance:true, images:[results[1]]},
        {id:'compare', type:'smart-compare', x:1000, y:180, comparePosition:73, images:[]}
    ], ['first', 'second', 'compare'], [
        {from:'target', to:'first', kind:'input', input_slot:'target'},
        {from:'reference', to:'first', kind:'input', input_slot:'reference'},
        {from:'target', to:'second', kind:'input', input_slot:'target'},
        {from:'reference', to:'second', kind:'input', input_slot:'reference'},
        {from:'first', to:'compare', kind:'input'},
        {from:'second', to:'compare', kind:'input'}
    ]);
    const before = await state(page);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.equal(await page.evaluate(async () => { clearTimeout(saveTimer); return saveCanvas(); }), true);
    const stack = stored().nodes.find(node => node.collapsed);
    assert.equal(stack.images.length, 4);
    assert.ok(stack.images.every(image => image.local_db_id && image.url === '' && !('_localBlobReady' in image) && !('_localBlobUrl' in image)));
    assert.ok(stack.collapsedNodes.filter(node => node.type === 'smart-color').every(node =>
        node.images[0].local_db_id && node.images[0].url === '' && !('_localBlobUrl' in node.images[0])));
    await page.reload();
    await page.waitForFunction(() => nodes.find(node => node.collapsed)?.images.every(image => image._localBlobReady && image.url.startsWith('blob:')));
    assert.equal(await page.locator('.collapsed-stack-card').count(), 4);
    assert.equal(await page.evaluate(async () => {
        const images = nodes.find(node => node.collapsed).images;
        return (await Promise.all(images.map(async image => (await fetch(image.url)).text()))).every(text => text.includes('#86a79c'));
    }), true, 'every card resolves to the original locally stored image');
    await expand(page);
    await page.waitForFunction(() => nodes.filter(isSmartColorNode).every(node => !node.colorLocalHydrating && node.images[0]?._localBlobReady));
    assert.deepEqual(await state(page), before);
    assert.equal(await page.locator('.smart-compare-stage-slider').getAttribute('aria-valuenow'), '73');
    assert.deepEqual(errors, []);
});

test('color target previews and compare inputs fold without adding outputs to the original nodes', {timeout:testTimeout}, async t => {
    const {page, errors} = await openFixture(t);
    await setNodes(page, [
        upload('target', -400),
        {id:'color', type:'smart-color', x:100, y:180, colorIntensity:72, images:[]},
        {id:'compare', type:'smart-compare', x:600, y:180, comparePosition:61, images:[]}
    ], ['color', 'compare'], [
        {from:'target', to:'color', kind:'input', input_slot:'target'},
        {from:'target', to:'compare', kind:'input'}
    ]);
    const before = await state(page);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.collapsed).images.map(image => image.url)), [
        '/output/target.svg', '/output/target.svg'
    ]);
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.deepEqual(errors, []);
});

test('the selection toolbar folds one multi-image upload in place and restores its layout', {timeout:testTimeout}, async t => {
    const {page, errors} = await openFixture(t);
    await setNodes(page, [{...upload('multi'), w:520, h:420, scale:0.8, manualSize:true,
        images:[image('one'), image('two'), image('three')]}], ['multi']);
    const before = await state(page);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.deepEqual(await page.evaluate(() => nodes.map(node => ({id:node.id, collapsed:node.collapsed, x:node.x, y:node.y}))), [
        {id:'multi', collapsed:true, x:100, y:180}
    ]);
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.deepEqual(errors, []);
});

test('groups have a fold action and can fold with generated images without an upload in the selection', {timeout:testTimeout}, async t => {
    const {page, errors} = await openFixture(t);
    const group = {id:'group', type:'smart-group', x:100, y:180, items:[], images:[image('one'), image('two')]};
    await setNodes(page, [group, upload('outside', 1000)], ['group'], [{from:'outside', to:'group', kind:'input'}]);
    const groupAction = page.locator('[data-smart-group-action="collapse"]');
    assert.equal(await groupAction.isEnabled(), true);
    await groupAction.click();
    await waitForFold(page);
    await page.evaluate(() => { nodes = nodes.filter(node => node.id !== 'outside'); });
    await expand(page);
    assert.deepEqual(await page.evaluate(() => nodes.map(node => node.id)), ['group']);
    assert.deepEqual(await page.evaluate(() => canvas.connections), [], 'expanding does not restore edges to a deleted external node');

    await setNodes(page, [group, {...upload('paint', 700), type:'smart-paint'}], ['group', 'paint']);
    const before = await state(page);
    assert.equal(await page.locator('.smart-selection-toolbar').count(), 1);
    assert.equal(await page.locator('[data-smart-selection-action="collapse"]').isEnabled(), true);
    await page.locator('[data-smart-selection-action="collapse"]').click();
    await waitForFold(page);
    assert.equal(await page.evaluate(() => nodes.find(node => node.collapsed).images.length), 3);
    await expand(page);
    assert.deepEqual(await state(page), before);
    assert.deepEqual(errors, []);
});

test('incomplete, unsupported, locked and read-only selections do not lose any nodes', {timeout:testTimeout}, async t => {
    const {page, errors} = await openFixture(t);
    const cases = [
        {nodes:[upload('one')], selected:['one']},
        {nodes:[upload('one'), {id:'empty', type:'smart-upload', images:[]}], selected:['one', 'empty']},
        {nodes:[upload('one'), {...upload('busy'), pending:1}], selected:['one', 'busy']},
        {nodes:[upload('one'), {...upload('color'), type:'smart-color', colorProcessing:true}], selected:['one', 'color']},
        {nodes:[upload('one'), {...upload('color'), type:'smart-color', _colorRunQueued:true}], selected:['one', 'color']},
        {nodes:[upload('one'), {...upload('color'), type:'smart-color', colorLocalHydrating:true}], selected:['one', 'color']},
        {nodes:[upload('one'), {id:'compare', type:'smart-compare', images:[]}], selected:['one', 'compare']},
        {nodes:[upload('one'), {id:'prompt', type:'smart-prompt', text:'保留提示词'}], selected:['one', 'prompt']},
        {nodes:[{id:'group', type:'smart-group', images:[image('one'), image('two')], items:['prompt']},
            {id:'prompt', type:'smart-prompt', text:'保留组内提示词'}], selected:['group', 'prompt']},
        {nodes:[{id:'group', type:'smart-group', images:[image('one')], items:['member']}, upload('member')], selected:['group'], locked:'member'},
        {nodes:[upload('one'), upload('two')], selected:['one', 'two'], readOnly:true}
    ];
    for(const fixture of cases){
        await setNodes(page, fixture.nodes, fixture.selected);
        const before = await page.evaluate(({locked, readOnly}) => {
            if(locked) collabLocks.set(locked, {member:{id:'other-editor', name:'其他成员'}});
            sharedCanvasReadOnly = Boolean(readOnly);
            return JSON.stringify({nodes, connections:canvas.connections, undo:undoStack.length});
        }, fixture);
        assert.equal(await page.evaluate(() => collapseSelectedImageNodes()), false);
        assert.equal(await page.evaluate(() => JSON.stringify({nodes, connections:canvas.connections, undo:undoStack.length})), before);
        const button = page.locator('[data-smart-selection-action="collapse"]');
        if(!fixture.locked && !fixture.readOnly && await button.count()) assert.equal(await button.isDisabled(), true);
    }
    assert.deepEqual(errors, []);
});
