'use strict';

/**
 * 小美画布 · DeepSeek Harness 适配补丁工具箱。
 *
 * vendor/deepseek-harness 是上游仓库的一个克隆，小美画布对它的改动（模型路由、
 * 桌面 Host 适配、两级模型菜单…）都以「未提交的工作树改动」形式存在。上游更新时
 * desktop/deepseek-updater.cjs 会自动 `git diff HEAD` 存一份补丁再 3-way 重放，
 * 但那份补丁只落在 .xiaomei-data 的时间戳目录里，不好找也不好审。
 *
 * 这个脚本把同一件事做成可复用命令，并把「当前适配」固化到 desktop/harness-patches/：
 *
 *   node desktop/harness-patch.cjs save     保存当前工作树改动为补丁（含 manifest）
 *   node desktop/harness-patch.cjs status   补丁是否与工作树一致、能否干净重放
 *   node desktop/harness-patch.cjs verify   在临时克隆里试重放（不动工作树）
 *   node desktop/harness-patch.cjs apply    把补丁 3-way 重放到工作树
 *   node desktop/harness-patch.cjs rebuild  重建 Harness 产物（客户端，可选宿主/前端）
 *
 * 典型用法：上游更新报「适配补丁与上游冲突」→ `apply` 留下冲突标记 → 手工合完 →
 * 跑 `node --test tests/` 与 `rebuild` → `save` 刷新补丁。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// 允许覆盖，便于测试与非常规安装位置。
const HARNESS_ROOT = process.env.XIAOMEI_HARNESS_ROOT
  ? path.resolve(process.env.XIAOMEI_HARNESS_ROOT)
  : path.join(PROJECT_ROOT, 'vendor', 'deepseek-harness');
const DATA_ROOT = process.env.XIAOMEI_DATA_ROOT
  ? path.resolve(process.env.XIAOMEI_DATA_ROOT)
  : path.join(PROJECT_ROOT, '.xiaomei-data');
const PATCH_DIR = process.env.XIAOMEI_HARNESS_PATCH_DIR
  ? path.resolve(process.env.XIAOMEI_HARNESS_PATCH_DIR)
  : path.join(__dirname, 'harness-patches');
const PATCH_FILE = path.join(PATCH_DIR, 'xiaomei-adapter.patch');
const MANIFEST_FILE = path.join(PATCH_DIR, 'manifest.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || HARNESS_ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    // 构建要跑几十秒到几分钟，让它直接继承终端输出，用户能看见进度。
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout || 10 * 60_000,
    // Windows 下 git 是 exe，不需要 shell；pnpm 走 .mjs 也不需要。
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = String(result.stderr || result.stdout || '').trim();
    const error = new Error(`${command} ${args.join(' ')} 失败：${detail.slice(0, 800)}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

function git(...args) {
  return run('git', args).stdout;
}

function gitAllowFailure(...args) {
  return run('git', args, { allowFailure: true });
}

function short(value, limit = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function assertHarness() {
  if (!fs.existsSync(path.join(HARNESS_ROOT, '.git'))) {
    throw new Error(`找不到 Harness 仓库：${HARNESS_ROOT}`);
  }
}

/**
 * 完整适配快照：已跟踪文件的改动 + 适配新增的文件。
 *
 * `git diff HEAD` 看不见未跟踪文件，而适配里确实有新增文件（如
 * llm-pi-ai/src/completions-fetch.ts）。这里用一份临时索引做 intent-to-add，
 * 让新增文件也进补丁，同时不污染真实索引。
 */
function snapshot() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const index = path.join(DATA_ROOT, 'harness-patch-index');
  try { fs.rmSync(index, { force: true }); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run('git', ['read-tree', 'HEAD'], { env });
    run('git', ['add', '-N', '.'], { env });
    const patch = run('git', ['diff', '--binary', 'HEAD'], { env }).stdout;
    const output = run('git', ['diff', '--numstat', 'HEAD'], { env }).stdout;
    const files = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      const added = match[1] === '-' ? 0 : Number(match[1]);
      const removed = match[2] === '-' ? 0 : Number(match[2]);
      insertions += added;
      deletions += removed;
      files.push({ path: match[3], insertions: added, deletions: removed });
    }
    return { patch, files, insertions, deletions };
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
  }
}

