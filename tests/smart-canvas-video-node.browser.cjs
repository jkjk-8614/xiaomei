const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

async function fixture(t, options={}){
    const browser = await chromium.launch({channel:'msedge', headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1500,height:920}});
    page.setDefaultTimeout(7000);
    const calls = [];
    const errors = [];
    let stored = {
        id:'video-node', title:'视频节点拆分', nodes:[
            {id:'legacy-video', type:'smart-paint', x:760, y:180, w:320, h:260, images:[],
                promptDraftText:'让产品缓慢旋转', promptDraftHtml:'让产品缓慢旋转',
                runSettings:{engine:'api', apiKind:'video', videoProvider:'fixture', videoModel:'fixture-video', videoDuration:5, videoAspect:'16:9'}},
            {id:'source', type:'smart-upload', x:160, y:180, w:300, h:260, images:[{url:'/fixture-images/source.png', name:'参考图', kind:'image'}]}
        ], connections:[], logs:[], settings:{engine:'api', apiKind:'image', provider_id:'fixture', model:'fixture-image', videoProvider:'fixture', videoModel:'fixture-video'}
    };
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'no browser exceptions'));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if(url.hostname !== 'video-node.test') return route.abort();
        const pathname = url.pathname;
        if(pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404, body:''});
        }
        if(pathname.startsWith('/fixture-images/')){
            return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#c7d2fe"/></svg>'});
        }
        if(pathname === '/api/config') return route.fulfill({json:{api_providers:[
            {id:'fixture', name:'Fixture', enabled:true, protocol:'openai', chat_models:['fixture-chat'], image_models:['fixture-image'], video_models:['fixture-video']}
        ], comfy_instances:[]}});
        if(pathname === '/api/canvases/video-node'){
            if(request.method() === 'PUT') stored = {...stored, ...request.postDataJSON()};
            return route.fulfill({json:{canvas:stored}});
        }
        if(pathname === '/api/canvas-video'){
            calls.push({path:pathname, body:request.postDataJSON()});
            if(options.videoHandler) return options.videoHandler(route);
            return route.fulfill({json:{videos:['/output/video-node.mp4']}});
        }
        if(pathname === '/api/ai/upload') return route.fulfill({json:{files:[]}});
        if(request.method() === 'POST') calls.push({path:pathname, body:request.postDataJSON()});
        return route.fulfill({json:{skills:[], categories:[], libraries:[], items:[], cases:[], workflows:[], batches:[]}});
    });
    await page.goto('http://video-node.test/static/smart-canvas.html?id=video-node');
    await page.waitForFunction(() => smartConfigReady && canvas?.id === 'video-node');
    return {page, calls, stored:() => stored};
}

