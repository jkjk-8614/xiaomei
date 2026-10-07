const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const {
  DesktopUpdater,
  compareVersions,
  normalizeManifest,
  normalizeVersion,
  isAllowedUpdateUrl,
} = require('../desktop/updater.cjs');

const VALID_MANIFEST = {
  version: '0.1.0-test.3',
  platform: 'win32',
  arch: 'x64',
  artifact: 'nsis',
  installerUrl: 'https://downloads.example.com/xiaomei-setup.exe',
  sha256: 'a'.repeat(64),
  size: 123,
};

test('compares stable and prerelease desktop versions', () => {
  assert.equal(compareVersions('0.1.0-test.3', '0.1.0-test.2'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0-test.9'), 1);
  assert.equal(compareVersions('0.1.0-test.2', '0.1.0-test.2'), 0);
});

test('normalizes only semver versions', () => {
  assert.equal(normalizeVersion('v0.1.0-test.3'), '0.1.0-test.3');
  assert.equal(normalizeVersion('v1.0'), '1.0.0');
  assert.equal(normalizeVersion('2026.9.15'), '2026.9.15');
  assert.equal(normalizeVersion('latest'), '');
});

test('keeps a network failure actionable instead of exposing raw fetch errors', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-updater-network-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const configPath = path.join(temporaryRoot, 'update-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: 'manifest', manifestUrl: 'https://127.0.0.1:1/update.json' }), 'utf8');
  const updater = new DesktopUpdater({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    configPath,
  });
  const result = await updater.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'network_unavailable');
  assert.match(result.message, /GitHub 更新服务器|检查网络/);
});

test('accepts a complete HTTPS NSIS manifest', () => {
  const result = normalizeManifest(VALID_MANIFEST);
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.1.0-test.3');
  assert.equal(result.sha256, 'a'.repeat(64));
});

test('rejects unsafe or incomplete manifests', () => {
  assert.equal(normalizeManifest({ ...VALID_MANIFEST, installerUrl: 'http://downloads.example.com/app.exe' }).ok, false);
  assert.equal(normalizeManifest({ ...VALID_MANIFEST, sha256: 'bad' }).ok, false);
  assert.equal(normalizeManifest({ ...VALID_MANIFEST, artifact: 'portable' }).code, 'unsupported_artifact');
  assert.equal(isAllowedUpdateUrl('file:///C:/app.exe'), false);
  assert.equal(isAllowedUpdateUrl('http://127.0.0.1:8080/update.json'), true);
});

test('selects the matching platform asset from a multi-platform release manifest', () => {
  const result = normalizeManifest({
    version: '0.1.0-test.4',
    channel: 'stable',
    releases: [
      { platform: 'win32', arch: 'x64', artifact: 'nsis', fileName: 'xiaomei-Setup-x64.exe', downloadUrl: 'https://example.com/xiaomei.exe', sha256: 'a'.repeat(64), size: 10 },
      { platform: 'darwin', arch: 'arm64', artifact: 'zip', fileName: 'xiaomei-macOS-arm64.zip', downloadUrl: 'https://example.com/xiaomei-arm64.zip', sha256: 'b'.repeat(64), size: 11 },
    ],
  }, { platform: 'darwin', arch: 'arm64' });
  assert.equal(result.ok, true);
  assert.equal(result.artifact, 'zip');
  assert.equal(result.fileName, 'xiaomei-macOS-arm64.zip');
  assert.equal(result.sha256, 'b'.repeat(64));
});

test('checks build revisions without changing the application version', async (t) => {
  const artifact = process.platform === 'darwin' ? 'zip' : 'nsis';
  let manifest = {
    ...VALID_MANIFEST,
    version: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    artifact,
    buildRevision: 42,
    fileName: artifact === 'zip' ? 'xiaomei.zip' : 'xiaomei.exe',
  };
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(manifest));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-revision-'));
  t.after(() => {
    server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const configPath = path.join(temporaryRoot, 'update-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manifestUrl: `http://127.0.0.1:${server.address().port}/update.json` }));
  const makeUpdater = (version, revision) => new DesktopUpdater({
    app: { isPackaged: true, getVersion: () => version }, configPath, buildRevision: revision,
  });
  assert.equal((await makeUpdater('1.0.0', 41).check()).status, 'available');
  assert.equal((await makeUpdater('1.0.0', 42).check()).status, 'current');
  assert.equal((await makeUpdater('1.0.0', 43).check()).status, 'current');
  assert.equal((await makeUpdater('1.0.10', 0).check()).status, 'available');
  manifest.version = '1.1.0';
  assert.equal((await makeUpdater('1.0.0', 43).check()).status, 'available');
  manifest.buildRevision = 'bad';
  assert.equal((await makeUpdater('1.0.0', 41).check()).code, 'invalid_build_revision');
  delete manifest.buildRevision;
  assert.equal((await makeUpdater('1.0.0', 41).check()).status, 'available');
  manifest.version = '1.0.0';
  assert.equal((await makeUpdater('1.0.0', 41).check()).status, 'current');
});

test('checks, downloads, and verifies a local update artifact', { skip: process.platform !== 'win32' }, async (t) => {
  const installer = Buffer.from('xiaomei-updater-test-installer');
  const sha256 = crypto.createHash('sha256').update(installer).digest('hex');
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/update.json')) {
      const manifest = {
        ...VALID_MANIFEST,
        installerUrl: `http://127.0.0.1:${server.address().port}/app.exe`,
        sha256,
        size: installer.length,
      };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest));
      return;
    }
    response.setHeader('content-type', 'application/octet-stream');
    response.end(installer);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-updater-'));
  t.after(() => {
    try { server.close(); } catch {}
    try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
  });
  const configPath = path.join(temporaryRoot, 'update-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manifestUrl: `http://127.0.0.1:${server.address().port}/update.json` }), 'utf8');
  const updater = new DesktopUpdater({
    app: { isPackaged: true, getVersion: () => '0.1.0-test.2' },
    runtimeRoot: temporaryRoot,
    configPath,
  });
  const result = await updater.check();
  assert.equal(result.status, 'available');
  const downloaded = await updater.download(result);
  assert.equal(downloaded.sha256, sha256);
  assert.equal(fs.readFileSync(downloaded.path).equals(installer), true);
});
