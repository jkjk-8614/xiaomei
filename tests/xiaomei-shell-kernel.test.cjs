const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadKernel(search, saved) {
    const store = new Map(Object.entries(saved || {}));
    const attrs = {};
    const calls = [];
    const sandbox = {
        URLSearchParams,
        URL,
        Headers: class Headers {
            constructor(init) { this.map = {}; if (init && init.map) Object.assign(this.map, init.map); }
            has(key) { return Object.keys(this.map).some(item => item.toLowerCase() === key.toLowerCase()); }
            set(key, value) { this.map[key] = value; }
        },
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
        location: { search: search || '', href: 'http://127.0.0.1:3000/asset-manager.html' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        },
        fetch(input, init) { calls.push({ input, init }); return Promise.resolve({ ok: true }); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-shell-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-shell-kernel.js' });
    sandbox.XiaomeiShellKernel._calls = calls;
    sandbox._store = store;
    sandbox._attrs = attrs;
    return sandbox;
}

test('asset shell stays on next and does not attach a selection header', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-shell-kernel.js'), 'utf8');
    assert.equal(/xiaomei\.assetKernel|xmAssets|localStorage|X-Xiaomei-Assets/.test(source), false);
    const fresh = loadKernel('');
    assert.equal(fresh.XiaomeiShellKernel.isActive(), true);
    assert.equal(fresh._attrs['data-xm-assets'], 'next');
    assert.equal(fresh.XiaomeiShellKernel.setActive(false), true);
    assert.equal(fresh._store.size, 0);
    await fresh.fetch('/api/asset-library');
    assert.equal(fresh.XiaomeiShellKernel._calls[0].init, undefined);
    await fresh.fetch('/api/history');
    assert.equal(fresh.XiaomeiShellKernel._calls[1].init, undefined);

    for (const search of ['?xmAssets=0', '?xmAssets=legacy', '?xmAssets=1']) {
        const loaded = loadKernel(search);
        assert.equal(loaded.XiaomeiShellKernel.isActive(), true);
        assert.equal(loaded._attrs['data-xm-assets'], 'next');
        assert.equal(loaded._store.size, 0);
        await loaded.fetch('/api/providers');
        assert.equal(loaded.XiaomeiShellKernel._calls[0].init, undefined);
    }

    const stuck = loadKernel('', { 'xiaomei.assetKernel': 'legacy' });
    assert.equal(stuck.XiaomeiShellKernel.isActive(), true);
    assert.equal(stuck.XiaomeiShellKernel.setActive(false), true);
    assert.equal(stuck._store.get('xiaomei.assetKernel'), 'legacy');
});

test('selection, preview, theme, and history decisions', () => {
    const kernel = loadKernel('').XiaomeiShellKernel;
    const picked = new Set();
    assert.equal(kernel.toggleMember(picked, 'a'), true);
    assert.equal(kernel.toggleMember(picked, 'a'), false);
    assert.deepEqual(kernel.bulkAll(['1', '2'], ['1']), ['1', '2']);
    assert.deepEqual(kernel.bulkChoice(['1', '2'], ['1', '2'], '2'), ['1']);
    const zoomed = kernel.previewWheel({ zoom: 1, panX: 0, panY: 0 }, { x: 20, y: 10 }, -1, { min: 1, max: 6 });
    assert.ok(zoomed.zoom > 1);
    assert.notEqual(zoomed.panX, 0);
    const look = kernel.resolveAppearance({ accent: '#3b82f6', skin: 'soft' }, 'light');
    assert.equal(look.accent, '#0e7490');
    assert.equal(look.eyeCare, true);
    assert.equal(kernel.scaleMode('75'), '75');
    assert.equal(kernel.scaleMode('nope'), 'auto');
    assert.equal(kernel.autoScale({ dpr: 2, width: 1600, height: 1000, screenLong: 1600 }), 1);
    assert.equal(kernel.historyDeleteBody('171000').timestamp, '171000');
});

test('asset requests and provider records keep the current fields', () => {
    const sandbox = loadKernel('?xmAssets=0');
    const kernel = sandbox.XiaomeiShellKernel;
    assert.equal(kernel.isActive(), true);
    return sandbox.fetch('/api/asset-library', { headers: { 'Content-Type': 'application/json' } }).then(() => {
        assert.equal(sandbox.XiaomeiShellKernel._calls[0].init.headers['Content-Type'], 'application/json');
        assert.equal(sandbox.XiaomeiShellKernel._calls[0].init.headers['X-Xiaomei-Assets'], undefined);
    }).then(() => {
        const saved = kernel.assetBatch('save', { libraryId: 'default', categoryId: 'scenes', url: '/assets/a.png', name: '衬衫' });
        assert.equal(saved.library_id, 'default');
        assert.equal(saved.category_id, 'scenes');
        const prepared = kernel.prepareProviders([
            { id: 'tmp', _idDraft: true, name: '商店', base_url: 'https://api.example.com/v1', protocol: 'openai', image_models: ['a', 'a', ''], chat_models: [], video_models: [] },
            { id: 'jimeng', name: '即梦', protocol: 'jimeng', base_url: 'https://unused.example', image_models: ['jimeng-image-2k'], chat_models: [], video_models: [] }
        ], { selectedId: 'tmp', displayName: (raw) => raw });
        assert.equal(prepared.providers[0].id, 'example-com');
        assert.deepEqual(Array.from(prepared.providers[0].image_models), ['a']);
        assert.equal(prepared.providers[1].base_url, '');
        assert.ok(prepared.providers[1].image_models.includes('5.0'));
        assert.equal(prepared.providers[1].image_models.includes('jimeng-image-2k'), false);
        const wire = kernel.wireProviders(prepared.providers);
        assert.equal(wire[0].primary, false);
        assert.equal(wire[0].image_generation_endpoint, '');
        const duplicate = kernel.prepareProviders([
            { id: 'shop', name: '甲' },
            { id: 'shop', name: '乙' }
        ], {});
        assert.equal(duplicate.error, 'duplicate');
        const managed = kernel.prepareProviders([
            { id: 'codex', protocol: 'codex', model_selection_managed: true, image_models: ['custom-one'], chat_models: ['gpt-5.5'], video_models: ['gone'] }
        ], {});
        assert.deepEqual(Array.from(managed.providers[0].image_models), ['custom-one']);
        assert.deepEqual(Array.from(managed.providers[0].video_models), []);
        const rows = kernel.folderRows({ id: '__root__', children: [{ id: 'looks', name: '造型', items: [{ id: 'v', kind: 'video' }, { id: 'p', kind: 'image' }] }] }, [{ id: 'root-image', kind: 'image' }]);
        assert.equal(rows[0].items.length, 1);
        assert.equal(rows[1].items[0].id, 'p');
        assert.equal(kernel.matches({ name: '蓝裙', kind: 'image', width: 100, height: 100, classification: { tags: ['棉'] } }, { query: '蓝裙', tags: '棉', shape: 'square' }), true);
    });
});
