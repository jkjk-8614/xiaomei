#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifySourceSnapshot } from './current-source-snapshot.mjs';

const root = process.cwd();
await verifySourceSnapshot();
const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-package', 'build', 'python', '__pycache__']);
const forbidden = [
  /^(?:data|assets|output|user_data|logs|\.xiaomei-data|\.ui-patch-backup)(?:[\\/]|$)/i,
  /(?:^|[\\/])global_config\.json$/i,
  /(?:^|[\\/])(?:\.cache|\.pytest_cache|\.venv|\.idea|\.vscode)(?:[\\/]|$)/i,
  /^ComfyUI[\\/]comfy_model_preferences\.json$/i,
  /^desktop[\\/]update-config\.local\.json$/i,
  /^packages[\\/].*\.whl$/i,
  /(?:^|[\\/])__pycache__(?:[\\/]|$)|\.(?:pyc|pyo|bak|tmp)$/i,
  /(^|[\\/])\.env$/i,
  /(^|[\\/])\.xiaomei-data([\\/]|$)/i,
  /(^|[\\/])history\.json$/i,
  /(^|[\\/])user_data([\\/]|$)/i,
  /^assets[\\/](?:input|uploads|output|library)(?:[\\/]|$)/i,
  /^data[\\/](?:models|conversations|canvases)(?:[\\/]|$)/i,
  /^ComfyUI[\\/](?:models|model_downloads|model-downloads|input|output|user|temp|\.venv)(?:[\\/]|$)/i,
];

function isPrivateEnv(file) {
  return /(^|[\\/])\.env(?:\.[^\\/]+)*$/i.test(file) && !/(^|[\\/])\.env(?:\.[^\\/]+)?\.example$/i.test(file);
}

const found = [];
for (const file of ['requirements.txt', 'requirements-lock.txt']) {
  const content = await readFile(path.join(root, file), 'utf8');
  if (/^\s*(?:onnxruntime[-_]gpu|nvidia[-_])/mi.test(content)) {
    throw new Error(`${file} 必须只包含 CPU 基础依赖；GPU/CUDA/cuDNN 通过可选组件安装器下载`);
  }
}
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).split('\0').filter(Boolean);
const trackedForbidden = tracked.filter((file) => /^(?:node_modules|python)(?:[\\/]|$)/i.test(file) || forbidden.some(pattern => pattern.test(file)) || isPrivateEnv(file));
if (trackedForbidden.length) {
  console.error('Git 跟踪列表包含运行数据或本地安装文件：');
  for (const file of trackedForbidden.slice(0, 30)) console.error(`- ${file}`);
  process.exit(1);
}
async function walk(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const next = relative ? path.join(relative, entry.name) : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, next);
    else if (isPrivateEnv(next) || forbidden.some((pattern) => pattern.test(next))) found.push(next);
  }
}

await walk(root);
if (found.length) {
  console.error('发布输入包含运行数据或敏感配置：');
  for (const file of found.slice(0, 30)) console.error(`- ${file}`);
  process.exit(1);
}
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const sensitiveText = /\.(?:py|js|cjs|mjs|json|html|css|md|txt|yml|yaml|xml|sh|ps1|bat|command|vbs)$/i;
const secretCandidates = [];
for (const file of tracked) {
  if (!sensitiveText.test(file) || /^(?:vendor|tests|\.github)(?:[\\/]|$)/i.test(file)) continue;
  const full = path.join(root, file);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile() || info.size > 8 * 1024 * 1024) continue;
  const content = await readFile(full, 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(content))) secretCandidates.push(file);
}
if (secretCandidates.length) {
  console.error('源码疑似包含真实密钥：');
  for (const file of secretCandidates.slice(0, 30)) console.error(`- ${file}`);
  process.exit(1);
}
const envExample = await readFile(path.join(root, 'API/.env.example'), 'utf8');
if (/^\s*[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET)\s*=\s*[^\s#]+/mi.test(envExample)) {
  throw new Error('API/.env.example 中不得预填真实凭据');
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8'));
const notes = JSON.parse(await readFile(path.join(root, 'static/update-notes.json'), 'utf8'));
const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const tag = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? process.env.INPUT_RELEASE_TAG : process.env.GITHUB_REF_NAME;
if (pkg.version !== version || desktopPkg.version !== version || notes.version !== version || pkg.displayVersion !== desktopPkg.displayVersion || (tag && tag !== `v${pkg.displayVersion}`)) {
  throw new Error('发布标签、软件显示版本、内部版本和更新清单不一致');
}
for (const required of ['ComfyUI/web/comfyui.html', 'ComfyUI/integration/comfy_apps.py', 'API/.env.example']) {
  const info = await stat(path.join(root, required)).catch(() => null);
  if (!info?.isFile()) throw new Error(`缺少发布文件：${required}`);
}
console.log('release input check passed');
