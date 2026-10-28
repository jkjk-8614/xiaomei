'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git';
const DEFAULT_BRANCH = 'master';

function short(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isNetworkError(error) {
  const message = String(error?.message || error || '');
  if (error?.code === 'HARNESS_UPDATE_NETWORK') return true;
  if (/returned error: (?:400|401|403|404)|authentication failed|certificate (?:problem|verify failed)|unable to get local issuer/i.test(message)) return false;
  return /无法连接 GitHub|schannel:.*(?:handshake|SSL\/TLS)|SSL_ERROR_SYSCALL|OpenSSL SSL_(?:connect|read)|unexpected eof while reading|SSL connection|TLS connection|could not resolve (?:host|proxy)|failed to connect|connection (?:reset|timed out)|remote end hung up|HTTP\/2.*(?:error|closed)|RPC failed; curl|git .*\b(?:ls-remote|fetch)\b.*超时/i.test(message);
}

function proxyUrl(value) {
  const first = String(value || '').split(';')[0].trim();
  const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+(\S+)$/i.exec(first);
  if (!match) return '';
  const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS5: 'socks5h', SOCKS4: 'socks4a' }[match[1].toUpperCase()];
  try {
    const parsed = new URL(`${scheme}://${match[2]}`);
    return parsed.hostname && parsed.port && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}

async function runRemoteGit(args, { cwd, timeout, remote, resolveProxy, platform = process.platform, runCommand = run } = {}) {
  const options = { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  try {
    return await runCommand('git', args, options);
  } catch (error) {
    if (!/^https?:\/\//i.test(remote || '') || !isNetworkError(error)) throw error;
    // Keep these settings local to this retry; never rewrite the user's Git config.
    const retryArgs = ['-c', 'http.version=HTTP/1.1'];
    if (platform === 'win32' && /schannel:.*(?:handshake|SSL\/TLS)/i.test(error.message)) {
      retryArgs.push('-c', 'http.sslBackend=openssl');
    }
    try {
      const proxy = proxyUrl(await resolveProxy?.(remote));
      if (proxy) retryArgs.push('-c', `http.proxy=${proxy}`);
    } catch {}
    try {
      return await runCommand('git', [...retryArgs, ...args], options);
    } catch (retryError) {
      if (!isNetworkError(retryError)) throw retryError;
      const failed = new Error(`无法连接 GitHub，请检查网络或系统代理后重试。${short(retryError.message, 1000)}`);
      failed.code = 'HARNESS_UPDATE_NETWORK';
      throw failed;
    }
  }
}

function pnpmCommand(root) {
  const localPnpm = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  if (fs.existsSync(localPnpm)) return { command: 'node', prefix: [localPnpm] };
  return { command: process.platform === 'win32' ? 'corepack.cmd' : 'corepack', prefix: ['pnpm'] };
}

/**
 * Capture the complete adapter worktree, including files that are not tracked
 * yet. A plain `git diff HEAD` silently omits new adapter modules, which would
 * make a successful upstream update drop them after the temporary backup is
 * removed. An intent-to-add index keeps the real index and worktree untouched.
 */
async function captureWorktreePatch(root, dataRoot) {
  const index = path.join(dataRoot, `harness-update-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await run('git', ['read-tree', 'HEAD'], { cwd: root, env, timeout: 30_000 });
    await run('git', ['add', '-N', '.'], { cwd: root, env, timeout: 30_000 });
    return await run('git', ['diff', '--binary', 'HEAD'], { cwd: root, env, timeout: 30_000 });
  } finally {
    try { fs.rmSync(index, { force: true }); } catch {}
    try { fs.rmSync(`${index}.lock`, { force: true }); } catch {}
  }
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

function sameFileContents(leftPath, rightPath) {
  const left = fs.readFileSync(leftPath);
  const right = fs.readFileSync(rightPath);
  if (left.equals(right)) return true;
  // Git may normalize line endings when a patch is applied in a Windows
  // checkout. Adapter additions are normally text, so compare their logical
  // contents while keeping binary files byte exact.
  if (left.includes(0) || right.includes(0)) return false;
  return left.toString('utf8').replace(/\r\n/g, '\n')
    === right.toString('utf8').replace(/\r\n/g, '\n');
}

function isHash(value) {
  return /^[0-9a-f]{7,64}$/i.test(String(value || '').trim());
}

class DeepSeekHarnessUpdater {
  constructor({ root, dataRoot, remote = DEFAULT_REMOTE, branch = DEFAULT_BRANCH, resolveProxy } = {}) {
    this.root = path.resolve(root || '');
    this.dataRoot = path.resolve(dataRoot || path.join(this.root, '.xiaomei-data'));
    this.remote = String(remote || DEFAULT_REMOTE).trim();
    this.branch = String(branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
    this.resolveProxy = resolveProxy;
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
      const remoteOutput = await runRemoteGit(['ls-remote', this.remote, this.branch], { cwd: this.root, timeout: 20_000, remote: this.remote, resolveProxy: this.resolveProxy });
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
            await run('git', ['cat-file', '-e', `${remoteCommit}^{commit}`], { cwd: this.root, timeout: 10_000 });
            try {
              await run('git', ['merge-base', '--is-ancestor', local.commit, remoteCommit], { cwd: this.root, timeout: 10_000 });
            } catch { fastForward = false; }
          } catch {
            // ls-remote can report a commit we have not fetched yet.
          }
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
      return { ...local, remote: this.remote, remote_branch: this.branch, update_available: false, status: 'unavailable', error_code: error.code, message: short(error?.message || error, 1000) };
    }
  }

  async update({ onProgress } = {}) {
    const report = (stage, message) => { try { onProgress?.({ stage, message }); } catch {} };
    const check = await this.check();
    if (!check.available) throw new Error(check.message || 'DeepSeek Harness 不可用');
    if (check.status === 'unavailable') {
      const error = new Error(check.message || '无法检查 DeepSeek Harness 上游版本，请稍后重试');
      error.code = check.error_code;
      throw error;
    }
    if (!check.update_available) return { ...check, updated: false };
    if (!check.fast_forward) throw new Error('本地 DeepSeek Harness 与上游分叉，请先手动处理本地提交');

    const backupDir = path.join(this.dataRoot, 'deepseek-harness-updates', new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
    const patchFile = path.join(backupDir, 'xiaomei-adapter.patch');
    // 时间戳目录只保留「这一次」的备份，事后不好找。同时写一份稳定路径的副本，
    // 冲突时 desktop/harness-patch.cjs 和人工恢复都能直接拿到最新适配补丁。
    const stablePatchFile = path.join(this.dataRoot, 'deepseek-harness-adapter.patch');
    const untrackedBackupRoot = path.join(backupDir, 'untracked');
    const previousCommit = check.commit;
    fs.mkdirSync(backupDir, { recursive: true });
    let patchSaved = false;
    let worktreeChanged = false;
    const movedUntracked = [];
    try {
      report('backup', '正在保存小美画布适配补丁');
      const diff = await captureWorktreePatch(this.root, this.dataRoot);
      if (diff.stdout.trim()) {
        fs.writeFileSync(patchFile, diff.stdout, 'utf8');
        try { fs.writeFileSync(stablePatchFile, diff.stdout, 'utf8'); } catch {}
        patchSaved = true;
      }
      report('download', '正在获取 DeepSeek Harness 上游更新');
      const shallow = short((await run('git', ['rev-parse', '--is-shallow-repository'], { cwd: this.root, timeout: 10_000 })).stdout) === 'true';
      await runRemoteGit(shallow ? ['fetch', '--unshallow', this.remote, this.branch] : ['fetch', this.remote, this.branch], { cwd: this.root, timeout: 15 * 60_000, remote: this.remote, resolveProxy: this.resolveProxy });
      const fetchedCommit = short((await run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: this.root, timeout: 10_000 })).stdout, 80);
      if (fetchedCommit !== check.remote_commit) throw new Error('检查更新期间上游版本发生变化，请重新检查');
      try {
        await run('git', ['merge-base', '--is-ancestor', previousCommit, fetchedCommit], { cwd: this.root, timeout: 10_000 });
      } catch {
        throw new Error('本地 DeepSeek Harness 与上游分叉，请先手动处理本地提交');
      }
      // Verify the adapter against the fetched tree before changing the live
      // checkout. A conflict must leave its index, source and build intact.
      const probeDir = path.join(backupDir, 'merge-probe');
      try {
        report('patch', '正在预检小美画布适配补丁');
        await run('git', ['clone', '--local', '--no-checkout', this.root, probeDir], { cwd: backupDir, timeout: 5 * 60_000 });
        await run('git', ['checkout', '--detach', fetchedCommit], { cwd: probeDir, timeout: 60_000 });
        if (patchSaved) {
          try {
            await run('git', ['apply', '--3way', patchFile], { cwd: probeDir, timeout: 60_000 });
          } catch (error) {
            const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: probeDir, timeout: 10_000 });
            throw new Error(`适配补丁与上游冲突：${conflicts.stdout.trim() || short(error?.message || error)}（补丁已存于 ${patchFile}；处理步骤见 desktop/harness-patches/README.md）`);
          }
        }
        for (const rel of check.untracked_files || []) {
          const source = path.resolve(this.root, rel);
          const target = path.resolve(probeDir, rel);
          if (!source.startsWith(`${this.root}${path.sep}`) || !fs.existsSync(source) || !fs.existsSync(target)) continue;
          if (!sameFileContents(source, target)) throw new Error(`未跟踪适配文件与上游冲突：${rel}`);
        }
      } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
      worktreeChanged = true;
      for (const rel of check.untracked_files || []) {
        const source = path.resolve(this.root, rel);
        const target = path.resolve(untrackedBackupRoot, rel);
        if (!source.startsWith(`${this.root}${path.sep}`) || !fs.existsSync(source)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
        movedUntracked.push({ rel, source, target });
      }
      // Ignored node_modules and generated lib/ output stay in place until the
      // build; tracked and newly added adapter source came through the patch.
      await run('git', ['reset', '--hard', 'HEAD'], { cwd: this.root, timeout: 30_000 });
      await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: this.root, timeout: 60_000 });
      if (patchSaved) {
        report('patch', '正在重新应用小美画布适配补丁');
        try {
          await run('git', ['apply', '--3way', patchFile], { cwd: this.root, timeout: 60_000 });
        } catch (error) {
          const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.root, timeout: 10_000 });
          throw new Error(`适配补丁与上游冲突：${conflicts.stdout.trim() || short(error?.message || error)}（补丁已存于 ${patchFile}；处理步骤见 desktop/harness-patches/README.md）`);
        }
      }
      for (const item of movedUntracked) {
        const target = path.resolve(this.root, item.rel);
        if (fs.existsSync(target)) {
          if (!sameFileContents(target, item.target)) throw new Error(`未跟踪适配文件与上游冲突：${item.rel}`);
          fs.rmSync(item.target, { force: true });
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(item.target, target);
        }
      }
      report('build', '正在重新构建 DeepSeek Harness');
      const packageManager = pnpmCommand(this.root);
      const runPnpm = (args) => run(packageManager.command, [...packageManager.prefix, ...args], { cwd: this.root, timeout: 15 * 60_000 });
      await runPnpm(['install', '--frozen-lockfile']);
      await runPnpm(['run', 'build:lib:host']);
      await runPnpm(['run', 'build:lib:client']);
      await runPnpm(['run', 'build:web']);
      report('done', 'DeepSeek Harness 已更新并完成构建');
      const result = await this.localState();
      return { ...result, updated: true, previous_commit: previousCommit, backup_dir: backupDir };
    } catch (error) {
      if (!worktreeChanged) {
        const failed = new Error(`DeepSeek Harness 更新失败：${short(error?.message || error, 1000)}`);
        failed.code = error.code;
        throw failed;
      }
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
        throw new Error(`DeepSeek Harness 更新失败，且恢复失败：${short(rollbackError?.message || rollbackError, 1000)}`);
      }
      throw new Error(`DeepSeek Harness 更新失败：${short(error?.message || error, 1000)}`);
    }
  }
}

module.exports = { DeepSeekHarnessUpdater, DEFAULT_REMOTE, DEFAULT_BRANCH, pnpmCommand, runRemoteGit, isNetworkError };
