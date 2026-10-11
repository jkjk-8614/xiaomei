#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'dist-package', 'build', 'python', '__pycache__']);
const forbidden = [
  /(^|[\\/])\.env$/i,
  /(^|[\\/])history\.json$/i,
  /(^|[\\/])user_data([\\/]|$)/i,
  /^assets[\\/](?:input|uploads|output|library)(?:[\\/]|$)/i,
  /^data[\\/](?:models|conversations|canvases)(?:[\\/]|$)/i,
  /^ComfyUI[\\/](?:models|input|output|user|temp|\.venv)(?:[\\/]|$)/i,
];

const found = [];
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
const trackedForbidden = tracked.filter((file) => /^(?:data|output|assets|user_data|logs|node_modules|python|\.xiaomei-data)(?:[\\/]|$)|(?:^|[\\/])history\.json$|(?:^|[\\/])\.env$/i.test(file));
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
    else if (forbidden.some((pattern) => pattern.test(next))) found.push(next);
  }
}

await walk(root);
if (found.length) {
  console.error('发布输入包含运行数据或敏感配置：');
  for (const file of found.slice(0, 30)) console.error(`- ${file}`);
  process.exit(1);
}
for (const required of ['ComfyUI/web/comfyui.html', 'ComfyUI/integration/comfy_apps.py', 'API/.env.example']) {
  const info = await stat(path.join(root, required)).catch(() => null);
  if (!info?.isFile()) throw new Error(`缺少发布文件：${required}`);
}
console.log('release input check passed');
