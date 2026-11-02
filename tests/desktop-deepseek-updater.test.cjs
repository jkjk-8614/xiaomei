'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { DeepSeekHarnessUpdater, pnpmCommand, runRemoteGit, isNetworkError } = require('../desktop/deepseek-updater.cjs');

const handshakeError = "fatal: unable to access 'https://github.com/deepseek-ai/deepseek-harness.git/': schannel: failed to receive handshake, SSL/TLS connection failed";
const remote = 'https://github.com/deepseek-ai/deepseek-harness.git';

test('command capture preserves UTF-8 characters split between pipe chunks', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'deepseek-updater.cjs'), 'utf8');
  const sandbox = { require, module: { exports: {} }, process, setTimeout, clearTimeout };
  vm.runInNewContext(`${source}\nmodule.exports.captureCommand = run;`, sandbox);
  const expected = '模型与推理等级\n中文补丁路径';
  const script = `const b = Buffer.from(${JSON.stringify(expected)}); process.stdout.write(b.subarray(0, 1)); process.stderr.write(b.subarray(0, 2)); setTimeout(() => { process.stdout.write(b.subarray(1)); process.stderr.write(b.subarray(2)); }, 50);`;
  const result = await sandbox.module.exports.captureCommand(process.execPath, ['-e', script]);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, expected);
});

test('remote checks and fetches recover from a Schannel failure using the system proxy', async () => {
  for (const args of [['ls-remote', remote, 'master'], ['fetch', '--unshallow', remote, 'master']]) {
    const calls = [];
    const result = await runRemoteGit(args, {
      cwd: '中文 路径', timeout: 20000, remote, platform: 'win32',
      resolveProxy: async url => { assert.equal(url, remote); return 'PROXY 127.0.0.1:7897; DIRECT'; },
      runCommand: async (command, argv, options) => {
        calls.push({ command, argv, options });
        if (calls.length === 1) throw new Error(handshakeError);
        return { stdout: 'recovered' };
      },
    });
    assert.equal(result.stdout, 'recovered');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].argv, args);
    assert.deepEqual(calls[1].argv, ['-c', 'http.version=HTTP/1.1', '-c', 'http.sslBackend=openssl', '-c', 'http.proxy=http://127.0.0.1:7897/', ...args]);
    assert.equal(calls[1].options.cwd, '中文 路径');
    assert.equal(calls[1].options.env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(!calls.flatMap(c => c.argv).some(arg => /sslVerify|--global/.test(arg)));
  }
});

test('successful requests keep the existing Git network configuration', async () => {
  let calls = 0;
  await runRemoteGit(['ls-remote', remote, 'master'], {
    remote, resolveProxy: () => { throw new Error('must not resolve'); },
    runCommand: async (command, args) => { calls++; assert.equal(args[0], 'ls-remote'); return { stdout: 'ok' }; },
  });
  assert.equal(calls, 1);
});

test('persistent connection failures stop after one retry with actionable guidance', async () => {
  let calls = 0;
  await assert.rejects(runRemoteGit(['fetch', remote, 'master'], {
    remote, platform: 'win32', resolveProxy: async () => { throw new Error('proxy resolution failed'); },
    runCommand: async () => { calls++; throw new Error(handshakeError); },
  }), error => {
    assert.equal(error.code, 'HARNESS_UPDATE_NETWORK');
    assert.match(error.message, /检查网络或系统代理后重试/);
    assert.match(error.message, /schannel/);
    return true;
  });
  assert.equal(calls, 2);
});

test('authentication, certificate and adapter failures are not retried as network failures', async () => {
  for (const message of ['The requested URL returned error: 403', 'SSL certificate problem: unable to get local issuer certificate', '适配补丁与上游冲突']) {
    let calls = 0;
    assert.equal(isNetworkError(message), false);
    await assert.rejects(runRemoteGit(['fetch', remote, 'master'], {
      remote, runCommand: async () => { calls++; throw new Error(message); },
    }));
    assert.equal(calls, 1);
  }
});

test('non-Windows retries retain their TLS backend and respect DIRECT proxy results', async () => {
  let calls = 0;
  await runRemoteGit(['fetch', remote, 'master'], {
    remote, platform: 'darwin', resolveProxy: async () => 'DIRECT; PROXY 127.0.0.1:7897',
    runCommand: async (command, args) => {
      if (++calls === 1) throw new Error('Failed to connect to github.com');
      assert.deepEqual(args.slice(0, 2), ['-c', 'http.version=HTTP/1.1']);
      assert.ok(!args.some(arg => /sslBackend|http.proxy/.test(arg)));
      return { stdout: 'ok' };
    },
  });
});

