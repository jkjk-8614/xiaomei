const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function extract(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end);
}
const now = Date.now();
function setup() {
    const ctx = vm.createContext({Date, nowMs:() => now});
    for(const name of ['taskProgressNumber', 'taskProgressFromObject', 'taskQueueInfo', 'formatRunDuration', 'generationTaskProgress', 'generationTaskDisplay']) {
        vm.runInContext(extract(name), ctx);
    }
    return ctx;
}
test('API tasks without measured progress show waiting duration, never an estimated percent', () => {
    const ctx = setup();
    for(const status of ['running', 'queued', 'processing', 'unknown']){
        const display = ctx.generationTaskDisplay({runSettings:{engine:'api'}}, {status, started_at:(now - 166000) / 1000}, true);
        assert.equal(display.value, '2:46');
        assert.equal(display.source, 'indeterminate');
        assert.ok(!display.value.includes('%'));
    }
    const submitting = ctx.generationTaskDisplay({running:true, runStartedAt:now - 3000});
    assert.equal(submitting.value, '3s');
    assert.equal(submitting.phase, 'submitting');
});
test('measured progress, including zero, is still displayed', () => {
    const ctx = setup();
    for(const progress of [0, 75]){
        const display = ctx.generationTaskDisplay({}, {status:'running', progress_percent:progress});
        assert.equal(display.value, `${progress}%`);
        assert.equal(display.source, 'real');
    }
});
test('ComfyUI estimates are labelled as estimates even in compact grids', () => {
    const display = setup().generationTaskDisplay({runSettings:{engine:'comfy'}, runStartedAt:now - 166000}, {status:'running'}, true);
    assert.equal(display.source, 'estimated');
    assert.match(display.label, /预计/);
});
test('a completed task is receiving results, not still waiting for generation', () => {
    const display = setup().generationTaskDisplay({}, {status:'succeeded'});
    assert.equal(display.value, '100%');
    assert.equal(display.label, '接收结果');
});
test('canvas polling starts immediately and bounds each read without resubmitting generation', async () => {
    let received;
    const ctx = vm.createContext({
        activeSmartTaskPolls:new Map(), tr:key => key,
        XiaomeiImageTaskClient:{pollImageTask:async (_id, options) => { received = options; return {images:['/ready.png']}; }},
    });
    vm.runInContext(extract('pollSmartCanvasTask'), ctx);
    await ctx.pollSmartCanvasTask('existing-task');
    assert.equal(received.initialDelayMs, 0);
    assert.equal(received.timeoutMs, 15000);
    assert.ok(received.maxNetworkFailures > 0);
    assert.equal(ctx.activeSmartTaskPolls.size, 0);
});
