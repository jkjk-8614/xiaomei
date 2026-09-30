import { app } from '../../scripts/app.js';

let converting = false;
let loading = false;
let configured = false;
let autoModelNames = new Set();
const NODE_TYPE_ALIASES = Object.freeze({
  'Get Image Size': 'GetImageSize',
});
const OLD_QWENVL_WIDGETS = [
  'model_name', 'quantization', 'preset_prompt', 'custom_prompt',
  'max_tokens', 'keep_model_loaded', 'seed', 'attention_mode',
];
const QWENVL_WIDGETS = [
  'model_name', 'quantization', 'attention_mode', 'preset_prompt',
  'custom_prompt', 'max_tokens', 'keep_model_loaded', 'seed',
];

function normalizeQwenVlWidgets(node) {
  if (node.type !== 'AILab_QwenVL' || !Array.isArray(node.inputs) || !Array.isArray(node.widgets_values)) return;
  const widgetInputs = node.inputs.filter(input => input?.widget);
  if (widgetInputs.map(input => input.widget.name).join('|') !== OLD_QWENVL_WIDGETS.join('|')) return;
  const values = node.widgets_values;
  const seed = Number(values[6]);
  if (values.length !== 9 || typeof values[4] !== 'number' || typeof values[5] !== 'boolean'
      || !Number.isSafeInteger(seed) || seed < 1
      || !['fixed', 'randomize', 'increment', 'decrement'].includes(values[7])
      || !['auto', 'sage', 'flash_attention_2', 'sdpa'].includes(values[8])) return;
  const inputByName = new Map(widgetInputs.map(input => [input.widget.name, input]));
  const validSeed = ((seed - 1) % 4294967295) + 1;
  node.widgets_values = [values[0], values[1], values[8], values[2], values[3],
    values[4], values[5], validSeed, values[7]];
  node.inputs = [...node.inputs.filter(input => !input?.widget),
    ...QWENVL_WIDGETS.map(name => inputByName.get(name))];
}

function normalizeWorkflowNodeTypes(workflow) {
  const normalized = structuredClone(workflow);
  const normalizeNode = node => {
    if (!node || typeof node !== 'object') return;
    const canonical = NODE_TYPE_ALIASES[node.type];
    if (canonical && window.LiteGraph?.registered_node_types?.[canonical]) {
      node.type = canonical;
    }
    normalizeQwenVlWidgets(node);
  };
  for (const node of normalized.nodes || []) normalizeNode(node);
  for (const subgraph of normalized.subgraphs || []) {
    for (const node of subgraph.nodes || []) normalizeNode(node);
  }
  return normalized;
}

function hideIdleCancelButton() {
  if (document.getElementById('xiaomei-hide-idle-cancel-button')) return;
  const style = document.createElement('style');
  style.id = 'xiaomei-hide-idle-cancel-button';
  style.textContent = '.actionbar button[disabled]:has(i[class*="lucide--x"]) { display: none !important; }';
  document.head.appendChild(style);
}

function patchModelDownloadLinks() {
  if (window.parent === window || HTMLAnchorElement.prototype._xiaomeiModelDownloadPatched) return;
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const name = String(this.download || '').trim();
    const href = String(this.href || '');
    const modelLink = this.target === '_blank'
      && autoModelNames.has(name)
      && /\.(safetensors|sft|ckpt|pth|pt)$/i.test(name)
      && /^https:\/\/(?:www\.)?(?:huggingface\.co|civitai\.com|civitai\.red)\//i.test(href);
    if (modelLink) {
      window.parent.postMessage({ type: 'xiaomei-model-download', name, url: href }, '*');
      return;
    }
    return nativeClick.call(this);
  };
  HTMLAnchorElement.prototype._xiaomeiModelDownloadPatched = true;
}

app.registerExtension({
  name: 'Xiaomei.NativeAppBridge',
  afterConfigureGraph() { configured = true; },
  setup() {
    hideIdleCancelButton();
    patchModelDownloadLinks();
    window.addEventListener('message', async event => {
      if (event.source !== window.parent || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(event.origin)) return;
      if (event.data?.type === 'xiaomei-model-download-config') {
        autoModelNames = new Set((event.data.names || []).map(name => String(name || '').trim()).filter(Boolean));
        return;
      }
      if (event.data?.type === 'xiaomei-ping') {
        event.source.postMessage({ type: 'xiaomei-ready', nonce: event.data.nonce, ready: configured }, event.origin);
        return;
      }
      if (event.data?.type === 'xiaomei-load-workflow' && event.data.nonce) {
        const reply = result => event.source.postMessage({ type: 'xiaomei-workflow-loaded', nonce: event.data.nonce, ...result }, event.origin);
        if (!configured) { reply({ error: 'ComfyUI 仍在初始化，请稍后重试', retryable: true }); return; }
        if (loading || converting) { reply({ error: '另一个工作流操作正在进行，请稍后重试', retryable: true }); return; }
        if (event.data.format !== 'UI' || !event.data.workflow || !Array.isArray(event.data.workflow.nodes)) {
          reply({ error: '当前只有 UI JSON 包含节点布局；API JSON 只能运行，不能加载到完整编辑器' });
          return;
        }
        loading = true;
        try {
          await app.loadGraphData(normalizeWorkflowNodeTypes(event.data.workflow));
          app.graph?.setDirtyCanvas(true, true);
          reply({ ok: true });
        } catch (error) { reply({ error: String(error.message || error) }); }
        finally { loading = false; }
        return;
      }
      if (event.data?.type !== 'xiaomei-convert' || !event.data.nonce) return;
      const reply = result => event.source.postMessage({ type: 'xiaomei-converted', nonce: event.data.nonce, ...result }, event.origin);
      if (!configured) { reply({ error: 'ComfyUI 仍在初始化，请稍后重试' }); return; }
      if (converting) { reply({ error: '另一个工作流正在转换，请稍后重试' }); return; }
      converting = true;
      const previous = app.graph.serialize();
      try {
        await app.loadGraphData(normalizeWorkflowNodeTypes(event.data.workflow));
        const converted = await app.graphToPrompt();
        if (!converted.output || !Object.keys(converted.output).length) throw new Error('没有可执行输出；请补齐缺少的节点');
        const invalid = Object.entries(converted.output).filter(([, node]) => !node?.class_type);
        if (invalid.length) {
          const names = invalid.map(([id]) => {
            const source = event.data.workflow.nodes?.find(node => String(node.id) === id);
            return source?.type ? `${source.type}（节点 ${id}）` : `节点 ${id}`;
          });
          throw new Error('以下节点未能转换，请先安装或检查对应扩展：' + names.join('、'));
        }
        reply({ prompt: converted.output });
      } catch (error) { reply({ error: String(error.message || error) }); }
      finally {
        try { await app.loadGraphData(previous); } finally { converting = false; }
      }
    });
  }
});
