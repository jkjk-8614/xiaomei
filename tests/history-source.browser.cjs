const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

test('history counts and source filters include legacy records', async () => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=';
        const records = ['canvas','chat','commerce','online','comfyui'].map((source, index) => ({
            prompt:source + ' result', timestamp:index + 1, type:'online', history_source:source,
            history_group:'online', media_items:[{url:imageUrl,kind:'image'}],
        }));
        records.push({prompt:'legacy canvas result', timestamp:6, type:'online',
            params:{history_source:'canvas'}, history_group:'online', images:[imageUrl]});
        records.push({prompt:'legacy online result', timestamp:7, type:'online', images:[imageUrl]});
        await page.route('**/*', async route => {
            assert.equal(route.request().method(), 'GET');
            const pathname = new URL(route.request().url()).pathname;
            if(pathname === '/api/history') return route.fulfill({json:records});
            if(pathname === '/api/projects') return route.fulfill({json:[]});
            if(pathname.startsWith('/static/')) {
                const filename = path.resolve(__dirname, '..', '.' + pathname);
                return route.fulfill({path:filename});
            }
            return route.fulfill({status:404, body:''});
        });
        await page.goto('http://history.test/static/history.html?manager=1');
        await page.waitForFunction(() => document.getElementById('managerAllCount').textContent === '7');
        for(const [id, count] of Object.entries({Canvas:2,Chat:1,Commerce:1,Comfyui:1})) {
            assert.equal(await page.locator('#manager' + id + 'Count').innerText(), String(count));
        }
        for(const [source, expected] of [
            ['canvas',['canvas result','legacy canvas result']],
            ['chat',['chat result']], ['commerce',['commerce result']],
            ['comfyui',['comfyui result']],
        ]) {
            await page.locator('[data-manager-source="' + source + '"]').click();
            const prompts = await page.evaluate(() => filteredRecords.map(record => record.prompt));
            assert.deepEqual(prompts.sort(), expected.sort());
            assert.equal(await page.locator('#content .card').count(), expected.length);
        }
        await page.locator('[data-manager-source="canvas"]').click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('#content .card img')).every(image => image.complete && image.naturalWidth > 0));
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
