// Opt-in live checks against the configured desktop route; never prints credentials.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

async function main() {
  const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  const context = vm.createContext({ fs, path, process, xiaomeiApiConfigRoot: () => root });
  for (const name of ['readApiEnvValue', 'harnessOpenAiBaseURL', 'harnessModelInputModalities', 'readXiaomeiHarnessModelConfig']) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0], context);
  }
  const config = context.readXiaomeiHarnessModelConfig();
  const route = config.routes.find(r => r.id === process.env.HARNESS_TEST_PROVIDER) || config.routes[0];
  if (!route) throw new Error('请先在 API 设置中配置聊天平台');
  if (process.env.HARNESS_TEST_TRACE === '1') {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      const body = JSON.parse(init.body);
      console.log(JSON.stringify({ model: body.model, stream: body.stream, messages: body.messages }));
      if (body.stream === false) console.log('completion:', await response.clone().text());
      return response;
    };
  }
  const dir = path.join(root, 'vendor/deepseek-harness/packages/llm/llm-pi-ai/lib/types');
  const { PiAiAdapter } = await import(pathToFileURL(path.join(dir, 'adapter.js')));
  const { resolveProfiles } = await import(pathToFileURL(path.join(dir, 'config.js')));
  const llm = await import(pathToFileURL(path.join(root, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')));
  const profiles = resolveProfiles({ [route.id]: {
    api: route.api, baseURL: route.baseURL, models: route.models,
    nonStreamingModels: route.nonStreamingModels,
    compat: { supportsFinishReason: !route.omitsFinishReason },
  } });
  const auth = { credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, authContext: { env: async () => undefined, fileExists: async () => false } };
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => config.env[route.apiKeyEnv], auth });
  const wanted = (process.env.HARNESS_TEST_MODELS || '').split(',').filter(Boolean);
  const models = route.models.filter(m => !wanted.length || wanted.includes(m.id));
  if (!models.length) throw new Error('HARNESS_TEST_MODELS did not match any configured model');
  const tools = [{ name: 'echo_test', description: 'Return the supplied word', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } }];
  const failures = [];
  await Promise.all(models.map(async ({ id: model }) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '连通性测试：请调用 echo_test，word 为 测试。' }] }];
    for (let step = 0; step < 2; step++) {
      const assembler = new llm.BlockAssembler();
      try {
        for await (const chunk of adapter.stream({ provider: route.id, model, messages, tools, maxTokens: 256, signal: AbortSignal.timeout(60000) })) assembler.push(chunk);
        const message = assembler.message({ provider: route.id, model, ...(assembler.replayState ? { replayState: assembler.replayState } : {}) });
        const calls = message.content.filter(b => b.type === 'tool-call');
        console.log(JSON.stringify({ model, step, finish: assembler.finish, text: message.content.filter(b => b.type === 'text').map(b => b.text).join(''), calls: calls.map(c => ({ name: c.name, arguments: c.arguments })) }));
        if (assembler.finish.kind === 'error') throw new Error(`model returned ${assembler.finish.kind}`);
        if (!calls.length) {
          if (step === 0) throw new Error('model did not issue the requested tool call');
          break;
        }
        messages.push(message);
        for (const call of calls) {
          if (call.name !== 'echo_test') throw new Error('Unexpected tool');
          messages.push(llm.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: '测试' }], isError: false }));
        }
      } catch (error) {
        const message = String(error.message).replaceAll(config.env[route.apiKeyEnv], '[redacted]');
        console.log(JSON.stringify({ model, step, error: message }));
        failures.push({ model, step, message });
        break;
      }
    }
  }));
  if (failures.length) throw new Error(`${failures.length} model smoke check(s) failed`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
