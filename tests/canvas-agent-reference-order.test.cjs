const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}

function fixture() {
    const refs = ['a', 'b', 'c', 'd', 'e'].map(nodeId => ({ nodeId, imageIndex: 0, url: `${nodeId}.png` }));
    const target = { id: 'paint', inputRefOrder: [] };
    const context = vm.createContext({
        nodes: [target],
        stableReferenceImagesFor: () => refs.slice(0, 2),
        collectMentionedImagesFromPrompt: () => refs.slice(2),
        outputImagesForNode: () => [], canvasTaskScopeUpstreamIds: () => [],
        mediaKindForItem: () => 'image',
        pushUndo() {}, scheduleSave() {}, inputThumbsRow: { dataset: {} },
    });
    const names = ['inputRefKey', 'uniqueReferenceImages', 'orderedSmartInputReferences',
        'visibleReferenceImagesFor', 'canvasTaskScopeReferenceImages', 'movedBeforeAfterIds',
        'sameOrderedIds', 'inputRefOrderForItems', 'reorderInputThumb'];
    vm.runInContext(names.map(extract).join('\n'), context);
    const scope = { mode: 'reuse', targetNodeId: target.id };
    let displayed = [];
    context.render = () => { displayed = context.canvasTaskScopeReferenceImages(scope).map(ref => ref.url); };
    return { context, target, refs, scope, displayed: () => Array.from(displayed) };
}

test('dragging a prompt reference updates Agent order and numbered request references', () => {
    const f = fixture();
    f.context.reorderInputThumb(f.target, f.context.visibleReferenceImagesFor(f.target), 4, 1);
    const expected = ['a.png', 'e.png', 'b.png', 'c.png', 'd.png'];
    assert.deepEqual(f.displayed(), expected);
    assert.deepEqual(Array.from(f.context.canvasTaskScopeReferenceImages(f.scope), ref => ref.url), expected);
    assert.deepEqual(f.refs.map(ref => ref.url), ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
});

test('invalid drag preserves reference order', () => {
    const f = fixture();
    f.context.reorderInputThumb(f.target, f.refs, -1, 2);
    assert.deepEqual(f.target.inputRefOrder, []);
    assert.deepEqual(Array.from(f.context.canvasTaskScopeReferenceImages(f.scope), ref => ref.url), f.refs.map(ref => ref.url));
});

test('Agent follows inputs from four to two to zero without reviving upstream images or results', () => {
    const f = fixture();
    const source = { id: 'source' }, ancestor = { id: 'ancestor' };
    f.context.nodes.push(source, ancestor);
    let inputs = f.refs.slice(0, 4);
    f.context.stableReferenceImagesFor = () => inputs;
    f.context.collectMentionedImagesFromPrompt = () => [];
    f.context.canvasTaskScopeUpstreamIds = () => [source.id, ancestor.id];
    f.context.outputImagesForNode = node => node === f.target
        ? [{ url: 'result.png', nodeId: f.target.id }]
        : f.refs;
    f.context.manualReferenceImagesFor = () => [{ url: 'ancestor-manual.png' }];
    f.scope.selectedImage = { url: 'result.png', nodeId: f.target.id, imageIndex: 0 };

    for (const count of [4, 2, 0, 5]) {
        inputs = f.refs.slice(0, count);
        const left = Array.from(f.context.visibleReferenceImagesFor(f.target), ref => ref.url);
        const right = Array.from(f.context.canvasTaskScopeReferenceImages(f.scope), ref => ref.url);
        assert.equal(left.length, count);
        assert.deepEqual(right, left);
    }
});

test('selecting a source image does not add its older ancestors', () => {
    const f = fixture();
    const source = { id: 'source', type: 'smart-image' };
    f.context.nodes.push(source, { id: 'ancestor' });
    f.context.outputImagesForNode = node => node === source ? f.refs : [{ url: 'old.png' }];
    f.context.manualReferenceImagesFor = () => [];
    f.context.canvasTaskScopeUpstreamIds = () => ['ancestor'];
    const scope = { mode: 'create', sourceNodeIds: [source.id] };
    assert.deepEqual(Array.from(f.context.canvasTaskScopeReferenceImages(scope), ref => ref.url), f.refs.map(ref => ref.url));
});

test('more than twenty references keep their order in both composers, request and message history', () => {
    const f = fixture();
    const refs = Array.from({ length: 25 }, (_, index) => ({ url: `image-${index}.png`, nodeId: 'source', imageIndex: index }));
    f.context.stableReferenceImagesFor = () => [...refs, refs[0], { url: '' }];
    f.context.collectMentionedImagesFromPrompt = () => [];
    const agentSource = fs.readFileSync(path.join(__dirname, '../static/js/canvas-agent.js'), 'utf8');
    const names = ['composerAttachmentReferences', 'planReferenceImages', 'scopeWithComposerReferences', 'snapshotReferenceImages', 'messageReferenceImages'];
    const agentFunctions = names.map(name => {
        const start = agentSource.indexOf(`    function ${name}(`);
        const end = agentSource.indexOf('\n    function ', start + 1);
        assert.ok(start >= 0 && end > start);
        return agentSource.slice(start, end);
    });
    f.context.composerFileReferences = [];
    vm.runInContext(agentFunctions.join('\n'), f.context);
    f.context.reorderInputThumb(f.target, refs, 24, 1);
    const left = Array.from(f.context.visibleReferenceImagesFor(f.target), ref => ref.url);
    const scope = { ...f.scope, referenceImages: f.context.canvasTaskScopeReferenceImages(f.scope) };
    const displayed = f.context.composerAttachmentReferences(scope);
    const request = f.context.snapshotReferenceImages(f.context.planReferenceImages(f.context.scopeWithComposerReferences(scope)));
    assert.equal(left.length, 25);
    for (const items of [displayed, request, f.context.messageReferenceImages({ referenceImages: request })]) {
        assert.deepEqual(Array.from(items, ref => ref.url), left);
    }
    f.context.composerFileReferences = [{ url: 'extra.png' }, refs[0]];
    const extraScope = f.context.scopeWithComposerReferences(scope);
    assert.deepEqual(Array.from(f.context.composerAttachmentReferences(scope), ref => ref.url), [...left, 'extra.png']);
    assert.deepEqual(Array.from(f.context.planReferenceImages(extraScope), ref => ref.url), [...left, 'extra.png']);
});
