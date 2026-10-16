const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('smart canvas modifier selection and Alt copying preserve selected connections', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({
        channel: 'msedge',
        headless: true
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10000);

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

    const altCopy = await page.evaluate(() => {
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        const first = createNode(100, 150, [], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
        const second = createNode(100, 450, [], {nodeType:SMART_UPLOAD_NODE_TYPE, select:false, skipUndo:true});
        const target = createPaintNodeAt({x:600, y:220}, {select:false, skipUndo:true});
        const outside = createPaintNodeAt({x:1100, y:700}, {select:false, skipUndo:true});
        addConnection(first.id, target.id, 'input');
        addConnection(second.id, target.id, 'input');
        addConnection(first.id, outside.id, 'input');
        target.inputNodeIds = [first.id, second.id];
        target.inputRefOrder = [`${first.id}|0`, `${second.id}|0`];
        outside.inputNodeIds = [first.id];
        viewport = {x:0, y:0, scale:1};
        applyViewport();
        render();
        beginSelectionGesture({clientX:70, clientY:100});
        finishSelection({clientX:950, clientY:650});
        const selectedBefore = selectedNodeIds();
        duplicateForAltDrag(target);
        const copies = selectedNodeIds();
        const copiedTarget = nodes.find(node => node.id === copies[2]);
        const internalLinks = canvas.connections.filter(conn => copies.includes(conn.from) && conn.to === copiedTarget.id);
        const visibleLinks = [...world.querySelectorAll('.connection-layer .conn-group')]
            .filter(group => copies.includes(group.dataset.connFrom) && group.dataset.connTo === copiedTarget.id);
        const externalLink = canvas.connections.some(conn => copies.includes(conn.from) && conn.to === outside.id);
        selectedId = first.id;
        selectedIds = [];
        const beforeSingle = canvas.connections.length;
        duplicateForAltDrag(first);
        return {
            selectedBefore,
            originals:[first.id, second.id, target.id],
            copies,
            internalLinks:internalLinks.map(conn => [conn.from, conn.to, conn.kind]),
            visibleLinks:visibleLinks.length,
            copiedInputs:copiedTarget.inputNodeIds,
            copiedInputOrder:copiedTarget.inputRefOrder,
            externalLink,
            singleUploadAddedLinks:canvas.connections.length - beforeSingle
        };
    });
    assert.deepEqual(altCopy.selectedBefore, altCopy.originals);
    assert.equal(altCopy.internalLinks.length, 2);
    assert.equal(altCopy.visibleLinks, 2);
    assert.deepEqual(new Set(altCopy.internalLinks.map(link => link[0])), new Set(altCopy.copies.slice(0, 2)));
    assert.deepEqual(new Set(altCopy.copiedInputs), new Set(altCopy.copies.slice(0, 2)));
    assert.deepEqual(altCopy.copiedInputOrder, altCopy.copies.slice(0, 2).map(id => `${id}|0`));
    assert.equal(altCopy.externalLink, false);
    assert.equal(altCopy.singleUploadAddedLinks, 0);
});
