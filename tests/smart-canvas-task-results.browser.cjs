const assert = require('node:assert/strict');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

(async () => {
    const target = process.env.CANVAS_TEST_URL;
    assert.ok(target, 'Set CANVAS_TEST_URL to a canvas with saved pending image tasks');
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1440,height:1000}});
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Exercise saved tasks without writing the user's canvas or submitting generation.
        await page.route('**/*', async route => {
            if(!['GET','HEAD'].includes(route.request().method())) {
                return route.fulfill({status:200, contentType:'application/json', body:'{}'});
            }
            return route.continue();
        });
        await page.routeWebSocket('**/*', socket => socket.close());
        await page.goto(target);
        await page.waitForFunction(() => typeof nodes !== 'undefined' && nodes.some(node => node.pendingTasks?.length));
        const initial = await page.evaluate(() => {
            const target = nodes.find(node => node.pendingTasks?.length);
            window.testNodeId = target.id;
            window.testTaskCount = target.pendingTasks.length;
            // An undo or canvas merge replaces the node while the requests are active.
            nodes = structuredClone(nodes);
            return {id:target.id, tasks:target.pendingTasks.length};
        });
        await page.waitForFunction(() => {
            const node = nodes.find(item => item.id === window.testNodeId);
            return node && !node.pending && !node.pendingTasks?.length && node.images?.length >= window.testTaskCount;
        }, null, {timeout:60000});
        const result = await page.evaluate(async () => {
            const node = nodes.find(item => item.id === window.testNodeId);
            const loaded = await Promise.all(node.images.map(item => new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve({width:image.naturalWidth, height:image.naturalHeight});
                image.onerror = () => resolve(null);
                image.src = item.url;
            })));
            const element = document.querySelector(`[data-id="${node.id}"]`);
            return {images:node.images.length, pending:node.pending, loaded, visible:!!element, text:element?.textContent};
        });
        assert.equal(result.images, initial.tasks);
        assert.equal(result.pending, 0);
        assert.ok(result.visible);
        assert.ok(result.loaded.every(item => item?.width > 0 && item?.height > 0));
        assert.ok(!result.text.includes('92%'));
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({images:result.images, pending:result.pending, loaded:result.loaded, pageErrors:errors}));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode=1; });
