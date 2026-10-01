'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const path = require('node:path');

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_UPDATE_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_GITHUB_OWNER = 'jkjk-8614';
const DEFAULT_GITHUB_REPO = 'xiaomei';

function normalizeVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const short = text.match(/^(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (short) return `${short[1]}.${short[2]}.0${short[3]}`;
  return VERSION_PATTERN.test(text) ? text : '';
}

function parseVersion(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  const withoutBuild = normalized.split('+')[0];
  const separator = withoutBuild.indexOf('-');
  const core = separator >= 0 ? withoutBuild.slice(0, separator) : withoutBuild;
  const prerelease = separator >= 0 ? withoutBuild.slice(separator + 1) : '';
  const numbers = core.split('.').map((item) => Number(item));
  const identifiers = prerelease ? prerelease.split('.') : [];
  return { numbers, identifiers };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.identifiers.length && !b.identifiers.length) return 0;
  if (!a.identifiers.length) return 1;
  if (!b.identifiers.length) return -1;
  const length = Math.max(a.identifiers.length, b.identifiers.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.identifiers.length) return -1;
    if (index >= b.identifiers.length) return 1;
    const av = a.identifiers[index];
    const bv = b.identifiers[index];
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isAllowedUpdateUrl(value, { allowInsecure = false } = {}) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && (isLoopbackHost(parsed.hostname) || allowInsecure);
  } catch {
    return false;
  }
}

function cleanNotes(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => {
      if (item && typeof item === 'object') return String(item.text || item.title || '').trim();
      return String(item || '').trim();
    })
    .filter(Boolean)
    .slice(0, 30)
    .map((item) => item.slice(0, 500));
}

function normalizeManifest(payload, { platform = process.platform, arch = process.arch, allowInsecure = false, channel = '' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'invalid_manifest', message: '更新清单不是 JSON 对象' };
  }
  let source = payload;
  if (Array.isArray(payload.releases)) {
    const candidates = payload.releases.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    const exact = candidates.find((item) => String(item.platform || '').trim() === platform && String(item.arch || '').trim() === arch);
    const universal = platform === 'darwin'
      ? candidates.find((item) => String(item.platform || '').trim() === platform && String(item.arch || '').trim() === 'universal')
      : null;
    source = exact || universal || candidates.find((item) => String(item.platform || '').trim() === platform) || null;
    if (!source) return { ok: false, code: 'platform_mismatch', message: '更新清单没有适用于当前平台的安装包' };
    source = { ...payload, ...source };
  }
  const version = normalizeVersion(source.version);
  if (!version) {
    return { ok: false, code: 'invalid_version', message: '更新清单缺少有效的 semver 版本号' };
  }
  if (source.platform && String(source.platform).trim() !== platform) {
    return { ok: false, code: 'platform_mismatch', message: '更新清单不适用于当前操作系统' };
  }
  if (source.arch && String(source.arch).trim() !== arch && !(platform === 'darwin' && String(source.arch).trim() === 'universal')) {
    return { ok: false, code: 'arch_mismatch', message: '更新清单不适用于当前 CPU 架构' };
  }
  const manifestChannel = String(source.channel || '').trim();
  if (channel && manifestChannel && manifestChannel !== channel) {
    return { ok: false, code: 'channel_mismatch', message: '更新清单不属于当前更新通道' };
  }
  const artifact = String(source.artifact || (platform === 'darwin' ? 'zip' : 'nsis')).trim().toLowerCase();
  if (platform === 'win32' && artifact !== 'nsis' && artifact !== 'setup') {
    return { ok: false, code: 'unsupported_artifact', message: '当前 Windows 更新仅支持 NSIS 安装版' };
  }
  if (platform === 'darwin' && artifact !== 'zip') {
    return { ok: false, code: 'unsupported_artifact', message: '当前 macOS 更新仅支持 ZIP 安装包' };
  }
  const installerUrl = String(source.installerUrl || source.downloadUrl || source.url || '').trim();
  if (!isAllowedUpdateUrl(installerUrl, { allowInsecure })) {
    return { ok: false, code: 'invalid_download_url', message: '更新清单缺少 HTTPS 安装包地址' };
  }
  const sha256 = String(source.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return { ok: false, code: 'invalid_sha256', message: '更新清单缺少有效的 SHA-256 校验值' };
  }
  const size = source.size === undefined || source.size === null || source.size === ''
    ? 0
    : Number(source.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_BYTES) {
    return { ok: false, code: 'invalid_size', message: '更新清单中的安装包大小无效' };
  }
  const declaredName = String(source.fileName || source.filename || '').trim();
  const fileName = declaredName && path.basename(declaredName) === declaredName
    ? declaredName.slice(0, 180)
    : platform === 'darwin' ? `xiaomei-canvas-${version}-macOS-${arch}.zip` : `xiaomei-canvas-${version}-Setup-x64.exe`;
  const expectedExtension = platform === 'darwin' ? '.zip' : '.exe';
  if (!fileName.toLowerCase().endsWith(expectedExtension)) {
    return { ok: false, code: 'invalid_file_name', message: `更新清单中的安装包必须是 ${expectedExtension} 文件` };
  }
  return {
    ok: true,
    version,
    platform,
    arch,
    channel: manifestChannel || channel || 'stable',
    artifact,
    installerUrl,
    sha256,
    size,
    fileName,
    notes: cleanNotes(payload.notes || payload.releaseNotes),
    publishedAt: String(payload.publishedAt || payload.published_at || '').trim().slice(0, 80),
    mandatory: source.mandatory === true,
  };
}

