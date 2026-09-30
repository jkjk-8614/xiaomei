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
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    const images = await page.evaluate(() => Array.from({ length: 9 }, (_, index) => {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 400;
        const context = canvas.getContext('2d');
        context.fillStyle = ['#dce8e1', '#eedddd', '#dbe5ef'][index % 3];
        context.fillRect(0, 0, 300, 400);
        context.fillStyle = '#fff';
        context.fillRect(40, 70, 220, 260);
        context.fillStyle = '#53675c';
        context.font = '72px sans-serif';
        context.textAlign = 'center';
        context.fillText(String(index + 1), 150, 225);
        return canvas.toDataURL('image/png').split(',')[1];
    }));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'xiaomei-group-drag.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            if (!fs.existsSync(file)) return route.fulfill({ contentType: 'application/javascript', body: '' });
            return route.fulfill({ path: file });
        }
        if (url.pathname.endsWith('.png') || url.pathname === '/api/media-preview') {
            const source = url.searchParams.get('url') || url.pathname;
            const index = Number(source.match(/image-(\d+)\.png/)?.[1] || 0);
            return route.fulfill({ contentType: 'image/png', body: Buffer.from(images[index], 'base64') });
        }
        if (url.pathname === '/api/config' || url.pathname === '/api/providers') {
            return route.fulfill({ json: {
                api_providers: [{ id: 'fixture', name: 'Fixture', enabled: true, protocol: 'openai', chat_models: ['fixture-chat'], image_models: ['fixture-image'], video_models: [] }],
                comfy_instances: []
            } });
        }
        if (url.pathname === '/api/canvases/group-drag-fixture') {
            return route.fulfill({ json: { canvas: {
                id: 'group-drag-fixture', title: 'Group drag fixture', nodes: [], connections: [], logs: [],
                settings: { engine: 'api', provider_id: 'fixture', model: 'fixture-image', count: 1 }
            } } });
        }
        return route.fulfill({ json: { skills: [], categories: [], libraries: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://xiaomei-group-drag.test/static/smart-canvas.html?id=group-drag-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Group drag fixture');
    return page;
}

async function makeGroup(page, count = 9, nodeType = 'smart-group') {
    const id = await page.evaluate(({ count, nodeType }) => {
        clearImageClickTimer();
        suppressImageClickUntil = 0;
        suppressNodeClickUntil = 0;
        nodes = [];
        canvas.connections = [];
        selectedId = '';
        selectedIds = [];
        selectedImage = { nodeId: '', index: -1 };
        undoStack.length = 0;
        discardPendingUndo();
        viewport = { x: 0, y: 0, scale: 1 };
        applyViewport();
        const images = Array.from({ length: count }, (_, index) => ({
            url: `/output/image-${index}.png`, name: `image-${index}.png`, kind: 'image',
            width: 300, height: 400, layout_w: 300, layout_h: 400, asset_ref_id: `asset_fixture_${index}`
        }));
        const group = nodeType === 'smart-group'
            ? createSmartGroupNode(180, 120, { select: false, skipUndo: true })
            : createNode(180, 120, images, { nodeType, select: false, skipUndo: true });
        group.images = images;
        if (nodeType === 'smart-group' && count === 9) {
            group.w = 520;
            group.h = 650;
        }
        render();
        return group.id;
    }, { count, nodeType });
    await page.waitForFunction(id => {
        const images = [...world.querySelectorAll(`[data-id="${id}"] img`)];
        return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
    }, id);
    return id;
}

function imageItem(page, id, index = 0) {
    return page.locator(`.image-node[data-id="${id}"] [data-image-index="${index}"]`).filter({ has: page.locator('img') }).first();
}

async function dragImage(page, id, alt = false, short = false) {
    const box = await imageItem(page, id).boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    if (alt) await page.keyboard.up('Alt');
    await page.mouse.move(short ? box.x + box.width / 2 + 2 : 1080, short ? box.y + box.height / 2 : 500, { steps: 12 });
    await page.mouse.up();
}

test('Alt dragging a group image preserves the source and creates one independent copy', { timeout: 60000 }, async t => {
    const page = await fixture(t);
    for (const [count, nodeType] of [[9, 'smart-group'], [1, 'smart-group'], [3, 'smart-upload']]) {
        const id = await makeGroup(page, count, nodeType);
        const before = await page.evaluate(id => {
            const upstream = createPromptNode(20, 780, { select: false, skipUndo: true });
            const downstream = createPromptNode(1250, 780, { select: false, skipUndo: true });
            connectInputNode(upstream.id, id);
            connectInputNode(id, downstream.id);
            undoStack.length = 0;
            return {
                images: JSON.parse(JSON.stringify(nodes.find(node => node.id === id).images)),
                rect: nodeRect(nodes.find(node => node.id === id)),
                ids: nodes.map(node => node.id), connections: JSON.parse(JSON.stringify(canvas.connections))
            };
        }, id);
        await dragImage(page, id, true);
        const copied = await page.evaluate(({ id, ids }) => {
            const source = nodes.find(node => node.id === id);
            const copy = nodes.find(node => !ids.includes(node.id));
            return {
                nodeCount: nodes.length, images: source.images, rect: nodeRect(source),
                copyImages: copy?.images, copyPosition: copy ? { x: copy.x, y: copy.y } : null,
                connections: canvas.connections, undoCount: undoStack.length,
                independent: copy?.images?.[0] !== source.images[0]
            };
        }, { id, ids: before.ids });
        assert.equal(copied.nodeCount, before.ids.length + 1);
        assert.deepEqual(copied.images, before.images, `${nodeType}: source images must remain in order`);
        assert.deepEqual(copied.rect, before.rect);
        assert.equal(copied.copyImages.length, 1);
        for (const field of ['url', 'name', 'kind', 'width', 'height', 'asset_ref_id']) {
            assert.equal(copied.copyImages[0][field], before.images[0][field]);
        }
        assert.ok(copied.copyPosition.x > 800);
        assert.equal(copied.independent, true);
        assert.deepEqual(copied.connections, before.connections);
        assert.equal(copied.undoCount, 1);
        const restored = await page.evaluate(id => {
            performUndo();
            return { nodeCount: nodes.length, images: nodes.find(node => node.id === id).images };
        }, id);
        assert.equal(restored.nodeCount, before.ids.length);
        assert.deepEqual(restored.images, before.images);
    }

    const id = await makeGroup(page, 3);
    await dragImage(page, id, true, true);
    assert.equal(await page.evaluate(() => nodes.length), 1, 'Alt click without a drag must not copy');
    assert.equal(await page.evaluate(() => undoStack.length), 0);
    await dragImage(page, id);
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).images.length, id), 2, 'plain drag still moves the image out');
    await page.evaluate(() => performUndo());
    assert.equal(await page.evaluate(id => nodes.find(node => node.id === id).images.length, id), 3);
});

