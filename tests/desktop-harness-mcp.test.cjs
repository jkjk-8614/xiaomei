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
const harness = path.join(project, 'vendor', 'deepseek-harness');
const runtimeRequire = createRequire(path.join(harness, 'apps', 'cli', 'package.json'));
const source = fs.readFileSync(path.join(project, 'desktop', 'main.cjs'), 'utf8');
const functions = [
  'collectDeepSeekSkillRoots', 'fingerprintDeepSeekSkills', 'ensureDeepSeekHarnessProfile',
  'yamlScalar', 'yamlEnvKey', 'readXiaomeiMcpServers', 'mcpClientProfileRows',
];

function generateProfile(projectRoot, runtimeRoot) {
  const context = vm.createContext({
    fs, path, crypto, process,
    PROJECT_ROOT: projectRoot, TEST_RUNTIME_DATA_ROOT: runtimeRoot, DEEPSEEK_HARNESS_ROOT: harness,
    xiaomeiApiConfigRoot: () => runtimeRoot,
    readXiaomeiHarnessModelConfig: () => ({ routes: [], env: {} }),
    syncXiaomeiHarnessWorkspace: () => {},
  });
  vm.runInContext(functions.map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]).join('\n'), context);
  return context.ensureDeepSeekHarnessProfile();
}

