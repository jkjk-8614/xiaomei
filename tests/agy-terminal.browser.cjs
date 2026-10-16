const assert = require('node:assert/strict');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

(async () => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let terminalPosts = 0;
        let terminalFails = false;
        await page.route('**/api/**', async route => {
            const path = new URL(route.request().url()).pathname;
            let status = 200;
            let data = {};
            if(path === '/api/providers'){
                data = {providers:[{id:'gemini-cli', name:'Antigravity CLI', protocol:'gemini-cli', enabled:true, image_models:[], chat_models:[], video_models:[]}]};
            } else if(path === '/api/cli/update-check'){
                data = {ok:true, installed:true, current_version:'1.3.3', latest_version:'1.3.3', update_available:false, message:'已是最新版本'};
            } else if(path === '/api/gemini-cli/status'){
                data = {installed:true, version:'1.3.3', path:'C:/mock/agy.exe'};
            } else if(path === '/api/gemini-cli/install'){
                data = {status:'idle', supported:true, message:''};
            } else if(path === '/api/gemini-cli/terminal'){
                terminalPosts += 1;
                status = terminalFails ? 404 : 200;
                data = terminalFails
                    ? {detail:'未找到 agy。请先安装 Antigravity CLI。'}
                    : {ok:true, message:'已打开 agy 终端。'};
            }
            await route.fulfill({status, contentType:'application/json', body:JSON.stringify(data)});
        });

        await page.goto('http://127.0.0.1:3000/static/api-settings.html');
        await page.waitForFunction(() => typeof selectProvider === 'function');
        await page.evaluate(() => selectProvider('gemini-cli'));
        await page.locator('#geminiCliTerminalBtn').click();
        await page.waitForFunction(() => document.querySelector('#geminiCliTerminalStatus').textContent.includes('已打开 agy 终端'));
        assert.equal(terminalPosts, 1);

        terminalFails = true;
        await page.locator('#geminiCliTerminalBtn').click();
        await page.waitForFunction(() => document.querySelector('#geminiCliTerminalStatus').textContent.includes('未找到 agy'));
        assert.equal(terminalPosts, 2);
        assert.equal(await page.locator('#geminiCliTerminalBtn').isEnabled(), true);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