/** 工作树里有哪些改动（用于状态展示）。 */
function changedFiles() {
  const status = git('status', '--porcelain=v1', '--untracked-files=all').trim();
  if (!status) return { tracked: [], untracked: [] };
  const lines = status.split(/\r?\n/).filter(Boolean);
  return {
    tracked: lines.filter((line) => !line.startsWith('?? ')).map((line) => line.slice(3)),
    untracked: lines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)),
  };
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return null; }
}

function headCommit() {
  try { return short(git('rev-parse', 'HEAD').trim(), 64); } catch { return ''; }
}

/** 保存当前适配补丁。 */
function save() {
  assertHarness();
  const { patch, files, insertions, deletions } = snapshot();
  if (!patch.trim()) {
    throw new Error('Harness 工作树没有改动，无需保存补丁（若刚被 reset，请用 apply 恢复）');
  }
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  fs.writeFileSync(PATCH_FILE, patch, 'utf8');
  const manifest = {
    saved_at: new Date().toISOString(),
    base_commit: headCommit(),
    base_branch: short(git('branch', '--show-current').trim(), 80),
    files,
    insertions,
    deletions,
    bytes: Buffer.byteLength(patch, 'utf8'),
  };
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // .xiaomei-data 里的稳定副本，供 updater 与人工恢复使用。
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(path.join(DATA_ROOT, 'deepseek-harness-adapter.patch'), patch, 'utf8');
  } catch {}
  return manifest;
}

