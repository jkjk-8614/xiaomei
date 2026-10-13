const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DesktopUpdater } = require('../desktop/updater.cjs');

const bytes = Buffer.from('update network fixture');
const manifest = {
  version: '1.0.6', platform: process.platform, arch: process.arch,
  artifact: process.platform === 'darwin' ? 'zip' : 'nsis',
  fileName: process.platform === 'darwin' ? 'test.zip' : 'test.exe',
  installerUrl: 'https://downloads.example.com/app.exe',
  size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
};
const json = value => new Response(JSON.stringify(value));
const release = [{ tag_name: 'v1.06', assets: [{ id: 123, name: 'update.json', browser_download_url: 'https://github.com/example/update.json' }] }];
const pending = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
  else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t, fetchImpl, provider = 'github') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider, manifestUrl: 'https://github.com/example/update.json' }));
  return new DesktopUpdater({ app: { isPackaged: true, getVersion: () => '1.0.5' }, runtimeRoot: root, configPath, fetchImpl });
}

test('blocked github.com falls back to the asset API and uses the same transport for downloads', async t => {
  const urls = [];
  const updater = setup(t, async (url, options) => {
    urls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    if (url.startsWith('https://github.com/')) throw new TypeError('fetch failed');
    if (url.includes('/releases?')) return json(release);
    if (url.includes('/releases/assets/123')) {
      assert.equal(options.headers.accept, 'application/octet-stream');
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/manifest' } });
    }
    if (url.includes('/manifest')) return json(manifest);
    return new Response(bytes);
  });
  const result = await updater.check();
  assert.equal(result.status, 'available');
  const downloaded = await updater.download(result);
  assert.deepEqual(fs.readFileSync(downloaded.path), bytes);
  assert.ok(urls.some(url => url.includes('/releases/assets/123')));
  assert.equal(urls.at(-1), manifest.installerUrl);
});

test('all metadata requests share a twenty second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const calls = [];
  const updater = setup(t, async (url, { signal }) => {
    calls.push(url);
    if (url.includes('/releases?')) {
      await new Promise(resolve => setTimeout(resolve, 5500));
      return json(release);
    }
    return pending(signal);
  });
  const check = updater.check();
  t.mock.timers.tick(6000); await flush();
  t.mock.timers.tick(5500); await flush();
  t.mock.timers.tick(6000); await flush();
  assert.equal(calls.length, 4);
  t.mock.timers.tick(2500); await flush();
  const result = await check;
  assert.equal(result.code, 'timeout');
  assert.equal(Date.now(), 120000);
});

for (const [detail, code] of [
  ['net::ERR_PROXY_CONNECTION_FAILED', 'proxy_unavailable'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls_error'],
  ['net::ERR_NAME_NOT_RESOLVED', 'dns_error'],
]) test(`explains ${code} without exposing raw network details`, async t => {
  const updater = setup(t, async () => { throw new Error(detail); }, 'manifest');
  const result = await updater.check();
  assert.equal(result.code, code);
  assert.match(result.message, /重试/);
  assert.ok(!result.message.includes('net::'));
});

test('explains rate limits and malformed responses', async t => {
  let response = new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  const updater = setup(t, async () => response, 'manifest');
  assert.equal((await updater.check()).code, 'rate_limited');
  response = new Response('<html>gateway failure</html>');
  assert.equal((await updater.check()).code, 'invalid_json');
});

test('rejects an unsafe redirect before contacting its target', async t => {
  let calls = 0;
  const updater = setup(t, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://unsafe.example/app.exe' } });
  }, 'manifest');
  assert.equal((await updater.check()).code, 'unsafe_redirect');
  assert.equal(calls, 1);
  await assert.rejects(updater.download(manifest), { code: 'unsafe_redirect' });
  assert.equal(calls, 2);
});

test('stalled downloads time out, remove partial files, and can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let streaming;
  const started = new Promise(resolve => { streaming = resolve; });
  const updater = setup(t, async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    },
    pull() { streaming(); },
  })));
  const download = updater.download(manifest);
  const rejected = assert.rejects(download, { code: 'timeout' });
  await started;
  // Wait until the partial chunk has been written and the next read is waiting.
  while (!fs.existsSync(path.join(updater.runtimeRoot, 'tmp', 'updates', manifest.fileName)) || fs.statSync(path.join(updater.runtimeRoot, 'tmp', 'updates', manifest.fileName)).size < 3) await flush();
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(fs.existsSync(path.join(updater.runtimeRoot, 'tmp', 'updates', manifest.fileName)), false);
  updater.fetchImpl = async () => new Response(bytes);
  assert.equal((await updater.download(manifest)).sha256, manifest.sha256);
});

test('cancellation during connection is distinct from a timeout', async t => {
  let connecting;
  const connected = new Promise(resolve => { connecting = resolve; });
  const updater = setup(t, async (_url, { signal }) => { connecting(); return pending(signal); });
  const controller = new AbortController();
  const rejected = assert.rejects(updater.download(manifest, { signal: controller.signal }), { code: 'cancelled' });
  await connected;
  controller.abort();
  await rejected;
});

test('wrong size and wrong checksum never leave an installable cache file', async t => {
  const updater = setup(t, async () => new Response(bytes));
  await assert.rejects(updater.download({ ...manifest, size: bytes.length - 1 }), { code: 'size_mismatch' });
  await assert.rejects(updater.download({ ...manifest, sha256: 'a'.repeat(64) }), { code: 'sha256_mismatch' });
  assert.equal(fs.existsSync(path.join(updater.runtimeRoot, 'tmp', 'updates', manifest.fileName)), false);
});
