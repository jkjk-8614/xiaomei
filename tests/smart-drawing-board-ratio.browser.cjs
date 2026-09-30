const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');

(async () => {
    const browser = await chromium.launch({channel:'msedge', headless:true});
    try {
        const page = await browser.newPage();
        await page.setContent('<div class="image-node drawing-board-node empty-node" style="width:500px;height:430px"><div class="node-head">手绘板</div><div class="node-body"></div><div class="node-hint">完成后点击输出图片</div></div>');
        await page.addStyleTag({path:path.join(__dirname, '../static/css/smart-canvas.css')});
        await page.addStyleTag({content:'.image-node.drawing-board-node{position:relative!important}'});
        await page.addScriptTag({path:path.join(__dirname, '../static/js/smart-drawing-board-node.js')});
        await page.evaluate(() => {
            window.boardNode = {id:'ratio-test', type:'smart-drawing-board', images:[{url:'/old.png'}], drawingBoard:window.SmartDrawingBoard.defaultState()};
            window.boardCanEdit = true;
            window.boardNode.drawingBoard.strokes = [{points:[[100,100,.5],[900,600,.5]], color:'#111827', size:18, opacity:1, tool:'brush'}];
            window.renderBoard = () => {
                const element = document.querySelector('.drawing-board-node');
                element.querySelector('.node-body').innerHTML = window.SmartDrawingBoard.bodyHtml(window.boardNode);
                window.SmartDrawingBoard.bindNode(element, window.boardNode, {
                    canEdit:() => window.boardCanEdit,
                    onBeforeChange:() => true,
                    onChanged:(_node, detail) => { if(detail.layoutChanged) window.renderBoard(); }
                });
            };
            window.renderBoard();
        });

        const options = await page.locator('[data-drawing-ratio] option').allTextContents();
        assert.deepEqual(options, ['1:1','4:3','3:4','3:2','2:3','16:9','9:16']);

        await page.selectOption('[data-drawing-ratio]', '9:16');
        const result = await page.evaluate(async () => {
            const state = window.boardNode.drawingBoard;
            const stageElement = document.querySelector('[data-drawing-stage]');
            const stage = stageElement.getBoundingClientRect();
            const canvas = document.querySelector('[data-drawing-canvas]').getBoundingClientRect();
            const blob = await window.SmartDrawingBoard.toBlob(window.boardNode);
            const bitmap = await createImageBitmap(blob);
            const imageSize = {width:bitmap.width, height:bitmap.height};
            bitmap.close();
            return {width:state.width, height:state.height, nodeHeight:window.boardNode.h, dirty:state.dirty, points:state.strokes[0].points, canvas:{width:canvas.width,height:canvas.height}, stage:{width:stageElement.clientWidth,height:stageElement.clientHeight}, imageSize};
        });
        assert.deepEqual(result.imageSize, {width:576,height:1024});
        assert.equal(result.dirty, true);
        assert.ok(result.points.every(point => point[0] >= 0 && point[0] <= result.width && point[1] >= 0 && point[1] <= result.height));
        assert.ok(Math.abs(result.canvas.width / result.canvas.height - 9 / 16) < .01);
        assert.ok(result.nodeHeight > 800);
        assert.ok(Math.abs(result.canvas.width - result.stage.width) < 3);
        assert.ok(Math.abs(result.canvas.height - result.stage.height) < 3);

        const canvasBox = await page.locator('[data-drawing-canvas]').boundingBox();
        const centerX = canvasBox.x + canvasBox.width / 2;
        const centerY = canvasBox.y + canvasBox.height / 2;
        await page.mouse.move(centerX, centerY);
        await page.mouse.down();
        await page.mouse.move(centerX + 6, centerY + 6);
        await page.mouse.up();
        const drawn = await page.evaluate(() => window.boardNode.drawingBoard.strokes);
        assert.equal(drawn.length, 2);
        assert.ok(Math.abs(drawn[1].points[0][0] - 288) < 3);
        assert.ok(Math.abs(drawn[1].points[0][1] - 512) < 3);

        await page.click('[data-drawing-action="undo"]');
        await page.click('[data-drawing-action="undo"]');
        const restored = await page.evaluate(() => ({state:window.boardNode.drawingBoard, ratio:document.querySelector('[data-drawing-ratio]').value}));
        assert.equal(restored.ratio, '4:3');
        assert.equal(restored.state.width, 1024);
        assert.equal(restored.state.height, 768);
        assert.equal(restored.state.dirty, false);
        assert.deepEqual(restored.state.strokes[0].points, [[100,100,.5],[900,600,.5]]);
        for(const [ratio, width, height] of [['1:1',1024,1024], ['3:4',768,1024], ['16:9',1024,576]]){
            await page.selectOption('[data-drawing-ratio]', ratio);
            const size = await page.evaluate(async () => {
                const bitmap = await createImageBitmap(await window.SmartDrawingBoard.toBlob(window.boardNode));
                const result = [bitmap.width, bitmap.height];
                bitmap.close();
                return result;
            });
            assert.deepEqual(size, [width,height]);
            await page.click('[data-drawing-action="undo"]');
        }
        await page.evaluate(() => { window.boardCanEdit = false; });
        await page.selectOption('[data-drawing-ratio]', '16:9');
        const blocked = await page.evaluate(() => ({state:window.boardNode.drawingBoard, ratio:document.querySelector('[data-drawing-ratio]').value}));
        assert.equal(blocked.ratio, '4:3');
        assert.equal(blocked.state.width, 1024);
        assert.equal(blocked.state.height, 768);
        await page.evaluate(() => {
            window.SmartDrawingBoard.resizeNode(document.querySelector('.drawing-board-node'), window.boardNode, 340);
        });
        await page.waitForTimeout(50);
        const compact = await page.evaluate(() => {
            const bounds = selector => document.querySelector(selector).getBoundingClientRect();
            const card = bounds('.drawing-board-card');
            const ratio = bounds('.drawing-board-ratio');
            const exportButton = bounds('.drawing-board-export');
            const stage = document.querySelector('.drawing-board-stage');
            const canvas = bounds('[data-drawing-canvas]');
            return {cardRight:card.right, ratioRight:ratio.right, exportRight:exportButton.right, stage:{width:stage.clientWidth,height:stage.clientHeight}, canvas:{width:canvas.width,height:canvas.height}};
        });
        assert.ok(compact.ratioRight < compact.exportRight && compact.exportRight <= compact.cardRight + 1);
        assert.ok(Math.abs(compact.canvas.width - compact.stage.width) < 3 && Math.abs(compact.canvas.height - compact.stage.height) < 3);
        assert.ok(Math.abs(compact.canvas.width / compact.canvas.height - 4 / 3) < .01);
        await page.evaluate(() => {
            window.boardCanEdit = true;
            window.boardNode.drawingBoard.width = 1000;
            window.boardNode.drawingBoard.height = 700;
            window.renderBoard();
        });
        assert.equal(await page.locator('[data-drawing-ratio]').inputValue(), 'custom');
        await page.selectOption('[data-drawing-ratio]', '16:9');
        await page.click('[data-drawing-action="undo"]');
        const custom = await page.evaluate(() => ({width:window.boardNode.drawingBoard.width, height:window.boardNode.drawingBoard.height, ratio:document.querySelector('[data-drawing-ratio]').value}));
        assert.deepEqual(custom, {width:1000,height:700,ratio:'custom'});
        const reopenedPortrait = await page.evaluate(() => {
            window.boardNode.w = 575;
            window.boardNode.h = 430;
            window.boardNode.drawingBoard.width = 576;
            window.boardNode.drawingBoard.height = 1024;
            const element = document.querySelector('.drawing-board-node');
            element.style.width = '575px';
            element.style.height = '430px';
            window.renderBoard();
            const stage = element.querySelector('[data-drawing-stage]');
            const canvas = element.querySelector('[data-drawing-canvas]').getBoundingClientRect();
            return {nodeHeight:window.boardNode.h, stageWidth:stage.clientWidth, stageHeight:stage.clientHeight, canvasWidth:canvas.width, canvasHeight:canvas.height};
        });
        assert.ok(reopenedPortrait.nodeHeight > 900);
        assert.ok(Math.abs(reopenedPortrait.stageWidth - reopenedPortrait.canvasWidth) < 3);
        assert.ok(Math.abs(reopenedPortrait.stageHeight - reopenedPortrait.canvasHeight) < 3);
        await page.evaluate(() => {
            const element = document.querySelector('.drawing-board-node');
            window.SmartDrawingBoard.resizeNode(element, window.boardNode, 600);
        });
        await page.waitForTimeout(50);
        const resizedPortrait = await page.evaluate(() => {
            const element = document.querySelector('.drawing-board-node');
            const stage = element.querySelector('[data-drawing-stage]');
            const canvas = element.querySelector('[data-drawing-canvas]').getBoundingClientRect();
            return {width:window.boardNode.w, height:window.boardNode.h, stageWidth:stage.clientWidth, stageHeight:stage.clientHeight, canvasWidth:canvas.width, canvasHeight:canvas.height};
        });
        assert.equal(resizedPortrait.width, 600);
        assert.ok(resizedPortrait.height > reopenedPortrait.nodeHeight);
        assert.ok(Math.abs(resizedPortrait.stageWidth - resizedPortrait.canvasWidth) < 3);
        assert.ok(Math.abs(resizedPortrait.stageHeight - resizedPortrait.canvasHeight) < 3);
        console.log('PASS: drawing ratio, node auto sizing, fitted preview, pen coordinates, PNG size, undo, read-only guard, compact layout, and legacy size');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