function writeServers(runtimeRoot, servers) {
  const file = path.join(runtimeRoot, 'data', 'mcp_servers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ servers }, null, 2), 'utf8');
}

function profileRows(profileState) {
  const include = require(path.join(harness, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'));
  const yaml = runtimeRequire('js-yaml');
  const patches = yaml.load(fs.readFileSync(path.join(profileState.profile, 'cordis.patch.yml'), 'utf8'), { schema: include.entryListSchema });
  // The profile patch is a patch list: a new row arrives through the loader's
  // insert form, so the mounted entries live under `insert`.
  return patches.flatMap(patch => patch.insert ?? []);
}

test('小美画布 MCP 设置变成 Harness 的 MCP 客户端配置', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, '小美画布');
  const runtimeRoot = path.join(root, '运行数据');
  fs.mkdirSync(projectRoot, { recursive: true });
  writeServers(runtimeRoot, [
    { name: 'Blender', server_name: 'blender', transport: 'stdio', enabled: true, command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-blender'], cwd: 'C:/tools', env: { TOKEN: 'abc' } },
    { name: '远端服务', server_name: 'remote', transport: 'http', enabled: true, url: 'http://127.0.0.1:8000/mcp',
      headers: { Authorization: 'Bearer x' } },
    { name: '已停用', server_name: 'off', transport: 'stdio', enabled: false, command: 'npx' },
    { name: '缺少前缀', transport: 'stdio', enabled: true, command: 'npx' },
  ]);

  const profileState = generateProfile(projectRoot, runtimeRoot);
  assert.equal(profileState.home, path.join(runtimeRoot, '.xiaomei-data', 'deepseek-harness'));
  assert.ok(!fs.existsSync(path.join(projectRoot, '.xiaomei-data')));
  const rows = profileRows(profileState);
  assert.deepEqual(rows.map(row => row.id), ['mcp-blender', 'mcp-remote']);
  assert.equal(rows[0].config.serverName, 'blender');
  assert.equal(rows[0].config.transport, 'stdio');
  assert.equal(rows[0].config.command, 'npx');
  assert.deepEqual(rows[0].config.args, ['-y', '@modelcontextprotocol/server-blender']);
  assert.equal(rows[0].config.cwd, 'C:/tools');
  assert.deepEqual(rows[0].config.env, { TOKEN: 'abc' });
  assert.equal(rows[1].config.transport, 'streamable-http');
  assert.equal(rows[1].config.url, 'http://127.0.0.1:8000/mcp');
  assert.deepEqual(rows[1].config.headers, { Authorization: 'Bearer x' });

  // 生成结果必须能被 Harness 官方 MCP 客户端的配置模型接受。
  const mcpClient = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-mcp-client')).href);
  for (const row of rows) {
    const parsed = mcpClient.Config(row.config);
    assert.equal(parsed.serverName, row.config.serverName);
  }

  const changed = generateProfile(projectRoot, runtimeRoot);
  assert.equal(changed.fingerprint, profileState.fingerprint);
  writeServers(runtimeRoot, [{ name: 'Blender', server_name: 'blender', transport: 'stdio', enabled: true, command: 'npx' }]);
  const updated = generateProfile(projectRoot, runtimeRoot);
  assert.notEqual(updated.fingerprint, profileState.fingerprint);
});

// AI 在对话里装好一个 MCP 后第一次写出 data/mcp_servers.json，桌面端必须立刻
// 重建 profile；否则要等用户手动刷新对话页，新工具才出现在 mcp__前缀__ 下。
test('MCP 配置从无到有时会触发 Harness profile 重建', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-mcp-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'mcp_servers.json');
  let applies = 0;
  let tick = null;
  const context = vm.createContext({
    fs, path,
    xiaomeiMcpWatcher: null,
    xiaomeiApiConfigRoot: () => root,
    applyXiaomeiMcpServersChange: () => { applies += 1; },
    setInterval: callback => { tick = callback; return { unref() {} }; },
  });
  vm.runInContext(source.match(/^function watchXiaomeiMcpServers\([^]*?^}/m)[0], context);
  context.watchXiaomeiMcpServers();
  assert.equal(typeof tick, 'function', '应注册轮询回调');
  // 启动时文件还不存在：基线是 0，不能当成一次变更去重启对话页。
  assert.equal(applies, 0);

  // 用 utimes 给出确定的时间戳，避免依赖文件系统的时间精度。
  const stamp = offsetSeconds => {
    const when = new Date(Date.now() + offsetSeconds * 1000);
    fs.utimesSync(file, when, when);
  };

  writeServers(root, [{ name: 'Photoshop MCP Pro', server_name: 'photoshop', transport: 'stdio',
    enabled: true, command: 'node', args: ['dist/index.js'] }]);
  stamp(1);
  tick();
  assert.equal(applies, 1, '首次创建 mcp_servers.json 应触发 profile 重建');

  // 内容没变时不重复重建，避免无谓重启对话页。
  tick();
  assert.equal(applies, 1);

  // 之后再装一个 MCP 仍然生效。
  writeServers(root, [
    { name: 'Photoshop MCP Pro', server_name: 'photoshop', transport: 'stdio', enabled: true, command: 'node' },
    { name: 'Blender', server_name: 'blender', transport: 'stdio', enabled: true, command: 'npx' },
  ]);
  stamp(2);
  tick();
  assert.equal(applies, 2);

  // 文件消失只移动基线：一次偶发的 stat 失败不该把对话页重启掉。
  fs.rmSync(file);
  tick();
  assert.equal(applies, 2);
});

test('DeepSeek 对话按 mcp__前缀__工具名 挂载已启用的 MCP 服务', { timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-mcp-boot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, '小美画布');
  const runtimeRoot = path.join(root, '运行数据');
  fs.mkdirSync(projectRoot, { recursive: true });
  const fixture = path.join(__dirname, 'fixtures', 'mcp-fixture-server.cjs');
  writeServers(runtimeRoot, [
    { name: 'Fixture', server_name: 'fixture', transport: 'stdio', enabled: true, command: process.execPath,
      args: [fixture] },
  ]);

  const profileState = generateProfile(projectRoot, runtimeRoot);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = profileState.home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  const { runProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh/profile-boot')).href);
  const { loadLayeredEnv, loadProfileDirectory } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const overrides = path.join(root, 'test.patch.json');
  fs.writeFileSync(overrides, JSON.stringify([
    { id: 'desktop-product-telemetry', disabled: true },
    { id: 'product-analytics', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-log-deepseek', disabled: true },
  ]));
  const installAnchor = path.join(harness, 'apps', 'cli', 'package.json');
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'desktop',
    resolvedProfile: { profile: loadProfileDirectory('dsh', profileState.profile, installAnchor), installAnchor },
    patchFiles: [overrides], args: ['--no-open', '--port', '0'],
  });

  const tools = ctx.get('tools');
  const deadline = Date.now() + 60000;
  let names = [];
  try {
    while (Date.now() < deadline) {
      names = tools.schemas().map(schema => schema.name);
      if (names.includes('mcp__fixture__add')) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(names.includes('mcp__fixture__add'), `MCP 工具未挂载: ${names.join(', ')}`);
    assert.ok(names.includes('mcp__fixture__greet'), `MCP 工具未挂载: ${names.join(', ')}`);
  } finally {
    // Stop the Host before the temp profile is removed.
    await ctx.fiber.dispose();
  }
});

