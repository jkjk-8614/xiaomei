const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');

test('1:1 batch image placeholders keep a gutter and repair the old automatic grid', { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== 'xiaomei-grid.test') return route.abort();
        if(url.pathname.startsWith('/static/')){
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            return fs.existsSync(file) ? route.fulfill({ path:file }) : route.fulfill({ status:404, body:'' });
        }
        if(url.pathname === '/api/canvases/grid') return route.fulfill({ json:{ canvas:{
            id:'grid', title:'Grid', connections:[], logs:[], nodes:[{
                id:'loop', type:'smart-loop', batchUiMode:'paired', batchDetailModeV2:true,
                x:30, y:30, w:420, h:640, batchSourceNodeId:'local', batchSourceText:'1:1 主图',
                batchImageSettings:{ratio:'1:1', resolution:'4K'},
                aiSplitPrompts:Array.from({length:5}, (_, index) => ({title:`第${index + 1}屏`, prompt:`画面${index + 1}`}))
            }]
        } } });
        return route.fulfill({ json:{api_providers:[], skills:[], categories:[], libraries:[], items:[], workflows:[]} });
    });
    await page.goto('http://xiaomei-grid.test/static/smart-canvas.html?id=grid');
    await page.waitForFunction(() => nodes.some(node => node.id === 'loop') && smartLoopDetailPaintNodes(nodes.find(node => node.id === 'loop')).length === 5);
    const gaps = await page.evaluate(() => {
        const loop = nodes.find(node => node.id === 'loop');
        const targets = smartLoopDetailPaintNodes(loop).sort((a, b) => a.batchDetailScreenIndex - b.batchDetailScreenIndex);
        const gutter = () => targets[1].x - targets[0].x - nodeRect(targets[0]).width;
        const initial = gutter();
        const square = displayBoxFromNaturalSize({w:4096, h:4096});
        const startX = targets[0].x, startY = targets[0].y;
        targets.forEach((target, index) => {
            target.x = startX + (index % 2) * 362;
            target.y = startY + Math.floor(index / 2) * 500;
            target.w = square.w;
            target.h = square.h;
        });
        render();
        const repaired = gutter();
        targets[1].x += 25;
        const moved = targets[1].x;
        render();
        return {initial, square, repaired, moved, afterManualMove:targets[1].x};
    });
    assert.equal(gaps.square.w, 440, '1:1 images expand the placeholder to 440 canvas units');
    assert.ok(gaps.initial >= 56, `new nodes have a visible gutter: ${gaps.initial}`);
    assert.ok(gaps.repaired >= 56, `old crowded nodes are separated: ${gaps.repaired}`);
    assert.equal(gaps.afterManualMove, gaps.moved, 'manual placement stays unchanged');
});
