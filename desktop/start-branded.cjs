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
const { spawn } = require('child_process');
const { brand, BRANDED_EXE } = require('./brand-electron-exe.cjs');

const DESKTOP_DIR = __dirname;

const result = brand();
if (!result.ok) {
  process.stderr.write(`[start] 未能更新应用名称与图标（${result.reason}）\n`);
}

const exePath = process.platform === 'win32' && fs.existsSync(BRANDED_EXE)
  ? BRANDED_EXE : require('electron');

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
