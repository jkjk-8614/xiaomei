const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

async function openFixture(t) {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600, height:1000}});
    page.setDefaultTimeout(10000);
    const errors = [];
    let stored = {
        id:'ungroup-fixture', title:'Ungroup fixture', nodes:[], connections:[], logs:[],
        settings:{engine:'api', provider_id:'fixture', model:'fixture-image', count:1},
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-ungroup.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            if(!fs.existsSync(file)) return route.fulfill({contentType:'application/javascript', body:''});
            return route.fulfill({path:file});
        }
        if(url.pathname.endsWith('.png')) return route.fulfill({contentType:'image/png', body:pixel});
        if(url.pathname === '/api/config'){
            return route.fulfill({json:{
                api_providers:[{id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image'], video_models:[]}],
                comfy_instances:[]
            }});
        }
        if(url.pathname === '/api/canvases/ungroup-fixture'){
            if(route.request().method() === 'PUT') stored = {...stored, ...route.request().postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });

    await page.goto('http://xiaomei-ungroup.test/static/smart-canvas.html?id=ungroup-fixture');
    await page.waitForFunction(() => smartCanvasReady && canvas?.id === 'ungroup-fixture');
    return {page, errors};
}

test('ungroup keeps smart-group connections and restores their original targets', { timeout:60000 }, async t => {
    const {page, errors} = await openFixture(t);

    const exact = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const make = (x, y, url) => createNode(x, y, [{url, name:url.split('/').pop(), kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const sourceA = make(80, 120, '/output/source-a.png');
        const sourceB = make(80, 420, '/output/source-b.png');
        const imageA = make(480, 120, '/output/image-a.png');
        const imageB = make(480, 420, '/output/image-b.png');
        const sink = make(920, 260, '/output/sink.png');
        connectInputNode(sourceA.id, imageA.id);
        connectInputNode(sourceB.id, imageB.id);
        connectInputNode(imageA.id, imageB.id);
        connectInputNode(imageA.id, sink.id);
        connectInputNode(imageB.id, sink.id);
        selectedIds = [imageA.id, imageB.id];
        groupSelectedNodes();
        const group = nodes.find(isSmartGroupNode);
        const collapsedConnections = canvas.connections.map(connection => ({...connection}));
        // 模拟一次保存和重新打开，确保精确回接所需的来源记录不是只存在内存里。
        canvas.nodes = nodes;
        const stored = JSON.parse(JSON.stringify(canvasForStorage()));
        canvas = stored;
        nodes = stored.nodes.map(normalizeLegacySmartNode).filter(Boolean);
        canvas.connections = stored.connections || [];
        const persistedGroup = nodes.find(isSmartGroupNode);
        const rememberedCount = persistedGroup?._smartGroupOriginConnections?.length || 0;
        ungroupNode(persistedGroup.id);
        const restoredA = nodes.find(node => node.images?.[0]?.url === '/output/image-a.png');
        const restoredB = nodes.find(node => node.images?.[0]?.url === '/output/image-b.png');
        const has = (from, to) => canvas.connections.some(connection => connection.from === from && connection.to === to && (connection.kind || 'flow') === 'input');
        return {
            groupRemoved:!nodes.some(isSmartGroupNode),
            collapsedConnections,
            rememberedCount,
            restored:[
                has(sourceA.id, restoredA.id),
                has(sourceB.id, restoredB.id),
                has(restoredA.id, restoredB.id),
                has(restoredA.id, sink.id),
                has(restoredB.id, sink.id)
            ],
            crossed:[has(sourceA.id, restoredB.id), has(sourceB.id, restoredA.id)],
            restoredAInputs:restoredA.inputNodeIds || [],
            restoredBInputs:restoredB.inputNodeIds || [],
            sinkInputs:nodes.find(node => node.id === sink.id)?.inputNodeIds || [],
            restoredIds:[restoredA.id, restoredB.id],
            sourceIds:[sourceA.id, sourceB.id]
        };
    });
    assert.equal(exact.groupRemoved, true);
    assert.equal(exact.rememberedCount, 5);
    assert.ok(exact.collapsedConnections.length < exact.rememberedCount, 'grouping should collapse duplicate container edges');
    assert.deepEqual(exact.restored, [true, true, true, true, true]);
    assert.deepEqual(exact.crossed, [false, false]);
    assert.deepEqual(exact.restoredAInputs, [exact.sourceIds[0]]);
    assert.deepEqual(new Set(exact.restoredBInputs), new Set([exact.sourceIds[1], exact.restoredIds[0]]));
    assert.deepEqual(new Set(exact.sinkInputs), new Set(exact.restoredIds));

    const legacy = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const source = createNode(80, 180, [{url:'/output/legacy-source.png', kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const group = createSmartGroupNode(420, 180, {select:false, skipUndo:true});
        group.images = [
            {url:'/output/legacy-a.png', kind:'image'},
            {url:'/output/legacy-b.png', kind:'image'}
        ];
        const sink = createNode(900, 180, [{url:'/output/legacy-sink.png', kind:'image'}], {nodeType:'smart-upload', select:false, skipUndo:true});
        connectInputNode(source.id, group.id);
        connectInputNode(group.id, sink.id);
        ungroupNode(group.id);
        const restored = nodes.filter(node => ['/output/legacy-a.png', '/output/legacy-b.png'].includes(node.images?.[0]?.url));
        return {
            restoredCount:restored.length,
            incoming:restored.every(node => canvas.connections.some(connection => connection.from === source.id && connection.to === node.id)),
            outgoing:restored.every(node => canvas.connections.some(connection => connection.from === node.id && connection.to === sink.id)),
            sinkInputs:sink.inputNodeIds || [],
            restoredIds:restored.map(node => node.id),
            hasContainerEdge:canvas.connections.some(connection => connection.from === group.id || connection.to === group.id)
        };
    });
    assert.equal(legacy.restoredCount, 2);
    assert.equal(legacy.incoming, true);
    assert.equal(legacy.outgoing, true);
    assert.deepEqual(new Set(legacy.sinkInputs), new Set(legacy.restoredIds));
    assert.equal(legacy.hasContainerEdge, false);
    assert.deepEqual(errors, []);
});

test('ungroup preserves new aggregate edges, deleted edges, and exact origins across reload and undo', {timeout:40000}, async t => {
    const {page, errors} = await openFixture(t);
    const groupId = await page.evaluate(async () => {
        const upload = (id, x, y) => ({id, type:'smart-upload', x, y, images:[{url:'/output/'+id+'.png', kind:'image'}]});
        nodes = [
            upload('source', 60, 150), upload('a', 450, 100), upload('b', 450, 360),
            upload('precise', 1000, 90), upload('aggregate', 1000, 330), upload('stale', 1000, 600),
            upload('remote-source', 60, 480),
        ];
        canvas.connections = [
            {from:'a', to:'precise', kind:'input', input_slot:'reference-1', label:'original'},
            {from:'source', to:'b', kind:'input'},
            {from:'remote-source', to:'a', kind:'input'},
            {from:'a', to:'b', kind:'input'},
        ];
        selectedIds = ['a','b'];
        groupSelectedNodes();
        const group = nodes.find(isSmartGroupNode);
        if(!group) throw new Error('expected group');
        connectInputNode(group.id, 'aggregate');
        group._smartGroupOriginConnections.push({from:'old-missing', to:'stale', kind:'input'});
        connectInputNode(group.id, 'stale');
        const removed = canvas.connections.find(edge => edge.from === 'source' && edge.to === group.id);
        removeSmartConnections([removed]);
        canvas.connections = canvas.connections.filter(edge => edge.from !== 'remote-source');
        clearTimeout(saveTimer);
        if(!await saveCanvas()) throw new Error('could not save fixture');
        return group.id;
    });

    await page.reload();
    await page.waitForFunction(groupId => smartCanvasReady && nodes.some(node => node.id === groupId), groupId);
    const clickSplit = async () => {
        await page.evaluate(id => { selectSmartCard(id); syncSelectionUi(); }, groupId);
        await page.locator('.image-node[data-id="'+groupId+'"] [data-smart-group-action="ungroup"]').click();
    };
    const read = () => page.evaluate(() => {
        const assetId = name => nodes.find(node => node.images?.[0]?.url === '/output/'+name+'.png')?.id;
        const a = assetId('a'), b = assetId('b');
        const incoming = id => canvas.connections.filter(edge => edge.to === id);
        const precise = incoming('precise');
        return {
            hasInternal:incoming(b).some(edge => edge.from === a),
            precise:precise.map(edge => [edge.from,edge.input_slot,edge.label]),
            aggregate:incoming('aggregate').map(edge => edge.from),
            deleted:canvas.connections.some(edge => ['source','remote-source'].includes(edge.from) && (edge.to === a || edge.to === b)),
            stale:incoming('stale').length,
            cache:nodes.find(node => node.id === 'aggregate').inputNodeIds || [],
            assets:[a,b],
        };
    });
    function verify(result) {
        assert.equal(result.hasInternal, true);
        assert.deepEqual(result.precise, [[result.assets[0],'reference-1','original']]);
        assert.deepEqual(result.aggregate, result.assets);
        assert.equal(result.deleted, false);
        assert.equal(result.stale, 0);
        assert.deepEqual(result.cache, result.assets);
    }

    await clickSplit();
    const expanded = await read();
    verify(expanded);
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(id => nodes.some(node => node.id === id), groupId), true);
    await page.evaluate(() => performRedo());
    assert.deepEqual(await read(), expanded);
    await page.evaluate(() => performUndo());
    await clickSplit();
    verify(await read());
    assert.deepEqual(errors, []);
});

test('group changes honor collaboration locks and undo restores a legacy folded card', {timeout:40000}, async t => {
    const {page, errors} = await openFixture(t);
    const result = await page.evaluate(() => {
        const image = url => ({url, kind:'image'});
        nodes = [
            {id:'legacy', type:'smart-upload', collapsed:true, x:140,y:140,
                images:[image('/output/a.png'),image('/output/b.png')]},
            {id:'member', type:'smart-prompt', text:'旧提示词', x:550,y:140,images:[]},
            {id:'group', type:'smart-group', x:500,y:80, items:['member'], images:[]},
        ];
        canvas.connections = [];
        undoStack.length = 0;
        redoStack.length = 0;
        const remote = {member:{id:'remote', name:'Remote'}};
        collabLocks.set('member', remote);
        const blocked = ungroupNode('group');
        const before = [blocked, nodes.some(node => node.id === 'group'), undoStack.length];
        collabLocks.clear();
        const expanded = expandCollapsedImageNode('legacy');
        performUndo();
        const legacy = nodes.find(node => node.id === 'legacy');
        return {before, expanded, folded:legacy?.collapsed, images:legacy?.images.length};
    });
    assert.deepEqual(result, {before:[false,true,0], expanded:true, folded:true, images:2});
    assert.deepEqual(errors, []);
});

test('ungroup arranges restored images and members cleanly without overlap', {timeout:40000}, async t => {
    const {page, errors} = await openFixture(t);
    const result = await page.evaluate(() => {
        const overlaps = rects => {
            for(let i = 0; i < rects.length; i++){
                for(let j = i + 1; j < rects.length; j++){
                    const a = rects[i], b = rects[j];
                    if(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y){
                        return true;
                    }
                }
            }
            return false;
        };

        // 1) 4 张竖图智能分组（含用户缩小分组后解组）
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const group = createSmartGroupNode(200, 120, {select:false, skipUndo:true});
        group.images = [1, 2, 3, 4].map(n => ({
            url:`/output/wheel-${n}.png`,
            name:`wheel-${n}.png`,
            kind:'image',
            natural_w:768,
            natural_h:1024
        }));
        group.w = 240;
        group.h = 300;
        arrangeSmartGroupMembers(group, {skipUndo:true});
        render();
        ungroupNode(group.id);
        const fourRects = nodes.map(node => nodeRect(node));
        const fourDomRects = nodes.map(node => {
            const el = world.querySelector(`.image-node[data-id="${node.id}"]`);
            return {
                x:Number.parseFloat(el?.style.left || '0'),
                y:Number.parseFloat(el?.style.top || '0'),
                width:Number.parseFloat(el?.style.width || '0'),
                height:Number.parseFloat(el?.style.height || '0'),
            };
        });

        // 2) 混合分组：2 张不同比例图片 + 1 个提示词节点
        nodes = [];
        canvas.connections = [];
        const mixedA = createNode(100, 100, [{url:'/output/wide.png', kind:'image', natural_w:1280, natural_h:720}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const mixedB = createNode(700, 100, [{url:'/output/tall.png', kind:'image', natural_w:720, natural_h:1280}], {nodeType:'smart-upload', select:false, skipUndo:true});
        const prompt = createPromptNode(100, 560);
        selectedIds = [mixedA.id, mixedB.id, prompt.id];
        groupSelectedNodes();
        const mixedGroup = nodes.find(isSmartGroupNode);
        ungroupNode(mixedGroup.id);
        const mixedRects = nodes.map(node => nodeRect(node));

        // 3) 垂直排列的多图节点解组保持竖排且不重叠
        nodes = [];
        canvas.connections = [];
        const verticalNode = createNode(160, 140, [
            {url:'/output/v1.png', kind:'image', natural_w:800, natural_h:800},
            {url:'/output/v2.png', kind:'image', natural_w:800, natural_h:800},
            {url:'/output/v3.png', kind:'image', natural_w:800, natural_h:800}
        ], {nodeType:'smart-upload', select:false, skipUndo:true});
        verticalNode.imageArrangement = 'vertical';
        ungroupNode(verticalNode.id);
        const verticalRects = nodes.map(node => nodeRect(node));

        return {
            fourCount:fourRects.length,
            fourOverlap:overlaps(fourRects),
            fourDomOverlap:overlaps(fourDomRects),
            fourGapX:fourRects[1].x - (fourRects[0].x + fourRects[0].width),
            fourGapY:fourRects[2].y - (fourRects[0].y + fourRects[0].height),
            fourRowAligned:fourRects[0].y === fourRects[1].y && fourRects[2].y === fourRects[3].y,
            fourColAligned:fourRects[0].x === fourRects[2].x && fourRects[1].x === fourRects[3].x,
            mixedCount:mixedRects.length,
            mixedOverlap:overlaps(mixedRects),
            verticalCount:verticalRects.length,
            verticalOverlap:overlaps(verticalRects),
            verticalAligned:verticalRects.every(rect => rect.x === verticalRects[0].x),
            verticalGaps:[
                verticalRects[1].y - (verticalRects[0].y + verticalRects[0].height),
                verticalRects[2].y - (verticalRects[1].y + verticalRects[1].height),
            ]
        };
    });
    assert.equal(result.fourCount, 4);
    assert.equal(result.fourOverlap, false);
    assert.equal(result.fourDomOverlap, false);
    assert.equal(result.fourGapX, 32);
    assert.equal(result.fourGapY, 32);
    assert.equal(result.fourRowAligned, true);
    assert.equal(result.fourColAligned, true);
    assert.equal(result.mixedCount, 3);
    assert.equal(result.mixedOverlap, false);
    assert.equal(result.verticalCount, 3);
    assert.equal(result.verticalOverlap, false);
    assert.equal(result.verticalAligned, true);
    assert.deepEqual(result.verticalGaps, [32, 32]);
    assert.deepEqual(errors, []);
});
