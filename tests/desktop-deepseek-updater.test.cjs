'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DeepSeekHarnessUpdater, pnpmCommand } = require('../desktop/deepseek-updater.cjs');

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

    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master' });
    await assert.rejects(updater.update(), /适配补丁与上游冲突.*src\/adapter\.txt/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), oldHead);
    assert.equal(fs.readFileSync(path.join(local, 'src', 'adapter.txt'), 'utf8'), 'xiaomei change\n');
    assert.equal(git(local, 'status', '--porcelain'), 'M src/adapter.txt');
    assert.ok(git(local, 'ls-files', 'src/adapter.txt'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the updater builds with the Harness-local pnpm in a Chinese path', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-update-'));
  const remote = path.join(temp, 'remote');
  const local = path.join(temp, '中文 路径');
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
    git(temp, 'clone', remote, local);
    const localPnpm = path.join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    fs.mkdirSync(path.dirname(localPnpm), { recursive: true });
    fs.writeFileSync(localPnpm, "import fs from 'node:fs'; fs.appendFileSync('pnpm-invocations.txt', `${process.argv.slice(2).join(' ')}\\n`);\n");
    fs.writeFileSync(path.join(remote, 'version.txt'), 'new\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'update');

    assert.deepEqual(pnpmCommand(local), { command: 'node', prefix: [localPnpm] });
    const updater = new DeepSeekHarnessUpdater({ root: local, dataRoot: path.join(temp, 'data'), remote, branch: 'master' });
    const result = await updater.update();
    assert.equal(result.updated, true);
    assert.equal(fs.readFileSync(path.join(local, 'version.txt'), 'utf8').trim(), 'new');
    assert.deepEqual(fs.readFileSync(path.join(local, 'pnpm-invocations.txt'), 'utf8').trim().split('\n'), [
      'install --frozen-lockfile',
      'run build:lib:host',
      'run build:lib:client',
      'run build:web',
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
