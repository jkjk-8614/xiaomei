#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { refreshReleaseSnapshot, verifySourceSnapshot } from './current-source-snapshot.mjs';

const repository = 'jkjk-8614/xiaomei';
const releasePattern = /^v1\.(\d{2})$/;
const requiredAssets = [/Windows-x64\.exe$/, /macOS-arm64\.zip$/, /^update\.json$/];
const dryRun = process.argv.includes('--dry-run');
await verifySourceSnapshot({ checkLocal: true });

function githubToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const credential = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  if (credential.status !== 0) return '';
  return credential.stdout.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice(9) || '';
}
const token = githubToken();
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Xiaomei-release-preparation' };
if (token) headers.authorization = `Bearer ${token}`;

async function githubReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers,
    });
    if (!response.ok) throw new Error(`无法读取 GitHub 正式版本：HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub 返回的发布列表无效');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

function patchOf(version) {
  const match = /^1\.0\.(\d+)$/.exec(String(version || ''));
  if (!match) throw new Error(`内部版本格式无效：${version}`);
  return Number(match[1]);
}

function hasRequiredAssets(release) {
  const names = (release.assets || []).filter((asset) => asset.state === 'uploaded' && asset.size > 0).map((asset) => asset.name);
  return requiredAssets.every((pattern) => names.some((name) => pattern.test(name)));
}

async function completedByWorkflow(release) {
  if (!hasRequiredAssets(release)) return false;
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/desktop-release.yml/runs?branch=${encodeURIComponent(release.tag_name)}&per_page=100`, {
    headers,
  });
  if (!response.ok) throw new Error(`无法核对发布工作流：HTTP ${response.status}`);
  const payload = await response.json();
  const latestRun = Array.isArray(payload.workflow_runs)
    ? payload.workflow_runs.sort((a, b) => Number(b.run_number) - Number(a.run_number))[0]
    : null;
  return latestRun?.status === 'completed' && latestRun.conclusion === 'success';
}

const packageFile = new URL('../package.json', import.meta.url);
const desktopPackageFile = new URL('../desktop/package.json', import.meta.url);
const lockFile = new URL('../desktop/package-lock.json', import.meta.url);
const versionFile = new URL('../VERSION', import.meta.url);
const notesFile = new URL('../static/update-notes.json', import.meta.url);
const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
const desktopPkg = JSON.parse(await readFile(desktopPackageFile, 'utf8'));
const lock = JSON.parse(await readFile(lockFile, 'utf8'));
const notes = JSON.parse(await readFile(notesFile, 'utf8'));
const localPatch = patchOf(pkg.version);
const releases = (await githubReleases()).filter((release) => !release.prerelease && releasePattern.test(release.tag_name || ''));
if (!releases.length) throw new Error('未找到 GitHub 版本，停止自动递增');
releases.sort((a, b) => Number(releasePattern.exec(b.tag_name)[1]) - Number(releasePattern.exec(a.tag_name)[1]));
const latest = releases[0];
const remotePatch = Number(releasePattern.exec(latest.tag_name)[1]);
const latestComplete = !latest.draft && await completedByWorkflow(latest);
const targetPatch = latestComplete ? remotePatch + 1 : remotePatch;
if (localPatch > targetPatch) throw new Error(`本地版本 1.0.${localPatch} 超过待发布版本 1.0.${targetPatch}，请先核对失败的发布`);
if (targetPatch > 99) throw new Error('显示版本已超过 v1.99，请先确定下一段版本规则');
const version = `1.0.${targetPatch}`;
const displayVersion = `1.${String(targetPatch).padStart(2, '0')}`;
const tag = `v${displayVersion}`;
const retry = localPatch === targetPatch && (!latestComplete || latest.tag_name !== tag);

pkg.version = version;
pkg.displayVersion = displayVersion;
desktopPkg.version = version;
desktopPkg.displayVersion = displayVersion;
lock.version = version;
lock.packages[''].version = version;
notes.version = version;
if (!retry) notes.items = [];
delete notes.updated_at;
if (!dryRun) {
  await Promise.all([
    writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`),
    writeFile(desktopPackageFile, `${JSON.stringify(desktopPkg, null, 2)}\n`),
    writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`),
    writeFile(versionFile, `${version}\n`),
    writeFile(notesFile, `${JSON.stringify(notes, null, 2)}\n`),
  ]);
  await refreshReleaseSnapshot(['static/update-notes.json']);
}
console.log(`${dryRun ? '预演' : retry ? '重试' : '准备'} ${tag}：软件显示 v${displayVersion}，内部版本 ${version}${dryRun ? (retry ? '（当前版本重试）' : '（下一正式版本）') : ''}`);
