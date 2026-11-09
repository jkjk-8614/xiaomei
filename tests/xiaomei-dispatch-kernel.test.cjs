const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadKernel(search) {
    const sandbox = {
        URLSearchParams,
        URL,
        Headers: class Headers {
            constructor(init) { this.map = {}; if (init) Object.assign(this.map, init); }
            has(key) { return Object.keys(this.map).some(item => item.toLowerCase() === key.toLowerCase()); }
            set(key, value) { this.map[key] = value; }
        },
        document: { documentElement: { setAttribute() {} } },
        location: { search: search || '', href: 'http://127.0.0.1:3000/canvas' },
        localStorage: { getItem() { return null; }, setItem() {} },
        fetch() { return Promise.resolve({ ok: true }); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/xiaomei-dispatch-kernel.js'), 'utf8'), sandbox, { filename: 'xiaomei-dispatch-kernel.js' });
    return sandbox.XiaomeiDispatchKernel;
}

test('dispatch kernel is legacy until the query opts in', () => {
    assert.equal(loadKernel('').isActive(), false);
    assert.equal(loadKernel('?xmDispatch=1').isActive(), true);
});

test('poll decisions cover success, empty output, and failure', () => {
    const kernel = loadKernel('');
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
