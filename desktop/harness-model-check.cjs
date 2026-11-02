const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const project = path.resolve(__dirname, '..');
const harness = process.env.XIAOMEI_HARNESS_CHECK_ROOT
  ? path.resolve(process.env.XIAOMEI_HARNESS_CHECK_ROOT)
  : path.join(project, 'vendor', 'deepseek-harness');
const source = fs.readFileSync(path.join(project, 'desktop', 'main.cjs'), 'utf8');
const models = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'];

function load(context, names) {
  for (const name of names) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0], context);
  }
}

const context = vm.createContext({});
load(context, ['harnessModelInputModalities']);
const modalities = (provider, model, cache) => {
  const value = context.harnessModelInputModalities(provider, model, cache);
  return value === undefined ? undefined : Array.from(value);
};

test('GPT-6 models on compatible gateways accept image input without a published catalog', () => {
  for (const model of [...models, 'openai/gpt-6-sol', 'GPT-6-SOL']) {
    assert.deepEqual(modalities({ id: 'gateway' }, model), ['text', 'image'], model);
  }
});

test('provider declarations and published modalities retain priority over family detection', () => {
  const id = 'gpt-6-sol';
  const cache = { providers: { gateway: { [id]: ['text'] } } };
  assert.deepEqual(modalities({ id: 'gateway' }, id, cache), ['text']);
  assert.deepEqual(modalities({ id: 'gateway', vision_models: [id] }, id, cache), ['text', 'image']);
  assert.deepEqual(modalities({
    id: 'gateway', vision_models: [id], model_input_modalities: { [id]: ['text'] },
  }, id, { providers: { gateway: { [id]: ['text', 'image'] } } }), ['text']);
  assert.deepEqual(modalities({ id: 'gateway' }, 'new-vision', {
    providers: { gateway: { 'new-vision': ['text', 'image'] } },
  }), ['text', 'image']);
});

test('text-only and unknown models keep their existing image restrictions', () => {
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'unknown-model']) {
    assert.equal(modalities({ id: 'gateway' }, model), undefined);
  }
  for (const model of ['gpt-5.6-sol', 'gpt-4o', 'claude-opus-5', 'gemini-3.8-flash']) {
    assert.deepEqual(modalities({ id: 'gateway' }, model), ['text', 'image']);
  }
});

test('generated desktop profile exposes GPT-6 vision capability to the built Harness adapter', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-modalities-'));
  t.after(() => {
    assert.ok(root.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, '安装目录');
  const runtimeRoot = path.join(root, '用户数据');
  const provider = {
    id: 'gateway', name: 'Gateway', enabled: true, protocol: 'openai',
    base_url: 'http://127.0.0.1:1', chat_models: [...models, 'text-only', 'deepseek-chat'],
    model_input_modalities: { 'text-only': ['text'] },
  };
  const providersFile = path.join(runtimeRoot, 'data', 'api_providers.json');
  fs.mkdirSync(path.dirname(providersFile), { recursive: true });
  const originalProviders = JSON.stringify([provider]);
  fs.writeFileSync(providersFile, originalProviders);
  const fixture = vm.createContext({
    fs, path, crypto, process,
    PROJECT_ROOT: projectRoot, TEST_RUNTIME_DATA_ROOT: runtimeRoot,
    DEEPSEEK_HARNESS_ROOT: path.join(root, 'harness'),
    xiaomeiApiConfigRoot: () => runtimeRoot,
    readApiEnvValue: () => 'fixture-key',
    readHarnessModalityCache: () => ({ updatedAt: 0, providers: {} }),
    collectDeepSeekSkillRoots: () => [], fingerprintDeepSeekSkills: () => 'fixture',
    syncXiaomeiHarnessWorkspace: () => {}, readXiaomeiMcpServers: () => [],
    mcpClientProfileRows: () => [],
  });
  load(fixture, [
    'yamlScalar', 'yamlKey', 'harnessProviderKeyEnv', 'harnessModelInputModalities',
    'harnessOpenAiBaseURL', 'readXiaomeiHarnessModelConfig', 'ensureDeepSeekHarnessProfile',
  ]);
  const state = fixture.ensureDeepSeekHarnessProfile();
  const developmentPackage = path.join(harness, 'apps', 'cli', 'package.json');
  const runtimeRequire = createRequire(fs.existsSync(developmentPackage)
    ? developmentPackage : path.join(harness, 'package.json'));
  const yaml = runtimeRequire('js-yaml');
  const rows = yaml.load(fs.readFileSync(path.join(state.profile, 'cordis.patch.yml'), 'utf8'));
  const config = rows.find(row => row.id === 'llm-pi-ai').config;
  const [{ Context }, llm, adapter] = await Promise.all([
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm')).href),
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href),
  ]);
  const ctx = new Context();
  await ctx.plugin(llm.default);
  await ctx.plugin(adapter, config);
  for (const model of models) {
    const info = await ctx.llm.resolveModelInfo('xiaomei-gateway', model);
    assert.deepEqual(info.inputModalities, ['text', 'image'], model);
  }
  for (const model of ['text-only', 'deepseek-chat']) {
    const info = await ctx.llm.resolveModelInfo('xiaomei-gateway', model);
    assert.deepEqual(info.inputModalities, ['text'], model);
  }
  assert.equal(fs.readFileSync(providersFile, 'utf8'), originalProviders);
  assert.ok(!fs.existsSync(projectRoot));
});
