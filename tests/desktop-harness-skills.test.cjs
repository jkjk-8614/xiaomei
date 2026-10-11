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
const functions = ['collectDeepSeekSkillRoots', 'fingerprintDeepSeekSkills', 'ensureDeepSeekHarnessProfile', 'yamlScalar'];

function generateProfile(projectRoot, runtimeRoot) {
  const context = vm.createContext({
    fs, path, crypto, process,
    PROJECT_ROOT: projectRoot, TEST_RUNTIME_DATA_ROOT: runtimeRoot, DEEPSEEK_HARNESS_ROOT: harness,
    readXiaomeiHarnessModelConfig: () => ({ routes: [], env: {} }),
    syncXiaomeiHarnessWorkspace: () => {},
  });
  vm.runInContext(functions.map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]).join('\n'), context);
  return context.ensureDeepSeekHarnessProfile();
}

test('the generated desktop profile exposes asset Skills in the actual slash catalog', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, '小美画布');
  const runtimeRoot = path.join(root, '运行数据');
  const writeSkill = (file, name) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: 测试资产管理技能\n---\n\n正文 ${name}\n`, 'utf8');
  };
  writeSkill(path.join(projectRoot, 'data/agent_skills/legacy.md'), 'legacy-skill');
  writeSkill(path.join(projectRoot, 'data/agent_skills/packages/product/SKILL.md'), 'product-skill');
  writeSkill(path.join(runtimeRoot, 'data/agent_skills/packages/runtime/SKILL.md'), 'runtime-skill');
  const profileState = generateProfile(projectRoot, runtimeRoot);
  const include = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis-plugin-include')).href);
  const yaml = runtimeRequire('js-yaml');
  const patches = yaml.load(fs.readFileSync(path.join(profileState.profile, 'cordis.patch.yml'), 'utf8'), { schema: include.entryListSchema });
  const filesystem = patches.find(row => row.id === 'skill-filesystem');
  assert.equal(filesystem.disabled, false);
  assert.equal(filesystem.config.includeDefaultRoots, false);
  assert.equal(filesystem.config.customSkillDirs.length, 4);

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
  t.after(async () => { await ctx.fiber.dispose(); });
  const office = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-skill-office')).href);
  await ctx.plugin(office, { assetRoot: path.join(harness, 'packages/skill/skill-office/assets'), cli: false });
  for (const preset of ['standard', 'ptc', 'cordis', 'minimal']) {
    const created = await ctx.sessionController.create({ cwd: projectRoot, agentPreset: preset });
    const catalog = await ctx.sessionSkillCatalog.list({ sessionId: created.sessionId }, new AbortController().signal);
    const names = catalog.skills.map(skill => skill.name);
    for (const name of ['legacy-skill', 'product-skill', 'runtime-skill', 'office-docx', 'office-pptx', 'office-xlsx']) {
      assert.ok(names.includes(name), `${preset} slash catalog must include ${name}: ${names.join(', ')}`);
    }
  }
  const changedFile = path.join(projectRoot, 'data/agent_skills/packages/new/SKILL.md');
  writeSkill(changedFile, 'new-skill');
  assert.notEqual(generateProfile(projectRoot, runtimeRoot).fingerprint, profileState.fingerprint);
  fs.rmSync(changedFile);
  assert.equal(generateProfile(projectRoot, runtimeRoot).fingerprint, profileState.fingerprint);
});
