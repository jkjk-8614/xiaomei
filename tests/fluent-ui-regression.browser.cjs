const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7v8AAAAASUVORK5CYII=', 'base64');

async function fixture(t, { blockTheme = false } = {}) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => localStorage.setItem('studio_ui_scale_mode', '100'));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'regression.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            if (blockTheme && url.pathname.endsWith('/fluent.js')) return route.abort();
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice(8));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname.endsWith('.png') || url.pathname.includes('media-preview')) return route.fulfill({ contentType: 'image/png', body: pixel });
        if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [{ id: 'default', name: '默认项目' }] } });
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if (url.pathname === '/api/canvases/fixture') return route.fulfill({ json: { canvas: { id: 'fixture', title: 'UI regression', nodes: [], connections: [], settings: { engine: 'api' } } } });
        return route.fulfill({ json: { providers: [], canvases: [], items: [], files: [], skills: [], categories: [], libraries: [], cases: [], workflows: [], batches: [] } });
    });
    return page;
}

test('business buttons retain native keyboard and disabled behavior when theme module fails', async t => {
    const page = await fixture(t, { blockTheme: true });
    await page.goto('http://regression.test/static/canvas-list.html');
    const add = page.locator('#newProjectBtn');
    assert.equal(await add.evaluate(el => el instanceof HTMLButtonElement), true);
    await add.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#newProjectRow').isVisible(), true);
    await page.locator('#newProjectCancel').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#newProjectRow').isVisible(), false);
    await add.evaluate(el => { el.disabled = true; el.click(); });
    assert.equal(await page.locator('#newProjectRow').isVisible(), false);
});

test('appearance font sizes reach controls and node labels and survive reload', async t => {
    const page = await fixture(t);
    await page.goto('http://regression.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => document.documentElement.dataset.fluentReady === 'true');
    const read = () => page.evaluate(() => {
        const control = getComputedStyle(document.getElementById('assetToggle'));
        const label = document.createElement('span');
        label.className = 'comfy-node-field-label';
        document.body.append(label);
        const size = getComputedStyle(label).fontSize;
        label.remove();
        return { control: parseFloat(control.fontSize), label: parseFloat(size), weight: Number(control.fontWeight), font: control.fontFamily };
    });
    await page.evaluate(() => StudioAppearance.set({ font:'sans', fontSize:'normal', skin:'warm' }));
    const normal = await read();
    assert.ok(normal.weight >= 500);
    assert.ok(normal.font.includes('Microsoft YaHei UI'));
    await page.evaluate(() => StudioAppearance.set({ fontSize:'xlarge' }));
    const large = await read();
    assert.equal(large.control / normal.control, 1.25);
    assert.equal(large.label / normal.label, 1.25);
    await page.evaluate(() => {
        createComfyWorkflowNodeAt({x:650,y:300}, {workflow_ref:'readability.json', workflow_title:'清晰度检查', fields:[
            {id:'strength',name:'降噪强度',type:'number',default:0.5},
            {id:'prompt',name:'提示词',type:'textarea',default:'保留商品细节与文字'}
        ]});
    });
    fs.mkdirSync(path.join(root,'output/fluent-ui-review'),{recursive:true});
    await page.screenshot({path:path.join(root,'output/fluent-ui-review/readability-warm-xlarge.png')});
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.fluentReady === 'true');
    assert.deepEqual(await read(), large);
    await page.evaluate(() => window.postMessage({type:'studio-appearance',appearance:{font:'sans',fontSize:'small',skin:'dark'}}, '*'));
    await page.waitForFunction(() => document.documentElement.classList.contains('studio-theme-dark'));
    assert.ok((await read()).control < normal.control);
});

test('preview navigation stays centered on hover and changes the displayed image', async t => {
    const page = await fixture(t);
    await page.goto('http://regression.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => document.documentElement.dataset.fluentReady === 'true');
    await page.evaluate(() => {
        const node = createNode(0, 0, ['a', 'b'].map(name => ({ url: `/output/${name}.png`, kind: 'image' })), { select: false });
        openImagePreview(node.id, 0);
    });
    const next = page.locator('.preview-nav-btn.next');
    await next.waitFor({ state: 'visible' });
    const before = await next.boundingBox();
    await next.hover();
    await page.waitForTimeout(200);
    const after = await next.boundingBox();
    assert.ok(Math.abs((before.y + before.height / 2) - (after.y + after.height / 2)) < 2, 'hover must not remove positioning transform');
    await next.click();
    await page.waitForFunction(() => document.getElementById('previewCurrentImage').src.includes('b.png'));
});

test('canvas panel toggles preserve visible active state and close using keyboard', async t => {
    const page = await fixture(t);
    await page.goto('http://regression.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => document.documentElement.dataset.fluentReady === 'true');
    const asset = page.locator('#assetToggle');
    const color = () => asset.evaluate(el => getComputedStyle(el).backgroundColor);
    const before = await color();
    await asset.click();
    await page.waitForTimeout(200);
    assert.notEqual(await color(), before, 'open asset panel must visibly mark its toggle active');
    await page.locator('#canvasAgentToggle').click();
    await page.locator('#canvasAgentSettingsToggle').click();
    assert.equal(await page.locator('#canvasAgentSettingsToggle').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#canvasAgentClose').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#canvasAgentPanel').isVisible(), false);
});
