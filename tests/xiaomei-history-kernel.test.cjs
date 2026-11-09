const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function local(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadKernel(search) {
    const store = new Map();
    const sandbox = {
        URLSearchParams,
        Math,
        Number,
        String,
        Object,
        JSON,
        document: { documentElement: { setAttribute() {} } },
        location: { search: search || '' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-history-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-history-kernel.js' });
    return { kernel: sandbox.XiaomeiHistoryKernel, store };
}

test('history kernel stays legacy until opted in', () => {
    const { kernel, store } = loadKernel('');
    assert.equal(kernel.isActive(), false);
    assert.equal(store.has('xiaomei.historyKernel'), false);
    const enabled = loadKernel('?xmHistory=1');
    assert.equal(enabled.kernel.isActive(), true);
    const disabled = loadKernel('?xmHistory=0');
    assert.equal(disabled.kernel.isActive(), false);
});

test('undo stack is bounded and smart redo restores the replaced frame', () => {
    const { kernel } = loadKernel('');
    const past = [];
    const future = ['stale'];
    kernel.push(past, future, { id: 1 }, 2, true);
    kernel.push(past, future, { id: 2 }, 2, true);
    kernel.push(past, future, { id: 3 }, 2, true);
    assert.deepEqual(local(past), [{ id: 2 }, { id: 3 }]);
    assert.deepEqual(local(future), []);
    const undone = kernel.undo(past, future, { id: 4 });
    assert.equal(undone.id, 3);
    assert.equal(future[0].id, 4);
    const redone = kernel.redo(past, future, { id: 2 });
    assert.equal(redone.id, 4);
    assert.equal(kernel.undo([], null, { id: 1 }), null);
});

test('paste recenters the copied cluster and remaps internal edges', () => {
    const { kernel } = loadKernel('');
    const shift = kernel.centerShift([{ x: 0, y: 10 }, { x: 40, y: 30 }], { x: 100, y: 80 });
    assert.equal(shift.x, 80);
    assert.equal(shift.y, 60);
    const edges = kernel.remapEdges([
        { id: 'old', from: 'a', to: 'b' },
        { id: 'keep', from: 'outside', to: 'b' },
        { id: 'loop', from: 'a', to: 'a' }
    ], { a: 'a2', b: 'b2' }, {
        keepUnknownFrom: true,
        newId() { return 'fresh'; }
    });
    assert.equal(edges.length, 2);
    assert.equal(edges[0].from, 'a2');
    assert.equal(edges[0].to, 'b2');
    assert.equal(edges[0].id, 'fresh');
    assert.equal(edges[1].from, 'outside');
    assert.equal(kernel.pasteStillFresh(10, [9, 4]), true);
    assert.equal(kernel.pasteStillFresh(10, [10]), false);
});

test('shortcut chords match classic undo and smart redo', () => {
    const { kernel } = loadKernel('');
    const plain = { plainEditable: false, commandEditable: false, modal: false, textSelected: false, canPaste: true };
    assert.equal(kernel.chord({ key: 'z', ctrl: true }, { ...plain, profile: 'classic' }).type, 'undo');
    assert.equal(kernel.chord({ key: 'y', ctrl: true }, { ...plain, profile: 'classic' }), null);
    assert.equal(kernel.chord({ key: 'z', meta: true, shift: true }, { ...plain, profile: 'smart' }).type, 'redo');
    assert.equal(kernel.chord({ key: 'y', ctrl: true }, { ...plain, profile: 'smart' }).type, 'redo');
    assert.equal(kernel.chord({ key: 'c', ctrl: true }, { ...plain, textSelected: true, profile: 'smart' }), null);
    assert.equal(kernel.chord({ key: 'v', ctrl: true }, { ...plain, canPaste: false, profile: 'classic' }), null);
    assert.equal(kernel.chord({ key: 'v', ctrl: true }, plain).type, 'paste-deferred');
    assert.equal(kernel.chord({ key: 'v', ctrl: true }, plain).delay, 90);
    assert.equal(kernel.chord({ key: 'z', repeat: true }, plain).type, 'ignore');
    assert.equal(kernel.chord({ key: 'z' }, plain).type, 'zoom-preview');
    assert.equal(kernel.chord({ key: 'z', ctrl: true }, { ...plain, commandEditable: true }), null);
    assert.equal(kernel.chord({ key: 'g', ctrl: true, shift: true }, { ...plain, profile: 'smart' }).type, 'ungroup');
    assert.equal(kernel.chord({ key: 'g', ctrl: true }, { ...plain, profile: 'classic', commandEditable: true }).type, 'group');
});