test('image names appear only for the clicked image and remain editable', { timeout: 60000 }, async t => {
    const page = await fixture(t);
    const id = await makeGroup(page);
    const badges = page.locator(`.image-node[data-id="${id}"] .image-name-badge`);
    assert.equal(await badges.count(), 9);
    for (let index = 0; index < 9; index++) await assert.doesNotReject(() => badges.nth(index).waitFor({ state: 'hidden' }));
    await imageItem(page, id, 0).hover();
    assert.equal(await badges.nth(0).isVisible(), false, 'hover alone must not reveal a name');
    await imageItem(page, id, 0).click();
    await badges.nth(0).waitFor({ state: 'visible' });
    await imageItem(page, id, 1).click();
    await badges.nth(1).waitFor({ state: 'visible' });
    assert.equal(await badges.nth(0).isVisible(), false);
    await badges.nth(1).dblclick();
    await page.locator('#assetDialogInput').fill('renamed.png');
    await page.locator('#assetDialogOk').click();
    await page.waitForFunction(id => nodes.find(node => node.id === id).images[1].name === 'renamed.png', id);
    assert.equal(await badges.nth(1).textContent(), 'renamed.png');
    await page.mouse.click(1050, 750);
    await badges.nth(1).waitFor({ state: 'hidden' });

    const singleId = await makeGroup(page, 1, 'smart-upload');
    const singleBadge = page.locator(`.image-node[data-id="${singleId}"] .image-name-badge`);
    assert.equal(await singleBadge.isVisible(), false);
    await imageItem(page, singleId).click();
    await singleBadge.waitFor({ state: 'visible' });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-group-drag-'));
    await makeGroup(page);
    await page.screenshot({ path: path.join(directory, 'desktop.png') });
    await page.setViewportSize({ width: 430, height: 900 });
    await page.evaluate(() => {
        viewport = { x: -97, y: 100, scale: 0.65 };
        applyViewport();
    });
    await page.screenshot({ path: path.join(directory, 'narrow.png') });
    console.log(`Group image screenshots: ${directory}`);
});
