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
    'splitSmartLoopPromptLines',
    'splitSmartLoopPromptFields',
    'smartLoopIsPaired',
    'smartLoopCanReturnToPaired',
    'smartLoopPairedPromptValues',
    'smartLoopPromptFieldValues',
    'smartLoopActivePromptFieldValues',
    'smartLoopAiSplitPrompts',
    'smartLoopAiSplitIsStale',
    'smartLoopDetailPaintNodes',
    'smartLoopPairedState',
    'smartLoopNumberedScreenBlocks',
    'smartLoopNumberedScreenItems',
    'extractSmartLoopSourceScreens',
    'parseSmartLoopAiSplitResult'
].map(extract).join('\n'), context);

context.downstreamImageTargetsFor = node => (node?.detailTargets || []);
context.isHistoryGroupNode = () => false;
context.isSmartPaintNode = node => node?.type === 'smart-paint';
context.SMART_PAINT_NODE_TYPE = 'smart-paint';
context.cascadeTailForLoop = () => ({id:'paint-1', type:'smart-paint'});
context.smartLoopPreviewImages = () => [{url:'product.png'}];
context.smartLoopAiSplitIsStale = () => false;
context.tr = key => key;
context.trf = (key, values) => `${key}:${JSON.stringify(values)}`;

test('paired prompts keep internal line breaks as one prompt', () => {
    const prompt = '保持原图中的：\n相框主体完全不变\n相框颜色、材质和比例不变';
    const node = { type: 'smart-loop', batchUiMode: 'paired', variablePrompt: prompt };

    assert.deepEqual(Array.from(context.smartLoopPromptFieldValues(node)), [prompt]);
    assert.deepEqual(Array.from(context.smartLoopActivePromptFieldValues(node)), [prompt]);
});

