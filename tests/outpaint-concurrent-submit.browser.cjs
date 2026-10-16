const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('three outpaint editors can submit while earlier generations are pending', {timeout:60000}, async t => {
    const installedEdge = process.platform === 'win32'
        ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync)
        : null;
    const browser = await chromium.launch(installedEdge ? {executablePath:installedEdge, headless:true} : {channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1400,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="red"/></svg>';
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'outpaint-submit.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/canvases/outpaint-submit-fixture'){
            return route.fulfill({json:{canvas:{id:'outpaint-submit-fixture',title:'Outpaint fixture',nodes:[],connections:[],logs:[],settings:{}}}});
        }
        if(url.pathname === '/output/source.svg' || url.pathname === '/api/media-preview'){
            return route.fulfill({contentType:'image/svg+xml',body:image});
        }
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });

    await page.goto('http://outpaint-submit.test/static/smart-canvas.html?id=outpaint-submit-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Outpaint fixture');
    await page.evaluate(() => {
        window.outpaintSourceIds = Array.from({length:3}, (_, index) => createNode(100 + index * 180,100,[
            {url:'/output/source.svg',name:`source-${index}.svg`,kind:'image',natural_w:80,natural_h:60}
        ], {nodeType:'smart-image',select:false}).id);
        window.outpaintPending = [];
        applyImageOutpaint = async () => {
            const id = currentEditImage().node.id;
            closeImageEditor();
            return new Promise(resolve => outpaintPending.push({id,resolve}));
        };
    });

    for(let index=0;index<3;index++){
        await page.evaluate(index => openImageEditor(outpaintSourceIds[index],0), index);
        await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 80);
        await page.evaluate(() => setImageEditMode('outpaint',true));
        assert.equal(await page.locator('#outpaintRunBtn').isDisabled(),false, `image ${index + 1} can submit`);
        await page.locator('#outpaintRunBtn').click();
        await page.waitForFunction(expected => outpaintPending.length === expected, index + 1);
    }

    const submitted = await page.evaluate(() => outpaintPending.map(item => item.id));
    assert.deepEqual(submitted, await page.evaluate(() => outpaintSourceIds));

    // An earlier generation finishing must not clear the newest submission's busy state.
    await page.evaluate(async () => { outpaintPending[0].resolve(true); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(await page.locator('#outpaintRunBtn').isDisabled(),true);
    await page.evaluate(() => openImageEditor(outpaintSourceIds[2],0));
    await page.waitForFunction(() => document.getElementById('cropImage').naturalWidth === 80);
    await page.evaluate(() => setImageEditMode('outpaint',true));
    assert.equal(await page.locator('#outpaintRunBtn').isDisabled(),false);
    await page.evaluate(() => outpaintPending.forEach(item => item.resolve(true)));
    assert.deepEqual(errors,[]);
});