/** 在临时克隆里试重放补丁，不触碰工作树。 */
function verify() {
  assertHarness();
  if (!fs.existsSync(PATCH_FILE)) throw new Error(`还没有保存补丁：${PATCH_FILE}`);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  // 每次用独立目录：清理失败（被杀软/同步盘占用）也不影响下一次校验。
  const probe = path.join(DATA_ROOT, `harness-patch-probe-${process.pid}-${Date.now()}`);
  try {
    // --local 走硬链接，探针必须与仓库同盘，否则 Windows 上会 "Improper link"。
    run('git', ['clone', '--local', '--no-checkout', HARNESS_ROOT, probe], { cwd: DATA_ROOT });
    run('git', ['checkout', '--detach', 'HEAD'], { cwd: probe });
    const applied = gitAllowFailureAt(probe, 'apply', '--3way', PATCH_FILE);
    if (applied.status !== 0) {
      const conflicts = gitAllowFailureAt(probe, 'diff', '--name-only', '--diff-filter=U');
      return {
        ok: false,
        conflicts: String(conflicts.stdout || '').trim().split(/\r?\n/).filter(Boolean),
        message: short(applied.stderr || applied.stdout),
      };
    }
    return { ok: true, conflicts: [] };
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
}

function gitAllowFailureAt(cwd, ...args) {
  return run('git', args, { cwd, allowFailure: true });
}

/** 把补丁重放到工作树；已经打过则跳过。 */
function apply() {
  assertHarness();
  if (!fs.existsSync(PATCH_FILE)) throw new Error(`还没有保存补丁：${PATCH_FILE}`);
  // 反向检查通过 = 工作树已经是打过补丁的样子，重复执行应当无副作用。
  if (gitAllowFailure('apply', '--reverse', '--check', PATCH_FILE).status === 0) {
    return { applied: false, alreadyApplied: true };
  }
  if (gitAllowFailure('apply', '--check', PATCH_FILE).status === 0) {
    git('apply', PATCH_FILE);
    return { applied: true, alreadyApplied: false };
  }
  const result = gitAllowFailure('apply', '--3way', PATCH_FILE);
  if (result.status !== 0) {
    const conflicts = gitAllowFailure('diff', '--name-only', '--diff-filter=U');
    const list = String(conflicts.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    const error = new Error(`补丁与上游冲突：${list.join(', ') || short(result.stderr)}`);
    error.conflicts = list;
    throw error;
  }
  return { applied: true, alreadyApplied: false };
}

function pnpmEntry() {
  const local = path.join(HARNESS_ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  return fs.existsSync(local) ? local : null;
}

/** 重建产物：优先用 Harness 自带的 pnpm，缺了就按脚本内容直接调工具。 */
function rebuild({ host = false, web = false, log = () => {} } = {}) {
  assertHarness();
  const pnpm = pnpmEntry();
  const targets = ['build:lib:client'];
  if (host) targets.unshift('build:lib:host');
  if (web) targets.push('build:web');
  if (pnpm !== null) {
    for (const script of targets) {
      log(`pnpm run ${script}`);
      run(process.execPath, [pnpm, 'run', script], { timeout: 30 * 60_000, inherit: true });
    }
    return { via: 'pnpm', targets };
  }
  log('未找到 Harness 自带 pnpm，直接调用 tsc / tsdown');
  const tsc = path.join(HARNESS_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsdown = path.join(HARNESS_ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs');
  run(process.execPath, [tsc, '-b', 'tsconfig.client.json'], { timeout: 30 * 60_000, inherit: true });
  run(process.execPath, [tsdown, '--config-loader', 'native', '--env.DSH_BUILD_FACE', 'client'], { timeout: 30 * 60_000, inherit: true });
  return { via: 'direct', targets: ['tsc -b tsconfig.client.json', 'tsdown client'] };
}

/** 人类可读的状态。 */
function status() {
  assertHarness();
  const manifest = readManifest();
  const patch = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : null;
  const live = snapshot().patch;
  const dirty = changedFiles();
  const report = {
    harness_root: HARNESS_ROOT,
    head: headCommit(),
    branch: short(git('branch', '--show-current').trim(), 80),
    patch_file: fs.existsSync(PATCH_FILE) ? PATCH_FILE : null,
    patch_saved_at: manifest?.saved_at ?? null,
    patch_base_commit: manifest?.base_commit ?? null,
    patch_files: manifest?.files?.length ?? 0,
    live_changed_files: dirty.tracked.length,
    live_untracked_files: dirty.untracked.length,
    patch_matches_worktree: patch === null ? null : patch === live,
    patch_reapplies_cleanly: null,
  };
  if (patch !== null) {
    try { report.patch_reapplies_cleanly = verify(); } catch (error) {
      report.patch_reapplies_cleanly = { ok: false, message: short(error?.message || error) };
    }
  }
  return report;
}

function formatStatus(report) {
  const lines = [];
  lines.push(`Harness: ${report.harness_root}`);
  lines.push(`HEAD:    ${report.head} (${report.branch || 'detached'})`);
  if (report.patch_file === null) {
    lines.push('补丁:    未保存（先运行 save）');
  } else {
    lines.push(`补丁:    ${report.patch_file}`);
    lines.push(`         保存于 ${report.patch_saved_at}，基于 ${report.patch_base_commit}，${report.patch_files} 个文件`);
  }
  lines.push(`工作树:  ${report.live_changed_files} 个跟踪文件改动，${report.live_untracked_files} 个未跟踪文件`);
  if (report.patch_matches_worktree !== null) {
    lines.push(`一致性:  ${report.patch_matches_worktree ? '补丁与工作树一致' : '补丁与工作树不一致（改动后记得 save）'}`);
  }
  const verified = report.patch_reapplies_cleanly;
  if (verified !== null) {
    lines.push(`可重放:  ${verified.ok ? '是（能干净 3-way 应用）' : `否 — ${(verified.conflicts || []).join(', ') || verified.message}`}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const command = argv[0] || 'status';
  if (command === 'save') {
    const manifest = save();
    console.log(`已保存 ${manifest.files.length} 个文件（+${manifest.insertions}/-${manifest.deletions}）到 ${PATCH_FILE}`);
    return;
  }
  if (command === 'status') {
    console.log(formatStatus(status()));
    return;
  }
  if (command === 'verify') {
    const result = verify();
    console.log(result.ok ? '补丁可以干净重放' : `补丁重放冲突：${(result.conflicts || []).join(', ') || result.message}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'apply') {
    const result = apply();
    console.log(result.alreadyApplied ? '工作树已经应用过该补丁，未改动' : '补丁已重放到工作树');
    return;
  }
  if (command === 'rebuild') {
    const flags = new Set(argv.slice(1));
    const result = rebuild({
      host: flags.has('--host'),
      web: flags.has('--web'),
      log: (line) => console.log(`· ${line}`),
    });
    console.log(`重建完成（${result.via}）：${result.targets.join(', ')}`);
    return;
  }
  console.error('用法：node desktop/harness-patch.cjs <save|status|verify|apply|rebuild> [--host] [--web]');
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  HARNESS_ROOT,
  PATCH_DIR,
  PATCH_FILE,
  MANIFEST_FILE,
  save,
  status,
  verify,
  apply,
  rebuild,
  snapshot,
  changedFiles,
};