test('legacy loop nodes still expose the simple setup entry', () => {
    assert.equal(context.smartLoopCanReturnToPaired({type: 'smart-loop'}), true);
    assert.equal(context.smartLoopCanReturnToPaired({type: 'smart-loop', batchUiMode: 'advanced'}), true);
    assert.equal(context.smartLoopCanReturnToPaired({type: 'smart-loop', batchUiMode: 'paired'}), false);
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

test('simple batch split turns multiline input into prompt rows and drops blank lines', () => {
    const node = {
        type: 'smart-loop',
        batchUiMode: 'paired',
        variablePrompts: ['第一条\n\n第二条', '第三条']
    };

    assert.deepEqual(Array.from(context.splitSmartLoopPromptFields(node)), ['第一条', '第二条', '第三条']);
});

test('simple batch split accepts a custom separator', () => {
    const node = {
        type: 'smart-loop',
        batchUiMode: 'paired',
        variablePrompt: '第一条---第二条---第三条'
    };

    assert.deepEqual(Array.from(context.splitSmartLoopPromptFields(node, '---')), ['第一条', '第二条', '第三条']);
});

test('upstream plan stays intact until explicit AI or manual splitting', () => {
    const node = { type: 'smart-loop', batchUiMode: 'paired', batchDetailModeV2: true, variablePrompts: ['本地提示词'] };
    assert.deepEqual(
        Array.from(context.smartLoopPairedPromptValues(node, ['第一段\n第二段---第三段'])),
        ['本地提示词']
    );
    node.batchSplitSeparator = '---';
    assert.deepEqual(
        Array.from(context.smartLoopPairedPromptValues(node, ['第一段\n第二段---第三段'])),
        ['本地提示词']
    );
});

test('legacy paired nodes still split connected upstream text', () => {
    const node = { type: 'smart-loop', batchUiMode: 'paired', variablePrompts: ['本地提示词'] };
    assert.deepEqual(Array.from(context.smartLoopPairedPromptValues(node, ['第一段\n第二段---第三段'])), ['第一段', '第二段---第三段']);
});

test('AI results reject wrong counts, empty prompts and unusable replies', () => {
    assert.throws(() => context.parseSmartLoopAiSplitResult('这不是可拆分的结果', 2), /格式/);
    assert.throws(() => context.parseSmartLoopAiSplitResult(JSON.stringify({visual_guide:'',screens:[{prompt:'第一屏'}]}), 2), /返回了 1 屏/);
    assert.throws(() => context.parseSmartLoopAiSplitResult(JSON.stringify({visual_guide:'',screens:[{prompt:''}]}), 1), /空提示词/);
});

test('AI split parser accepts nested aliases, markdown JSON and an omitted visual guide', () => {
    const result = context.parseSmartLoopAiSplitResult('```json\n' + JSON.stringify({
        result: {
            segments: [
                {title: '首屏', source: '原文一', content: '首屏画面提示词'},
                {name: '细节', source_text: '原文二', visual_prompt: '细节画面提示词'}
            ]
        }
    }) + '\n```', 2);
    assert.equal(result.visualGuide, '');
    assert.deepEqual(Array.from(result.screens, item => item.prompt), ['首屏画面提示词', '细节画面提示词']);
});

test('AI split parser can recover numbered plain text screens', () => {
    const result = context.parseSmartLoopAiSplitResult('第1屏\n首屏构图与文案\n第2屏：材质细节构图', 2);
    assert.deepEqual(Array.from(result.screens, item => item.prompt), ['首屏构图与文案', '材质细节构图']);
});

test('AI split parser accepts markdown and pipe-style screen headings', () => {
    const result = context.parseSmartLoopAiSplitResult([
        '### 01｜首屏主视觉',
        '首屏产品构图与标题',
        '### 屏幕 2：材质细节',
        '第二屏材质近景与说明'
    ].join('\n'), 2);
    assert.deepEqual(Array.from(result.screens, item => item.prompt), [
        '首屏主视觉\n首屏产品构图与标题',
        '材质细节\n第二屏材质近景与说明'
    ]);
});

test('AI split parser falls back to explicit screen headings in the source plan', () => {
    const source = [
        '# 10 屏详情页全案逐屏拆解与 AI 提示词',
        '### 第 1 屏：【首屏】—主视觉',
        '首屏原文和画面限制',
        '### 第 2 屏：【细节】—材质',
        '第二屏原文和画面限制'
    ].join('\n');
    const result = context.parseSmartLoopAiSplitResult(JSON.stringify({screens:[{prompt:'模型只返回了一屏'}]}), 2, source);
    assert.deepEqual(Array.from(result.screens, item => item.prompt), [
        '### 第 1 屏：【首屏】—主视觉\n首屏原文和画面限制',
        '### 第 2 屏：【细节】—材质\n第二屏原文和画面限制'
    ]);
});

test('AI split parser can recover source screens when the model returns prose only', () => {
    const source = [
        '### 第 1 屏：首屏',
        '首屏完整文案与画面限制',
        '### 第 2 屏：细节',
        '第二屏完整文案与画面限制'
    ].join('\n');
    const result = context.parseSmartLoopAiSplitResult('我已完成拆分，但这里没有结构化数组。', 2, source);
    assert.deepEqual(Array.from(result.screens, item => item.prompt), [
        '### 第 1 屏：首屏\n首屏完整文案与画面限制',
        '### 第 2 屏：细节\n第二屏完整文案与画面限制'
    ]);
});

test('missing, empty, truncated and incomplete AI results recover the complete source plan', () => {
    const source = Array.from({length:10}, (_, index) => `### 第 ${index + 1} 屏：画面${index + 1}\n该屏完整文案\n\n保留布局与产品限制`).join('\n');
    for(const reply of ['', '{"screens":[]}', '{"screens":[', '{"screens":[{"prompt":""}]}',
        JSON.stringify({screens:Array.from({length:10}, () => ({prompt:''}))})]){
        const result = context.parseSmartLoopAiSplitResult(reply, 10, source);
        assert.equal(result.screens.length, 10);
        result.screens.forEach((screen, index) => {
            assert.equal(screen.prompt, `### 第 ${index + 1} 屏：画面${index + 1}\n该屏完整文案\n\n保留布局与产品限制`);
        });
    }
});

test('screen headings take precedence over numbered lists inside each screen', () => {
    const source = '### **第1屏：首屏**\n1. 商品文案\n2. 画面布局\n### **第2屏：细节**\n1. 材质文案\n2. 细节布局';
    const result = context.parseSmartLoopAiSplitResult(source, 2);
    assert.deepEqual(Array.from(result.screens, item => item.prompt), [
        '首屏\n1. 商品文案\n2. 画面布局',
        '细节\n1. 材质文案\n2. 细节布局'
    ]);
});

test('ambiguous paragraphs and duplicate source headings cannot become successful splits', () => {
    assert.throws(() => context.parseSmartLoopAiSplitResult('回复说明\n\n请稍后重试', 2), /格式/);
    assert.throws(() => context.parseSmartLoopAiSplitResult('', 2, '第1屏：首屏\n第1屏：重复屏'), /格式/);
    assert.throws(() => context.parseSmartLoopAiSplitResult('{"screens":[]}', 2, '第1屏：只有一屏'), /格式/);
});

test('AI split results keep the shared guide separate from screen prompts', () => {
    const result = context.parseSmartLoopAiSplitResult(JSON.stringify({
        visual_guide: '统一暖光、米白背景、产品外观不变',
        screens: [
            {title: '首屏主视觉', source_text: '首屏文案', prompt: '暖光首屏构图'},
            {title: '材质细节', source_text: '材质文案', prompt: '材质近景构图'}
        ]
    }), 2);
    assert.equal(result.visualGuide, '统一暖光、米白背景、产品外观不变');
    assert.deepEqual(Array.from(result.screens, item => item.prompt), ['暖光首屏构图', '材质近景构图']);
});

test('detail batch state requires one paint node per screen', () => {
    const node = {
        id: 'loop-1',
        type: 'smart-loop',
        batchUiMode: 'paired',
        batchDetailModeV2: true,
        detailTargets: [{id:'paint-1', type:'smart-paint'}],
        aiSplitPrompts: [{prompt:'屏幕一'}, {prompt:'屏幕二'}],
        variablePrompts: ['屏幕一', '屏幕二'],
        imageInput: true,
        showPrompt: true
    };
    const blocked = context.smartLoopPairedState(node);
    assert.equal(blocked.ready, false);
    assert.match(blocked.message, /smart\.loopDetailNeedPaintNodes/);
    node.detailTargets.push({id:'paint-2', type:'smart-paint'});
    const ready = context.smartLoopPairedState(node);
    assert.equal(ready.ready, true);
    assert.equal(ready.detailTargets.length, 2);
});

test('detail paint targets are counted once when legacy flow and input links coexist', () => {
    const paint = {id:'paint-1', type:'smart-paint'};
    const node = {
        id: 'loop-duplicate-links',
        type: 'smart-loop',
        batchUiMode: 'paired',
        batchDetailModeV2: true,
        detailTargets: [paint, paint],
        aiSplitPrompts: [{prompt:'屏幕一'}],
        variablePrompts: ['屏幕一']
    };
    assert.deepEqual(Array.from(context.smartLoopDetailPaintNodes(node), item => item.id), ['paint-1']);
});
