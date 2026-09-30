const assert = require('node:assert/strict');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const providers = [
    {id:'codex', name:'GPT CLI', protocol:'codex', enabled:true, image_models:[], chat_models:[], video_models:[]},
    {id:'gemini-cli', name:'Antigravity CLI', protocol:'gemini-cli', enabled:true, image_models:[], chat_models:[], video_models:[]},
    {id:'jimeng', name:'即梦 CLI', protocol:'jimeng', enabled:true, image_models:[], chat_models:[], video_models:[]},
];

(async () => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage({viewport:{width:1500, height:1000}});
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));

        const versions = {
            codex: {ok:true, installed:true, current_version:'1.2.3', latest_version:'1.3.0', update_available:true, message:'发现新版本'},
            'gemini-cli': {ok:true, installed:false, current_version:'', latest_version:'2.0.0', update_available:null, message:'未找到 CLI'},
            jimeng: {ok:true, installed:true, current_version:'1.4.2', latest_version:'1.4.2', update_available:false, message:'已是最新版本'},
        };
        const installStatus = {codex:'idle', jimeng:'idle', 'gemini-cli':'idle'};
        const installPosts = {codex:0, jimeng:0, 'gemini-cli':0};
        let errorMode = false;

        await page.route('**/api/**', async route => {
            const request = route.request();
            const url = new URL(request.url());
            const path = url.pathname;
            const kind = url.searchParams.get('kind');

            if(errorMode && (path === '/api/cli/update-check' || /\/api\/(codex|gemini-cli|jimeng)\/status$/.test(path))){
                await route.abort();
                return;
            }

            let data = {};
            if(path === '/api/providers'){
                data = {providers};
            } else if(path === '/api/cli/update-check' && versions[kind]){
                data = {...versions[kind], kind};
            } else if(path === '/api/codex/status'){
                data = {installed:true, version:'codex 1.3.0', path:'C:/mock/codex.exe'};
            } else if(path === '/api/gemini-cli/status'){
                data = {installed:false, version:'', path:''};
            } else if(path === '/api/jimeng/status'){
                data = {installed:true, logged_in:true, version_ok:true, raw:{credits:100}};
            } else {
                const installMatch = path.match(/^\/api\/(codex|gemini-cli|jimeng)\/install$/);
                if(installMatch){
                    const installKind = installMatch[1];
                    if(request.method() === 'POST'){
                        installPosts[installKind] += 1;
                        installStatus[installKind] = 'running';
                    }
                    const status = installStatus[installKind];
                    data = {
                        status,
                        supported:true,
                        message: {
                            idle:'',
                            running:'正在安装 CLI，请稍候…',
                            succeeded:'安装完成',
                            failed:'安装失败，请重试',
                        }[status],
                    };
                }
            }
            await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(data)});
        });

        await page.goto('http://127.0.0.1:3000/static/api-settings.html');
        await page.waitForFunction(() => typeof selectProvider === 'function' && Array.isArray(providers) && providers.length === 3);
        await page.waitForFunction(() => document.querySelectorAll('.provider-cli-row').length === 3);
        assert.equal(await page.locator('.provider-cli-row .cli-provider-actions').count(), 0);
        assert.equal(await page.locator('.provider-cli-row .cli-provider-install').count(), 0);
        assert.equal(await page.locator('.provider-cli-row .cli-provider-check').count(), 0);

        await page.evaluate(() => selectProvider('codex'));
        await page.waitForFunction(() => document.querySelector('#codexCliStatus').textContent.trim() === '更新');
        assert.equal(await page.locator('#codexCliStatus').isEnabled(), true);

        await page.locator('#codexCliStatus').click();
        await page.waitForFunction(() => document.querySelector('#codexCliStatus').textContent.includes('安装中'));
        assert.equal(installPosts.codex, 1);
        await page.evaluate(() => handleCliStatusAction('codex'));
        assert.equal(installPosts.codex, 1);

        versions.codex = {...versions.codex, installed:true, current_version:'1.3.0', latest_version:'1.3.0', update_available:false};
        installStatus.codex = 'succeeded';
        await page.waitForFunction(() => document.querySelector('#codexCliUpdate').textContent.includes('安装完成'), {timeout:10000});
        await page.waitForFunction(() => document.querySelector('#codexCliStatus').textContent.trim() === '最新版本', {timeout:10000});
        assert.equal(await page.locator('#codexCliStatus').isDisabled(), true);

        await page.evaluate(() => selectProvider('gemini-cli'));
        await page.waitForFunction(() => document.querySelector('#geminiCliStatus').textContent.trim() === '安装');
        assert.equal(await page.locator('#geminiCliStatus').isEnabled(), true);
        await page.locator('#geminiCliStatus').click();
        await page.waitForFunction(() => document.querySelector('#geminiCliStatus').textContent.includes('安装中'));
        assert.equal(installPosts['gemini-cli'], 1);

        await page.evaluate(() => selectProvider('jimeng'));
        await page.waitForFunction(() => document.querySelector('#jimengCliAction').textContent.trim() === '最新版本');
        await page.waitForFunction(() => document.querySelector('#jimengCliStatus').textContent.trim() === '已登录');

        errorMode = true;
        await page.evaluate(() => {
            selectProvider('codex');
            return refreshCliSidebarStatus('codex');
        });
        await page.waitForFunction(() => document.querySelector('#codexCliStatus').textContent.trim() === '检测失败');
        const bodyText = await page.locator('body').innerText();
        assert.equal(/failed to fetch|fetch failed/i.test(bodyText), false);
        assert.equal(bodyText.includes('无法连接'), true);

        assert.deepEqual(errors, []);
        console.log('CLI status UI: hidden sidebar actions, update/latest/install states, install refresh, login status and Chinese errors passed');
    } finally {
        await browser.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
