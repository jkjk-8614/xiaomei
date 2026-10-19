#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2] || '.');
const forbidden = [
  /^(?:data|assets|output|user_data|logs|\.xiaomei-data|\.ui-patch-backup)(?:\/|$)/i,
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|global_config\.json|history\.json|asset_library\.json|projects\.json|prompt_cases\.json|prompt_libraries\.json)$/i,
  /(?:^|\/)(?:\.cache|__pycache__|\.pytest_cache|\.venv)(?:\/|$)/i,
  /^cache(?:\/|$)/i,
  /(?:^|\/)(?:assets|ComfyUI)\/(?:input|uploads|output|library|models|model_downloads|model-downloads|user|temp|图片空间|canvases|conversations|media_previews)(?:\/|$)/i,
];
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const textExtensions = new Set(['.py', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '.xml', '.sh', '.ps1', '.bat', '.command', '.vbs']);
const knownSecrets = process.env.XIAOMEI_RELEASE_SECRETS_FILE
  ? (await readFile(process.env.XIAOMEI_RELEASE_SECRETS_FILE, 'utf8')).split(/\r?\n/)
    .map((line) => line.match(/^\s*[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*(.*?)\s*$/i)?.[1] || '')
    .filter((value) => value.length >= 12 && !/^(?:your|replace|example|test|placeholder)/i.test(value))
  : [];
const violations = [];
let scanned = 0;

async function walk(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (relative === '' && ['.git', 'node_modules', 'dist-package', 'build', 'python'].includes(entry.name)) continue;
    if (!/(?:^|\/)\.env\.example$/i.test(next) && forbidden.some((pattern) => pattern.test(next))) {
      violations.push(`${next}: 运行数据路径`);
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, next);
    else if (entry.isFile()) {
      scanned += 1;
      if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(full);
        if (info.size <= 8 * 1024 * 1024) {
          const content = await readFile(full, 'utf8');
          const packageDependency = /(?:^|\/)node_modules\/|^bundled\/win-api\/Lib\/site-packages\//i.test(next);
          if (knownSecrets.some((value) => content.includes(value)) || (!packageDependency && secretPatterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(content); }))) {
            violations.push(`${next}: 疑似真实密钥`);
          }
        }
      }
    }
  }
}

await walk(root);
const snapshot = JSON.parse(await readFile(new URL('../source-snapshot.json', import.meta.url), 'utf8'));
for (const file of [
  'tools/commerce-analysis/node_modules/playwright/package.json',
  'tools/commerce-analysis/node_modules/playwright-core/package.json',
]) {
  if (!await stat(path.join(root, file)).then(info => info.isFile()).catch(() => false)) {
    violations.push(`${file}: 浏览器自动化运行依赖缺失`);
  }
}
if (process.platform === 'darwin') {
  const archive = path.join(root, 'bundled', 'playwright-browsers.tar.gz');
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile() || info.size < 1024 * 1024) {
    violations.push('bundled/playwright-browsers.tar.gz: macOS 浏览器运行组件缺失');
  }
}
for (const file of snapshot.criticalPackagedPaths || []) {
  const expected = snapshot.files.find((entry) => entry.path === file)?.releaseSha256;
  if (!expected) throw new Error(`当前功能快照缺少关键文件：${file}`);
  const packaged = await readFile(path.join(root, file)).catch(() => null);
  const normalized = packaged && Buffer.from(packaged.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  if (!normalized || createHash('sha256').update(normalized).digest('hex') !== expected) {
    violations.push(`${file}: 安装包内容与当前功能源码不一致`);
  }
}
if (violations.length) {
  for (const violation of violations.slice(0, 50)) console.error(violation);
  throw new Error(`发布隐私检查失败：${violations.length} 项`);
}
console.log(`发布隐私检查通过：${scanned} 个文件`);
