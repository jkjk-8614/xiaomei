const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('canvas Agent uses a bottom-right orb and keeps the existing panel toggle accessible', { timeout: 40000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    let releaseAnswer;
    let failAnswer = false;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'canvas-agent-orb.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!fs.existsSync(file)) file = path.resolve(root, 'ComfyUI/web', url.pathname.slice('/static/'.length));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [
            { id: 'test', name: 'Test', enabled: true, chat_models: ['test-chat'], image_models: [] }
        ], comfy_instances: [] } });
        if (url.pathname === '/api/canvas-llm') {
            await new Promise(resolve => { releaseAnswer = resolve; });
            return failAnswer ? route.fulfill({ status: 400, json: { detail: '模拟请求失败' } })
                : route.fulfill({ json: { text: '当前画布没有节点。', model: 'test-chat' } });
        }
        if (url.pathname === '/api/canvas-share/session') return route.fulfill({ json: { canvas_id: 'orb', role: 'viewer' } });
        if (url.pathname === '/api/canvases/orb') return route.fulfill({ json: { canvas: {
            id: 'orb', title: 'Orb test', nodes: [], connections: [], logs: [], settings: { engine: 'api' }
        } } });
        return route.fulfill({ json: { providers: [], skills: [], categories: [], workflows: [], items: [], canvases: [] } });
    });

    await page.goto('http://canvas-agent-orb.test/static/smart-canvas.html?id=orb');
    await page.waitForFunction(() => document.getElementById('smartTitle').textContent === 'Orb test');

    const toggle = page.locator('#canvasAgentToggle');
    const initial = await toggle.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const orb = element.querySelector('.canvas-agent-orb');
        return {
            position: style.position,
            display: style.display,
            width: rect.width,
            height: rect.height,
            right: window.innerWidth - rect.right,
            bottom: window.innerHeight - rect.bottom,
            labelWidth: element.querySelector('.canvas-agent-toggle-label')?.getBoundingClientRect().width || 0,
            hasOrb: Boolean(orb),
            hasEyes: orb?.querySelectorAll('.canvas-agent-orb-eye').length || 0,
            expanded: element.getAttribute('aria-expanded')
        };
    });
    assert.equal(initial.position, 'fixed');
    assert.ok(initial.width >= 60 && initial.height >= 60, 'orb entry should remain a large touch target');
    assert.ok(initial.right >= 12 && initial.right <= 40, 'orb should be anchored near the right edge');
    assert.ok(initial.bottom >= 12 && initial.bottom <= 40, 'orb should be anchored near the bottom edge');
    assert.equal(initial.labelWidth, 1, 'the text label remains available to assistive technology but is visually hidden');
    assert.equal(initial.hasOrb, true);
    assert.equal(initial.hasEyes, 2);
    assert.equal(initial.expanded, 'false');
    const toolbar = await page.evaluate(() => ['assetToggle', 'smartLogToggle', 'smartShortcutToggle', 'smartWorkflowToggle'].map(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { id, right: window.innerWidth - rect.right };
    }));
    assert.deepEqual(toolbar.map(item => item.right), [22, 130, 238, 346], 'top tools should use the right side without an Agent slot');

    const orbBox = await toggle.locator('.canvas-agent-orb').boundingBox();
    assert.ok(orbBox, 'orb should expose a measurable visual surface');
    await page.mouse.move(orbBox.x + orbBox.width * .18, orbBox.y + orbBox.height * .2);
    await page.waitForFunction(() => {
        const orb = document.querySelector('.canvas-agent-orb');
        return parseFloat(getComputedStyle(orb).getPropertyValue('--agent-eye-x')) < -1
            && parseFloat(getComputedStyle(orb).getPropertyValue('--agent-eye-y')) < -1;
    });
    const tracking = await toggle.locator('.canvas-agent-orb').evaluate(orb => ({
        x: getComputedStyle(orb).getPropertyValue('--agent-eye-x'),
        y: getComputedStyle(orb).getPropertyValue('--agent-eye-y')
    }));
    assert.ok(parseFloat(tracking.x) < -1, 'eyes should look toward the mouse horizontally');
    assert.ok(parseFloat(tracking.y) < -1, 'eyes should look toward the mouse vertically');

    await toggle.click();
    const opened = await page.locator('#canvasAgentPanel').evaluate(panel => ({
        open: panel.classList.contains('open'),
        toggleExpanded: document.getElementById('canvasAgentToggle').getAttribute('aria-expanded'),
        toggleActive: document.getElementById('canvasAgentToggle').classList.contains('active'),
        togglePointerEvents: getComputedStyle(document.getElementById('canvasAgentToggle')).pointerEvents
    }));
    assert.equal(opened.open, true);
    assert.equal(opened.toggleExpanded, 'true');
    assert.equal(opened.toggleActive, true);
    assert.equal(opened.togglePointerEvents, 'none', 'the hidden orb must not sit above the open Agent panel');

    await page.locator('#canvasAgentClose').click();
    const closed = await toggle.evaluate(element => ({
        panelOpen: document.getElementById('canvasAgentPanel').classList.contains('open'),
        expanded: element.getAttribute('aria-expanded'),
        active: element.classList.contains('active'),
        pointerEvents: getComputedStyle(element).pointerEvents
    }));
    assert.equal(closed.panelOpen, false);
    assert.equal(closed.expanded, 'false');
    assert.equal(closed.active, false);
    assert.notEqual(closed.pointerEvents, 'none');

    await page.mouse.move(0, 0);
    await toggle.focus();
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#canvasAgentInput').evaluate(el => el === document.activeElement), true);
    await page.locator('#canvasAgentClose').focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);

    for (const skin of ['minimal', 'dark']) {
        await page.evaluate(skin => StudioAppearance.set({ skin, accent: '#bb44cc' }), skin);
        assert.equal(await toggle.locator('.canvas-agent-orb').isVisible(), true);
        assert.equal(await toggle.locator('.canvas-agent-orb-eye').first().isVisible(), true);
        assert.match(await toggle.evaluate(el => getComputedStyle(el).getPropertyValue('--agent-orb-accent')), /\S+/);
        const bounds = await page.evaluate(() => ({
            orb: document.getElementById('canvasAgentToggle').getBoundingClientRect().toJSON(),
            map: document.getElementById('minimap').getBoundingClientRect().toJSON(),
            panel: document.getElementById('canvasNavPanel').getBoundingClientRect().toJSON()
        }));
        const overlaps = !(bounds.map.right <= bounds.orb.left || bounds.map.left >= bounds.orb.right || bounds.map.bottom <= bounds.orb.top || bounds.map.top >= bounds.orb.bottom);
        assert.equal(overlaps, false, `minimap must not overlap the orb (${JSON.stringify(bounds)})`);
        if (process.env.XIAOMEI_ORB_QA_DIR) {
            fs.mkdirSync(process.env.XIAOMEI_ORB_QA_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.XIAOMEI_ORB_QA_DIR, `desktop-${skin}.png`) });
        }
    }

    await toggle.click();
    for (const fail of [false, true]) {
        failAnswer = fail;
        releaseAnswer = undefined;
        await page.locator('#canvasAgentInput').fill('当前画布有哪些节点？');
        await page.locator('#canvasAgentSend').click();
        await page.waitForFunction(() => document.getElementById('canvasAgentToggle').classList.contains('is-running'));
        await page.locator('#canvasAgentClose').click();
        assert.equal(await toggle.evaluate(el => el.dataset.agentState), 'running');
        await page.waitForFunction(() => document.getElementById('canvasAgentComposerStatusText').textContent === '正在读取画布');
        while (!releaseAnswer) await new Promise(resolve => setImmediate(resolve));
        releaseAnswer();
        await page.waitForFunction(expected => document.getElementById('canvasAgentToggle').dataset.agentState === expected, fail ? 'error' : 'done');
        assert.equal(await toggle.evaluate(el => el.classList.contains('is-running')), false);
        assert.equal(await toggle.evaluate((el, expected) => el.classList.contains(expected), fail ? 'is-error' : 'is-done'), true);
        await toggle.click();
    }
    await page.locator('#canvasAgentClose').click();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const animations = await toggle.evaluate(el => [
        getComputedStyle(el.querySelector('.canvas-agent-orb')).animationName,
        getComputedStyle(el, '::before').animationName
    ]);
    assert.deepEqual(animations, ['none', 'none']);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await toggle.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom };
    });
    assert.ok(mobile.width >= 58 && mobile.height >= 58, 'mobile orb should remain a usable touch target');
    assert.ok(mobile.right >= 10 && mobile.right <= 28);
    assert.ok(mobile.bottom >= 10 && mobile.bottom <= 28);
    assert.equal(await toggle.locator('.canvas-agent-orb').isVisible(), true);
    assert.equal(await toggle.locator('.canvas-agent-orb-eye').first().isVisible(), true);
    if (process.env.XIAOMEI_ORB_QA_DIR) await page.screenshot({ path: path.join(process.env.XIAOMEI_ORB_QA_DIR, 'mobile-dark.png') });

    await page.goto('http://canvas-agent-orb.test/static/smart-canvas.html?id=orb&shared=1');
    await page.waitForFunction(() => document.body.classList.contains('canvas-share-mode'));
    assert.equal(await toggle.isVisible(), false);
    // theme.js is loaded in <head> and its existing startup reflow reads body before it exists.
    const unrelatedErrors = errors.filter(error => error.message.includes("reading 'offsetWidth'") && error.stack.includes('/static/js/theme.js'));
    assert.deepEqual(errors.filter(error => !unrelatedErrors.includes(error)), []);
});
