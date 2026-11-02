#!/usr/bin/env node
'use strict';

/**
 * 把 node_modules/electron/dist/electron.exe 复制一份并写入品牌资源，
 * 生成「小美画布.exe」——让 Windows 任务管理器、任务栏、Alt+Tab、文件属性
 * 显示的都是「小美画布」和品牌图标，而不是默认的 Electron。
 *
 * 为什么需要这一步：
 *   Electron 官方运行时的 PE 版本资源写死了 FileDescription=Electron、
 *   ProductName=Electron，图标也是 Electron 默认图标。Windows 任务管理器
 *   的进程列表读的正是这两个东西——主进程因为有窗口标题还能显示「小美画布」，
 *   但渲染进程 / GPU 进程 / utility 进程没有窗口，就全都显示「Electron」
 *   和默认图标（表现为一组 4 个进程里 3 个叫 Electron）。
 *   光把 exe 改名没用：改名只影响文件名，不影响 PE 资源里的描述和图标。
 *
 * 触发时机：
 *   - 首次运行 / 重新 npm install 之后（dist 目录会被整个替换掉）
 *   - launch-hidden.vbs 每次启动前静默调用（已是最新则几十毫秒返回）
 *   - 手动：node desktop/brand-electron-exe.cjs --force
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_NAME = '小美画布';
const DESKTOP_DIR = __dirname;
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, '..');
const DIST_DIR = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist');
const SOURCE_EXE = path.join(DIST_DIR, 'electron.exe');
const BRANDED_EXE = path.join(DIST_DIR, `${APP_NAME}.exe`);
const ICON_PATH = path.join(PROJECT_ROOT, 'static', 'images', 'app-icon.ico');
const STATE_PATH = path.join(DESKTOP_DIR, '.brand-electron-state.json');
const RCEDIT_CANDIDATES = [
  path.join(PROJECT_ROOT, 'tools', 'bin', 'rcedit-x64.exe'),
  path.join(PROJECT_ROOT, 'tools', 'bin', 'rcedit.exe'),
];

const VERSION_STRINGS = {
  FileDescription: APP_NAME,
  ProductName: APP_NAME,
  InternalName: `${APP_NAME}.exe`,
  OriginalFilename: `${APP_NAME}.exe`,
  CompanyName: APP_NAME,
  LegalCopyright: `Copyright © ${new Date().getFullYear()} ${APP_NAME}`,
};

function log(message) {
  process.stdout.write(`[brand] ${message}\n`);
}

function fileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {}
}

function pickRcedit() {
  for (const candidate of RCEDIT_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function isUpToDate(sourceFingerprint) {
  if (!fs.existsSync(BRANDED_EXE)) return false;
  const state = readState();
  if (!state || state.source !== sourceFingerprint || state.appName !== APP_NAME) return false;
  // 目标 exe 必须比生成记录更新或一致，防止被外部工具覆盖回原版
  return fileFingerprint(BRANDED_EXE) === state.branded;
}

function runRcedit(rceditPath, targetExe) {
  const args = [targetExe, '--set-icon', ICON_PATH];
  for (const [key, value] of Object.entries(VERSION_STRINGS)) {
    args.push('--set-version-string', key, value);
  }
  args.push('--set-file-version', '1.0.0.0', '--set-product-version', '1.0.0.0');
  const result = spawnSync(rceditPath, args, { windowsHide: true, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rcedit 退出码 ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function brand({ force = false } = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: 'not-windows' };
  if (!fs.existsSync(SOURCE_EXE)) return { ok: false, reason: 'electron-runtime-missing' };
  if (!fs.existsSync(ICON_PATH)) return { ok: false, reason: 'app-icon-missing' };

  const sourceFingerprint = fileFingerprint(SOURCE_EXE);
  if (!force && isUpToDate(sourceFingerprint)) return { ok: true, skipped: 'up-to-date' };

  const rceditPath = pickRcedit();
  if (!rceditPath) return { ok: false, reason: 'rcedit-missing' };

  // 先写临时文件再原子替换：rcedit 中途失败也不会留下半个坏 exe
  const stagingExe = path.join(DIST_DIR, `${APP_NAME}.branding-${process.pid}.exe`);
  try {
    fs.copyFileSync(SOURCE_EXE, stagingExe);
    runRcedit(rceditPath, stagingExe);
    fs.copyFileSync(stagingExe, BRANDED_EXE);
    const state = {
      appName: APP_NAME,
      source: sourceFingerprint,
      branded: fileFingerprint(BRANDED_EXE),
      generatedAt: new Date().toISOString(),
    };
    writeState(state);
    log(`已生成 ${path.basename(BRANDED_EXE)}（图标 + 版本资源已写入）`);
    return { ok: true, generated: true };
  } catch (error) {
    // 应用正在运行时 exe 被占用，属于正常情况：保留旧文件，下次启动再补
    const message = String(error?.message || error || '');
    const busy = /EBUSY|EPERM|EACCES|being used|拒绝访问/i.test(message);
    if (!busy) log(`生成失败：${message}`);
    return { ok: false, reason: busy ? 'exe-in-use' : 'rcedit-failed', message };
  } finally {
    try { fs.rmSync(stagingExe, { force: true }); } catch {}
  }
}

if (require.main === module) {
  const result = brand({ force: process.argv.includes('--force') });
  if (result.ok) {
    if (result.skipped && process.argv.includes('--verbose')) log(`跳过：${result.skipped}`);
    process.exit(0);
  }
  if (result.reason === 'exe-in-use') {
    log('小美画布正在运行，品牌 exe 暂时无法改写；下次启动会自动补上。');
    process.exit(0);
  }
  log(`未能完成品牌化：${result.reason}${result.message ? ` (${result.message})` : ''}`);
  process.exit(process.argv.includes('--force') ? 1 : 0);
}

module.exports = { brand, BRANDED_EXE, SOURCE_EXE, APP_NAME };
