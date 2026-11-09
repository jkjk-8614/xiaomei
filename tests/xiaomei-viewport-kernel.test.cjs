const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadKernel(search, saved) {
    const store = new Map(Object.entries(saved || {}));
    const attrs = {};
    const element = { style: {} };
    const sandbox = {
        URLSearchParams,
        Math,
        Number,
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
        location: { search: search || '' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-viewport-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-viewport-kernel.js' });
    return { kernel: sandbox.XiaomeiViewportKernel, store, element, attrs };
}

test('viewport kernel stays on next and ignores legacy switches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-viewport-kernel.js'), 'utf8');
    assert.equal(/xiaomei\.viewportKernel|xmViewport|localStorage/.test(source), false);
    const fresh = loadKernel('');
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.attrs['data-xm-viewport'], 'next');
    assert.equal(fresh.store.size, 0);
    assert.equal(fresh.kernel.setActive(false), true);
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.attrs['data-xm-viewport'], 'next');
    assert.equal(fresh.store.size, 0);
    for (const search of ['?xmViewport=0', '?xmViewport=legacy', '?xmViewport=1', '?xmViewport=next']) {
        const loaded = loadKernel(search);
        assert.equal(loaded.kernel.isActive(), true);
        assert.equal(loaded.attrs['data-xm-viewport'], 'next');
        assert.equal(loaded.store.size, 0);
    }
    for (const saved of ['legacy', '0', 'next']) {
        const loaded = loadKernel('', { 'xiaomei.viewportKernel': saved });
        assert.equal(loaded.kernel.isActive(), true);
        assert.equal(loaded.attrs['data-xm-viewport'], 'next');
        assert.equal(loaded.kernel.setActive(false), true);
        assert.equal(loaded.store.get('xiaomei.viewportKernel'), saved);
    }
});

test('pointer mapping keeps the cursor anchored while zooming', () => {
    const { kernel } = loadKernel('');
    const camera = { x: 100, y: 50, scale: 1 };
    const frame = { left: 10, top: 20, width: 800, height: 600 };
    const before = kernel.pointerToWorld(camera, frame, 210, 120);
    assert.equal(before.x, 100);
    assert.equal(before.y, 50);
    kernel.classicWheel(camera, frame, 210, 120, 1);
    assert.equal(camera.scale, 0.92);
    const after = kernel.pointerToWorld(camera, frame, 210, 120);
    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.y - before.y) < 1e-9);
    assert.equal(camera.x, 108);
    assert.equal(camera.y, 54);
});

test('center zoom and drag follow the camera spec', () => {
    const { kernel } = loadKernel('');
    const camera = { x: 40, y: 20, scale: 1 };
    kernel.zoomAboutCenter(camera, { width: 800, height: 600 }, 1.1);
    assert.ok(Math.abs(camera.x - 4) < 1e-9);
    assert.ok(Math.abs(camera.y - (-8)) < 1e-9);
    kernel.dragCamera(camera, 10, 30, 4, -6);
    assert.equal(camera.x, 14);
    assert.equal(camera.y, 24);
});

test('smart wheel gain is clamped and slider zoom snaps', () => {
    const { kernel } = loadKernel('');
    const step = kernel.smartWheelStep(
        { x: 0, y: 0, scale: 1 },
        { left: 0, top: 0 },
        200,
        100,
        100,
        0,
        800
    );
    assert.equal(step.scale, 0.85);
    assert.equal(step.x, 30);
    assert.equal(step.y, 15);
    assert.equal(kernel.steppedZoom(1.026, 0.06, 2, 0.05), 1.05);
    assert.equal(kernel.positiveScale(0, 1), 1);
    assert.equal(kernel.positiveScale(1.25, 1), 1.25);
});

test('fit and focus place the camera around content', () => {
    const { kernel } = loadKernel('');
    const camera = { x: 0, y: 0, scale: 1 };
    const frame = { width: 1000, height: 800 };
    const options = { pad: 180, inset: 80, minZoom: 0.06, maxZoom: 0.82, emptyZoom: 0.45, allowEmpty: true };
    assert.equal(kernel.fitBoxes(camera, frame, [], options), true);
    assert.equal(camera.scale, 0.45);
    assert.equal(camera.x, 500);
    assert.equal(camera.y, 400);
    kernel.fitBoxes(camera, frame, [{ x: 0, y: 0, w: 100, h: 100 }], options);
    assert.equal(camera.scale, 0.82);
    assert.ok(Math.abs(camera.x - 459) < 1e-9);
    assert.ok(Math.abs(camera.y - 359) < 1e-9);

    const wide = { x: 0, y: 0, scale: 1 };
    const spread = [
        { x: 0, y: 0, w: 20, h: 20 },
        { x: 5000, y: 0, w: 20, h: 20 }
    ];
    assert.equal(kernel.focusContent(wide, frame, spread, {
        pad: 160, inset: 80, minZoom: 0.06, maxZoom: 0.82, emptyZoom: 0.45, floor: 0.18, focusZoom: 0.45
    }), true);
    assert.equal(wide.scale, 0.45);
    assert.ok(wide.x < frame.width / 2);
});

test('minimap enclosure and node origin formatting', () => {
    const { kernel, element } = loadKernel('');
    const bounds = kernel.enclose([
        { x: 0, y: 0, w: 100, h: 100 },
        { x: -10, y: -10, w: 200, h: 150 }
    ], { minPad: 240, ratio: 0.08, emptyX: 0, emptyY: 0, emptyW: 1000, emptyH: 700 });
    assert.equal(bounds.x, -250);
    assert.equal(bounds.y, -250);
    assert.equal(bounds.w, 680);
    assert.equal(bounds.h, 630);
    const map = kernel.containMap(bounds, 172, 110);
    assert.ok(map.scale > 0);
    assert.ok(Math.abs(map.offsetX - (172 - bounds.w * map.scale) / 2) < 1e-9);
    assert.equal(kernel.nodeOriginStyle({ x: 12, y: -4 }), 'left:12px;top:-4px');
    assert.equal(kernel.nodeOriginStyle({}), 'left:0px;top:0px');
    kernel.writeMeasuredOrigin(element, undefined, 8);
    assert.equal(element.style.left, '0px');
    assert.equal(element.style.top, '8px');
    kernel.paintWorldLayer(element, { x: 3, y: 4, scale: 1.5 }, 'translate3d');
    assert.equal(element.style.transform, 'translate3d(3px, 4px, 0) scale(1.5)');
    kernel.paintWorldLayer(element, { x: 3, y: 4, scale: 1.5 }, 'translate');
    assert.equal(element.style.transform, 'translate(3px, 4px) scale(1.5)');
});

test('affine inverse matches a translated scaled matrix', () => {
    const { kernel } = loadKernel('');
    const matrix = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 30 };
    const inverted = kernel.invertAffine(matrix, 14, 36);
    assert.equal(inverted.x, 2);
    assert.equal(inverted.y, 3);
    assert.equal(kernel.invertAffine({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 1, 1), null);
});
