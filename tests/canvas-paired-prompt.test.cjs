const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');

function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start, `could not extract ${name}`);
    return source.slice(start, end);
}

const context = vm.createContext({});
vm.runInContext([
    'splitSmartPromptItems',
    'smartLoopIsPaired',
    'smartLoopPromptFieldValues',
    'smartLoopActivePromptFieldValues'
].map(extract).join('\n'), context);

test('paired prompts keep internal line breaks as one prompt', () => {
    const prompt = '保持原图中的：\n相框主体完全不变\n相框颜色、材质和比例不变';
    const node = { type: 'smart-loop', batchUiMode: 'paired', variablePrompt: prompt };

    assert.deepEqual(Array.from(context.smartLoopPromptFieldValues(node)), [prompt]);
    assert.deepEqual(Array.from(context.smartLoopActivePromptFieldValues(node)), [prompt]);
});

test('advanced loops still rotate legacy newline-separated prompts', () => {
    const node = { type: 'smart-loop', batchUiMode: 'advanced', variablePrompt: '第一条提示词\n第二条提示词' };

    assert.deepEqual(Array.from(context.smartLoopPromptFieldValues(node)), ['第一条提示词', '第二条提示词']);
});

test('explicit paired rows remain separate even when one row contains line breaks', () => {
    const node = {
        type: 'smart-loop',
        batchUiMode: 'paired',
        variablePrompts: ['第一条\n补充说明', '第二条']
    };

    assert.deepEqual(Array.from(context.smartLoopPromptFieldValues(node)), ['第一条\n补充说明', '第二条']);
});