function desktopFixture(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  const dialogs = [], states = [];
  const context = vm.createContext({
    Date, isNetworkError, mainWindow: null, PACKAGED_DEEPSEEK_HARNESS: false,
    deepSeekHarnessUpdateOperationPromise: null, deepSeekHarnessUpdateCheckPromise: null,
    deepSeekHarnessUpdatePromptPromise: null, deepSeekHarnessUpdateLastResult: null,
    deepSeekHarnessProcess: null, deepSeekHarnessVisible: false,
    terminateDeepSeekHarnessProcess() {},
    writeDeepSeekHarnessUpdateState: state => states.push(state),
    readDeepSeekHarnessUpdateState: () => ({}),
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 1 }; } },
    ...overrides,
  });
  for (const name of ['updateDeepSeekHarness', 'checkDeepSeekHarnessUpdate']) {
    vm.runInContext(source.match(new RegExp(`^async function ${name}\\([^]*?^}`, 'm'))[0], context);
  }
  return { context, dialogs, states };
}

test('the retry button performs another update and clears failure state on success', async () => {
  let updates = 0;
  const dialogs = [];
  const f = desktopFixture({
    deepSeekHarnessUpdater: { update: async () => {
      if (++updates === 1) throw new Error(handshakeError);
      return { updated: true, commit: 'new-commit' };
    } },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 }; } },
  });
  assert.equal((await f.context.updateDeepSeekHarness({ remote_commit: 'new-commit' })).updated, true);
  assert.equal(updates, 2);
  assert.deepEqual(Array.from(dialogs[0].buttons), ['重试', '稍后再说']);
  assert.match(dialogs[0].detail, /检查网络或系统代理/);
  assert.equal(f.states.at(-1).failedCommit, '');
  assert.equal(f.context.deepSeekHarnessUpdateOperationPromise, null);
});

test('deferring a network failure ends the operation without changing the checkout', async () => {
  let updates = 0;
  const f = desktopFixture({ deepSeekHarnessUpdater: { update: async () => { updates++; throw new Error(handshakeError); } } });
  assert.equal((await f.context.updateDeepSeekHarness({ remote_commit: 'new-commit' })).retryable, true);
  assert.equal(updates, 1);
  assert.equal(f.context.deepSeekHarnessUpdateOperationPromise, null);
});

test('the desktop does not restart a Harness build that failed rollback validation', async () => {
  let refreshed = false;
  const failure = new Error('restored artifacts failed validation');
  failure.code = 'HARNESS_UPDATE_ROLLBACK_FAILED';
  const f = desktopFixture({
    deepSeekHarnessVisible: true,
    deepSeekHarnessUpdater: { update: async () => { throw failure; } },
    refreshDeepSeekHarness: async () => { refreshed = true; },
  });
  const result = await f.context.updateDeepSeekHarness({ remote_commit: 'new-commit' });
  assert.equal(refreshed, false);
  assert.equal(result.status, 'error');
  assert.match(result.message, /restored artifacts failed validation/);
});

