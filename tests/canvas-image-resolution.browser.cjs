const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {test} = require('node:test');
const {chromium, _electron} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('canvas resolution swaps, failed loads and panning paint remain stable', {timeout:90000}, async t => {
    const useElectron = process.env.CANVAS_TEST_ELECTRON === '1';
    const browser = useElectron
        ? await _electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'fixtures/canvas-render-host.cjs')]})
        : await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = useElectron ? await browser.firstWindow()
        : await browser.newPage({viewport:{width:1600,height:1000}, deviceScaleFactor:1.5});
    page.setDefaultTimeout(8000);
    const errors = [], requests = [], held = [];
    let holdOriginals = true, failOriginals = false;
    page.on('pageerror', error => errors.push(error.message));
    const images = await page.evaluate(() => Object.fromEntries([512,1024,1280,2048].map(edge => {
        const c = document.createElement('canvas');
        c.width = Math.round(edge * 720 / 1280); c.height = edge;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#d34829'; ctx.fillRect(0,0,c.width,c.height);
        return [edge,c.toDataURL('image/png').split(',')[1]];
    })));
    const fulfillImage = (route, edge) => route.fulfill({contentType:'image/png',body:Buffer.from(images[edge],'base64')});
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url()), pathname = url.pathname;
        if(url.hostname !== 'canvas-resolution.test') return route.abort();
        if(pathname.startsWith('/static/')){
            let file = path.resolve(root, '.' + decodeURIComponent(pathname));
            if(!fs.existsSync(file)) file = path.resolve(root,'ComfyUI/web',pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
        }
        if(pathname === '/api/media-preview'){
            requests.push(url.pathname + url.search);
            return fulfillImage(route, Number(url.searchParams.get('w')));
        }
        if(pathname.startsWith('/output/')){
            requests.push(pathname);
            if(holdOriginals){ held.push(route); return; }
            if(failOriginals) return route.abort();
            return fulfillImage(route,1280);
        }
        if(pathname === '/api/canvases/resolution-fixture') return route.fulfill({json:{canvas:{
            id:'resolution-fixture',title:'Resolution fixture',nodes:[],connections:[],logs:[],settings:{}
        }}});
        return route.fulfill({json:{skills:[],categories:[],libraries:[],items:[],workflows:[],batches:[],api_providers:[]}});
    });
    await page.goto('http://canvas-resolution.test/static/smart-canvas.html?id=resolution-fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Resolution fixture');
    await page.evaluate(() => {
        window.fixture = createNode(50,70,['a','b'].map(name => ({url:`/output/${name}.png`,kind:'image',natural_w:720,natural_h:1280})),{select:false});
        fixture.w = 650; fixture.h = 650;
        viewport = {x:0,y:0,scale:1}; render(); applyViewport();
        window.fixtureImage = world.querySelector('.node-body img');
    });
    await page.waitForFunction(() => fixtureImage.complete && fixtureImage.naturalHeight === 512);
    await page.evaluate(() => { viewport.scale = 2; applyViewport(); });
    await page.waitForFunction(() => fixtureImage.naturalHeight === 1024);
    await page.evaluate(() => { viewport.scale = 4; applyViewport(); });
    await page.waitForFunction(() => smartCanvasResolutionLoads === 2);
    await page.waitForTimeout(150);
    assert.equal(held.length,2, 'only two visible originals load concurrently');
    const originalSrc = await page.evaluate(() => fixtureImage.getAttribute('src'));
    assert.match(originalSrc,/media-preview/);
    await page.evaluate(() => { shell.classList.add('panning'); setSmartCanvasPanningMediaMode(true); });
    for(const route of held.splice(0)) await fulfillImage(route,1280);
    await page.waitForFunction(() => smartCanvasResolutionLoads === 0);
    assert.equal(await page.evaluate(() => fixtureImage.getAttribute('src')),originalSrc,'a load completing during pan cannot replace the image');
    holdOriginals = false;
    await page.evaluate(() => { shell.classList.remove('panning'); setSmartCanvasPanningMediaMode(false); });
    await page.waitForFunction(() => fixtureImage.getAttribute('src') === '/output/a.png' && fixtureImage.naturalHeight === 1280);
    await page.evaluate(() => { render(); syncSmartSelectedImageResolution(world); });
    assert.equal(await page.evaluate(() => fixtureImage === world.querySelector('.node-body img')),true,'render preserves the decoded element');
    assert.equal(await page.evaluate(() => fixtureImage.getAttribute('src')),'/output/a.png','selection/render must not force a thumbnail');
    await page.evaluate(() => { viewport.x = -5000; applyViewport(); });
    await page.waitForFunction(() => fixtureImage.getAttribute('src').includes('w=512'));
    assert.deepEqual(await page.evaluate(() => fixture.images.map(img => [img.natural_w,img.natural_h])),[[720,1280],[720,1280]],'preview resolution never overwrites original dimensions');

    failOriginals = true;
    await page.evaluate(() => {
        nodes = []; canvas.nodes = nodes;
        createNode(60,80,[{url:'/output/fail.png',kind:'image',natural_w:720,natural_h:1280}],{select:false});
        viewport = {x:0,y:0,scale:4}; render(); applyViewport();
    });
    await page.waitForTimeout(500);
    assert.ok(requests.includes('/output/fail.png'));
    assert.equal(await page.locator('.node-body img').first().evaluate(img => img.complete && img.naturalHeight === 512),true,'failed high-res load keeps the usable thumbnail');
    const failures = requests.filter(url => url === '/output/fail.png').length;
    await page.evaluate(() => { render(); applyViewport(); });
    await page.waitForTimeout(300);
    assert.equal(requests.filter(url => url === '/output/fail.png').length,failures,'failed target does not retry on every repaint');

    holdOriginals = true; failOriginals = false;
    await page.evaluate(() => {
        nodes = []; canvas.nodes = nodes;
        createNode(40,60,[{url:'/output/stale.png',kind:'image',natural_w:720,natural_h:1280}],{select:false});
        render(); applyViewport(); window.staleImage = world.querySelector('.node-body img');
    });
    await page.waitForFunction(() => smartCanvasResolutionLoads > 0);
    await page.evaluate(() => { nodes = []; canvas.nodes = nodes; render(); });
    for(const route of held.splice(0)) await fulfillImage(route,1280);
    await page.waitForFunction(() => smartCanvasResolutionLoads === 0);
    assert.match(await page.evaluate(() => staleImage.getAttribute('src')),/media-preview/,'removed nodes ignore late responses');
    holdOriginals = false;

    await page.evaluate(() => {
        createNode(50,70,[{url:'/output/huge.png',kind:'image',natural_w:20000,natural_h:35000}],{select:false});
        viewport = {x:0,y:0,scale:8}; render(); applyViewport();
    });
    await page.waitForTimeout(400);
    assert.equal(requests.includes('/output/huge.png'),false,'huge originals must never be decoded in the world');
    assert.ok(requests.some(url => url.includes('w=2048') && url.includes('huge.png')));

    await page.evaluate(() => {
        nodes = []; canvas.nodes = nodes;
        viewport = {x:0,y:0,scale:0.8};
        for(let i=0;i<50;i++){
            const x = (i%10)*300-600, y = Math.floor(i/10)*400-400;
            const node = createNode(x,y,[{url:`/output/paint-${i}.png`,kind:'image',natural_w:720,natural_h:1280}],{select:false});
            node.manualSize = true; node.w = 160; node.h = 284;
        }
        render(); applyViewport();
    });
    await page.waitForFunction(() => [...world.querySelectorAll('.node-body img')].every(img => img.complete && img.naturalWidth > 0));
    assert.equal(await page.evaluate(() => getComputedStyle(world).willChange),'auto');
    for(const scale of [0.55,1.15,0.85]){
        await page.evaluate(scale => {
            shell.classList.add('panning'); setSmartCanvasPanningMediaMode(true);
            viewport = {x:150,y:130,scale}; applyViewport();
            if(scale === 0.85){
                nodes.forEach(node => { node.x += 12000; node.y += 8000; });
                viewport.x -= 12000 * scale; viewport.y -= 8000 * scale;
                render(); applyViewport();
            }
        },scale);
        for(let i=0;i<12;i++) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
            viewport.x += 9; viewport.y += 3; applyViewport(); resolve();
        })));
        const screenshot = useElectron
            ? Buffer.from(await browser.evaluate(async ({BrowserWindow}) => {
                const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
                return image.toPNG().toString('base64');
            }),'base64')
            : await page.screenshot({path:path.join(os.tmpdir(),`xiaomei-canvas-pan-${scale}.png`)});
        const pixels = await page.evaluate(async base64 => {
            const sample = new Image(); sample.src = 'data:image/png;base64,' + base64; await sample.decode();
            const c = document.createElement('canvas'); c.width = sample.width; c.height = sample.height;
            const ctx = c.getContext('2d'); ctx.drawImage(sample,0,0);
            return [...world.querySelectorAll('.node-body img')].flatMap(img => {
                const r = img.getBoundingClientRect(), x = r.left+r.width/2, y = r.top+r.height/2;
                if(x<50 || x>innerWidth-30 || y<100 || y>innerHeight-30
                    || (x>innerWidth-240 && y>innerHeight-190)) return [];
                return [Array.from(ctx.getImageData(Math.round(x*sample.width/innerWidth),Math.round(y*sample.height/innerHeight),1,1).data)];
            });
        },screenshot.toString('base64'));
        assert.ok(pixels.length >= 3, 'paint check must sample several visible images: '+JSON.stringify(await page.evaluate(() => ({viewport,size:[innerWidth,innerHeight],rects:[...world.querySelectorAll('.node-body img')].slice(10,20).map(img=>img.getBoundingClientRect().toJSON())}))));
        assert.ok(pixels.every(pixel => Math.abs(pixel[0]-211)<3 && Math.abs(pixel[1]-72)<3 && Math.abs(pixel[2]-41)<3),`missing image pixels during pan at ${scale}: ${JSON.stringify(pixels)}`);
        await page.evaluate(() => { shell.classList.remove('panning'); setSmartCanvasPanningMediaMode(false); });
    }
    assert.deepEqual(errors,[]);
});
