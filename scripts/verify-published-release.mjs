#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions, normalizeManifest } = require('../desktop/updater.cjs');
const repository = process.env.GITHUB_REPOSITORY || 'jkjk-8614/xiaomei';
const tag = process.env.RELEASE_TAG;
const token = process.env.GH_TOKEN;
const directory = path.resolve(process.argv[2] || 'release-assets');
const draftMode = process.argv.includes('--draft');
if (!tag || !token) throw new Error('缺少发布标签或 GitHub 凭据');

const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'Xiaomei-release-verification' };
async function api(suffix) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, { headers });
  if (!response.ok) throw new Error(`GitHub 发布核对失败：HTTP ${response.status} (${suffix})`);
  return response.json();
}
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const localManifestText = await readFile(path.join(directory, 'update.json'), 'utf8');
const manifest = JSON.parse(localManifestText);
if (tag !== `v${pkg.displayVersion}` || manifest.version !== pkg.version || manifest.displayVersion !== pkg.displayVersion || manifest.buildRevision !== Number(process.env.GITHUB_RUN_NUMBER)) {
  throw new Error('标签、显示版本、内部版本、构建编号与更新清单不一致');
}
if (manifest.releases?.length !== 2 || compareVersions(pkg.version, `1.0.${Number(pkg.version.split('.')[2]) - 1}`) <= 0) throw new Error('更新清单的版本或附件数量无效');
for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']]) {
  const normalized = normalizeManifest(manifest, { platform, arch });
  if (!normalized.ok || normalized.version !== pkg.version || normalized.buildRevision !== manifest.buildRevision) throw new Error(`${platform}/${arch} 不能识别新版`);
}

const release = (await api('releases?per_page=100')).find((item) => item.tag_name === tag);
if (!release) throw new Error(`GitHub 上没有找到 ${tag} Release`);
if (Boolean(release.draft) !== draftMode || release.prerelease || release.name !== `小美画布 v${pkg.displayVersion}` || String(release.body || '') !== '') {
  throw new Error('发布标题、正式状态或空正文不符合规则');
}
const expected = new Map([['update.json', { size: Buffer.byteLength(localManifestText) }]]);
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const entry of manifest.releases) {
  const normalizedName = entry.fileName.replace(/^小美画布(?=-v\d)/, '');
  const file = path.join(directory, entry.fileName);
  const info = await stat(file);
  const digest = await sha256(file);
  if (info.size !== entry.size || digest !== entry.sha256) throw new Error(`${entry.fileName} 与更新清单不一致`);
  if (entry.downloadUrl !== `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(normalizedName)}`) {
    throw new Error(`${entry.fileName} 下载地址无效`);
  }
  expected.set(normalizedName, { size: info.size });
}
const uploaded = (release.assets || []).filter((asset) => asset.state === 'uploaded');
if (uploaded.length !== expected.size) throw new Error('发布附件数量不一致');
for (const asset of uploaded) {
  if (!expected.has(asset.name) || expected.get(asset.name).size !== asset.size) throw new Error(`发布附件不一致：${asset.name}`);
}

if (draftMode) {
  console.log(`已核对 ${tag} 草稿：空正文、3 个附件、2 个平台和构建编号 ${manifest.buildRevision}`);
  process.exit(0);
}

let remoteManifest;
let latest;
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    latest = await api('releases/latest');
    const response = await fetch(`https://github.com/${repository}/releases/latest/download/update.json`, { headers: { 'user-agent': 'Xiaomei-release-verification' } });
    if (!response.ok) throw new Error(`更新清单下载 HTTP ${response.status}`);
    remoteManifest = JSON.parse(await response.text());
    if (latest.tag_name === tag && remoteManifest.version === manifest.version && remoteManifest.buildRevision === manifest.buildRevision) break;
  } catch (error) {
    if (attempt === 5) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (latest?.tag_name !== tag || remoteManifest?.version !== manifest.version || remoteManifest?.buildRevision !== manifest.buildRevision) {
  throw new Error('最新版下载入口仍未指向本次更新');
}
console.log(`已核对 ${tag}：空正文、3 个附件、2 个平台、构建编号 ${manifest.buildRevision} 和最新版更新入口`);
