const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const skills = [
    { id: 'first', name: '第一项', description: '商品策划' },
    { id: 'second', name: '第二项', description: '视觉设计' },
    { id: 'third', name: '第三项', description: '主图生成' },
];

test('Agent Skill favorites stay above other entries across search and reload', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'skill-favorites.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/agent-skills') return route.fulfill({ json: { skills, categories: [] } });
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if (url.pathname === '/api/canvases/favorites-fixture') return route.fulfill({ json: { canvas: {
            id: 'favorites-fixture', nodes: [{ id: 'agent', type: 'smart-agent', x: 200, y: 100, w: 460, h: 720 }],
            viewport: { x: 0, y: 0, scale: 1 }, connections: [], logs: [], settings: {},
        } } });
        return route.fulfill({ json: { skills: [], categories: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    const open = async () => {
        await page.goto('http://skill-favorites.test/static/smart-canvas.html?id=favorites-fixture');
        await page.waitForFunction(() => smartConfigReady && nodes.some(node => node.id === 'agent'));
        await page.locator('.image-node[data-id="agent"] .agent-skill-library').click();
        await page.locator('.agent-skill-library-favorite').first().waitFor();
    };
    const rows = page.locator('.image-node[data-id="agent"] .agent-skill-library-item:not([hidden])');
    const order = () => rows.locator('.agent-skill-library-label strong').allTextContents();
    await open();
    assert.deepEqual(await order(), ['第一项', '第二项', '第三项']);
    await page.locator('.agent-skill-library-search-input').fill('第二');
    assert.deepEqual(await order(), ['第二项']);
    await rows.first().locator('.agent-skill-library-favorite').click();
    assert.equal(await page.locator('.agent-skill-library-favorite[aria-pressed="true"]').count(), 1);
    await page.locator('.agent-skill-library-search-input').fill('');
    assert.deepEqual(await order(), ['第二项', '第一项', '第三项']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('smart_canvas_agent_skill_favorites_v1'))), ['second']);
    await open();
    assert.deepEqual(await order(), ['第二项', '第一项', '第三项']);
    await rows.first().locator('.agent-skill-library-favorite').click();
    assert.deepEqual(await order(), ['第一项', '第二项', '第三项']);
    assert.deepEqual(errors, []);
});
