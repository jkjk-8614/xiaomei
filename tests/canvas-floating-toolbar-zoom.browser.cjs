const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('selected image toolbar stays readable while the canvas zooms out', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'toolbar-zoom.test') return route.abort();
        if(url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/fixture.svg') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="pink"/></svg>'});
        if(url.pathname === '/api/canvases/toolbar-fixture') return route.fulfill({json:{canvas:{id:'toolbar-fixture',title:'Toolbar fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],cases:[],workflows:[],batches:[]}});
    });
    await page.goto('http://toolbar-zoom.test/static/smart-canvas.html?id=toolbar-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Toolbar fixture');
    const samples = await page.evaluate(() => {
        const node = createNode(500,300,[{url:'/fixture.svg',kind:'image',natural_w:300,natural_h:300}],{select:true});
        const read = scale => {
            viewport = {x:120,y:80,scale};
            applyViewport();
            const el = world.querySelector(`.image-node[data-id="${CSS.escape(node.id)}"]`);
            const toolbar = el.querySelector('.smart-node-floating-menu');
            const rect = toolbar.getBoundingClientRect();
            const nodeRect = el.getBoundingClientRect();
            const button = toolbar.querySelector('button').getBoundingClientRect();
            return {scale,width:rect.width,height:rect.height,buttonHeight:button.height,zoom:Number(getComputedStyle(toolbar).zoom),gap:nodeRect.top-rect.bottom};
        };
        const samples = [1,0.6,0.25,0.1,0.06,2].map(read);
        render();
        samples.push(read(0.06));
        return samples;
    });
    const baseline = samples[0];
    for(const sample of samples) {
        assert.ok(Math.abs(sample.width-baseline.width)<3, JSON.stringify(sample));
        assert.ok(Math.abs(sample.height-baseline.height)<1, JSON.stringify(sample));
        assert.ok(Math.abs(sample.buttonHeight-24)<1, JSON.stringify(sample));
        assert.ok(Math.abs(sample.zoom-1/sample.scale)<0.001, JSON.stringify(sample));
        assert.ok(Math.abs(sample.gap-8)<1, JSON.stringify(sample));
    }
});
