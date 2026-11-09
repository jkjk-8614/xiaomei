const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function local(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadKernel(search, saved) {
    const store = new Map(Object.entries(saved || {}));
    const attrs = {};
    const sandbox = {
        URLSearchParams,
        Math,
        Number,
        String,
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
        location: { search: search || '' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-node-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-node-kernel.js' });
    return { kernel: sandbox.XiaomeiNodeKernel, store, attrs };
}

test('node kernel stays on next and ignores legacy switches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-node-kernel.js'), 'utf8');
    assert.equal(/xiaomei\.nodeKernel|xmNodes|localStorage/.test(source), false);
    const fresh = loadKernel('');
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.attrs['data-xm-nodes'], 'next');
    assert.equal(fresh.kernel.setActive(false), true);
    assert.equal(fresh.store.size, 0);
    for (const search of ['?xmNodes=0', '?xmNodes=legacy', '?xmNodes=1']) {
        const loaded = loadKernel(search);
        assert.equal(loaded.kernel.isActive(), true);
        assert.equal(loaded.attrs['data-xm-nodes'], 'next');
        assert.equal(loaded.store.size, 0);
    }
    const stuck = loadKernel('', { 'xiaomei.nodeKernel': 'legacy' });
    assert.equal(stuck.kernel.isActive(), true);
    assert.equal(stuck.kernel.setActive(false), true);
    assert.equal(stuck.store.get('xiaomei.nodeKernel'), 'legacy');
});

test('drag cohort moves group members and the rest of a multi-selection', () => {
    const { kernel } = loadKernel('');
    const records = {
        group: { id: 'group', x: 0, y: 0, group: true, items: ['image', 'prompt'] },
        image: { id: 'image', x: 10, y: 20, group: false },
        prompt: { id: 'prompt', x: 30, y: 40, group: false },
        other: { id: 'other', x: 80, y: 90, group: false }
    };
    const companions = kernel.dragCompanions(records, { id: 'group', group: true, items: ['image', 'prompt'] }, ['group']);
    assert.deepEqual(local(companions.map(item => item.id)), ['image', 'prompt']);
    const selected = kernel.dragCompanions(records, { id: 'image', group: false, items: [] }, ['image', 'other']);
    assert.deepEqual(local(selected.map(item => item.id)), ['other']);
    const delta = kernel.worldDelta({ x: 140, y: 80 }, { x: 100, y: 40 }, 2);
    assert.equal(delta.x, 20);
    assert.equal(delta.y, 20);
    assert.equal(kernel.snappedDelta(10, 20, 28), 18);
    assert.equal(kernel.passedDeadzone({ x: 3, y: 4 }, { x: 0, y: 0 }, 4), true);
});

test('group expansion includes the container and its siblings', () => {
    const { kernel } = loadKernel('');
    const groups = {
        g: { id: 'g', memberIds: ['a', 'b'] }
    };
    const ids = kernel.expandIds(['a'], function (id) {
        if (id === 'a' || id === 'b') return { groupId: 'g' };
        if (groups[id]) return { memberIds: groups[id].memberIds };
        return null;
    });
    assert.deepEqual(local(ids), ['a', 'g', 'b']);
    const members = kernel.directMembers('g', ['a', 'g', 'nested', 'a'], function (id) {
        return { id: id };
    }, function (member) { return member.id === 'nested' || member.id === 'g'; });
    assert.deepEqual(local(members), ['a']);
});

test('curves keep their endpoints and classic bend', () => {
    const { kernel } = loadKernel('');
    const from = { x: 0, y: 10 };
    const to = { x: 200, y: 50 };
    const classic = kernel.curveBetween(from, to, 'classic');
    assert.equal(classic.d, 'M 0 10 C 90 10, 110 50, 200 50');
    const smart = kernel.curveBetween(from, to, 'smart');
    assert.equal(smart.d, 'M0 10 C 90 10, 110 50, 200 50');
    assert.equal(kernel.curveBetween(from, to, 'straight').d, 'M0 10 L200 50');
    const start = kernel.sampleCurve(from, to, 0, 'classic');
    const end = kernel.sampleCurve(from, to, 1, 'classic');
    assert.equal(start.x, 0);
    assert.equal(start.y, 10);
    assert.equal(end.x, 200);
    assert.equal(end.y, 50);
    assert.deepEqual(local(kernel.edgeAnchor({ x: 4, y: 8, w: 100, h: 40 }, 'out')), { x: 104, y: 28 });
    const hit = kernel.nearestPoint([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }], 40, 0, 48);
    assert.equal(hit.id, 'b');
    assert.equal(kernel.nearestPoint([{ id: 'a', x: 0, y: 0 }], 100, 0, 48), null);
});

test('connection policy rejects cycles and accepts a generator output', () => {
    const { kernel } = loadKernel('');
    const edges = [{ from: 'b', to: 'a' }];
    assert.equal(kernel.reaches(edges, 'b', 'a'), true);
    assert.equal(kernel.classicMayConnect('generator', 'output', {}), true);
    assert.equal(kernel.classicMayConnect('generator', 'video', { mediaOutput: true, acyclic: false }), false);
    assert.equal(kernel.classicMayConnect('generator', 'video', { mediaOutput: true, acyclic: true }), true);
    assert.equal(kernel.classicMayConnect('prompt', 'loop', { loopPrompt: true }), true);
    assert.equal(kernel.classicMayConnect('image', 'llm', {}), true);
    assert.equal(kernel.centerInside({ x: 10, y: 10, w: 20, h: 20 }, { x: 0, y: 0, w: 40, h: 40 }), true);
    assert.equal(kernel.centerInside({ x: 100, y: 10, w: 20, h: 20 }, { x: 0, y: 0, w: 40, h: 40 }), false);
});

test('column layout follows connection depth and dedupes edges', () => {
    const { kernel } = loadKernel('');
    const placed = kernel.columnLayout([
        { id: 'a', x: 0, y: 0, w: 100, h: 40, sortY: 0 },
        { id: 'b', x: 10, y: 20, w: 100, h: 40, sortY: 20 }
    ], [{ from: 'a', to: 'b' }], { minRow: 120, rowGap: 56, minCol: 220, colGap: 180 });
    assert.equal(placed[0].id, 'a');
    assert.equal(placed[0].x, 0);
    assert.equal(placed[0].y, 0);
    assert.equal(placed[1].id, 'b');
    assert.equal(placed[1].x, 400);
    const unique = kernel.uniqueEdges([
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'a', to: 'a', kind: 'flow' }
    ], function (edge) { return edge.from + edge.to + edge.kind; });
    assert.equal(unique.length, 1);
});