test('DeepSeek 侧栏底部的 MCP 设置入口指向小美画布的 MCP 页面', { timeout: 300000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-mcp-ui-'));
  const projectRoot = path.join(root, '小美画布');
  const runtimeRoot = path.join(root, '运行数据');
  fs.mkdirSync(projectRoot, { recursive: true });
  const profileState = generateProfile(projectRoot, runtimeRoot);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = profileState.home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });

  // 官方 Web GUI 启动后把自己的带令牌地址打印到标准输出。
  const urls = [];
  const originalLog = console.log;
  console.log = (...args) => {
    const match = /dsh web: (http:\/\/\S+)/.exec(args.map(arg => String(arg)).join(' '));
    if (match) urls.push(match[1]);
    originalLog(...args);
  };
  t.after(() => { console.log = originalLog; });

  const { runProfile } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh/profile-boot')).href);
  const { loadLayeredEnv, loadProfileDirectory } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const overrides = path.join(root, 'test.patch.json');
  fs.writeFileSync(overrides, JSON.stringify([
    { id: 'desktop-product-telemetry', disabled: true },
    { id: 'product-analytics', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-log-deepseek', disabled: true },
  ]));
  const installAnchor = path.join(harness, 'apps', 'cli', 'package.json');
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'desktop',
    resolvedProfile: { profile: loadProfileDirectory('dsh', profileState.profile, installAnchor), installAnchor },
    patchFiles: [overrides], args: ['--no-open', '--port', '0'],
  });

  const { chromium } = require(path.join(project, 'tools', 'commerce-analysis', 'node_modules', 'playwright'));
  let browser = null;
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !urls.length) await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(urls.length, '未取得 DeepSeek Web GUI 地址');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(urls[0], { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-slot="settings.trigger"]', { timeout: 60000 });
    // 桌面端把主窗口地址写进页面，入口脚本据此跳回小美画布。
    await page.evaluate(origin => {
      document.documentElement.setAttribute('data-xiaomei-origin', origin);
      window.__opened = [];
      window.open = target => { window.__opened.push(target); return null; };
    }, 'http://127.0.0.1:3000');
    await page.evaluate(fs.readFileSync(path.join(project, 'desktop', 'harness-mcp-entry.js'), 'utf8'));
    await page.waitForSelector('[data-xiaomei-mcp-entry]', { timeout: 30000 });

    const entry = await page.evaluate(() => {
      const node = document.querySelector('[data-xiaomei-mcp-entry]');
      const settings = document.querySelector('[data-slot="settings.trigger"]').closest('button');
      const entryRect = node.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      node.click();
      return {
        text: (node.textContent || '').trim(),
        label: node.getAttribute('aria-label'),
        opened: window.__opened,
        sameRow: Math.abs(entryRect.top - settingsRect.top) < 24,
        onTheRight: entryRect.left >= settingsRect.left,
      };
    });
    assert.equal(entry.text, 'MCP 设置');
    assert.equal(entry.label, 'MCP 设置');
    assert.deepEqual(entry.opened, ['http://127.0.0.1:3000/static/index.html?page=mcp']);
    assert.ok(entry.sameRow, 'MCP 入口应与设置按钮同一行');
    assert.ok(entry.onTheRight, 'MCP 入口应在设置按钮右侧');
  } finally {
    if (browser) await browser.close();
    // Stop the Host before the temp profile is removed.
    await ctx.fiber.dispose();
  }
});
