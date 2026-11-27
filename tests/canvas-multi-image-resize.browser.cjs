const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function fixture(t) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    let stored = { id: 'multi-resize', title: '多图自适应拉长', nodes: [], connections: [], logs: [], settings: {} };
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'multi-resize.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.svg') || url.pathname === '/api/media-preview') {
            const src = url.searchParams.get('url') || url.pathname;
            const portrait = src.includes('portrait');
            const landscape = src.includes('landscape');
            const w = portrait ? 300 : landscape ? 400 : 300;
            const h = portrait ? 400 : landscape ? 300 : 300;
            const fill = portrait ? '#d8e2dc' : landscape ? '#d7e3fc' : '#fae1dd';
            return route.fulfill({
                contentType: 'image/svg+xml',
                body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/></svg>`
            });
        }
        if (url.pathname === '/api/canvases/multi-resize') {
            if (route.request().method() === 'PUT') stored = { ...stored, ...route.request().postDataJSON() };
            return route.fulfill({ json: { canvas: stored } });
        }
        if (url.pathname === '/api/config') {
            return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        }
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://multi-resize.test/static/smart-canvas.html?id=multi-resize');
    await page.waitForFunction(() => canvas?.id === 'multi-resize');
    await page.addStyleTag({ content: '#composer { display:none !important; }' });
    return page;
}

async function dragResizeHandle(page, nodeId, dx, dy) {
    const node = page.locator(`.image-node[data-id="${nodeId}"]`);
    await node.hover();
    const handle = node.locator('> .node-resize-handle');
    await handle.waitFor({ state: 'visible' });
    const box = await handle.boundingBox();
    assert.ok(box, `resize handle missing for ${nodeId}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => !resizeState);
}

async function readCardState(page, nodeId) {
    return page.evaluate(id => {
        const node = nodes.find(item => item.id === id);
        const el = world.querySelector(`.image-node[data-id="${id}"]`);
        const grid = el?.querySelector('.thumb-grid');
        const layout = imageLayout(node.images || [], nodeScale(node), node);
        return {
            w: node.w,
            h: node.h,
            manualSize: Boolean(node.manualSize),
            rect: nodeRect(node),
            layout: {
                cols: layout.cols,
                rows: layout.rows,
                visibleRows: layout.visibleRows,
                width: layout.width,
                height: layout.height,
                thumbW: layout.thumbW || layout.thumb,
                thumbH: layout.thumbH || layout.thumb,
                scrollable: Boolean(layout.scrollable)
            },
            domWidth: parseFloat(el?.style.width || '0'),
            domHeight: parseFloat(el?.style.height || '0'),
            scrollHeight: grid ? grid.scrollHeight : 0,
            clientHeight: grid ? grid.clientHeight : 0,
            overflowAttr: grid?.dataset?.thumbOverflow || '',
            tileCount: grid ? grid.querySelectorAll('.thumb-item').length : 0
        };
    }, nodeId);
}

test('multi-image upload node stretches vertically to reveal hidden rows, reflows columns when widened, and persists across reload', { timeout: 45000 }, async t => {
    const page = await fixture(t);
    const id = await page.evaluate(() => {
        viewport = { x: 40, y: 40, scale: 0.6 };
        applyViewport();
        // 15 张混合比例图片（中位数 1:1），默认 4 列 × 3 排可见（共 4 排），出现滚动条
        const images = Array.from({ length: 15 }, (_, index) => {
            const mode = index < 7 ? 'portrait' : index === 7 ? 'square' : 'landscape';
            return {
                url: `/media/${mode}-${index}.svg`,
                name: `${mode}-${index}.svg`,
                kind: 'image',
                natural_w: mode === 'portrait' ? 300 : mode === 'landscape' ? 400 : 300,
                natural_h: mode === 'portrait' ? 400 : mode === 'landscape' ? 300 : 300
            };
        });
        const node = createNode(80, 60, images, { nodeType: 'smart-upload', select: false, skipUndo: true });
        nodes = [node];
        undoStack.length = 0;
        render();
        return node.id;
    });

    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-multi-resize-'));
    const initial = await readCardState(page, id);
    await page.screenshot({ path: path.join(shotDir, '01-initial.png') });
    assert.equal(initial.tileCount, 15);
    assert.equal(initial.layout.cols, 4);
    assert.equal(initial.layout.visibleRows, 3);
    assert.equal(initial.overflowAttr, '1');
    assert.ok(initial.scrollHeight > initial.clientHeight + 5, 'initial 15-image upload node should scroll after 3 rows');

    // 1) 向下拉长约 100px（画布缩放 0.6 -> 屏幕 dy = 60）：应平滑展开第 4 排顶部，宽度保持稳定
    await dragResizeHandle(page, id, 0, 60);
    const mid = await readCardState(page, id);
    assert.equal(mid.layout.cols, 4);
    assert.equal(mid.domWidth, initial.domWidth, 'pulling down should not shrink width');
    assert.ok(mid.domHeight > initial.domHeight + 70, `height should stretch smoothly: ${initial.domHeight} -> ${mid.domHeight}`);
    assert.equal(mid.layout.scrollable, true);

    // 2) 继续向下拉长展开全部 4 排（画布高度再增加 ~140px -> 屏幕 dy = 84）
    await dragResizeHandle(page, id, 0, 84);
    const expanded = await readCardState(page, id);
    await page.screenshot({ path: path.join(shotDir, '02-expanded.png') });
    assert.equal(expanded.layout.cols, 4);
    assert.equal(expanded.layout.rows, 4);
    assert.equal(expanded.layout.visibleRows, 4);
    assert.equal(expanded.layout.scrollable, false);
    assert.equal(expanded.overflowAttr, '0');
    assert.ok(expanded.scrollHeight <= expanded.clientHeight + 2, `all 4 rows should be visible without scrollbar: ${expanded.scrollHeight} vs ${expanded.clientHeight}`);

    // 验证保存并刷新重载后严格幂等
    await page.evaluate(() => saveCanvas());
    await page.reload();
    await page.waitForFunction(() => nodes.length === 1);
    const reloaded = await readCardState(page, id);
    assert.deepEqual(
        { w: reloaded.domWidth, h: reloaded.domHeight, cols: reloaded.layout.cols, rows: reloaded.layout.rows, visibleRows: reloaded.layout.visibleRows },
        { w: expanded.domWidth, h: expanded.domHeight, cols: expanded.layout.cols, rows: expanded.layout.rows, visibleRows: expanded.layout.visibleRows }
    );

    // 3) 继续大幅向下拉长（再拉 450 画布 px -> 屏幕 dy = 270）：自适应减列为 3 列 × 5 排，单张缩略图放大
    await page.evaluate(() => { viewport = { x: 40, y: 40, scale: 0.5 }; applyViewport(); });
    await dragResizeHandle(page, id, 0, 225);
    const tall = await readCardState(page, id);
    await page.screenshot({ path: path.join(shotDir, '03-tall-3cols.png') });
    assert.equal(tall.layout.cols, 3);
    assert.equal(tall.layout.rows, 5);
    assert.ok(tall.domHeight > expanded.domHeight + 200);
    assert.ok(tall.layout.thumbW > expanded.layout.thumbW, 'reflowing into 3 columns should enlarge thumbnails');

    // 4) 从默认 4×3+滚动 往右拉宽：自适应增列为 5 列 × 3 排并消除滚动条
    await page.evaluate(nodeId => {
        const node = nodes.find(item => item.id === nodeId);
        delete node.manualSize;
        delete node.w;
        delete node.h;
        node.scale = 0.8;
        viewport = { x: 40, y: 40, scale: 0.6 };
        applyViewport();
        render();
    }, id);
    await dragResizeHandle(page, id, 120, 0); // +200 画布宽度
    const widened = await readCardState(page, id);
    assert.equal(widened.layout.cols, 5);
    assert.equal(widened.layout.rows, 3);
    assert.equal(widened.layout.scrollable, false);
    assert.ok(widened.domWidth > initial.domWidth + 120);
    assert.ok(widened.scrollHeight <= widened.clientHeight + 2);

    await page.screenshot({ path: path.join(shotDir, '04-widened-5cols.png') });
    console.log('MULTI_RESIZE_SHOTS=' + shotDir);
});

test('4-image grid reflows on single-axis stretch and smart-group with >4 rows stretches past 4 rows', { timeout: 45000 }, async t => {
    const page = await fixture(t);
    const ids = await page.evaluate(() => {
        viewport = { x: 40, y: 40, scale: 0.6 };
        applyViewport();
        const sq = index => ({ url: `/media/square-${index}.svg`, name: `sq-${index}.svg`, kind: 'image', natural_w: 300, natural_h: 300 });
        const four = createNode(80, 80, Array.from({ length: 4 }, (_, i) => sq(i)), { nodeType: 'smart-upload', select: false, skipUndo: true });
        Object.assign(four, { w: 232, h: 232, manualSize: true, scale: 1 });

        const group = createSmartGroupNode(500, 80, { select: false, skipUndo: true });
        group.images = Array.from({ length: 20 }, (_, i) => sq(i));

        nodes = [four, group];
        render();
        return { fourId: four.id, groupId: group.id };
    });

    // 4 张图往右拉宽：2×2 -> 4×1
    await dragResizeHandle(page, ids.fourId, 140, 0);
    const fourWide = await readCardState(page, ids.fourId);
    assert.equal(fourWide.layout.cols, 4);
    assert.equal(fourWide.layout.rows, 1);

    // 20 张图智能分组默认最多 4 排，向下拉长应展开超过 4 排并消除滚动条
    const groupBefore = await page.evaluate(id => {
        const node = nodes.find(item => item.id === id);
        const layout = smartGroupThumbLayout(node);
        return { height: layout.height, visibleRows: layout.visibleRows, rows: layout.rows };
    }, ids.groupId);
    assert.equal(groupBefore.rows, 5);
    assert.equal(groupBefore.visibleRows, 4);

    await dragResizeHandle(page, ids.groupId, 0, 140); // +233 画布高度
    const groupAfter = await page.evaluate(id => {
        const node = nodes.find(item => item.id === id);
        const layout = smartGroupThumbLayout(node);
        const grid = world.querySelector(`.image-node[data-id="${id}"] .smart-group-thumb-grid`);
        return {
            height: layout.height,
            visibleRows: layout.visibleRows,
            rows: layout.rows,
            scrollHeight: grid.scrollHeight,
            clientHeight: grid.clientHeight
        };
    }, ids.groupId);
    assert.ok(groupAfter.visibleRows >= 5, `expected >= 5 visible rows, got ${groupAfter.visibleRows}`);
    assert.equal(groupAfter.visibleRows, groupAfter.rows);
    assert.ok(groupAfter.height > groupBefore.height + 140);
    assert.ok(groupAfter.scrollHeight <= groupAfter.clientHeight + 2);
});
