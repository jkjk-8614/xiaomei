const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('smart canvas Alt left copying preserves inputs and Alt right copying disconnects them', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({
        channel: 'msedge',
        headless: true
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());

    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if (url.hostname !== 'xiaomei-selection.test') return route.abort();
        if (pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', pathname.slice('/static/'.length));
            if (!fs.existsSync(file) || !file.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ path: file });
        }
        if (pathname.startsWith('/output/') || pathname === '/api/media-preview') {
            return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64') });
        }
        if (pathname === '/api/canvases/selection-fixture') {
            return route.fulfill({ json: {
                canvas: {
                    id: 'selection-fixture',
                    title: 'Selection fixture',
                    nodes: [],
                    connections: [],
                    logs: [],
                    settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 1 }
                }
            } });
        }
        if (pathname === '/api/config' || pathname === '/api/providers') {
            return route.fulfill({ json: {
                api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', image_models: ['fixture-image'], chat_models: ['fixture-chat'], video_models: [] }],
                comfy_instances: []
            } });
        }
        if (pathname === '/api/workflows') return route.fulfill({ json: { workflows: [] } });
        if (pathname === '/api/comfy-apps/catalog') return route.fulfill({ json: { items: [] } });
        if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
        return route.fulfill({ status: 204, body: '' });
    });

    await page.goto('http://xiaomei-selection.test/static/smart-canvas.html?id=selection-fixture');
    await page.waitForFunction(() => typeof createNode === 'function'
        && typeof applyModifiedNodeSelection === 'function'
        && typeof beginSelectionGesture === 'function'
        && typeof finishSelection === 'function');
    assert.match(await page.locator('[data-i18n="smart.shortcutAltCopy"]').textContent(), /不带连线/);
    assert.match(await page.locator('[data-i18n="smart.shortcutAltCopy"]').textContent(), /左键.*带输入连线/);

    const ids = await page.evaluate(() => {
        const created = [
            createNode(100, 120, [], { select: false }),
            createNode(500, 120, [], { select: false }),
            createNode(900, 120, [], { select: false })
        ];
        selectedId = '';
        selectedIds = [];
        selectedImage = { nodeId: '', index: -1 };
        viewport = { x: 0, y: 0, scale: 1 };
        applyViewport();
        render();
        return created.map(node => node.id);
    });

    const selectedAfterShift = await page.evaluate(([first, second]) => {
        selectedId = first;
        selectedIds = [];
        selectedImage = { nodeId: '', index: -1 };
        syncSelectionUi();
        applyModifiedNodeSelection(second, { shiftKey: true });
        return selectedNodeIds();
    }, ids);
    assert.deepEqual(selectedAfterShift, [ids[0], ids[1]]);

    const selectedAfterCtrlOnUnselected = await page.evaluate(([third]) => {
        applyModifiedNodeSelection(third, { ctrlKey: true });
        return selectedNodeIds();
    }, [ids[2]]);
    assert.deepEqual(selectedAfterCtrlOnUnselected, [ids[0], ids[1]]);

    const selectedAfterCtrlOnSelected = await page.evaluate(([second]) => {
        applyModifiedNodeSelection(second, { ctrlKey: true });
        return selectedNodeIds();
    }, [ids[1]]);
    assert.deepEqual(selectedAfterCtrlOnSelected, [ids[0]]);

    const selectedAfterCtrlBox = await page.evaluate(([first, second]) => {
        selectedId = '';
        selectedIds = [first, second];
        selectedImage = { nodeId: '', index: -1 };
        syncSelectionUi();
        beginSelectionGesture({ clientX: 80, clientY: 80 }, { subtractive: true });
        finishSelection({ clientX: 400, clientY: 420 });
        return selectedNodeIds();
    }, [ids[0], ids[1]]);
    assert.deepEqual(selectedAfterCtrlBox, [ids[1]]);

    const selectedAfterShiftBox = await page.evaluate(([second, third]) => {
        selectedId = '';
        selectedIds = [second];
        selectedImage = { nodeId: '', index: -1 };
        syncSelectionUi();
        beginSelectionGesture({ clientX: 860, clientY: 80 }, { additive: true });
        finishSelection({ clientX: 1240, clientY: 420 });
        return selectedNodeIds();
    }, [ids[1], ids[2]]);
    assert.deepEqual(selectedAfterShiftBox, [ids[1], ids[2]]);

    for(const preserveConnections of [true, false]){
    const altCopy = await page.evaluate(preserveConnections => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const first = createNode(100, 150, [], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
        const second = createNode(100, 450, [], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
        const target = createPaintNodeAt({x:600, y:220}, {select:false, skipUndo:true});
        const outside = createPaintNodeAt({x:1100, y:700}, {select:false, skipUndo:true});
        const external = createNode(1100, 100, [], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
        addConnection(first.id, target.id, 'input');
        addConnection(second.id, target.id, 'input');
        addConnection(external.id, target.id, 'input');
        addConnection(first.id, outside.id, 'input');
        addConnection(target.id, outside.id, 'flow');
        target.inputNodeIds = [first.id, second.id, external.id];
        target.inputRefOrder = [`${second.id}|0`, `${external.id}|0`, `${first.id}|0`];
        target.blockedInputRefs = [`${first.id}|0`, `url|/output/removed.png`];
        target.sourceNodeId = second.id;
        outside.inputNodeIds = [first.id];
        const originalConnections = JSON.stringify(canvas.connections);
        viewport = {x:0, y:0, scale:1};
        applyViewport();
        render();
        beginSelectionGesture({clientX:70, clientY:100});
        finishSelection({clientX:950, clientY:650});
        const selectedBefore = selectedNodeIds();
        duplicateForAltDrag(target, preserveConnections);
        const copies = selectedNodeIds();
        const copiedTarget = nodes.find(node => node.id === copies[2]);
        const copiedLinks = canvas.connections.filter(conn => copies.includes(conn.from) || copies.includes(conn.to));
        const visibleLinks = [...world.querySelectorAll('.connection-layer .conn-group')]
            .filter(group => copies.includes(group.dataset.connFrom) || copies.includes(group.dataset.connTo));
        selectedId = first.id;
        selectedIds = [];
        const beforeSingle = canvas.connections.length;
        const singleUploadCopy = duplicateForAltDrag(first, preserveConnections);
        const singleUploadLinks = canvas.connections.filter(conn => conn.from === singleUploadCopy.id);
        const singleUploadVisibleLinks = [...world.querySelectorAll('.connection-layer .conn-group')]
            .filter(group => group.dataset.connFrom === singleUploadCopy.id);
        return {
            selectedBefore,
            originals:[first.id, second.id, target.id],
            copies,
            external:external.id,
            originalConnections,
            originalsAfter:JSON.stringify(canvas.connections.filter(conn => !copies.includes(conn.from) && !copies.includes(conn.to))),
            copiedLinks:copiedLinks.length,
            visibleLinks:visibleLinks.length,
            copiedInputs:copiedTarget.inputNodeIds,
            copiedInputOrder:copiedTarget.inputRefOrder || [],
            copiedBlocked:copiedTarget.blockedInputRefs || [],
            copiedSource:copiedTarget.sourceNodeId || '',
            copiedSources:copiedLinks.map(conn => conn.from),
            copiedTargets:copiedLinks.map(conn => conn.to),
            singleUploadAddedLinks:canvas.connections.length - beforeSingle,
            singleUploadLinks:singleUploadLinks.length,
            singleUploadVisibleLinks:singleUploadVisibleLinks.length,
            targetInputs:target.inputNodeIds,
            outsideInputs:outside.inputNodeIds
        };
    }, preserveConnections);
    assert.deepEqual(altCopy.selectedBefore, altCopy.originals);
    assert.equal(altCopy.copiedLinks, preserveConnections ? 3 : 0);
    assert.equal(altCopy.visibleLinks, preserveConnections ? 3 : 0);
    assert.deepEqual(altCopy.copiedInputs, preserveConnections ? [...altCopy.copies.slice(0, 2), altCopy.external] : []);
    assert.deepEqual(altCopy.copiedInputOrder, preserveConnections ? [`${altCopy.copies[1]}|0`, `${altCopy.external}|0`, `${altCopy.copies[0]}|0`] : []);
    assert.deepEqual(altCopy.copiedBlocked, preserveConnections ? [`${altCopy.copies[0]}|0`, 'url|/output/removed.png'] : []);
    assert.equal(altCopy.copiedSource, preserveConnections ? altCopy.copies[1] : '');
    assert.deepEqual(altCopy.copiedSources, preserveConnections ? [...altCopy.copies.slice(0, 2), altCopy.external] : []);
    assert.deepEqual(altCopy.copiedTargets, preserveConnections ? Array(3).fill(altCopy.copies[2]) : []);
    assert.equal(altCopy.singleUploadAddedLinks, 0);
    assert.equal(altCopy.singleUploadLinks, 0);
    assert.equal(altCopy.singleUploadVisibleLinks, 0);
    assert.equal(altCopy.originalsAfter, altCopy.originalConnections);
    assert.deepEqual(altCopy.targetInputs, [...altCopy.originals.slice(0, 2), altCopy.external]);
    assert.deepEqual(altCopy.outsideInputs, [altCopy.originals[0]]);
    }

    for(const button of ['right', 'left']){
        const preserveConnections = button === 'left';
        const single = await page.evaluate(() => {
            nodes = [];
            canvas.connections = [];
            selectedId = '';
            selectedIds = [];
            selectedImage = {nodeId:'', index:-1};
            undoStack.length = 0;
            redoStack.length = 0;
            discardPendingUndo();
            canvasViewPrefs.snap = false;
            canvasViewPrefs.follow = false;
            viewport = {x:0, y:0, scale:1};
            applyViewport();
            const first = createNode(40, 100, [{url:'/output/ref-1.png', kind:'image'}], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
            const second = createNode(40, 450, [{url:'/output/ref-2.png', kind:'image'}], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
            const target = createPaintNodeAt({x:450, y:120}, {select:false, skipUndo:true});
            const outside = createPaintNodeAt({x:1100, y:700}, {select:false, skipUndo:true});
            connectInputNode(first.id, target.id);
            connectInputNode(second.id, target.id);
            addConnection(target.id, outside.id, 'flow');
            target.inputRefOrder = [`${second.id}|0`, `${first.id}|0`];
            target.blockedInputRefs = [`${first.id}|0`];
            target.sourceNodeId = first.id;
            target.runInputRefs = [{url:'/output/ref-1.png', nodeId:first.id}];
            target.runPromptRefs = [{url:'/output/ref-1.png', nodeId:first.id}];
            target.promptDraftText = '生成商品主图';
            target.runSettings = {engine:'api', provider_id:'fixture', model:'fixture-image', count:4, ratio:'story'};
            target.images = [{url:'/output/completed.png', kind:'image', generatedResult:true}];
            target.running = true;
            target.pending = 2;
            render();
            return {target:target.id, inputs:[first.id, second.id], originalConnections:JSON.stringify(canvas.connections)};
        });
        const box = await page.locator(`.image-node[data-id="${single.target}"]`).boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + 3, box.y + 45);
        await page.keyboard.down('Alt');
        await page.mouse.down({button});
        await page.mouse.move(box.x + 483, box.y + 75, {steps:8});
        const duringDrag = await page.evaluate(() => ({
            dragging:dragState?.id,
            selected:selectedId,
            menuOpen:document.getElementById('createMenu')?.classList.contains('open') || false
        }));
        assert.equal(duringDrag.dragging, duringDrag.selected);
        assert.equal(duringDrag.menuOpen, false);
        await page.mouse.up({button});
        await page.keyboard.up('Alt');
        const singleCopy = await page.evaluate(originalId => {
            const original = nodes.find(node => node.id === originalId);
            const copy = nodes.find(node => node.id === selectedId && node.id !== originalId);
            if(!copy) return null;
            return {
                id:copy.id, x:copy.x, originalX:original.x, images:copy.images,
                inputs:copy.inputNodeIds, order:copy.inputRefOrder || [],
                blocked:copy.blockedInputRefs || [], source:copy.sourceNodeId || '',
                runInputs:copy.runInputRefs || [], runPromptRefs:copy.runPromptRefs || [],
                taskInputs:canvasTaskScopeInputNodes(copy).map(node => node.id),
                references:referenceImagesFor(copy).map(image => image.url),
                prompt:copy.promptDraftText, settings:copy.runSettings,
                running:copy.running, pending:copy.pending,
                originalImages:original.images.length, originalPending:original.pending,
                visibleLines:world.querySelectorAll(`.conn-group[data-conn-to="${copy.id}"]`).length,
                outgoing:canvas.connections.filter(conn => conn.from === copy.id).length,
                connections:JSON.stringify(canvas.connections),
                originalConnections:JSON.stringify(canvas.connections.filter(conn => conn.to !== copy.id)),
                menuOpen:document.getElementById('createMenu')?.classList.contains('open') || false
            };
        }, single.target);
        assert.ok(singleCopy, 'Alt dragging creates a drawing node');
        assert.ok(singleCopy.x > singleCopy.originalX + 400);
        assert.deepEqual(singleCopy.inputs, preserveConnections ? single.inputs : []);
        assert.deepEqual(singleCopy.order, preserveConnections ? single.inputs.slice().reverse().map(id => `${id}|0`) : []);
        assert.deepEqual(singleCopy.blocked, preserveConnections ? [`${single.inputs[0]}|0`] : []);
        assert.equal(singleCopy.source, preserveConnections ? single.inputs[0] : '');
        assert.deepEqual(singleCopy.runInputs, []);
        assert.deepEqual(singleCopy.runPromptRefs, []);
        assert.deepEqual(singleCopy.taskInputs, preserveConnections ? single.inputs : []);
        assert.deepEqual(singleCopy.references, preserveConnections ? ['/output/ref-2.png'] : []);
        assert.equal(singleCopy.visibleLines, preserveConnections ? 2 : 0);
        assert.equal(singleCopy.outgoing, 0);
        assert.equal(singleCopy.originalConnections, single.originalConnections);
        assert.equal(singleCopy.menuOpen, false);
        assert.equal(singleCopy.prompt, '生成商品主图');
        assert.equal(singleCopy.settings.count, 4);
        assert.equal(singleCopy.settings.ratio, 'story');
        assert.deepEqual(singleCopy.images, []);
        assert.equal(singleCopy.running, false);
        assert.equal(singleCopy.pending, 0);
        assert.equal(singleCopy.originalImages, 1);
        assert.equal(singleCopy.originalPending, 2);
        const afterUndo = await page.evaluate(() => {
            performUndo();
            return {nodes:nodes.length, connections:JSON.stringify(canvas.connections)};
        });
        assert.equal(afterUndo.nodes, 4);
        assert.equal(afterUndo.connections, single.originalConnections);
        const afterRedo = await page.evaluate(copyId => {
            performRedo();
            return {nodes:nodes.length, inputs:inputNodesFor(nodes.find(node => node.id === copyId)).map(node => node.id), connections:JSON.stringify(canvas.connections)};
        }, singleCopy.id);
        assert.equal(afterRedo.nodes, 5);
        assert.deepEqual(afterRedo.inputs, preserveConnections ? single.inputs : []);
        assert.equal(afterRedo.connections, singleCopy.connections);
    }

    for(const button of ['left', 'right']){
    for(const kind of ['flow', 'history', 'input']){
        const fixture = await page.evaluate(kind => {
            nodes = [
                {id:'source', type:'smart-prompt', x:50, y:100, text:'商品海报'},
                {id:'result', type:'smart-upload', x:450, y:100, w:240, h:300,
                    images:[{url:'/output/completed.png', kind:'image', natural_w:240, natural_h:300}],
                    sourceNodeId:'source'}
            ];
            canvas.connections = [{from:'source', to:'result', kind, input_slot:'reference'}];
            selectedId = '';
            selectedIds = [];
            suppressNodeClickUntil = 0;
            suppressImageClickUntil = 0;
            render();
            return {originalConnections:JSON.stringify(canvas.connections)};
        }, kind);
        const imageBox = await page.locator('.image-node[data-id="result"]').boundingBox();
        assert.ok(imageBox);
        await page.mouse.move(imageBox.x + 3, imageBox.y + 45);
        await page.keyboard.down('Alt');
        await page.mouse.down({button});
        await page.mouse.move(imageBox.x + 303, imageBox.y + 95, {steps:6});
        await page.mouse.up({button});
        await page.keyboard.up('Alt');
        const result = await page.evaluate(() => {
            const copy = nodes.find(node => node.id !== 'source' && node.id !== 'result');
            return {
                id:copy.id, source:copy.sourceNodeId || '', images:copy.images.map(image => image.url),
                connections:canvas.connections.filter(conn => conn.to === copy.id),
                originalConnections:JSON.stringify(canvas.connections.filter(conn => conn.to !== copy.id)),
                visibleLines:world.querySelectorAll(`.conn-group[data-conn-to="${copy.id}"]`).length
            };
        });
        assert.notEqual(result.id, 'result');
        assert.equal(result.source, button === 'left' ? 'source' : '');
        assert.deepEqual(result.images, ['/output/completed.png']);
        assert.deepEqual(result.connections, button === 'left' ? [{from:'source', to:result.id, kind, input_slot:'reference'}] : []);
        assert.equal(result.visibleLines, button === 'left' ? 1 : 0);
        assert.equal(result.originalConnections, fixture.originalConnections);
    }
    }
    assert.deepEqual(errors, []);
});
