'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oldAppRoot = path.resolve(process.argv[2] || '');
const expectedVersion = String(process.argv[3] || '');
const reportFile = path.resolve(process.argv[4] || '');
if (!fs.existsSync(path.join(oldAppRoot, 'desktop', 'updater.cjs')) || !/^1\.0\.\d+$/.test(expectedVersion)) {
  throw new Error('缺少旧版安装目录或预期版本');
}
const oldPackage = JSON.parse(fs.readFileSync(path.join(oldAppRoot, 'package.json'), 'utf8'));
const { DesktopUpdater } = require(path.join(oldAppRoot, 'desktop', 'updater.cjs'));
const updater = new DesktopUpdater({
  app: { isPackaged: true, getVersion: () => oldPackage.version },
  buildRevision: oldPackage.buildRevision || 0,
  runtimeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-release-upgrade-')),
  configPath: path.join(oldAppRoot, 'desktop', 'update-config.json'),
});

(async () => {
  const result = await updater.check();
  assert.equal(result.status, 'available', JSON.stringify(result));
  assert.equal(result.version, expectedVersion);
  assert.ok(result.buildRevision > Number(oldPackage.buildRevision || 0), '新版构建编号必须递增');
  const download = await updater.download(result);
  assert.ok(download.path && fs.statSync(download.path).size === result.size, '旧版下载的安装包大小错误');
  assert.equal(download.sha256, result.sha256, '旧版下载的安装包哈希错误');
  fs.writeFileSync(reportFile, JSON.stringify({ oldVersion: oldPackage.version, newVersion: result.version, buildRevision: result.buildRevision, installerPath: download.path }));
  console.log(`旧版 ${oldPackage.version} 已识别并下载 ${result.version}，SHA-256 校验通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
