#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = path.resolve(process.env.XIAOMEI_CURRENT_SOURCE || 'D:/小美画布');
const snapshotPath = path.join(releaseRoot, 'source-snapshot.json');
const capture = process.argv.includes('--capture');
const local = process.argv.includes('--local');
const criticalPackagedPaths = [
  'main.py', 'runtime_paths.py', 'skill_capabilities.py', 'desktop/main.cjs', 'desktop/preload.cjs',
  'desktop/harness-mcp-entry.js',
  'desktop/harness-patches/manifest.json', 'desktop/harness-patches/README.md',
  'desktop/harness-patches/xiaomei-adapter.patch',
  'static/index.html', 'static/smart-canvas.html',
  'static/js/smart-canvas.js', 'static/css/smart-canvas.css',
  'static/inspiration.html', 'static/js/inspiration.js',
  'inspiration_library.py', 'project_agent_store.py',
  'multi_agent_api.py', 'multi_agent_runtime.py', 'multi_agent_store.py',
  'static/js/canvas-multi-agent.js', 'static/js/smart-canvas-reference-picker.js',
  'ComfyUI/integration/comfy_model_downloads.py', 'ComfyUI/integration/comfy_model_links.py',
  'ComfyUI/web/js/comfy-models.js', 'ComfyUI/web/css/comfy-models.css',
  'ComfyUI/tools/comfy-app-bridge/__init__.py',
  'ComfyUI/tools/comfy-app-bridge/web/bridge.js',
  'ComfyUI/tools/comfy-app-bridge/README.md',
  'tools/chrome-model-downloader/manifest.json', 'tools/chrome-model-downloader/popup.html',
  'tools/chrome-model-downloader/popup.js', 'tools/chrome-model-downloader/popup.css',
  'tools/chrome-model-downloader/README.md',
];

function gitFiles(args) {
  const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`无法读取当前功能源码目录：${sourceRoot}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(file => file.replaceAll('\\', '/'));
}

function isProductSource(file, tracked) {
  const extension = path.extname(file).toLowerCase();
  if (/^[^/]+\.py$/.test(file) && file !== 'get-pip.py') return true;
  if (file === 'requirements.txt' || file === 'requirements-lock.txt' || file === 'API/.env.example') return true;
  if (/^desktop\/[^/]+\.(?:cjs|js)$/.test(file)) {
    return !/^desktop\/(?:_probe|_argv)(?:[_./]|$)/i.test(file);
  }
  if (/^desktop\/harness-patches\/[^/]+$/.test(file)) {
    return ['.json', '.md', '.patch'].includes(extension);
  }
  if (file.startsWith('static/')) {
    if (['.html', '.js', '.css', '.svg', '.json'].includes(extension)) {
      return !/^static\/_probe(?:[_./]|$)/i.test(file) && !/\.bak-/i.test(file);
    }
    return ['.png', '.jpg', '.jpeg', '.gif', '.ico'].includes(extension)
      && (tracked || /^static\/images\/(?:file-icons|inspiration)\//.test(file));
  }
  if (/^ComfyUI\/(?:integration|web)\//.test(file)) {
    return ['.py', '.js', '.html', '.css', '.svg'].includes(extension);
  }
  if (/^ComfyUI\/tools\/comfy-app-bridge\//.test(file)) {
    return ['.py', '.js', '.md'].includes(extension);
  }
  if (/^tools\/chrome-model-downloader\/[^/]+$/.test(file)) {
    return ['.js', '.json', '.html', '.css', '.md'].includes(extension);
  }
  if (/^tools\/skill-capabilities\/[^/]+$/.test(file)) {
    return ['.py', '.js', '.json', '.md'].includes(extension);
  }
  if (/^(?:tools|workflows)\//.test(file)) {
    return tracked && ['.py', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.svg', '.yaml', '.yml'].includes(extension);
  }
  return false;
}

const textExtensions = new Set(['.py', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.svg', '.yaml', '.yml', '.txt', '.md', '.patch']);
function fileHash(bytes, file) {
  const content = (textExtensions.has(path.extname(file).toLowerCase()) || path.basename(file) === '.env.example')
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : bytes;
  return createHash('sha256').update(content).digest('hex');
}
async function hashAt(root, file) {
  if (file.includes('..') || path.isAbsolute(file)) throw new Error(`无效源码路径：${file}`);
  const full = path.resolve(root, file);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error(`源码路径越界：${file}`);
  const content = await readFile(full);
  return fileHash(content, file);
}

async function sourcePaths() {
  const tracked = gitFiles(['ls-files', '--cached', '-z']);
  const untracked = gitFiles(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([
    // A deleted tracked file is still returned by `git ls-files`; do not turn
    // an intentional source deletion into a release snapshot failure.
    ...tracked.filter(file => existsSync(path.join(sourceRoot, file)) && isProductSource(file, true)),
    ...untracked.filter(file => isProductSource(file, false)),
  ])].sort();
}

async function verifyRelease(snapshot) {
  for (const entry of snapshot.files) {
    if (await hashAt(releaseRoot, entry.path) !== entry.releaseSha256) {
      throw new Error(`发布源码与快照不一致：${entry.path}`);
    }
  }
}

export async function verifySourceSnapshot({ checkLocal = false } = {}) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.files) || !snapshot.files.length) {
    throw new Error('当前功能源码快照无效');
  }
  await verifyRelease(snapshot);
  if (checkLocal) {
    const current = await sourcePaths();
    const expected = snapshot.files.map(entry => entry.path);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error('当前开发目录的程序文件列表已变化；请先同步最新功能再发布');
    }
    for (const entry of snapshot.files) {
      if (await hashAt(sourceRoot, entry.path) !== entry.sourceSha256) {
        throw new Error(`当前开发目录已有未同步功能：${entry.path}`);
      }
    }
  }
  console.log(`当前功能源码快照通过：${snapshot.files.length} 个文件${checkLocal ? '，开发目录一致' : ''}`);
  return snapshot;
}

export async function refreshReleaseSnapshot(files) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  for (const file of files) {
    const entry = snapshot.files.find(item => item.path === file);
    if (!entry) throw new Error(`当前功能快照缺少版本文件：${file}`);
    entry.releaseSha256 = await hashAt(releaseRoot, file);
  }
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await verifySourceSnapshot({ checkLocal: true });
}

if (capture) {
  const files = [];
  const missing = [];
  for (const file of await sourcePaths()) {
    try {
      files.push({ path: file, sourceSha256: await hashAt(sourceRoot, file), releaseSha256: await hashAt(releaseRoot, file) });
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(file);
      else throw error;
    }
  }
  if (missing.length) throw new Error(`发布候选缺少当前程序源码：${missing.join(', ')}`);
  if (criticalPackagedPaths.some(file => !files.some(entry => entry.path === file))) {
    throw new Error('当前功能快照缺少关键安装包源码');
  }
  await writeFile(snapshotPath, `${JSON.stringify({ schemaVersion: 1, criticalPackagedPaths, files }, null, 2)}\n`);
  console.log(`已记录当前功能源码：${files.length} 个文件`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySourceSnapshot({ checkLocal: local });
}
