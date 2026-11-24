const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require(process.env.XIAOMEI_TEST_PLAYWRIGHT || '../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:39191';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=', 'base64');

test('network panel shows delivery failure and verifies a stored image before turning green', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1000, height:720}});
    page.setDefaultTimeout(6000);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
    const requests = [];
    const now = Date.now()/1000;
    const ok = {status:'ok', checked_at:now};
    const recoveryId = 'img-20261123-120000-abcd1234';
    let deliveryFailed = true;
    let previewWorks = true;
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/') return route.fulfill({path:path.join(root, 'static/index.html')});
        if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404});
        }
        if (url.pathname === '/api/providers') return route.fulfill({json:{providers:[
            {id:'one', name:'平台一', primary:true, image_models:['test']},
            {id:'two', name:'平台二', image_models:['test']},
        ]}});
        if (url.pathname.startsWith('/api/image-network/')) {
            requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
            if (url.pathname.endsWith('/compare')) return route.fulfill({json:{
                configured:{status:'error', code:'proxy', origin:'https://cdn.example.test'},
                no_proxy:{status:'ok', code:'http_404', origin:'https://cdn.example.test'},
            }});
            if (url.pathname.includes('/two')) return route.fulfill({json:{checks:{provider:ok}}});
            return route.fulfill({json:{
                checks:{provider:ok, query:ok, download:deliveryFailed
                    ? {status:'error', code:'timeout', origin:'https://cdn.example.test', recovery_id:recoveryId, checked_at:now}
                    : ok, save:deliveryFailed ? undefined : ok},
                sample_url:deliveryFailed ? '' : '/api/storage-files/generated/sample.png',
            }});
        }
        if (url.pathname.startsWith('/api/storage-files/')) return previewWorks
            ? route.fulfill({contentType:'image/png', body:png})
            : route.fulfill({status:404});
        return route.fulfill({json:{history:[], items:[], projects:[], ok:true}});
    });
    await page.goto(origin);
    await page.evaluate(() => window.postMessage({type:'xiaomei-open-image-network'}, window.location.origin));
    const panel = page.getByRole('dialog', {name:'网络监测'});
    await panel.getByText('检测到故障。请查看失败的步骤。').waitFor();
    assert.equal(await panel.getByText('结果取图').locator('..').locator('[data-state=error]').count(), 1);
    await panel.getByRole('button', {name:'代理对照'}).click();
    await panel.getByText(/请优先检查代理节点/).waitFor();
    assert.ok(requests.includes('POST /api/image-network/one/compare?target=download'));
    await panel.getByRole('button', {name:'复制诊断'}).click();
    await panel.getByText('已复制诊断。').waitFor();
    assert.equal(await panel.getByText(/请优先检查代理节点/).isVisible(), true);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(recoveryId));
    await panel.getByRole('combobox').selectOption('two');
    await panel.getByText('等待检测或实际收图结果').waitFor();
    assert.equal(await panel.getByText(/主动检测不消耗额度/).isVisible(), true);
    assert.equal(await panel.getByText(recoveryId, {exact:false}).count(), 0);
    deliveryFailed = false;
    await panel.getByRole('combobox').selectOption('one');
    await panel.getByText('最近收图检查全部通过').waitFor();
    previewWorks = false;
    await panel.getByRole('button', {name:'立即检测'}).click();
    await panel.getByText('图片已保存，页面无法加载', {exact:false}).waitFor();
    assert.equal(await panel.getByText('最近收图检查全部通过').count(), 0);
    await panel.getByRole('button', {name:'关闭'}).click();
    assert.equal(await panel.isVisible(), false);
});

test('canvas adds the recovered image to the existing results without a generation request', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:900}});
    page.setDefaultTimeout(6000);
    const writes = [];
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404});
        }
        if (url.pathname.startsWith('/output/')) return route.fulfill({contentType:'image/png', body:png});
        if (url.pathname === '/api/canvases/network-fixture' && route.request().method() === 'GET') {
            return route.fulfill({json:{canvas:{id:'network-fixture', title:'Network fixture', nodes:[], connections:[], logs:[], settings:{}}}});
        }
        if (url.pathname === '/api/config') return route.fulfill({json:{api_providers:[], comfy_instances:[]}});
        if (route.request().method() === 'POST') writes.push(url.pathname);
        if (url.pathname === '/api/image-result-recovery/img-fixture') return route.fulfill({json:{images:['/output/recovered.png']}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto(origin + '/static/smart-canvas.html?id=network-fixture');
    await page.waitForFunction(() => smartConfigReady && canvas?.title === 'Network fixture');
    await page.evaluate(() => {
        nodes = [{
            id:'partial', type:'smart-image', x:300, y:100, outputKind:'image',
            images:[{url:'/output/first.png', kind:'image', natural_w:256, natural_h:256}],
            imageRecoveries:[{recovery_id:'img-fixture', error:'已收到 1/2 张'}],
        }];
        viewport = {x:0, y:0, scale:1};
        render();
        applyViewport();
    });
    const button = page.locator('[data-id="partial"] [data-image-result-recovery]');
    await button.click();
    await page.waitForFunction(() => nodes.find(node => node.id === 'partial')?.images?.length === 2);
    assert.deepEqual(await page.evaluate(() => nodes.find(node => node.id === 'partial').images.map(image => image.url)), [
        '/output/first.png', '/output/recovered.png',
    ]);
    assert.deepEqual(writes.filter(url => /canvas-image-tasks|online-image|image-result-recovery/.test(url)), [
        '/api/image-result-recovery/img-fixture',
    ]);
    assert.equal(await button.count(), 0);
});

test('commerce failure card retries delivery through the existing record', {timeout:30000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440, height:900}});
    page.setDefaultTimeout(6000);
    const writes = [];
    await page.addInitScript(() => localStorage.setItem('xiaomei_commerce_preferences_v1', JSON.stringify({
        values:{batch:{prompt:'测试图片', count:1}},
    })));
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404});
        }
        if (url.pathname.startsWith('/output/')) return route.fulfill({contentType:'image/png', body:png});
        if (url.pathname === '/api/config') return route.fulfill({json:{api_providers:[
            {id:'fixture', name:'测试平台', enabled:true, has_key:true, image_models:['fixture-image']},
        ]}});
        if (route.request().method() === 'POST') writes.push(url.pathname);
        if (url.pathname === '/api/canvas-image-tasks') return route.fulfill({json:{task_id:'fixture-task'}});
        if (url.pathname === '/api/canvas-image-tasks/fixture-task') return route.fulfill({json:{
            status:'failed', error:'图片下载超时。恢复编号：img-fixture。', recovery_id:'img-fixture',
        }});
        if (url.pathname === '/api/image-result-recovery/img-fixture') return route.fulfill({json:{images:['/output/recovered.png']}});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], workflows:[], batches:[]}});
    });
    await page.goto(origin + '/static/commerce.html?workflow=batch');
    await page.getByText('测试平台', {exact:true}).first().waitFor({state:'attached'});
    await page.locator('#generateBtn').click();
    const task = page.locator('.task-card');
    await task.getByRole('button', {name:'重试取图'}).last().click();
    await task.locator('img[src="/output/recovered.png"]').waitFor();
    assert.deepEqual(writes.filter(url => /canvas-image-tasks|online-image|image-result-recovery/.test(url)), [
        '/api/canvas-image-tasks', '/api/image-result-recovery/img-fixture',
    ]);
});