test('smart canvas has a standalone video generation node', {timeout:120000}, async t => {
    const {page, calls} = await fixture(t);

    await t.test('legacy video mode migrates to smart-video and owns the composer mode', async () => {
        await page.evaluate(() => { selectedId='legacy-video'; selectedIds=[]; updateComposer(); });
        await page.waitForTimeout(220);
        const snapshot = await page.evaluate(() => ({
            type:nodes.find(node => node.id === 'legacy-video')?.type,
            kind:nodes.find(node => node.id === 'legacy-video')?.runSettings?.apiKind,
            title:nodes.find(node => node.id === 'legacy-video')?.title,
            toggle:document.getElementById('apiKindToggle')?.style.display
        }));
        assert.equal(snapshot.type, 'smart-video');
        assert.equal(snapshot.kind, 'video');
        assert.equal(snapshot.title, '视频');
        assert.equal(snapshot.toggle, 'none');
    });

    await t.test('video mode and additional settings stay accessible without duplicate switches', async () => {
        await page.locator('.video-mode-trigger').click();
        await page.locator('[data-video-mode="omni"]').click();
        assert.equal(await page.locator('.video-mode-trigger').innerText(), '全能参考');
        assert.equal(await page.locator('[data-toggle-param="videoMultimodal"]').count(), 0);
        assert.equal(await page.locator('[data-toggle-param="videoUseFrameRoles"]').count(), 0);
        assert.equal(await page.locator('.video-generation-settings-popover [data-toggle-param]').count(), 0);
        await page.locator('.video-options-trigger').click();
        await page.locator('[data-toggle-param="videoEnhancePrompt"]').click();
        assert.equal(await page.evaluate(() => settings.videoEnhancePrompt), true);
        assert.equal(await page.locator('.video-options-popover').isVisible(), true);
        await page.locator('[data-toggle-param="videoTrustedAsset"]').click();
        assert.equal(await page.locator('[data-trusted-source="manual"]').isVisible(), true);
        assert.notEqual(await page.locator('[data-trusted-source="library"]').evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('[data-trusted-source="cloud"]').evaluate(el => getComputedStyle(el).backgroundColor));
    });

    await t.test('video controls fit on one row at the composer width, including a long model name', async () => {
        const layout = await page.evaluate(() => {
            closeAllSmartPopovers();
            document.querySelector('.composer').style.width = '660px';
            document.querySelector('.video-model-control .image-model-name').textContent = 'a-very-long-video-model-name-for-testing';
            const controls = [...document.querySelectorAll('.video-params-main > .smart-control')];
            const rects = controls.map(el => el.getBoundingClientRect());
            const actions = document.querySelector('.composer-actions').getBoundingClientRect();
            return {tops:rects.map(rect => rect.top), lastRight:rects.at(-1).right, actionsLeft:actions.left};
        });
        assert.ok(layout.tops.every(top => Math.abs(top - layout.tops[0]) < 1));
        assert.ok(layout.lastRight <= layout.actionsLeft);
        await page.locator('.video-options-trigger').click();
        assert.equal(await page.locator('.video-options-popover').isVisible(), true);
    });

    await t.test('new video nodes are separate and typed connections reject video into paint', async () => {
        assert.equal(await page.locator('[data-create-type="video"]').count(), 1);
        const result = await page.evaluate(() => {
            const video = createVideoNodeAt({x:1180, y:520}, {select:false, skipUndo:true});
            const paint = createPaintNodeAt({x:1180, y:780}, {select:false, skipUndo:true});
            return {
                type:video.type,
                kind:video.runSettings.apiKind,
                acceptsVideo:window.SmartCanvasDataVideo.canConnect({type:'smart-upload', images:[{url:'/fixture-video/input.mp4',kind:'video'}]}, video),
                rejectsVideoIntoPaint:window.SmartCanvasDataVideo.canConnect({type:'smart-upload', images:[{url:'/fixture-video/input.mp4',kind:'video'}]}, paint)
            };
        });
        assert.equal(result.type, 'smart-video');
        assert.equal(result.kind, 'video');
        assert.equal(result.acceptsVideo, true);
        assert.equal(result.rejectsVideoIntoPaint, false);
    });

    await t.test('video generation keeps the existing provider request path', async () => {
        await page.evaluate(() => {
            const node = nodes.find(item => item.id === 'legacy-video');
            selectedId = node.id;
            settings = smartSettingsForNode(node);
            settings.apiKind = 'video';
            settings.videoProvider = 'fixture';
            settings.videoModel = 'fixture-video';
        });
        await page.evaluate(async () => runApiVideoGeneration('让产品缓慢旋转', [{url:'/fixture-images/source.png', kind:'image'}], settings));
        const call = calls.find(item => item.path === '/api/canvas-video');
        assert.ok(call);
        assert.equal(call.body.model, 'fixture-video');
        assert.equal(call.body.images.length, 1);
    });
});

for(const outcome of ['failed','succeeded']){
    test(`video ${outcome} updates the current node after canvas sync`, {timeout:30000}, async t => {
        let release;
        const gate = new Promise(resolve => { release=resolve; });
        t.after(() => release());
        const {page,calls} = await fixture(t,{videoHandler:async route => {
            await gate;
            return outcome === 'failed'
                ? route.fulfill({status:502,json:{detail:'视频平台暂时不可用，请稍后重试'}})
                : route.fulfill({json:{videos:['/output/video-node.mp4']}});
        }});
        await page.evaluate(() => {
            selectedId='legacy-video';selectedIds=[];
            const node=nodes.find(n=>n.id===selectedId);
            node.title='生成失败';node.runError='上次失败';
            updateComposer();
        });
        await page.locator('#runBtn').click();
        await page.waitForFunction(() => nodes.find(n=>n.id==='legacy-video')?.pending===1);
        assert.equal(calls.filter(c=>c.path==='/api/canvas-video').length,1);
        await page.evaluate(() => {
            nodes=mergeSmartNodeLists(nodes,JSON.parse(JSON.stringify(nodes)));
            render();
        });
        await page.waitForTimeout(2200);
        const busy = await page.evaluate(() => {
            const node=nodes.find(n=>n.id==='legacy-video');
            return {pending:node.pending,error:node.runError,title:node.title,inFlight:smartNodeInFlight(node)};
        });
        assert.equal(busy.inFlight,true);
        assert.equal(busy.error,undefined);
        assert.notEqual(busy.title,'生成失败');
        release();
        await page.waitForFunction(() => !smartNodeInFlight(nodes.find(n=>n.id==='legacy-video')));
        if(outcome==='failed'){
            assert.match(await page.locator('[data-id="legacy-video"] .generation-failed-message').innerText(),/视频平台暂时不可用/);
        } else {
            assert.equal(await page.evaluate(() => nodes.find(n=>n.id==='legacy-video').images[0].url),'/output/video-node.mp4');
        }
        assert.equal(await page.locator('#runBtn').isEnabled(),true);
        assert.equal(calls.filter(c=>c.path==='/api/canvas-video').length,1);
    });
}
