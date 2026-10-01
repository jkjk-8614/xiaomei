#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith('--')) continue;
  const key = value.slice(2);
  args.set(key, process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[++index] : 'true');
}

const directory = path.resolve(String(args.get('directory') || 'dist-package'));
const output = path.resolve(String(args.get('output') || path.join(directory, 'update.json')));
const version = String(args.get('version') || '').trim().replace(/^v/i, '');
const buildRevision = Number(args.get('build-revision') || 0);
const tag = String(args.get('tag') || `v${version}`).trim();
const repository = String(args.get('repository') || process.env.GITHUB_REPOSITORY || 'jkjk-8614/xiaomei').trim();
const notes = String(args.get('notes') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 30);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`无效版本号：${version || '(空)'}`);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`无效 GitHub 仓库：${repository}`);
if (!Number.isSafeInteger(buildRevision) || buildRevision < 0) throw new Error('无效构建编号');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// GitHub Release keeps the Chinese label but normalizes the actual asset URL
// filename when uploading files whose names begin with "小美画布-v".
function releaseAssetName(fileName) {
  return fileName.replace(/^小美画布(?=-v\d)/, '');
}

function classify(fileName) {
  if (/(?:Setup-x64|Windows-x64)\.exe$/i.test(fileName)) return { platform: 'win32', arch: 'x64', artifact: 'nsis' };
  const mac = fileName.match(/macOS-(x64|arm64|universal)\.zip$/i);
  if (mac) return { platform: 'darwin', arch: mac[1].toLowerCase(), artifact: 'zip' };
  return null;
}

const entries = [];
for (const fileName of await readdir(directory)) {
  const classification = classify(fileName);
  if (!classification) continue;
  const filePath = path.join(directory, fileName);
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1) continue;
  const content = await readFile(filePath);
  entries.push({
    ...classification,
    version,
    fileName,
    downloadUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(releaseAssetName(fileName))}`,
    size: info.size,
    sha256: sha256(content),
  });
}

if (!entries.some((item) => item.platform === 'win32')) throw new Error('没有找到 Windows 安装包');
if (!entries.some((item) => item.platform === 'darwin')) throw new Error('没有找到 macOS ZIP');

const manifest = {
  schemaVersion: 2,
  version,
  buildRevision,
  channel: 'stable',
  publishedAt: new Date().toISOString(),
  notes,
  releases: entries,
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`已生成 ${output}（${entries.length} 个平台资产）`);