test('fixed clone failures prompt again; network cooldowns and adapter conflict handling remain intact', async () => {
  for (const [message, age, manual, prompt] of [
    [handshakeError, 1000, false, false],
    [handshakeError, 25 * 60 * 60 * 1000, false, true],
    [handshakeError, 1000, true, true],
    ["DeepSeek Harness 更新失败：Cloning into 'C:\\用户数据\\merge-probe'... fatal: failed to create link 'C:\\用户数据\\merge-prob", 1000, false, true],
    ['适配补丁与上游冲突', 25 * 60 * 60 * 1000, false, false],
  ]) {
    const f = desktopFixture({
      deepSeekHarnessUpdater: { check: async () => ({ status: 'available', remote_commit: 'new-commit' }) },
      readDeepSeekHarnessUpdateState: () => ({ failedCommit: 'new-commit', failedMessage: message, failedAt: Date.now() - age }),
    });
    await f.context.checkDeepSeekHarnessUpdate({ manual });
    assert.equal(f.dialogs.length, prompt ? 1 : 0);
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('a conflicting adapter patch leaves the live Harness checkout intact', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-update-'));
  const remote = path.join(temp, 'remote');
  const local = path.join(temp, 'local');
  try {
    fs.mkdirSync(remote);
    git(remote, 'init', '-b', 'master');
    git(remote, 'config', 'user.name', 'Harness Test');
    git(remote, 'config', 'user.email', 'harness-test@example.invalid');
    fs.mkdirSync(path.join(remote, 'src'));
    fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(remote, 'package.json'), '{"name":"harness-test"}\n');
    fs.writeFileSync(path.join(remote, 'src', 'adapter.txt'), 'original\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'base');
    git(temp, 'clone', remote, local);
    const oldHead = git(local, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(local, 'src', 'adapter.txt'), 'xiaomei change\n');
    fs.writeFileSync(path.join(remote, 'src', 'adapter.txt'), 'upstream change\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'upstream');

    const dataRoot = path.join(temp, 'data');
    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot, remote, branch: 'master' });
    await assert.rejects(updater.update(), (error) => {
      assert.match(error.message, /适配补丁与上游冲突.*src\/adapter\.txt/);
      assert.match(error.message, /desktop\/harness-patches\/README\.md/);
      return true;
    });
    assert.equal(git(local, 'rev-parse', 'HEAD'), oldHead);
    assert.equal(fs.readFileSync(path.join(local, 'src', 'adapter.txt'), 'utf8'), 'xiaomei change\n');
    assert.equal(git(local, 'status', '--porcelain'), 'M src/adapter.txt');
    assert.ok(git(local, 'ls-files', 'src/adapter.txt'));
    // The stable copy survives the timestamped backup dir, so the adapter can
    // always be found again (desktop/harness-patch.cjs and manual recovery).
    const stable = path.join(dataRoot, 'deepseek-harness-adapter.patch');
    assert.ok(fs.existsSync(stable));
    assert.match(fs.readFileSync(stable, 'utf8'), /xiaomei change/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the updater builds with source and data on separate roots in a Chinese path', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-update-'));
  // On Windows the workspace may be on D: while user data lives on C:.
  const sourceParent = path.resolve(__dirname, '..', 'tmp');
  fs.mkdirSync(sourceParent, { recursive: true });
  const sourceTemp = fs.mkdtempSync(path.join(sourceParent, 'harness-update-'));
  const remote = path.join(sourceTemp, 'remote');
  const local = path.join(sourceTemp, '中文 路径');
  try {
    fs.mkdirSync(remote);
    git(remote, 'init', '-b', 'master');
    git(remote, 'config', 'user.name', 'Harness Test');
    git(remote, 'config', 'user.email', 'harness-test@example.invalid');
    fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\npnpm-invocations.txt\n');
    fs.writeFileSync(path.join(remote, 'package.json'), '{"name":"harness-test"}\n');
    fs.writeFileSync(path.join(remote, 'version.txt'), 'old\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'base');
    git(sourceTemp, 'clone', remote, local);
    const localPnpm = path.join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    fs.mkdirSync(path.dirname(localPnpm), { recursive: true });
    fs.writeFileSync(localPnpm, "import fs from 'node:fs'; fs.appendFileSync('pnpm-invocations.txt', `${process.argv.slice(2).join(' ')}\\n`);\n");
    fs.writeFileSync(path.join(remote, 'version.txt'), 'new\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'update');

    assert.deepEqual(pnpmCommand(local), { command: 'node', prefix: [localPnpm] });
    let verified = false;
    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master',
      verifyBuild: async root => {
        assert.equal(root, local);
        assert.equal(fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim(), 'new');
        assert.match(fs.readFileSync(path.join(root, 'pnpm-invocations.txt'), 'utf8'), /run build:web/);
        verified = true;
      },
    });
    const result = await updater.update();
    assert.equal(result.updated, true);
    assert.equal(verified, true);
    assert.equal(fs.readFileSync(path.join(local, 'version.txt'), 'utf8').trim(), 'new');
    assert.deepEqual(fs.readFileSync(path.join(local, 'pnpm-invocations.txt'), 'utf8').trim().split('\n'), [
      'install --frozen-lockfile',
      'run build:lib:host',
      'run build:lib:client',
      'run build:web',
    ]);
  } finally {
    assert.ok(sourceTemp.startsWith(`${sourceParent}${path.sep}`));
    fs.rmSync(sourceTemp, { recursive: true, force: true });
    assert.ok(temp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a failed build keeps the diagnostic tail and restores the previous checkout', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-update-'));
  const remote = path.join(temp, 'remote');
  const local = path.join(temp, 'local');
  const diagnostic = `${'build output '.repeat(120)}\nERROR: fixture build failed at the final step`;
  try {
    fs.mkdirSync(remote);
    git(remote, 'init', '-b', 'master');
    git(remote, 'config', 'user.name', 'Harness Test');
    git(remote, 'config', 'user.email', 'harness-test@example.invalid');
    fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(remote, 'package.json'), '{"name":"harness-test"}\n');
    fs.writeFileSync(path.join(remote, 'version.txt'), 'old\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'base');
    git(temp, 'clone', remote, local);
    const previousCommit = git(local, 'rev-parse', 'HEAD');
    const localPnpm = path.join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    fs.mkdirSync(path.dirname(localPnpm), { recursive: true });
    fs.writeFileSync(localPnpm, `import fs from 'node:fs';
      if (fs.readFileSync('version.txt', 'utf8').trim() === 'new') {
        process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;
      }\n`);
    fs.writeFileSync(path.join(remote, 'version.txt'), 'new\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'update');

    let restored = false;
    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master',
      verifyBuild: async () => { restored = true; },
    });
    await assert.rejects(updater.update(), error => {
      assert.ok(error.message.includes(diagnostic));
      return true;
    });
    assert.equal(git(local, 'rev-parse', 'HEAD'), previousCommit);
    assert.equal(fs.readFileSync(path.join(local, 'version.txt'), 'utf8').trim(), 'old');
    assert.equal(git(local, 'status', '--porcelain'), '');
    assert.equal(restored, true);
  } finally {
    assert.ok(temp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the updater preserves new adapter files while fast-forwarding', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-update-'));
  const remote = path.join(temp, 'remote');
  const local = path.join(temp, 'local');
  try {
    fs.mkdirSync(remote);
    git(remote, 'init', '-b', 'master');
    git(remote, 'config', 'user.name', 'Harness Test');
    git(remote, 'config', 'user.email', 'harness-test@example.invalid');
    fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(remote, 'package.json'), '{"name":"harness-test"}\n');
    fs.writeFileSync(path.join(remote, 'version.txt'), 'old\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'base');
    git(temp, 'clone', remote, local);
    fs.mkdirSync(path.join(local, 'node_modules', 'pnpm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), 'process.exit(0);\n');
    fs.mkdirSync(path.join(local, 'src'), { recursive: true });
    fs.writeFileSync(path.join(local, 'src', 'xiaomei-adapter.ts'), 'export const adapter = true\n');
    fs.writeFileSync(path.join(remote, 'version.txt'), 'new\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'update');

    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master', verifyBuild: async () => {} });
    const result = await updater.update();
    assert.equal(result.updated, true);
    assert.equal(fs.readFileSync(path.join(local, 'src', 'xiaomei-adapter.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const adapter = true\n');
    const patch = fs.readFileSync(path.join(temp, 'data', 'deepseek-harness-adapter.patch'), 'utf8');
    assert.match(patch, /src\/xiaomei-adapter\.ts/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a model capability regression rejects the update and rebuilds the previous artifacts', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-model-rollback-'));
  t.after(() => {
    assert.ok(temp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const remote = path.join(temp, 'remote');
  const local = path.join(temp, 'local');
  fs.mkdirSync(remote);
  git(remote, 'init', '-b', 'master');
  git(remote, 'config', 'user.name', 'Harness Test');
  git(remote, 'config', 'user.email', 'harness-test@example.invalid');
  fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\nbuild-version.txt\n');
  fs.writeFileSync(path.join(remote, 'package.json'), '{"name":"harness-test"}\n');
  fs.writeFileSync(path.join(remote, 'version.txt'), 'old\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'base');
  git(temp, 'clone', remote, local);
  const previousCommit = git(local, 'rev-parse', 'HEAD');
  const manager = path.join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  fs.mkdirSync(path.dirname(manager), { recursive: true });
  fs.writeFileSync(manager, `import fs from 'node:fs';
    if (process.argv.includes('build:web')) fs.copyFileSync('version.txt', 'build-version.txt');\n`);
  fs.writeFileSync(path.join(local, 'build-version.txt'), 'old\n');
  fs.writeFileSync(path.join(remote, 'version.txt'), 'new\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'update');
  const verified = [], stages = [];
  const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master',
    verifyBuild: async root => {
      const built = fs.readFileSync(path.join(root, 'build-version.txt'), 'utf8').trim();
      verified.push(built);
      if (built === 'new') throw new Error('gpt-6-sol lost image input');
    },
  });
  await assert.rejects(updater.update({ onProgress: ({ stage }) => stages.push(stage) }), /gpt-6-sol lost image input/);
  assert.deepEqual(verified, ['new', 'old']);
  assert.ok(stages.includes('verify'));
  assert.ok(stages.includes('rollback'));
  assert.ok(!stages.includes('done'));
  assert.equal(git(local, 'rev-parse', 'HEAD'), previousCommit);
  assert.equal(fs.readFileSync(path.join(local, 'build-version.txt'), 'utf8').trim(), 'old');
  assert.equal(git(local, 'status', '--porcelain'), '');
});

test('the default build verification rejects missing artifacts without changing the target', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-missing-build-'));
  t.after(() => {
    assert.ok(root.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const updater = new DeepSeekHarnessUpdater({ root });
  await assert.rejects(updater.verifyBuild(root), /generated desktop profile|MODULE_NOT_FOUND|Cannot find module/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the default build verification loads the current built adapter in a fresh process', async () => {
  const root = process.env.XIAOMEI_TEST_HARNESS_ROOT || path.resolve(__dirname, '..', 'vendor', 'deepseek-harness');
  const result = await new DeepSeekHarnessUpdater({ root }).verifyBuild(root);
  assert.match(result.stdout, /pass 4/);
  assert.match(result.stdout, /fail 0/);
});
