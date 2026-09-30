const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('4K layered PSD exports in a worker while the page stays responsive', {timeout:90000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.context().route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'layers-stress.test') return route.abort();
        if (url.pathname === '/') return route.fulfill({contentType:'text/html', body:'<!doctype html><script src="/static/vendor/js/ag-psd-seethrough.bundle.js"></script><script src="/static/js/image-layer-psd.js"></script>'});
        const file = path.resolve(root, '.' + url.pathname);
        assert.ok(file.startsWith(root + path.sep));
        return fs.existsSync(file) ? route.fulfill({path:file}) : route.abort();
    });
    await page.goto('http://layers-stress.test');
    const result = await page.evaluate(async () => {
        const width = 4096, height = 2304;
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#efe7da'; ctx.fillRect(0, 0, width, height);
        const original = canvas.toDataURL('image/png');
        const layers = [];
        for (let i = 0; i < 4; i++) {
            if (i) {
                ctx.clearRect(0, 0, width, height);
                const gradient = ctx.createLinearGradient(0, 0, width, height);
                gradient.addColorStop(0, '#aa3322'); gradient.addColorStop(1, '#3377bb');
                ctx.fillStyle = gradient; ctx.fillRect(i * 500, 300, 700, 1300);
            }
            const url = canvas.toDataURL('image/png');
            layers.push({id:'layer-' + i, name:'压力测试图层 ' + i, url, native_width:width, transform:[0,0,width,0,width,height,0,height]});
        }
        canvas.width = canvas.height = 0;
        let ticks = 0, workerTicks = 0;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {super(...args);window.packing = true;}
            terminate() {window.packing = false;return super.terminate();}
        };
        const timer = setInterval(() => {ticks++;if (window.packing) workerTicks++;}, 10);
        const start = performance.now();
        try {
            const bytes = await XiaomeiLayerPsd.build({width, height, original_url:original, layers});
            const elapsed = performance.now() - start;
            const psd = AgPsd.readPsd(bytes, {skipLayerImageData:true, skipCompositeImageData:true, skipThumbnail:true});
            return {elapsed:Math.round(elapsed), bytes:bytes.byteLength, ticks, workerTicks, width:psd.width, height:psd.height, layers:psd.children.length, linked:psd.linkedFiles.length};
        } finally {clearInterval(timer);window.Worker = NativeWorker;}
    });
    assert.equal(result.width, 4096); assert.equal(result.height, 2304);
    assert.equal(result.layers, 5); assert.equal(result.linked, 4);
    assert.ok(result.workerTicks > 3, 'UI timers must run during compression and verification');
    console.log('4K PSD:', JSON.stringify(result));
});
