const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const sizes = {wide:[900,300], tall:[300,900], square:[600,600], long:[80,1600]};

async function fixture(t){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1000, height:700}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'input-hover.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname.startsWith('/fixture-images/') || url.pathname.startsWith('/assets/') || url.pathname === '/api/media-preview'){
            const source = new URL(url.searchParams.get('url') || url.pathname, url.origin);
            const name = path.basename(source.pathname, '.png');
            if(name === 'broken') return route.fulfill({status:404, body:''});
            if(name === 'slow' && url.searchParams.get('w') === '768') await new Promise(resolve => setTimeout(resolve, 350));
            const [width,height] = sizes[name] || sizes.square;
            return route.fulfill({contentType:'image/svg+xml', body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#30a9b3"/></svg>`});
        }
        if(url.pathname === '/api/canvases/fixture') return route.fulfill({json:{canvas:{id:'fixture', title:'Hover preview', nodes:[], connections:[], logs:[], settings:{}}}});
        return route.fulfill({json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto('http://input-hover.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture');
    await page.addStyleTag({content:'#composer {display:none !important}'});
    await page.evaluate(() => {
        const refs = ['wide','tall','square','long','slow','broken'].map(name => ({url:`/${name === 'slow' ? 'assets' : 'fixture-images'}/${name}.png`, kind:'image', name, manualAdded:true}));
        nodes = [
            {id:'source', type:'smart-upload', x:-1000, y:100, images:refs},
            {id:'agent', type:'smart-agent', x:80, y:100, w:440, h:550, images:[], manualInputRefs:refs},
            {id:'prompt', type:'smart-prompt', x:650, y:100, images:[], text:'Example', manualInputRefs:refs.slice(0,3)}
        ];
        canvas.connections = [{from:'source',to:'agent',kind:'input'}, {from:'source',to:'prompt',kind:'input'}];
        selectedId = '';
        viewport = {x:0, y:0, scale:1};
        applyViewport();
        render();
    });
    return {page, errors};
}

async function checkPreview(page, thumb, name){
    await thumb.hover({timeout:5000});
    await page.waitForFunction(name => {
        const preview = document.querySelector('.paint-input-ref-hover');
        return preview && !preview.hidden && preview.querySelector('img').dataset.refUrl.endsWith(`/${name}.png`);
    }, name, {timeout:5000});
    const geometry = await page.locator('.paint-input-ref-hover').evaluate(el => {
        const rect = el.getBoundingClientRect();
        const image = el.querySelector('img').getBoundingClientRect();
        const bounds = shell.getBoundingClientRect();
        return {left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom, ratio:image.width/image.height,
            bounds:{left:Math.max(0,bounds.left), top:Math.max(0,bounds.top), right:Math.min(innerWidth,bounds.right), bottom:Math.min(innerHeight,bounds.bottom)},
            position:getComputedStyle(el).position, pointerEvents:getComputedStyle(el).pointerEvents};
    });
    const expected = sizes[name][0]/sizes[name][1];
    assert.ok(Math.abs(geometry.ratio/expected - 1) < .01, `${name} preserves its ratio: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.left >= geometry.bounds.left + 7 && geometry.top >= geometry.bounds.top + 7 && geometry.right <= geometry.bounds.right - 7 && geometry.bottom <= geometry.bounds.bottom - 7, JSON.stringify(geometry));
    assert.equal(geometry.position, 'fixed');
    assert.equal(geometry.pointerEvents, 'none');
    return geometry;
}

test('node references keep image proportions and layout in both themes and at different zoom levels', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    const thumbs = page.locator('[data-id="agent"] [data-input-preview-url]');
    const layout = () => page.locator('.image-node').evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect();
        return {id:el.dataset.id, x:rect.x, y:rect.y, width:rect.width, height:rect.height};
    }));
    for(const dark of [false,true]){
        await page.evaluate(dark => StudioAppearance.apply({skin:dark ? 'dark' : 'minimal'}), dark);
        for(const scale of [.55,1,1.5]){
            await page.evaluate(scale => { viewport.scale = scale; applyViewport(); }, scale);
            const before = await layout();
            for(const [index,name] of ['wide','tall','square','long'].entries()) await checkPreview(page, thumbs.nth(index), name);
            assert.deepEqual(await layout(), before, 'hover never changes any node layout');
            await page.mouse.move(5,690);
            await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});
        }
    }
    await page.evaluate(() => { viewport.scale = 1; applyViewport(); });
    await checkPreview(page, page.locator('[data-id="prompt"] [data-input-preview-url]').first(), 'wide');
    const artifacts = path.join(os.tmpdir(), 'xiaomei-input-hover-preview');
    fs.mkdirSync(artifacts, {recursive:true});
    await page.screenshot({path:path.join(artifacts,'node-preview.png')});
    assert.deepEqual(errors, []);
    console.log(`Preview image: ${path.join(artifacts,'node-preview.png')}`);
});

test('preview fits canvas edges and a smaller canvas viewport', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    const thumb = page.locator('[data-id="agent"] [data-input-preview-url]').first();
    await page.addStyleTag({content:'#canvasNavPanel {display:none !important}'});
    for(const [x,y] of [[10,115],[940,115],[10,640],[940,640]]){
        await page.mouse.move(500,690);
        await thumb.evaluate((el, [x,y]) => {
            const rect = el.getBoundingClientRect();
            viewport.x += x - rect.left;
            viewport.y += y - rect.top;
            applyViewport();
        }, [x,y]);
        await checkPreview(page, thumb, 'wide');
    }
    await page.setViewportSize({width:640,height:480});
    await page.evaluate(() => {
        shell.style.width = '500px';
        shell.style.height = '360px';
        shell.style.margin = '50px';
        viewport = {x:0,y:0,scale:1};
        applyViewport();
    });
    await checkPreview(page, thumb, 'wide');
    await checkPreview(page, page.locator('[data-id="agent"] [data-input-preview-url]').nth(1), 'tall');
    assert.deepEqual(errors, []);
});

test('preview closes on gestures, removal and failed or late image loads', {timeout:40000}, async t => {
    const {page, errors} = await fixture(t);
    const thumbs = page.locator('[data-id="agent"] [data-input-preview-url]');
    await checkPreview(page, thumbs.first(), 'wide');
    await page.mouse.down();
    await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await page.mouse.move(5,690);
    await checkPreview(page, thumbs.first(), 'wide');
    await page.evaluate(() => { viewport.scale = .8; applyViewport(); });
    await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});
    await page.mouse.move(5,690);
    await checkPreview(page, thumbs.first(), 'wide');
    await page.setViewportSize({width:980,height:680});
    await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});
    await page.mouse.move(5,670);
    const lateLoad = page.waitForResponse(response => response.url().includes('/api/media-preview?w=768') && response.url().includes('slow.png'));
    await thumbs.nth(4).hover();
    await page.mouse.move(5,670);
    await lateLoad;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.paint-input-ref-hover').isVisible(), false, 'late loads cannot reopen the preview');
    await thumbs.nth(4).hover();
    await checkPreview(page, thumbs.nth(1), 'tall');
    await page.waitForTimeout(450);
    assert.ok((await page.locator('.paint-input-ref-hover img').getAttribute('data-ref-url')).endsWith('/tall.png'), 'switching references does not show a stale image');
    await thumbs.nth(5).hover();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.paint-input-ref-hover').isVisible(), false, 'failed loads do not leave an empty popup');
    await checkPreview(page, thumbs.first(), 'wide');
    await page.evaluate(() => { nodes = nodes.filter(node => node.id !== 'agent'); render(); });
    await page.locator('.paint-input-ref-hover').waitFor({state:'hidden'});
    assert.deepEqual(errors, []);
});
