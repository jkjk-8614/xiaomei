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
function setup(count=4) {
    const pending = new Map();
    const node = {id:'output', pending:count, images:[], pendingTasks:Array.from({length:count}, (_, i) => ({taskId:`task-${i}`, kind:'image'}))};
    const ctx = vm.createContext({
        nodes:[node], canvasId:'canvas',
        pollSmartCanvasTask(id, options) {
            if(!pending.has(id)) {
                let resolve, reject;
                const promise = new Promise((yes, no) => { resolve=yes; reject=no; });
                pending.set(id, {promise, resolve, reject, options});
            }
            return pending.get(id).promise;
        },
        preserveOutpaintCenterOnResults:async (_node, images) => images,
        cleanHistoryImages:items => items,
        copyMediaSizeFields:(_source, item) => item,
        stripImageGenerationMeta:item => item,
        render(){}, scheduleSave(){}, requestSmartProgressRender(){}, toast(){},
        addSmartGenerationLog(){}, nowMs:() => 1000, tr:key => key,
        markSmartNodeFailed(node, message){ node.runError=message; },
        MEDIA_NODE_DEFAULT_SCALE:1, MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE:1,
        MEDIA_GROUP_DEFAULT_SCALE:0.5, mediaNodeDefaultScale:() => 0.5,
    });
    for(const name of ['liveSmartNode', 'smartPendingTasks', 'resultMediaUrls', 'finalizeSmartPendingTask', 'resumeSmartPendingNode']) vm.runInContext(extract(name), ctx);
    return {ctx, node, pending};
}
test('four results reach the current node after replacement while polling', async () => {
    const {ctx, node, pending} = setup();
    const running = ctx.resumeSmartPendingNode(node);
    ctx.nodes = [structuredClone(node)];
    const live = ctx.nodes[0];
    pending.get('task-0').options.onTaskUpdate({status:'running', progress:75});
    assert.equal(live.pendingTasks[0].progress, 75);
    for(let i=0; i<4; i++) pending.get(`task-${i}`).resolve({images:[`/result-${i}.png`]});
    await running;
    assert.equal(live.images.length, 4);
    assert.equal(live.pending, 0);
    assert.equal(live.pendingTasks, undefined);
    assert.equal(live.running, false);
    assert.equal(node.images.length, 0);
});
test('concurrent resume does not apply a task twice or clear another pending task', async () => {
    const {ctx, node, pending} = setup(2);
    const one = ctx.resumeSmartPendingNode(node);
    const two = ctx.resumeSmartPendingNode(node);
    pending.get('task-0').resolve({images:['/first.png']});
    await new Promise(setImmediate);
    assert.equal(node.pending, 1);
    assert.equal(node.images.length, 1);
    pending.get('task-1').resolve({images:['/second.png']});
    await Promise.all([one, two]);
    assert.equal(node.images.length, 2);
    assert.equal(node.pending, 0);
});
test('replacement during asynchronous image processing still receives results', async () => {
    const {ctx, node, pending} = setup(1);
    ctx.preserveOutpaintCenterOnResults = async (_node, images) => {
        ctx.nodes = [structuredClone(node)];
        return images;
    };
    const running = ctx.resumeSmartPendingNode(node);
    pending.get('task-0').resolve({images:['/result.png']});
    await running;
    assert.equal(ctx.nodes[0].images.length, 1);
    assert.equal(ctx.nodes[0].pending, 0);
});
test('failed task clears the current node and records its error', async () => {
    const {ctx, node, pending} = setup(1);
    const running = ctx.resumeSmartPendingNode(node);
    ctx.nodes = [structuredClone(node)];
    pending.get('task-0').reject(new Error('upstream failed'));
    await assert.rejects(running, /upstream failed/);
    assert.equal(ctx.nodes[0].pending, 0);
    assert.equal(ctx.nodes[0].runError, 'upstream failed');
});
test('saved placeholder count cannot outlive the actual pending tasks', async () => {
    const {ctx, node, pending} = setup(1);
    node.pending = 4;
    node.images = [{url:'/already-1.png'}, {url:'/already-2.png'}, {url:'/already-3.png'}];
    const running = ctx.resumeSmartPendingNode(node);
    assert.equal(node.pending, 1);
    // A stale count can also arrive while result processing is in progress.
    node.pending = 4;
    pending.get('task-0').resolve({images:['/last.png']});
    await running;
    assert.equal(node.images.length, 4);
    assert.equal(node.pending, 0);
    assert.equal(node.pendingTasks, undefined);
    assert.ok(node.runFinishedAt);
});
test('failure after a partial result does not leave phantom pending slots', async () => {
    const {ctx, node, pending} = setup(1);
    node.images = [{url:'/already.png'}];
    const running = ctx.resumeSmartPendingNode(node);
    node.pending = 4;
    pending.get('task-0').reject(new Error('upstream failed'));
    await running;
    assert.equal(node.images.length, 1);
    assert.equal(node.pending, 0);
    assert.equal(node.pendingTasks, undefined);
});
for(const change of ['deleted', 'new-task', 'other-canvas']) test(`late results cannot overwrite ${change}`, async () => {
    const {ctx, node, pending} = setup(1);
    const running = ctx.resumeSmartPendingNode(node);
    if(change === 'deleted') ctx.nodes = [];
    if(change === 'new-task') node.pendingTasks = [{taskId:'new-task'}];
    if(change === 'other-canvas') ctx.canvasId = 'other';
    pending.get('task-0').resolve({images:['/late.png']});
    await running;
    assert.equal(node.images.length, 0);
    assert.equal(node.pending, 1);
});
