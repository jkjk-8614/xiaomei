const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridgePath = path.join(__dirname, '..', 'ComfyUI', 'tools', 'comfy-app-bridge', 'web', 'bridge.js');
const bridgeSource = fs.readFileSync(bridgePath, 'utf8').replace(/^import \{ app \} from '[^']+';\r?\n/, '');
const context = vm.createContext({
  app: { registerExtension() {} },
  window: { LiteGraph: { registered_node_types: {} } },
  structuredClone,
});
vm.runInContext(bridgeSource, context, { filename: bridgePath });

function normalize(workflow) {
  context.workflow = workflow;
  return JSON.parse(JSON.stringify(vm.runInContext('normalizeWorkflowNodeTypes(workflow)', context)));
}

function qwenNode(names, values) {
  return {
    id: 160,
    type: 'AILab_QwenVL',
    inputs: [
      { name: 'image', type: 'IMAGE', link: 1 },
      { name: 'video', type: 'IMAGE' },
      ...names.map(name => ({ name, widget: { name } })),
    ],
    widgets_values: values,
  };
}

const oldNames = [
  'model_name', 'quantization', 'preset_prompt', 'custom_prompt',
  'max_tokens', 'keep_model_loaded', 'seed', 'attention_mode',
];
const newNames = [
  'model_name', 'quantization', 'attention_mode', 'preset_prompt',
  'custom_prompt', 'max_tokens', 'keep_model_loaded', 'seed',
];

test('loads a QwenVL workflow saved with the old widget order', () => {
  const original = { nodes: [qwenNode(oldNames, [
    'Qwen3-VL-4B-Instruct', '8-bit (Balanced)', '🖼️ Detailed Description',
    '详细描述这张图', 1024, true, 233295919434295, 'randomize', 'auto',
  ])] };
  const normalized = normalize(original).nodes[0];
  assert.deepEqual(normalized.inputs.map(input => input.name), ['image', 'video', ...newNames]);
  assert.deepEqual(normalized.widgets_values, [
    'Qwen3-VL-4B-Instruct', '8-bit (Balanced)', 'auto',
    '🖼️ Detailed Description', '详细描述这张图', 1024, true,
    1885904485, 'randomize',
  ]);
  assert.equal(original.nodes[0].widgets_values[7], 'randomize');
  assert.equal(normalized.inputs[0].link, 1);
});

test('keeps current QwenVL workflows and unrelated nodes unchanged', () => {
  const current = qwenNode(newNames, [
    'Qwen3-VL-4B-Instruct', '8-bit (Balanced)', 'auto',
    '🖼️ Detailed Description', '详细描述这张图', 1024, true, 123, 'fixed',
  ]);
  const other = { id: 2, type: 'KSampler', widgets_values: [456] };
  assert.deepEqual(normalize({ nodes: [current, other] }), { nodes: [current, other] });
});
