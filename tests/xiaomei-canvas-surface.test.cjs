const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function read(name) {
    return fs.readFileSync(path.join(__dirname, '../static/js', name), 'utf8');
}

function sandbox() {
    const attrs = {};
    const box = {
        URLSearchParams,
        Math,
        Number,
        String,
        Object,
        JSON,
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } }
    };
    box.window = box;
    box.globalThis = box;
    vm.runInNewContext(read('xiaomei-viewport-kernel.js'), box, { filename: 'xiaomei-viewport-kernel.js' });
    vm.runInNewContext(read('xiaomei-canvas-keys.js'), box, { filename: 'xiaomei-canvas-keys.js' });
    vm.runInNewContext(read('xiaomei-smart-surface.js'), box, { filename: 'xiaomei-smart-surface.js' });
    vm.runInNewContext(read('canvas-editor-core.js'), box, { filename: 'canvas-editor-core.js' });
    box.attrs = attrs;
    return box;
}

test('editor coordinates go through the viewport kernel', () => {
    const core = read('canvas-editor-core.js');
    const list = read('canvas-list.js');
    assert.equal(core.includes('clientX) - Number(rect'), false);
    assert.equal(list.includes('(px - viewport.x) / viewport.scale'), false);
    const box = sandbox();
    const point = box.XiaomeiCanvasEditorCore.screenToWorld(140, 80, { left: 20, top: 10, width: 400, height: 300 }, { x: 30, y: 15, scale: 2 });
    assert.equal(point.x, 45);
    assert.equal(point.y, 27.5);
    const center = box.XiaomeiCanvasEditorCore.boardCenterWorld(400, 200, { x: 40, y: 20, scale: 2 });
    assert.equal(center.x, 80);
    assert.equal(center.y, 40);
    const collapsed = box.XiaomeiCanvasEditorCore.screenToWorld(10, 10, { left: 0, top: 0 }, { x: 0, y: 0, scale: 0 });
    assert.equal(collapsed.x, 10);
    assert.equal(collapsed.y, 10);
});

test('edit text box uses the same hit rectangle with a different builder', () => {
    const box = sandbox();
    const ctx = {
        save() {},
        restore() {},
        measureText() {
            return { width: 40, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 };
        }
    };
    const hit = box.XiaomeiCanvasEditorCore.measureEditTextItem({ x: 100, y: 50, size: 28, text: '茶' }, ctx);
    assert.equal(hit.pad, 5);
    assert.equal(hit.w, 50);
    assert.equal(hit.h, 30);
    assert.equal(hit.x, 75);
    assert.equal(hit.y, 35);
});

test('classic remainder keeps delete, escape order, lightbox, and shifted group', () => {
    const box = sandbox();
    const keys = box.XiaomeiCanvasKeys;
    const open = { imageEditor: true, promptTemplates: true, lightbox: true };
    const escape = keys.classicRemainder({ key: 'Escape', surfaces: open, selectionCount: 1 });
    assert.equal(escape.stop, true);
    assert.equal(escape.effects.at(-1).target, 'image-editor');
    const step = keys.classicRemainder({ key: 'ArrowRight', surfaces: { lightbox: true } });
    assert.equal(step.effects[0].direction, 1);
    const remove = keys.classicRemainder({ key: 'Delete', fieldFocused: false, selectionCount: 2, surfaces: {} });
    assert.equal(remove.effects[0].type, 'delete-selection');
    const typing = keys.classicRemainder({ key: 'Backspace', fieldFocused: true, selectionCount: 2, surfaces: {} });
    assert.equal(typing.effects.length, 0);
    const shifted = keys.classicRemainder({ key: 'g', command: true, surfaces: {} });
    assert.equal(shifted.effects.some(effect => effect.type === 'group'), true);
    const knife = keys.classicRemainder({ key: 'Shift', alt: false, activeEditable: false, surfaces: {} });
    assert.equal(knife.effects[0].type, 'arm-knife');
});

test('smart prelude yields the editor and the asset key stays outside the chord', () => {
    const keys = sandbox().XiaomeiCanvasKeys;
    const editor = keys.smartPrelude({ key: 'ArrowLeft', editable: false, imageEditor: true, previewMode: true });
    assert.equal(editor.skipChord, true);
    assert.equal(editor.effects.some(effect => effect.type === 'preview-step' && effect.direction === -1), true);
    const thumb = keys.smartPrelude({ key: 'Escape', thumbDrag: true, imageEditor: true });
    assert.equal(thumb.effects.map(effect => effect.type).join(','), 'clear-thumb');
    const assets = keys.smartRemainder({ key: 'a', command: false, alt: false, editable: false, repeat: false });
    assert.equal(assets.effects[0].type, 'toggle-assets');
    const held = keys.smartRemainder({ key: 'a', command: true, editable: false, repeat: false });
    assert.equal(held.effects.length, 0);
});

test('smart card shell and ports come from descriptors', () => {
    const surface = sandbox().XiaomeiSmartSurface;
    const className = surface.cardClass({ video: true, selected: true, pending: true });
    assert.equal(className, 'image-node video-smart-node selected node-pending');
    const ports = surface.portsHtml({ compare: true, loopPaired: true });
    assert.equal(ports.includes('data-input-slot="product"'), true);
    assert.equal(ports.includes('port-out'), false);
    const plain = surface.portsHtml({});
    assert.equal(plain.includes('title="连接输入"'), true);
    assert.equal(plain.includes('port-out'), true);
    const html = surface.cardHtml({
        id: 'n1',
        className: className,
        style: surface.cardStyle({ origin: 'left:4px;top:8px', width: 120, height: 80 }),
        titleHtml: '视频',
        bodyHtml: 'body',
        hintHtml: '',
        resize: true,
        ports: {}
    });
    assert.equal(html.startsWith('<div class="image-node video-smart-node selected node-pending"'), true);
    assert.equal(html.includes('data-id="n1"'), true);
    assert.equal(html.includes('width:120px;height:80px'), true);
    assert.equal(html.includes('<div class="node-body">body</div>'), true);
});

test('canvas pages load the new surfaces and drop the duplicate chord tails', () => {
    const canvas = read('canvas.js');
    const smart = read('smart-canvas.js');
    const classicPage = fs.readFileSync(path.join(__dirname, '../static/canvas.html'), 'utf8');
    const smartPage = fs.readFileSync(path.join(__dirname, '../static/smart-canvas.html'), 'utf8');
    const listPage = fs.readFileSync(path.join(__dirname, '../static/canvas-list.html'), 'utf8');
    assert.equal(canvas.includes("if((e.ctrlKey || e.metaKey) && key === 'z')"), false);
    assert.equal(smart.includes("if((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')"), false);
    assert.equal(canvas.includes('XiaomeiCanvasSurface.mountClassicFrame'), true);
    assert.equal(canvas.includes('XiaomeiCanvasSurface.mountImageGeneration'), true);
    assert.equal(smart.includes('XiaomeiSmartSurface.cardHtml'), true);
    assert.equal(classicPage.includes('xiaomei-canvas-surface.js'), true);
    assert.equal(classicPage.includes('menuAdd(\'image\')'), false);
    assert.equal(smartPage.includes('xiaomei-canvas-keys.js'), true);
    assert.equal(listPage.includes('xiaomei-viewport-kernel.js'), true);
});
