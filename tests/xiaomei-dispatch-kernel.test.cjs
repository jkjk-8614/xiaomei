const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadKernel(search, saved) {
    const store = new Map(Object.entries(saved || {}));
    const calls = [];
    const sandbox = {
        URLSearchParams,
        URL,
        Headers: class Headers {
            constructor(init) { this.map = {}; if (init && init.map) Object.assign(this.map, init.map); else if (init) Object.assign(this.map, init); }
            has(key) { return Object.keys(this.map).some(item => item.toLowerCase() === key.toLowerCase()); }
            set(key, value) { this.map[key] = value; }
        },
        document: { documentElement: { setAttribute() {} } },
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
    return { kernel: sandbox.XiaomeiDispatchKernel, store, calls, fetch: sandbox.fetch };
}

test('dispatch kernel defaults to next and a legacy rollback omits the header', async () => {
    const fresh = loadKernel('');
    assert.equal(fresh.kernel.isActive(), true);
    assert.equal(fresh.store.has('xiaomei.dispatchKernel'), false);
    await fresh.fetch('/api/tasks/1');
    assert.equal(fresh.calls[0].init.headers.map['X-Xiaomei-Dispatch'], 'next');
    await fresh.fetch('https://example.com/outside');
    assert.equal(fresh.calls[1].init, undefined);

    const enabled = loadKernel('?xmDispatch=1');
    assert.equal(enabled.kernel.isActive(), true);
    assert.equal(enabled.store.get('xiaomei.dispatchKernel'), 'next');

    const disabled = loadKernel('?xmDispatch=0');
    assert.equal(disabled.kernel.isActive(), false);
    assert.equal(disabled.store.get('xiaomei.dispatchKernel'), 'legacy');
    await disabled.fetch('/api/tasks/1');
    assert.equal(disabled.calls[0].init, undefined);

    const stuck = loadKernel('', { 'xiaomei.dispatchKernel': 'legacy' });
    assert.equal(stuck.kernel.isActive(), false);
    await stuck.fetch('/api/generate');
    assert.equal(stuck.calls[0].init, undefined);
    stuck.kernel.setActive(false);
    assert.equal(stuck.store.get('xiaomei.dispatchKernel'), 'legacy');
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
