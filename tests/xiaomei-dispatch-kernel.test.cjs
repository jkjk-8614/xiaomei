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
            constructor(init) { this.map = {}; if (init && init.map) Object.assign(this.map, init.map); else if (init) Object.assign(this.map, init); }
            has(key) { return Object.keys(this.map).some(item => item.toLowerCase() === key.toLowerCase()); }
            set(key, value) { this.map[key] = value; }
        },
        document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
        location: { search: search || '', href: 'http://127.0.0.1:3000/canvas' },
        localStorage: {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, value) { store.set(key, String(value)); }
        },
        fetch(input, init) { calls.push({ input, init }); return Promise.resolve({ ok: true }); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-dispatch-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-dispatch-kernel.js' });
    return { kernel: sandbox.XiaomeiDispatchKernel, store, calls, fetch: sandbox.fetch, attrs };
}

test('dispatch kernel stays on next and does not attach a selection header', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-dispatch-kernel.js'), 'utf8');
    assert.equal(/xiaomei\.dispatchKernel|xmDispatch|localStorage|X-Xiaomei-Dispatch/.test(source), false);
    const fresh = loadKernel('');
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.attrs['data-xm-dispatch'], 'next');
    assert.equal(fresh.kernel.setActive(false), true);
    assert.equal(fresh.store.size, 0);
    await fresh.fetch('/api/tasks/1', { headers: { 'Content-Type': 'application/json' } });
    assert.equal(fresh.calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(fresh.calls[0].init.headers['X-Xiaomei-Dispatch'], undefined);
    await fresh.fetch('https://example.com/outside');
    assert.equal(fresh.calls[1].init, undefined);

    for (const search of ['?xmDispatch=0', '?xmDispatch=legacy', '?xmDispatch=1']) {
        const loaded = loadKernel(search);
        assert.equal(loaded.kernel.isActive(), true);
        assert.equal(loaded.attrs['data-xm-dispatch'], 'next');
        assert.equal(loaded.store.size, 0);
        await loaded.fetch('/api/generate');
        assert.equal(loaded.calls[0].init, undefined);
    }

    const stuck = loadKernel('', { 'xiaomei.dispatchKernel': 'legacy' });
    assert.equal(stuck.kernel.isActive(), true);
    assert.equal(stuck.kernel.setActive(false), true);
    assert.equal(stuck.store.get('xiaomei.dispatchKernel'), 'legacy');
    await stuck.fetch('/api/generate');
    assert.equal(stuck.calls[0].init, undefined);
});

test('poll decisions cover success, empty output, and failure', () => {
    const { kernel } = loadKernel('');
    assert.equal(kernel.pollDecision({ status: 'succeeded', result: { images: [{ url: 'https://img/a.png' }] } }).state, 'succeeded');
    assert.equal(kernel.pollDecision({ status: 'succeeded', result: {} }).state, 'empty');
    assert.equal(kernel.pollDecision({ status: 'failed', error: 'quota', upstream_terminal_error: true }).terminal, true);
    assert.equal(kernel.pollDecision({ status: 'jimeng_pending' }).state, 'jimeng_pending');
    assert.equal(kernel.pollDecision({ status: 'queued' }).state, 'pending');
    const request = kernel.taskRequest('video', { providerId: 'shop', model: 'm', prompt: 'hi', projectId: 'default' });
    assert.equal(request.kind, 'video');
    assert.equal(request.provider_id, 'shop');
    assert.equal(request.history_source, 'canvas');
});
