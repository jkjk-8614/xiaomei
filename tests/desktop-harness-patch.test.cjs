'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * 把补丁工具指向一个临时仓库。模块在 require 时读取这些环境变量，所以每条用例
 * 都要用独立进程加载它。
 */
function loadTool({ root, patchDir, dataRoot }) {
  const modulePath = require.resolve('../desktop/harness-patch.cjs');
  delete require.cache[modulePath];
  process.env.XIAOMEI_HARNESS_ROOT = root;
  process.env.XIAOMEI_HARNESS_PATCH_DIR = patchDir;
  process.env.XIAOMEI_DATA_ROOT = dataRoot;
  return require(modulePath);
}

function makeRepo(temp) {
  const root = path.join(temp, 'harness');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'master');
  git(root, 'config', 'user.name', 'Harness Test');
  git(root, 'config', 'user.email', 'harness-test@example.invalid');
  // 关掉换行转换，用例才能对文件内容做逐字节断言。
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'src', 'adapter.txt'), 'upstream\n');
  fs.writeFileSync(path.join(root, 'src', 'untouched.txt'), 'keep me\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

test('a saved patch restores both modified and newly added adapter files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-patch-'));
  try {
    const root = makeRepo(temp);
    const patchDir = path.join(temp, 'patches');
    const dataRoot = path.join(temp, 'data');
    // 适配：改一个已跟踪文件 + 新增一个文件（git diff HEAD 看不见后者）。
    fs.writeFileSync(path.join(root, 'src', 'adapter.txt'), 'xiaomei\n');
    fs.writeFileSync(path.join(root, 'src', 'completions-fetch.ts'), 'export const x = 1\n');

    const tool = loadTool({ root, patchDir, dataRoot });
    const manifest = tool.save();
    assert.equal(manifest.files.length, 2);
    assert.ok(fs.existsSync(path.join(patchDir, 'xiaomei-adapter.patch')));
    assert.ok(fs.existsSync(path.join(dataRoot, 'deepseek-harness-adapter.patch')));

    // 模拟被 reset 到上游：改动与新增文件都消失。
    git(root, 'reset', '--hard', 'HEAD');
    git(root, 'clean', '-fd');
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'adapter.txt'), 'utf8'), 'upstream\n');
    assert.equal(fs.existsSync(path.join(root, 'src', 'completions-fetch.ts')), false);

    const result = tool.apply();
    assert.equal(result.applied, true);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'adapter.txt'), 'utf8'), 'xiaomei\n');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'completions-fetch.ts'), 'utf8'), 'export const x = 1\n');
    // 无关文件不受影响。
    assert.equal(fs.readFileSync(path.join(root, 'src', 'untouched.txt'), 'utf8'), 'keep me\n');

    // 再跑一次是幂等的。
    assert.equal(tool.apply().alreadyApplied, true);
    assert.equal(git(root, 'status', '--porcelain').split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('verify reports a clean reapply and status compares patch with the worktree', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-patch-'));
  const sourceParent = path.resolve(__dirname, '..', 'tmp');
  fs.mkdirSync(sourceParent, { recursive: true });
  const sourceTemp = fs.mkdtempSync(path.join(sourceParent, 'harness-patch-'));
  try {
    // Keep source on the workspace volume and data on the user temp volume.
    const root = makeRepo(sourceTemp);
    const patchDir = path.join(temp, 'patches');
    const dataRoot = path.join(temp, 'data');
    fs.writeFileSync(path.join(root, 'src', 'adapter.txt'), 'xiaomei\n');

    const tool = loadTool({ root, patchDir, dataRoot });
    tool.save();
    assert.equal(tool.verify().ok, true);
    const report = tool.status();
    assert.equal(report.patch_matches_worktree, true);
    assert.equal(report.live_changed_files, 1);

    // 保存后又改了工作树，状态应当识别出「补丁已过期」。
    fs.writeFileSync(path.join(root, 'src', 'adapter.txt'), 'xiaomei v2\n');
    assert.equal(tool.status().patch_matches_worktree, false);
  } finally {
    assert.ok(sourceTemp.startsWith(`${sourceParent}${path.sep}`));
    fs.rmSync(sourceTemp, { recursive: true, force: true });
    assert.ok(temp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
