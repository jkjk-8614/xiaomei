const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium, _electron} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('batch overview keeps sharp results through zoom, status updates and scrolling', {timeout:60000}, async t => {
    const electron = process.env.CANVAS_TEST_ELECTRON === '1';
    const browser = electron
        ? await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'fixtures/canvas-render-host.cjs')]})
        : await chromium.launch({channel:'msedge',headless:true});
    t.after(() => browser.close());
    const page = electron ? await browser.firstWindow()
        : await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1.5});
    page.setDefaultTimeout(8000);
    const errors = [], requests = [];
    let failOriginals = false;
    page.on('pageerror', error => errors.push(error.message));
    const images = await page.evaluate(() => Object.fromEntries([512,1024,1280,2048].map(edge => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(edge * 720 / 1280); canvas.height = edge;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle = '#111'; ctx.font = `${Math.round(edge/32)}px sans-serif`;
        for(let y=50;y<edge;y+=60) ctx.fillText('商品细节 · 清晰文字 123',12,y);
        return [edge,canvas.toDataURL('image/png').split(',')[1]];
    })));
    const fulfill = (route,edge) => route.fulfill({contentType:'image/png',body:Buffer.from(images[edge],'base64')});
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'batch-resolution.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root,'.'+decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root+path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(url.pathname === '/api/media-preview'){
            requests.push(url.pathname+url.search);
            return fulfill(route,Number(url.searchParams.get('w')));
        }
        if(url.pathname.startsWith('/output/')){
            requests.push(url.pathname);
            return failOriginals ? route.abort() : fulfill(route,1280);
        }
        if(url.pathname === '/api/canvases/batch-resolution') return route.fulfill({json:{canvas:{
            id:'batch-resolution',title:'Batch resolution',nodes:[],connections:[],logs:[],settings:{}
        }}});
        return route.fulfill({json:{api_providers:[],skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[]}});
    });
    await page.goto('http://batch-resolution.test/static/smart-canvas.html?id=batch-resolution');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'batch-resolution');
    await page.evaluate(() => {
        window.loopFixture = createLoopNode(0,0,{batchUiMode:'paired'});
        loopFixture.batchDetailModeV2 = true;
        loopFixture.batchOverviewOpen = true;
        loopFixture.batchSourceNodeId = 'local';
        loopFixture.batchSourceText = '保留产品与文字细节';
        loopFixture.aiSplitPrompts = Array.from({length:7},(_,i) => ({title:`第 ${i+1} 屏`,prompt:'保留产品与文字细节'}));
        const targets = ensureSmartLoopDetailPaintNodes(loopFixture,7);
        targets.forEach((paint,i) => {
            paint.batchOverviewOnly = true;
            paint.images = [{url:'/output/input.png',loopInputPreview:true},
                {url:`/output/${i === 1 ? 0 : i}.png`,kind:'image',natural_w:720,natural_h:1280}];
        });
        loopFixture.batchOverviewOffset = {x:0,y:0};
        loopFixture.batchOverviewSize = {width:730,height:400};
        selectedId = ''; selectedIds = [];
        viewport = {x:70,y:70,scale:1}; render(); applyViewport();
        window.overviewImage = world.querySelector('.batch-screen-media img');
    });
    await page.waitForFunction(() => overviewImage.complete && overviewImage.naturalHeight === 512);
    assert.equal(await page.evaluate(() => overviewImage.parentElement.dataset.refImageIndex),'1');
    await page.evaluate(() => { viewport.scale=2; applyViewport(); });
    await page.waitForFunction(() => overviewImage.naturalHeight === 1024);
    await page.evaluate(() => { viewport.scale=4; applyViewport(); });
    await page.waitForFunction(() => overviewImage.getAttribute('src') === '/output/0.png' && overviewImage.naturalHeight === 1280);
    assert.equal(await page.evaluate(() => overviewImage.naturalHeight),1280);
    await page.evaluate(() => {
        window.duplicateImage = world.querySelectorAll('.batch-screen-media img')[1];
        loopFixture.aiSplitPrompts[0].title = '更新后的标题';
        render({nodeIds:[loopFixture.id]});
    });
    assert.equal(await page.evaluate(() => overviewImage === world.querySelector('.batch-screen-media img')),true);
    assert.equal(await page.evaluate(() => duplicateImage === world.querySelectorAll('.batch-screen-media img')[1]),true,
        'duplicate source URLs keep separate decoded elements');
    assert.equal(await page.evaluate(() => overviewImage.getAttribute('src')),'/output/0.png',
        'status updates never replace high resolution with a 512px preview');

    await page.evaluate(() => {
        const grid = world.querySelector('.batch-overview-grid');
        grid.scrollTop = grid.scrollHeight;
    });
    await page.waitForFunction(() => {
        const img = world.querySelectorAll('.batch-screen-media img')[6];
        return img.getAttribute('src') === '/output/6.png' && img.naturalHeight === 1280;
    });
    assert.ok(requests.includes('/output/6.png'),'scrolling upgrades newly visible results without a viewport change');

    failOriginals = true;
    await page.evaluate(() => {
        const paint = smartLoopDetailPaintNodes(loopFixture)[6];
        paint.images[1] = {...paint.images[1],url:'/output/failed.png'};
        render({nodeIds:[loopFixture.id]});
    });
    await page.waitForFunction(() => smartCanvasResolutionLoads === 0
        && world.querySelectorAll('.batch-screen-media img')[6].dataset.originalSrc === '/output/failed.png');
    await page.waitForTimeout(450);
    const last = page.locator('.batch-screen-media img').nth(6);
    assert.ok(requests.includes('/output/failed.png'));
    assert.equal(await last.evaluate(img => img.complete && img.naturalHeight === 512),true,
        'failed high resolution leaves the usable preview visible');
    const failures = requests.filter(url => url === '/output/failed.png').length;
    await page.evaluate(() => { render(); applyViewport(); });
    await page.waitForTimeout(300);
    assert.equal(requests.filter(url => url === '/output/failed.png').length,failures);

    await page.evaluate(() => {
        viewport = {x:50,y:80,scale:1.5}; applyViewport();
        world.querySelector('.batch-overview-grid').scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(os.tmpdir(),`xiaomei-batch-resolution-${electron?'electron':'edge'}.png`)});
    assert.deepEqual(errors,[]);
});
