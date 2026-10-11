'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git';
const DEFAULT_BRANCH = 'master';

function short(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function run(command, args, options = {}) {
  const timeout = Number(options.timeout || 30_000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      // Windows batch launchers such as pnpm.cmd require cmd.exe.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`${command} ${args.join(' ')} 超时`));
    }, timeout);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(short(stderr || stdout || `${command} 退出码 ${code || signal || 'unknown'}`));
      error.code = code;
      error.signal = signal;
      reject(error);
    });
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isHash(value) {
  return /^[0-9a-f]{7,64}$/i.test(String(value || '').trim());
}

class DeepSeekHarnessUpdater {
  constructor({ root, dataRoot, remote = DEFAULT_REMOTE, branch = DEFAULT_BRANCH } = {}) {
    this.root = path.resolve(root || '');
    this.dataRoot = path.resolve(dataRoot || path.join(this.root, '.xiaomei-data'));
    this.remote = String(remote || DEFAULT_REMOTE).trim();
    this.branch = String(branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  }

  available() {
    return Boolean(this.root && fs.existsSync(path.join(this.root, '.git')) && fs.existsSync(path.join(this.root, 'package.json')));
  }

  async localState() {
    if (!this.available()) return { available: false, status: 'missing', message: '未找到 DeepSeek Harness 源码目录' };
    try {
      const head = short((await run('git', ['rev-parse', 'HEAD'], { cwd: this.root, timeout: 10_000 })).stdout, 80);
      const branch = short((await run('git', ['branch', '--show-current'], { cwd: this.root, timeout: 10_000 })).stdout, 80) || this.branch;
      const status = (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: this.root, timeout: 10_000 })).stdout.trim();
      const statusLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
      const untrackedFiles = statusLines
        .filter((line) => line.startsWith('?? '))
        .map((line) => line.slice(3).replace(/^"(.*)"$/, '$1').replace(/\\/g, '/'))
        .filter(Boolean);
      const packageInfo = readJson(path.join(this.root, 'package.json')) || {};
      return {
        available: true,
        status: 'ok',
        root: this.root,
        commit: head,
        branch,
        version: short(packageInfo.version, 80),
        dirty: Boolean(status),
        patch_files: statusLines.length,
        untracked_files: untrackedFiles,
      };
    } catch (error) {
      return { available: false, status: 'error', message: short(error?.message || error) };
    }
  }

  async check() {
    const local = await this.localState();
    if (!local.available) return { ...local, update_available: false };
    try {
      const remoteOutput = await run('git', ['ls-remote', this.remote, this.branch], { cwd: this.root, timeout: 20_000 });
      const remoteCommit = short(remoteOutput.stdout.split(/\s+/)[0], 80);
      if (!isHash(remoteCommit)) throw new Error('上游没有返回有效的提交版本');
      const same = remoteCommit.toLowerCase() === String(local.commit || '').toLowerCase();
      let fastForward = true;
      let shallow = false;
      try {
        shallow = short((await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: this.root, timeout: 10_000 })).stdout) === 'true';
      } catch {}
      if (!same) {
        // A one-commit checkout cannot prove ancestry until it is deepened.
        // Let the update operation perform that fetch and let --ff-only make
        // the final safety decision instead of hiding a valid update here.
        if (!shallow) {
          try {
            await run('git', ['merge-base', '--is-ancestor', local.commit, remoteCommit], { cwd: this.root, timeout: 10_000 });
          } catch { fastForward = false; }
        }
      }
      return {
        ...local,
        remote: this.remote,
        remote_branch: this.branch,
        remote_commit: remoteCommit,
        update_available: !same,
        fast_forward: fastForward,
        shallow,
        status: same ? 'current' : (fastForward ? 'available' : 'manual_required'),
        message: same ? 'DeepSeek Harness 已是最新版本' : (fastForward ? '发现 DeepSeek Harness 新版本' : '本地版本与上游分叉，需要手动处理'),
      };
    } catch (error) {
      return { ...local, remote: this.remote, remote_branch: this.branch, update_available: false, status: 'unavailable', message: short(error?.message || error) };
    }
  }

  async update({ onProgress } = {}) {
    const report = (stage, message) => { try { onProgress?.({ stage, message }); } catch {} };
    const check = await this.check();
    if (!check.available) throw new Error(check.message || 'DeepSeek Harness 不可用');
    if (check.status === 'unavailable') throw new Error(check.message || '无法检查 DeepSeek Harness 上游版本，请稍后重试');
    if (!check.update_available) return { ...check, updated: false };
    if (!check.fast_forward) throw new Error('本地 DeepSeek Harness 与上游分叉，请先手动处理本地提交');

    const backupDir = path.join(this.dataRoot, 'deepseek-harness-updates', new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
    const patchFile = path.join(backupDir, 'xiaomei-adapter.patch');
    const untrackedBackupRoot = path.join(backupDir, 'untracked');
    const previousCommit = check.commit;
    fs.mkdirSync(backupDir, { recursive: true });
    let patchSaved = false;
    const movedUntracked = [];
    try {
      report('backup', '正在保存小美画布适配补丁');
      const diff = await run('git', ['diff', '--binary', 'HEAD'], { cwd: this.root, timeout: 30_000 });
      if (diff.stdout.trim()) {
        fs.writeFileSync(patchFile, diff.stdout, 'utf8');
        patchSaved = true;
      }
      for (const rel of check.untracked_files || []) {
        const source = path.resolve(this.root, rel);
        const target = path.resolve(untrackedBackupRoot, rel);
        if (!source.startsWith(`${this.root}${path.sep}`) || !fs.existsSync(source)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
        movedUntracked.push({ rel, source, target });
      }
      // Only tracked source changes are part of the adapter patch. Ignored
      // node_modules and generated lib/ output stay in place until the build.
      await run('git', ['reset', '--hard', 'HEAD'], { cwd: this.root, timeout: 30_000 });
      report('download', '正在获取 DeepSeek Harness 上游更新');
      const shallow = short((await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: this.root, timeout: 10_000 })).stdout) === 'true';
      await run('git', shallow ? ['fetch', '--unshallow', this.remote, this.branch] : ['fetch', '--depth=1', this.remote, this.branch], { cwd: this.root, timeout: 15 * 60_000 });
      await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: this.root, timeout: 60_000 });
      if (patchSaved) {
        report('patch', '正在重新应用小美画布适配补丁');
        try {
          await run('git', ['apply', '--3way', patchFile], { cwd: this.root, timeout: 60_000 });
        } catch (error) {
          const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.root, timeout: 10_000 });
          throw new Error(`适配补丁与上游冲突：${conflicts.stdout.trim() || short(error?.message || error)}`);
        }
      }
      for (const item of movedUntracked) {
        const target = path.resolve(this.root, item.rel);
        if (fs.existsSync(target)) {
          const upstream = fs.readFileSync(target);
          const local = fs.readFileSync(item.target);
          if (!upstream.equals(local)) throw new Error(`未跟踪适配文件与上游冲突：${item.rel}`);
          fs.rmSync(item.target, { force: true });
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(item.target, target);
        }
      }
      report('build', '正在重新构建 DeepSeek Harness');
      const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      await run(packageManager, ['install', '--frozen-lockfile'], { cwd: this.root, timeout: 15 * 60_000 });
      await run(packageManager, ['run', 'build:lib:host'], { cwd: this.root, timeout: 15 * 60_000 });
      await run(packageManager, ['run', 'build:lib:client'], { cwd: this.root, timeout: 15 * 60_000 });
      await run(packageManager, ['run', 'build:web'], { cwd: this.root, timeout: 15 * 60_000 });
      report('done', 'DeepSeek Harness 已更新并完成构建');
      const result = await this.localState();
      return { ...result, updated: true, previous_commit: previousCommit, backup_dir: backupDir };
    } catch (error) {
      report('rollback', '更新失败，正在恢复原版本');
      try {
        await run('git', ['reset', '--hard', previousCommit], { cwd: this.root, timeout: 30_000 });
        if (patchSaved) await run('git', ['apply', '--3way', patchFile], { cwd: this.root, timeout: 60_000 });
        for (const item of movedUntracked) {
          const target = path.resolve(this.root, item.rel);
          if (!fs.existsSync(target) && fs.existsSync(item.target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(item.target, target);
          }
        }
      } catch (rollbackError) {
        throw new Error(`DeepSeek Harness 更新失败，且恢复失败：${short(rollbackError?.message || rollbackError)}`);
      }
      throw new Error(`DeepSeek Harness 更新失败：${short(error?.message || error)}`);
    }
  }
}

module.exports = { DeepSeekHarnessUpdater, DEFAULT_REMOTE, DEFAULT_BRANCH };
