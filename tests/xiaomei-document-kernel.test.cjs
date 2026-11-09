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
        JSON,
        Object,
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
        location: { search: search || '' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-document-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-document-kernel.js' });
    return { kernel: sandbox.XiaomeiDocumentKernel, store, attrs };
}

test('document kernel stays on next and ignores legacy switches', () => {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-document-kernel.js'), 'utf8');
    assert.equal(/xiaomei\.documentKernel|xmDocument|localStorage/.test(source), false);
    const fresh = loadKernel('');
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.attrs['data-xm-document'], 'next');
    assert.equal(fresh.kernel.setActive(false), true);
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.store.size, 0);
    for (const search of ['?xmDocument=0', '?xmDocument=legacy', '?xmDocument=next']) {
        const loaded = loadKernel(search);
        assert.equal(loaded.kernel.isActive(), true);
        assert.equal(loaded.attrs['data-xm-document'], 'next');
        assert.equal(loaded.store.size, 0);
    }
    const stuck = loadKernel('', { 'xiaomei.documentKernel': 'legacy' });
    assert.equal(stuck.kernel.isActive(), true);
    assert.equal(stuck.kernel.setActive(false), true);
    assert.equal(stuck.store.get('xiaomei.documentKernel'), 'legacy');
});

test('old smart files gain viewport, connections, and current node types', () => {
    const { kernel } = loadKernel('');
    const adopted = kernel.adopt({
        id: 'old',
        title: '旧项目',
        nodes: [
            { id: 'box', type: 'smart-container', inputImage: { url: '/assets/a.png', name: 'a' }, steps: 4 },
            { id: 'clip', type: 'smart-paint', title: '绘画', runSettings: { apiKind: 'video' } },
            { id: 'plain', type: 'smart-image', x: 12, y: 8 },
            { id: 'made', type: 'smart-image', runAt: 5, promptDraftText: 'keep', customFlag: true },
            { id: 'ghost', type: 'smart-image' }
        ]
    }, {
        profile: 'smart',
        dropNodeIds: ['ghost'],
        labels: { upload: '导入', paint: '绘画', video: '视频', group: 'Group', image: 'Image' }
    });
    const doc = adopted.document;
    assert.equal(doc.connections.length, 0);
    assert.equal(doc.viewport.x, 0);
    assert.equal(doc.viewport.y, 0);
    assert.equal(doc.viewport.scale, 1);
    assert.equal(doc.nodes.find(node => node.id === 'box').type, 'smart-image');
    assert.equal(doc.nodes.find(node => node.id === 'box').images[0].url, '/assets/a.png');
    assert.equal(doc.nodes.find(node => node.id === 'box').steps, undefined);
    assert.equal(doc.nodes.find(node => node.id === 'clip').type, 'smart-video');
    assert.equal(doc.nodes.find(node => node.id === 'clip').title, '视频');
    assert.equal(doc.nodes.find(node => node.id === 'plain').type, 'smart-upload');
    assert.equal(doc.nodes.find(node => node.id === 'made').type, 'smart-image');
    assert.equal(doc.nodes.find(node => node.id === 'made').customFlag, true);
    assert.equal(doc.nodes.find(node => node.id === 'ghost'), undefined);
    assert.equal(adopted.migrations.video, 1);
    assert.ok(adopted.migrations.upload >= 1);
});

test('classic save strips runtime fields and keeps the viewport', () => {
    const { kernel } = loadKernel('');
    const body = kernel.saveBody({
        title: 'Board',
        nodes: [{ id: 'n', type: 'msgen', x: 3, y: 4, running: true, _ltxEditor: {}, msRatio: 'wide' }],
        connections: [{ from: 'n', to: 'n' }, { from: 'n', to: 'out', kind: 'flow' }, { from: 'n', to: 'out', kind: 'flow' }],
        viewport: { x: 10, y: 20, scale: 0 }
    }, { profile: 'classic', fallbackIcon: '🧩', clientId: 'me', baseUpdatedAt: 8 });
    assert.equal(body.nodes[0].type, 'generator');
    assert.equal(body.nodes[0].ratio, 'wide');
    assert.equal(body.nodes[0].running, undefined);
    assert.equal(body.connections.length, 1);
    assert.equal(body.viewport.scale, 1);
    assert.equal(body.client_id, 'me');
    assert.equal(body.base_updated_at, 8);
    const again = kernel.adopt(body, { profile: 'classic' });
    assert.equal(again.document.nodes[0].type, 'generator');
    assert.equal(again.document.nodes[0].x, 3);
    assert.equal(local(again.document.viewport).x, 10);
});
