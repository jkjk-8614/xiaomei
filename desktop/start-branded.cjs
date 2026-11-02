#!/usr/bin/env node
'use strict';

/**
 * `npm start` 的入口：先确保「小美画布.exe」存在且资源正确，再用它启动应用。
 *
 * 直接 `electron .` 走的是 node_modules/electron/dist/electron.exe，
 * 那个文件的名字、图标、版本资源都是 Electron 官方的，任务管理器里就会
 * 显示「Electron」+ 默认图标。这里统一改走品牌化后的 exe。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { brand, BRANDED_EXE } = require('./brand-electron-exe.cjs');

const DESKTOP_DIR = __dirname;

const result = brand();
if (!result.ok) {
  process.stderr.write(`[start] 品牌化未完成（${result.reason}），回退到 electron.exe\n`);
}

const electronExe = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const exePath = fs.existsSync(BRANDED_EXE) ? BRANDED_EXE : electronExe;

const child = spawn(exePath, ['.'], {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
  env: { ...process.env, XIAOMEI_CANVAS_PORT: process.env.XIAOMEI_CANVAS_PORT || '3000' },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  process.stderr.write(`[start] 启动失败：${error.message}\n`);
  process.exit(1);
});
