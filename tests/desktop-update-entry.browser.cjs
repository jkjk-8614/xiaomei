const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

test('sidebar update entry uses desktop IPC and remains available after dismissing an update', async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(5000);
    const sourceChecks = [];
    await page.addInitScript(() => {
        localStorage.setItem('studio_sidebar_pinned', '1');
        window.updateCalls = [];
        window.electronAPI = {
            getUpdateInfo: async () => ({ version: '1.0.5', displayVersion: '1.05', isPackaged: true }),
            onUpdateStatus: callback => { window.updateStatus = callback; },
            checkForUpdates: async options => {
                window.updateCalls.push(options);
                return { status: 'available', version: '1.0.5', displayVersion: '1.05', dismissed: true };
            },
        };
    });
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'updates.test') return route.abort();
        if(url.pathname === '/api/check-update' || url.pathname === '/api/update-from-github') sourceChecks.push(url.pathname);
        if(url.pathname.startsWith('/static/')) {
            if(url.pathname.endsWith('.html') && url.pathname !== '/static/index.html') return route.fulfill({ body: '<html></html>', contentType: 'text/html' });
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            if(fs.existsSync(file)) return route.fulfill({ path: file });
        }
        return route.fulfill({ json: {} });
    });
    await page.goto('http://updates.test/static/index.html');
    await page.locator('#studioSidebar').hover();
    const button = page.locator('#project-update-check-btn');
    await button.waitFor({ state: 'visible' });
    assert.equal(await button.innerText(), '检查更新');
    assert.match(await button.getAttribute('title'), /v1\.05/);
    assert.equal(await button.evaluate(el => el.nextElementSibling.title), 'API 设置');
    await page.evaluate(() => window.updateStatus({ status: 'available', version: '1.0.5', displayVersion: '1.05' }));
    assert.equal(await button.innerText(), '更新到 v1.05');
    await button.click();
    await page.waitForFunction(() => window.updateCalls.length === 1 && !document.getElementById('project-update-check-btn').disabled);
    assert.deepEqual(await page.evaluate(() => window.updateCalls), [{ manual: true }]);
    assert.deepEqual(sourceChecks, []);
    await page.evaluate(() => {
        window.electronAPI.checkForUpdates = async () => ({ status: 'current', currentDisplayVersion: '1.05' });
    });
    let message = '';
    page.once('dialog', async dialog => { message = dialog.message(); await dialog.accept(); });
    await button.click();
    await page.waitForFunction(() => !document.getElementById('project-update-check-btn').disabled);
    assert.match(message, /已是最新版本（v1\.05）/);
});
