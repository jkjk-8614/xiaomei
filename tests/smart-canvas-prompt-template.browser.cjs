const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const template = {
    id:'view-rule', name:'视觉规范', category:'view',
    positive:'保持商品形状与文字准确', negative:'不要改变包装', params:{ratio:'1:1'}
};

test('prompt node template applies to system prompt and reaches the LLM request', {timeout:40000}, async t => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500, height:950}});
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if(url.hostname !== 'prompt-template.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + url.pathname);
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(url.pathname === '/api/config') return route.fulfill({json:{api_providers:[{
            id:'fixture', name:'Fixture', enabled:true, chat_models:['fixture-chat'], image_models:[]
        }], comfy_instances:[]}});
        if(url.pathname === '/api/prompt-libraries') return route.fulfill({json:{library:{libraries:[{
            id:'system', name:'系统提示词库', readonly:false,
            categories:[{id:'view', name:'视频规范'}], items:[template]
        }]}}});
        if(url.pathname === '/api/canvas-llm'){
            calls.push(request.postDataJSON());
            return route.fulfill({json:{text:'生成后的输出'}});
        }
        if(url.pathname === '/api/canvases/fixture'){
            if(request.method() === 'GET') return route.fulfill({json:{canvas:{
                id:'fixture', title:'模板验证', nodes:[{
                    id:'prompt', type:'smart-prompt', x:100, y:100, w:316, h:240,
                    text:'已有输出', llmEnabled:false, llmSystemEnabled:false,
                    llmInstruction:'生成主图提示词', promptInstructionInitialized:true,
                    llmProvider:'fixture', llmModel:'fixture-chat'
                }], connections:[], logs:[], settings:{}
            }}});
            return route.fulfill({json:{canvas:{id:'fixture', updated_at:Date.now()}}});
        }
        return route.fulfill({json:{items:[], libraries:[], skills:[], workflows:[]}});
    });

    await page.goto('http://prompt-template.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => canvas?.id === 'fixture' && smartConfigReady);
    const node = page.locator('[data-id="prompt"]');
    await node.locator('.prompt-preset-edit').click();
    await page.locator('[data-template-apply="positive"]').click();
    assert.equal(await node.locator('.prompt-llm-system').inputValue(), template.positive);
    assert.equal(await node.locator('.prompt-node-text').inputValue(), '已有输出');
    assert.equal(await page.evaluate(() => nodes.find(item => item.id === 'prompt').llmEnabled), true);

    await node.locator('.prompt-preset-edit').click();
    await page.locator('[data-template-apply="full"]').click();
    const full = await node.locator('.prompt-llm-system').inputValue();
    assert.match(full, /保持商品形状与文字准确/);
    assert.match(full, /Negative prompt:\n不要改变包装/);
    assert.match(full, /Params:\nratio: 1:1/);
    assert.equal(await node.locator('.prompt-node-text').inputValue(), '已有输出');

    await node.locator('.prompt-node-run').click();
    await page.waitForFunction(() => nodes.find(item => item.id === 'prompt').text === '生成后的输出');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system_prompt, full);
    assert.equal(calls[0].message, '生成主图提示词');
    assert.deepEqual(errors, []);
});