function withCacheBust(value) {
  const parsed = new URL(String(value));
  parsed.searchParams.set('_xiaomei_update', String(Date.now()));
  return parsed.toString();
}

async function fetchText(url, { timeoutMs = 10000, maxBytes = MAX_MANIFEST_BYTES, allowInsecure = false } = {}) {
  if (!isAllowedUpdateUrl(url, { allowInsecure })) {
    const error = new Error('更新地址必须使用 HTTPS');
    error.code = 'invalid_update_url';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10000));
  try {
    const response = await fetch(withCacheBust(url), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'XiaomeiCanvas-Updater' },
    });
    if (!response.ok) {
      const error = new Error(`更新服务器返回 HTTP ${response.status}`);
      error.code = 'http_error';
      throw error;
    }
    if (response.url && !isAllowedUpdateUrl(response.url, { allowInsecure })) {
      const error = new Error('更新服务器重定向到了不安全地址');
      error.code = 'unsafe_redirect';
      throw error;
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      const error = new Error('更新清单超过允许大小');
      error.code = 'manifest_too_large';
      throw error;
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const error = new Error('更新清单超过允许大小');
      error.code = 'manifest_too_large';
      throw error;
    }
    return text.replace(/^\uFEFF/, '');
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('连接更新服务器超时');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function updateError(message, code = 'update_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

class DesktopUpdater {
  constructor({ app, runtimeRoot, configPath, allowInsecure = false } = {}) {
    this.app = app;
    this.runtimeRoot = runtimeRoot || process.cwd();
    this.configPath = configPath || path.join(__dirname, 'update-config.json');
    this.allowInsecure = Boolean(allowInsecure);
  }

  readConfig() {
    const config = {
      provider: 'github',
      manifestUrl: '',
      github: { owner: DEFAULT_GITHUB_OWNER, repo: DEFAULT_GITHUB_REPO, releaseTag: '', allowPrerelease: true },
      channel: 'stable',
      checkOnStartup: true,
    };
    let parsedProvider = '';
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedProvider = String(parsed.provider || '').trim().toLowerCase();
        Object.assign(config, parsed);
      }
    } catch {}
    const environmentUrl = String(process.env.XIAOMEI_UPDATE_MANIFEST_URL || '').trim();
    if (environmentUrl) config.manifestUrl = environmentUrl;
    const githubOwner = String(process.env.XIAOMEI_UPDATE_GITHUB_OWNER || config.github?.owner || DEFAULT_GITHUB_OWNER).trim();
    const githubRepo = String(process.env.XIAOMEI_UPDATE_GITHUB_REPO || config.github?.repo || DEFAULT_GITHUB_REPO).trim();
    const githubTag = String(process.env.XIAOMEI_UPDATE_GITHUB_TAG || config.github?.releaseTag || '').trim();
    config.github = {
      owner: githubOwner || DEFAULT_GITHUB_OWNER,
      repo: githubRepo || DEFAULT_GITHUB_REPO,
      releaseTag: githubTag,
      allowPrerelease: config.github?.allowPrerelease !== false,
    };
    config.provider = String(process.env.XIAOMEI_UPDATE_PROVIDER || parsedProvider || (config.manifestUrl ? 'manifest' : config.provider || 'github')).trim().toLowerCase();
    config.manifestUrl = String(config.manifestUrl || '').trim();
    config.channel = String(config.channel || 'stable').trim() || 'stable';
    config.checkOnStartup = config.checkOnStartup !== false;
    return config;
  }

  currentVersion() {
    return normalizeVersion(this.app?.getVersion?.() || '');
  }

  async fetchGitHubManifest(config) {
    const owner = String(config.github?.owner || DEFAULT_GITHUB_OWNER).trim();
    const repo = String(config.github?.repo || DEFAULT_GITHUB_REPO).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw updateError('GitHub 仓库配置无效', 'invalid_github_repository');
    }
    const tag = String(config.github?.releaseTag || '').trim();
    const endpoint = tag
      ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`
      : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=20`;
    const releases = JSON.parse(await fetchText(endpoint, { maxBytes: 4 * MAX_MANIFEST_BYTES }));
    const candidates = Array.isArray(releases) ? releases : [releases];
    const release = candidates.find((item) => {
      if (!item || item.draft) return false;
      if (!config.github?.allowPrerelease && item.prerelease) return false;
      return Boolean(normalizeVersion(item.tag_name || item.name));
    });
    if (!release) throw updateError('GitHub Releases 中没有可用的版本', 'github_release_not_found');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifestAsset = assets.find((asset) => ['update.json', 'release-manifest.json'].includes(String(asset?.name || '').toLowerCase()));
    if (!manifestAsset?.browser_download_url) {
      throw updateError('GitHub Release 缺少 update.json 清单资产', 'github_manifest_not_found');
    }
    const manifest = JSON.parse(await fetchText(manifestAsset.browser_download_url, { maxBytes: MAX_MANIFEST_BYTES }));
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      if (!manifest.version) manifest.version = normalizeVersion(release.tag_name || release.name);
      if (!manifest.notes && release.body) manifest.notes = cleanNotes(String(release.body).split(/\r?\n/));
      if (!manifest.publishedAt && release.published_at) manifest.publishedAt = release.published_at;
    }
    return manifest;
  }

  async check() {
    if (!this.app?.isPackaged && process.env.XIAOMEI_UPDATE_ALLOW_DEV !== '1') {
      return { status: 'development', version: this.currentVersion(), message: '开发模式不检查桌面版更新' };
    }
    const config = this.readConfig();
    if (config.provider !== 'github' && !config.manifestUrl) {
      return { status: 'disabled', version: this.currentVersion(), message: '尚未配置桌面版更新地址' };
    }
    const current = this.currentVersion();
    if (!current) return { status: 'error', message: '当前桌面版本号无效，无法检查更新' };
    let payload;
    try {
      payload = config.provider === 'github'
        ? await this.fetchGitHubManifest(config)
        : JSON.parse(await fetchText(config.manifestUrl, { allowInsecure: this.allowInsecure }));
    } catch (error) {
      return { status: 'unavailable', version: current, message: error?.message || '无法连接更新服务器' };
    }
    const manifest = normalizeManifest(payload, {
      platform: process.platform,
      arch: process.arch,
      allowInsecure: this.allowInsecure,
      channel: config.channel,
    });
    if (!manifest.ok) return { status: 'invalid', version: current, message: manifest.message, code: manifest.code };
    if (compareVersions(manifest.version, current) <= 0) {
      return { status: 'current', version: current, latestVersion: manifest.version, message: `当前已经是最新版本（${current}）` };
    }
    return { status: 'available', version: current, ...manifest };
  }

  async download(manifest, { signal, onProgress } = {}) {
    const normalized = normalizeManifest(manifest, {
      platform: process.platform,
      arch: process.arch,
      allowInsecure: this.allowInsecure,
      channel: String(manifest?.channel || '').trim(),
    });
    if (!normalized.ok) throw updateError(normalized.message, normalized.code);
    const cacheDirectory = path.join(this.runtimeRoot, 'tmp', 'updates');
    await fsp.mkdir(cacheDirectory, { recursive: true });
    const destination = path.join(cacheDirectory, normalized.fileName);
    const report = (payload) => {
      try { onProgress?.(payload); } catch {}
    };
    try {
      if (fs.existsSync(destination)) {
        const existingHash = await sha256File(destination);
        if (existingHash === normalized.sha256) {
          const existingSize = (await fsp.stat(destination)).size;
          report({ downloadedBytes: existingSize, totalBytes: normalized.size || existingSize, percent: 100, reused: true });
          return { path: destination, size: existingSize, sha256: existingHash, reused: true };
        }
        await fsp.rm(destination, { force: true });
      }
      if (signal?.aborted) throw updateError('已取消更新', 'cancelled');
      const response = await fetch(normalized.installerUrl, { signal, redirect: 'follow', headers: { 'user-agent': 'XiaomeiCanvas-Updater' } });
      if (!response.ok) throw updateError(`下载安装包失败：HTTP ${response.status}`, 'http_error');
      if (response.url && !isAllowedUpdateUrl(response.url, { allowInsecure: this.allowInsecure })) {
        throw updateError('下载安装包重定向到了不安全地址', 'unsafe_redirect');
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      const totalBytes = normalized.size || (Number.isSafeInteger(contentLength) ? contentLength : 0);
      if (totalBytes > MAX_UPDATE_BYTES) throw updateError('安装包超过允许大小', 'update_too_large');
      const reader = response.body?.getReader?.();
      if (!reader) throw updateError('更新服务器没有返回可读的安装包内容', 'empty_body');
      let handle;
      let downloadedBytes = 0;
      try {
        handle = await fsp.open(destination, 'w');
        report({ downloadedBytes: 0, totalBytes, percent: totalBytes ? 0 : null });
        while (true) {
          if (signal?.aborted) throw updateError('已取消更新', 'cancelled');
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          downloadedBytes += value.length;
          if (downloadedBytes > MAX_UPDATE_BYTES) throw updateError('安装包超过允许大小', 'update_too_large');
          await handle.write(Buffer.from(value));
          report({ downloadedBytes, totalBytes, percent: totalBytes ? Math.min(100, Math.round(downloadedBytes / totalBytes * 100)) : null });
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { await handle?.close(); } catch {}
      }
      const actualSize = (await fsp.stat(destination)).size;
      if (normalized.size && actualSize !== normalized.size) {
        throw updateError(`安装包大小校验失败（收到 ${actualSize} 字节，应为 ${normalized.size} 字节）`, 'size_mismatch');
      }
      const actualHash = await sha256File(destination);
      if (actualHash !== normalized.sha256) throw updateError('安装包校验失败，文件可能已损坏', 'sha256_mismatch');
      report({ downloadedBytes: actualSize, totalBytes: normalized.size || actualSize, percent: 100, verified: true });
      return { path: destination, size: actualSize, sha256: actualHash, reused: false };
    } catch (error) {
      try { await fsp.rm(destination, { force: true }); } catch {}
      if (error?.name === 'AbortError') throw updateError('已取消更新', 'cancelled');
      throw error;
    }
  }
}

module.exports = {
  DesktopUpdater,
  compareVersions,
  normalizeVersion,
  normalizeManifest,
  isAllowedUpdateUrl,
  sha256File,
};
