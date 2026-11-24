import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { downloadVideoFile, retryableDownloadError } from './video-downloader.js';
import { createDownloadRetryQueue } from './download-retry.js';
import { createAtomicJsonWriter, createSerialQueue } from './state-storage.js';
import { normalizeFishProxyUrl, normalizeNarrationSegments, renderNarration } from './fish-narration.js';
import { publicFishVoices } from './fish-voices.js';
import { materialServerDefaults } from './material-server-defaults.js';
import { saveSftpPrivateKey } from './sftp-key.js';
import { normalizeContentOptions, groupFingerprint, imageContactSheets, modelImageDataUrls, copyMessages, parseCopyPlan, composeVideoPrompt, videoPromptForGroup, speechRevisionMessages, parseSpeechRevision } from './copy-planner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST_STATIC_DIR = path.resolve(ROOT, '..', '..', 'static');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const BASE_PATH = String(process.env.BASE_PATH || '').replace(/\/+$/, '');
const withBasePath = (pathname) => (BASE_PATH && typeof pathname === 'string' && pathname.startsWith('/') ? `${BASE_PATH}${pathname}` : pathname);
const publicFishVoicesWithBase = () => publicFishVoices().map((voice) => ({ ...voice, previewUrl: withBasePath(voice.previewUrl) }));
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const IMAGE_JOBS_FILE = path.join(DATA_DIR, 'image-jobs.json');
const USED_GROUPS_FILE = path.join(DATA_DIR, 'used-material-groups.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MODEL_REFERENCES_FILE = path.join(DATA_DIR, 'model-references.json');
const THUMBNAIL_DIR = path.join(DATA_DIR, 'thumbnails');
const FISH_AUDIO_CACHE_DIR = path.join(DATA_DIR, 'fish-audio-cache');
const writeJobs = createAtomicJsonWriter(JOBS_FILE);
const writeImageJobs = createAtomicJsonWriter(IMAGE_JOBS_FILE);
const writeModelReferences = createAtomicJsonWriter(MODEL_REFERENCES_FILE);
const enqueueMaterialSync = createSerialQueue();
const MATERIAL_DIR = process.env.MATERIAL_DIR || path.join(ROOT, '素材');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(ROOT, '输出');
const MODEL_REFERENCE_FOLDER = '__model_references__';
const MODEL_REFERENCE_DIR = path.join(DATA_DIR, MODEL_REFERENCE_FOLDER);
const DEFAULT_SFTP_CONFIG = {
  enabled: process.env.SFTP_ENABLED === undefined ? materialServerDefaults.sftpEnabled : String(process.env.SFTP_ENABLED).toLowerCase() !== 'false',
  host: process.env.SFTP_HOST || materialServerDefaults.sftpHost,
  port: process.env.SFTP_PORT ? Number(process.env.SFTP_PORT) : materialServerDefaults.sftpPort,
  username: process.env.SFTP_USERNAME || materialServerDefaults.sftpUsername,
  privateKeyPath: process.env.SFTP_PRIVATE_KEY_PATH || '',
  remoteDir: process.env.SFTP_REMOTE_DIR || materialServerDefaults.sftpRemoteDir,
};

const DEFAULT_CONFIG = {
  apiBaseUrl: process.env.API_BASE_URL || 'https://www.6789api.top',
  apiToken: process.env.API_TOKEN || '',
  officialApiKey: process.env.ARK_API_KEY || '',
  fishApiKey: process.env.FISH_API_KEY || '',
  fishProxyUrl: process.env.FISH_PROXY_URL || '',
  materialPublicBaseUrl: process.env.MATERIAL_PUBLIC_BASE_URL || materialServerDefaults.publicBaseUrl,
  concurrency: Number(process.env.WORKER_CONCURRENCY || 8),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
  autoRetry: String(process.env.AUTO_RETRY || 'false').toLowerCase() === 'true',
  outputDir: OUTPUT_DIR,
  sftp: DEFAULT_SFTP_CONFIG,
};

let config = { ...DEFAULT_CONFIG };
const CANVAS_SYNC_TOKEN = String(process.env.CANVAS_SYNC_TOKEN || '').trim();
let canvasLinked = {
  enabled: false,
  apiBaseUrl: '',
  apiToken: '',
  officialApiKey: '',
  officialProviderName: '火山引擎',
  lowCostProviderName: '6789API',
};

function effectiveApiBaseUrl(currentConfig = config) {
  const localBase = cleanBaseUrl(currentConfig.apiBaseUrl || '');
  if (currentConfig !== config) return localBase;
  const linkedBase = cleanBaseUrl(canvasLinked.apiBaseUrl || '');
  if (localBase && localBase !== 'https://www.6789api.top') return localBase;
  return linkedBase || localBase || 'https://www.6789api.top';
}

function effectiveApiToken(currentConfig = config) {
  const localToken = String(currentConfig.apiToken || '').trim();
  if (currentConfig !== config) return localToken;
  return localToken || String(canvasLinked.apiToken || '').trim();
}

function effectiveOfficialApiKey(currentConfig = config) {
  const localKey = String(currentConfig.officialApiKey || '').trim();
  if (currentConfig !== config) return localKey;
  return localKey || String(canvasLinked.officialApiKey || '').trim();
}

let jobs = [];
let imageJobs = [];
let usedMaterialGroups = {};
let modelReferenceNames = [];
let workerActive = 0;
let workerScheduled = false;
let imageWorkerActive = 0;
let imageWorkerScheduled = false;
const thumbnailPromises = new Map();
const copyPlans = new Map();
const COPY_PLAN_TTL_MS = 2 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DEFAULT_VIDEO_MODEL = 'seedance2.5（满血版）';
const OFFICIAL_API_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const PER_SECOND_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const FULL_25_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const FULL_25_LINE_3_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive'];
const VIDEO_MODEL_SPECS = {
  'doubao-seedance-2-5-260628': { provider: 'official', apiModel: 'doubao-seedance-2-5-260628', durations: Array.from({ length: 27 }, (_, index) => index + 4), resolutions: ['480p', '720p', '1080p'], ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], maxImages: 30 },
  'seedance2.5（满血版）': { apiModel: 'seedance2.5（满血版）', requestFormat: 'full-2.5', durations: Array.from({ length: 21 }, (_, index) => index + 10), resolutions: ['720p'], ratios: FULL_25_RATIOS, maxImages: 30 },
  'seedance2.5（满血版）线路1': { apiModel: 'seedance2.5（满血版）线路1', requestFormat: 'full-2.5', durations: [30], resolutions: ['720p'], ratios: FULL_25_RATIOS, maxImages: 30 },
  'seedance2.5（满血版）线路3': { apiModel: 'seedance2.5（满血版）线路3', requestFormat: 'full-2.5', durations: [30], resolutions: ['720p'], ratios: FULL_25_LINE_3_RATIOS, maxImages: 30 },
  'seedance2.5（满血版）线路4': { apiModel: 'seedance2.5（满血版）线路4', requestFormat: 'full-2.5', durations: [30], resolutions: ['720p'], ratios: FULL_25_RATIOS, maxImages: 30 },
  'seedance-2.0（按秒）': { apiModel: 'seedance-2.0', requestFormat: 'per-second', durations: [5, 10, 15], resolutions: ['720p'], ratios: PER_SECOND_RATIOS, maxImages: 9 },
  'seedance-2.0-fast（按秒）': { apiModel: 'seedance-2.0-fast', requestFormat: 'per-second', durations: [5, 10, 15], resolutions: ['720p'], ratios: PER_SECOND_RATIOS, maxImages: 9 },
  'seedance-2.5（按秒）': { apiModel: 'seedance-2.5', requestFormat: 'per-second', durations: Array.from({ length: 27 }, (_, index) => index + 4), resolutions: ['720p'], ratios: PER_SECOND_RATIOS, maxImages: 9 },
};
const MIME_BY_EXT = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MATERIAL_DIR, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });
  try {
    const savedConfig = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    config = { ...config, ...savedConfig, sftp: { ...config.sftp, ...(savedConfig.sftp || {}) } };
  } catch {
    await persistConfig();
  }
  try {
    modelReferenceNames = JSON.parse(await fs.readFile(MODEL_REFERENCES_FILE, 'utf8'));
    if (!Array.isArray(modelReferenceNames)) throw new Error('模特图片记录不是数组');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`模特图片记录读取失败，原文件已保留：${error.message}`);
    modelReferenceNames = [];
    await writeModelReferences(modelReferenceNames);
  }
  try {
    jobs = JSON.parse(await fs.readFile(JOBS_FILE, 'utf8'));
    if (!Array.isArray(jobs)) throw new Error('任务记录不是数组');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`视频任务记录读取失败，原文件已保留：${error.message}`);
    jobs = [];
    await persistJobs();
  }
  try {
    imageJobs = JSON.parse(await fs.readFile(IMAGE_JOBS_FILE, 'utf8'));
    if (!Array.isArray(imageJobs)) throw new Error('图片任务记录不是数组');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`图片任务记录读取失败，原文件已保留：${error.message}`);
    imageJobs = [];
    await persistImageJobs();
  }
  try {
    usedMaterialGroups = JSON.parse(await fs.readFile(USED_GROUPS_FILE, 'utf8')) || {};
  } catch {
    usedMaterialGroups = {};
  }
  for (const job of jobs) {
    if (job.status === 'failed' && job.taskId && job.error === 'fetch failed') {
      job.status = 'queued';
      job.error = '';
      job.completedAt = '';
    }
    if (job.submittedAt === undefined) job.submittedAt = job.taskId ? (job.startedAt || job.createdAt || '') : '';
    if (job.status === 'submitting' || job.status === 'processing' || job.status === 'queued') {
      job.status = 'queued';
      job.error = '';
    }
  }
  for (const job of imageJobs) {
    if (job.status === 'processing') {
      job.status = 'queued';
      job.error = '';
    }
  }
  for (const job of jobs) {
    if (job.groupId) {
      const current = usedMaterialGroups[String(job.groupId)] || {};
      usedMaterialGroups[String(job.groupId)] = {
        usedAt: current.usedAt || job.createdAt || new Date().toISOString(),
        count: Math.max(Number(current.count) || 0, 1),
      };
    }
  }
  await persistJobs();
  await persistImageJobs();
  await persistUsedMaterialGroups();
}

async function persistConfig() {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function persistJobs() {
  await writeJobs(jobs);
}

async function persistImageJobs() {
  await writeImageJobs(imageJobs);
}

async function persistUsedMaterialGroups() {
  await fs.writeFile(USED_GROUPS_FILE, JSON.stringify(usedMaterialGroups, null, 2), 'utf8');
}

async function markMaterialGroupsUsed(groups) {
  const usedAt = new Date().toISOString();
  for (const group of groups) {
    const key = String(group.id);
    const current = usedMaterialGroups[key] || {};
    usedMaterialGroups[key] = { usedAt: current.usedAt || usedAt, count: (Number(current.count) || 0) + 1 };
  }
  await persistUsedMaterialGroups();
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) reject(new Error('请求体超过 4 MB'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readRawBody(req, maxBytes = 256 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('上传内容超过 256 MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipartBody(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(marker);
  while (cursor !== -1) {
    let partStart = cursor + marker.length;
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    if (buffer.slice(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = buffer.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const nextBoundary = buffer.indexOf(marker, headerEnd + separator.length);
    if (nextBoundary === -1) break;
    const headers = buffer.slice(partStart, headerEnd).toString('utf8');
    let contentEnd = nextBoundary;
    if (buffer.slice(contentEnd - 2, contentEnd).toString() === '\r\n') contentEnd -= 2;
    const content = buffer.slice(headerEnd + separator.length, contentEnd);
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]*)/i)?.[1] || '';
    const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] || '';
    const encodedFilename = disposition.match(/filename\*=UTF-8''([^;\r\n]+)/i)?.[1];
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const filename = encodedFilename ? decodeURIComponent(encodedFilename) : filenameMatch?.[1] || '';
    if (filename) files.push({ name, filename, content });
    else if (name) fields[name] = content.toString('utf8');
    cursor = nextBoundary;
  }
  return { fields, files };
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanRemotePath(value) {
  const remotePath = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!remotePath || !remotePath.startsWith('/') || /[\r\n]/.test(remotePath)) throw new Error('SFTP 远程目录必须是有效的绝对路径');
  return remotePath;
}

function quoteSftp(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

function remoteJoin(base, relativePath) {
  const relative = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (relative.split('/').some((part) => part === '..')) throw new Error('素材路径无效');
  return relative ? `${base}/${relative}` : base;
}

function runSftpBatch(commands, sftp) {
  return new Promise((resolve, reject) => {
    const target = `${String(sftp.username || '').trim()}@${String(sftp.host || '').trim()}`;
    if (!sftp.username || !sftp.host) return reject(new Error('SFTP 主机和用户名不能为空'));
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=20',
      '-i', String(sftp.privateKeyPath || ''),
      '-P', String(Number(sftp.port) || 22),
      '-b', '-',
      target,
    ];
    const child = spawn('sftp', args, { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? '找不到 sftp 命令，请在 Windows“可选功能”中安装 OpenSSH 客户端' : `启动 SFTP 失败：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SFTP 上传失败（退出码 ${code}）：${stderr.trim() || '请检查服务器、端口、密钥和目录设置'}`));
    });
    child.stdin.end(`${commands.join('\n')}\n`);
  });
}

async function syncMaterialGroups(groups) {
  const sftp = { ...(config.sftp || {}) };
  if (!sftp.enabled || !groups.length) return;
  if (!sftp.host || !sftp.username || !sftp.port) throw new Error('请先填写 SFTP 主机、SSH 端口和用户');
  const keyPath = String(sftp.privateKeyPath || '').trim();
  if (!keyPath) throw new Error('请先在设置中粘贴 SFTP 私钥');
  try {
    await fs.access(keyPath);
  } catch {
    throw new Error(`SFTP 私钥文件不存在：${keyPath}`);
  }
  const remoteRoot = cleanRemotePath(sftp.remoteDir);
  const commands = [`-mkdir ${quoteSftp(remoteRoot)}`];
  const directories = new Set();
  const files = [];
  for (const group of groups) {
    for (const file of group.files) {
      const relativePath = String(file.relativePath || '').replace(/\\/g, '/');
      const localRoot = file.isModelReference ? DATA_DIR : MATERIAL_DIR;
      const localPath = path.resolve(localRoot, relativePath);
      if (!isInside(localRoot, localPath)) throw new Error(`素材路径无效：${relativePath}`);
      const parts = relativePath.split('/').filter(Boolean);
      let directory = remoteRoot;
      for (const part of parts.slice(0, -1)) {
        directory = `${directory}/${part}`;
        directories.add(directory);
      }
      files.push({ localPath, remotePath: remoteJoin(remoteRoot, relativePath) });
    }
  }
  for (const directory of directories) commands.push(`-mkdir ${quoteSftp(directory)}`);
  for (const file of files) commands.push(`put ${quoteSftp(file.localPath.replace(/\\/g, '/'))} ${quoteSftp(file.remotePath)}`);
  if (!files.length) throw new Error('选中的素材组没有可上传的图片');
  await enqueueMaterialSync(() => runSftpBatch(commands, sftp));
}

function publicConfig() {
  const activeToken = effectiveApiToken();
  const activeOfficialKey = effectiveOfficialApiKey();
  const activeBaseUrl = effectiveApiBaseUrl();
  const tokenSource = config.apiToken ? 'local' : (canvasLinked.apiToken ? 'canvas' : 'none');
  const officialKeySource = config.officialApiKey ? 'local' : (canvasLinked.officialApiKey ? 'canvas' : 'none');
  return {
    apiBaseUrl: activeBaseUrl,
    localApiBaseUrl: config.apiBaseUrl,
    materialPublicBaseUrl: config.materialPublicBaseUrl || '',
    hasToken: Boolean(activeToken),
    tokenSource,
    tokenPreview: activeToken ? `${activeToken.slice(0, 4)}••••${activeToken.slice(-4)}` : '',
    hasOfficialApiKey: Boolean(activeOfficialKey),
    officialKeySource,
    officialKeyPreview: activeOfficialKey ? `${activeOfficialKey.slice(0, 4)}••••${activeOfficialKey.slice(-4)}` : '',
    canvasSync: {
      enabled: Boolean(canvasLinked.enabled),
      officialProviderName: canvasLinked.officialProviderName || '火山引擎',
      lowCostProviderName: canvasLinked.lowCostProviderName || '6789API',
      hasCanvasOfficialKey: Boolean(canvasLinked.officialApiKey),
      hasCanvasLowCostKey: Boolean(canvasLinked.apiToken),
      canvasApiBaseUrl: cleanBaseUrl(canvasLinked.apiBaseUrl || ''),
    },
    hasFishKey: Boolean(config.fishApiKey),
    fishKeyPreview: config.fishApiKey ? `${config.fishApiKey.slice(0, 4)}••••${config.fishApiKey.slice(-4)}` : '',
    fishProxyUrl: config.fishProxyUrl || '',
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    autoRetry: Boolean(config.autoRetry),
    outputDir: config.outputDir,
    materialDir: MATERIAL_DIR,
    sftp: {
      enabled: Boolean(config.sftp?.enabled),
      host: config.sftp?.host || '',
      port: config.sftp?.port ?? '',
      username: config.sftp?.username || '',
      hasPrivateKey: Boolean(config.sftp?.privateKeyPath),
      remoteDir: config.sftp?.remoteDir || '',
    },
  };
}

function isInside(base, target) {
  const root = path.resolve(base);
  const resolved = path.resolve(target);
  return resolved === root || resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
}

function encodePath(value) {
  return String(value).split(/[\\/]/).map((part) => encodeURIComponent(part)).join('/');
}

function mimeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
  }[ext] || 'application/octet-stream';
}

function openLocalPathInExplorer(targetPath, selectFile = false) {
  const resolved = path.resolve(targetPath);
  if (process.platform === 'win32') {
    const args = selectFile ? ['/select,', resolved] : [resolved];
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const args = selectFile ? ['-R', resolved] : [resolved];
    const child = spawn('open', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const openDir = selectFile ? path.dirname(resolved) : resolved;
  const child = spawn('xdg-open', [openDir], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function streamVideoFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return json(res, 404, { error: '视频文件不存在或已被移动' });
  }
  if (!stat.isFile()) return json(res, 404, { error: '视频文件不存在' });
  const total = stat.size;
  const contentType = mimeForFile(filePath);
  const range = String(req.headers.range || '').trim();
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

async function walkImageFiles(dir) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkImageFiles(fullPath));
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

function validMaterialGroupName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..') throw new Error('素材组名称不能为空');
  if (name.length > 80 || /[<>:"/\\|?*\x00-\x1F]/.test(name)) throw new Error('素材组名称包含无效字符或过长');
  return name;
}

function safeUploadedFileName(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/')).trim();
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1F]/.test(name)) throw new Error(`文件名无效：${name || '未命名文件'}`);
  if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error(`不支持的图片格式：${name}`);
  return name;
}

function groupUsage(group) {
  const usage = usedMaterialGroups[String(group.id)];
  return {
    ...group,
    used: Boolean(usage) || /[（(]用过[）)]/.test(group.name),
    usedAt: usage?.usedAt || '',
    useCount: Number(usage?.count) || 0,
  };
}

async function readMaterialUpload(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
    if (!boundary) throw new Error('上传请求缺少 multipart 边界');
    return parseMultipartBody(await readRawBody(req), boundary);
  }
  return { fields: await readBody(req), files: [] };
}

async function saveMaterialFiles(groupId, files) {
  const safeGroupId = validMaterialGroupName(groupId);
  const groupDir = path.resolve(MATERIAL_DIR, safeGroupId);
  if (!isInside(MATERIAL_DIR, groupDir)) throw new Error('素材组路径无效');
  await fs.mkdir(groupDir, { recursive: true });
  let saved = 0;
  for (const file of files) {
    const fileName = safeUploadedFileName(file.filename);
    if (!file.content?.length) throw new Error(`文件为空：${fileName}`);
    if (file.content.length > 25 * 1024 * 1024) throw new Error(`单张图片不能超过 25 MB：${fileName}`);
    const target = path.resolve(groupDir, fileName);
    if (!isInside(groupDir, target)) throw new Error(`文件路径无效：${fileName}`);
    await fs.writeFile(target, file.content);
    saved += 1;
  }
  return saved;
}

async function scanMaterialGroups() {
  await fs.mkdir(MATERIAL_DIR, { recursive: true });
  const entries = await fs.readdir(MATERIAL_DIR, { withFileTypes: true });
  const groups = [];
  const rootFiles = entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  if (rootFiles.length) {
    groups.push(groupUsage({ id: '__root__', name: '未分组素材', relativePath: '', files: await describeMaterialFiles(rootFiles.map((entry) => path.join(MATERIAL_DIR, entry.name))) }));
  }
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const folder = path.join(MATERIAL_DIR, entry.name);
    const files = await walkImageFiles(folder);
    groups.push(groupUsage({ id: entry.name, name: entry.name, relativePath: entry.name, files: await describeMaterialFiles(files) }));
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

async function describeMaterialFiles(files) {
  const result = [];
  for (const filePath of files) {
    const stat = await fs.stat(filePath);
    const relativePath = path.relative(MATERIAL_DIR, filePath).split(path.sep).join('/');
    const baseUrl = cleanBaseUrl(config.materialPublicBaseUrl);
    const version = `${Math.trunc(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
    result.push({ name: path.basename(filePath), relativePath, size: stat.size, url: withBasePath(`/materials/${encodePath(relativePath)}`), thumbnailUrl: withBasePath(`/thumbnails/${encodePath(relativePath)}?v=${version}`), publicUrl: baseUrl ? `${baseUrl}/${encodePath(relativePath)}` : '' });
  }
  return result;
}

async function describeModelReferences(names) {
  const result = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(name)) throw new Error('模特图片记录无效');
    const stat = await fs.stat(path.join(MODEL_REFERENCE_DIR, name));
    const relativePath = `${MODEL_REFERENCE_FOLDER}/${name}`;
    const baseUrl = cleanBaseUrl(config.materialPublicBaseUrl);
    result.push({ id: name, name, relativePath, size: stat.size, isModelReference: true, thumbnailUrl: withBasePath(`/model-reference-thumbnails/${name}`), publicUrl: baseUrl ? `${baseUrl}/${encodePath(relativePath)}` : '' });
  }
  return result;
}

async function selectedModelReferences(ids, enabled) {
  if (!enabled) return [];
  if (!Array.isArray(ids) || ids.length > 3 || JSON.stringify(ids) !== JSON.stringify(modelReferenceNames)) {
    throw new Error('模特参考图已变化，请刷新后重试');
  }
  if (!ids.length) return [];
  if (!config.sftp?.enabled) throw new Error('使用已上传的模特图需要开启“生成前自动上传素材”');
  return describeModelReferences(ids);
}

async function saveModelReferences(files) {
  if (files.length < 1 || files.length > 3) throw new Error('模特参考图需要 1–3 张');
  await fs.mkdir(MODEL_REFERENCE_DIR, { recursive: true });
  const names = [];
  for (const file of files) {
    if (!file.content?.length || file.content.length > 25 * 1024 * 1024) throw new Error('单张模特图片必须在 25 MB 以内');
    const format = (await sharp(file.content).metadata()).format;
    const ext = { jpeg: 'jpg', png: 'png', webp: 'webp' }[format];
    if (!ext) throw new Error('模特图片仅支持 PNG、JPG 和 WebP');
    const name = `${crypto.createHash('sha256').update(file.content).digest('hex')}.${ext}`;
    try {
      await fs.writeFile(path.join(MODEL_REFERENCE_DIR, name), file.content, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!names.includes(name)) names.push(name);
  }
  modelReferenceNames = names;
  await writeModelReferences(modelReferenceNames);
  return describeModelReferences(modelReferenceNames);
}

async function createCopyPlan(group, input, options, modelReferences = []) {
  const token = effectiveApiToken();
  const baseUrl = effectiveApiBaseUrl();
  if (!token) throw new Error('文案专家需要先在画布 API 设置或本页设置中配置 6789API 低价密钥');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('视频提示词不能为空');
  const duration = Number(input.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw new Error('视频时长无效');
  const sheets = await imageContactSheets(group, MATERIAL_DIR);
  const modelImages = await modelImageDataUrls(modelReferences, DATA_DIR);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let data;
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: options.textModel, messages: copyMessages(group, options, prompt, duration, sheets, modelImages, input.narrationEnabled === true), temperature: 0.25 }),
      signal: controller.signal,
    });
    data = await parseResponse(response);
    if (!response.ok) throw new Error(`${response.status} ${apiError(data, response.statusText)}`);
    if (data?.code !== undefined && String(data.code) !== '0') throw new Error(apiError(data, `业务码 ${data.code}`));
  } catch (error) {
    throw new Error(`文案专家识图请求失败：${error.name === 'AbortError' ? '请求超时' : error.message}`);
  } finally {
    clearTimeout(timeout);
  }
  const plan = parseCopyPlan(data);
  const planId = crypto.randomUUID();
  copyPlans.set(planId, {
    groupId: group.id,
    fingerprint: groupFingerprint(group),
    modelFingerprint: groupFingerprint({ files: modelReferences }),
    modelReferenceIds: modelReferences.map((reference) => reference.id),
    prompt,
    duration,
    options: JSON.stringify(options),
    plan,
    createdAt: Date.now(),
  });
  return { planId, plan, finalPrompt: composeVideoPrompt(prompt, group.name, options, plan, modelReferences.length, input.narrationEnabled === true), groupId: group.id, groupName: group.name, imageCount: group.files.length, modelImageCount: modelReferences.length };
}

async function reviseCopySpeech(job, spokenText, audioSeconds, maxSeconds) {
  const token = effectiveApiToken();
  const baseUrl = effectiveApiBaseUrl();
  if (!token) throw new Error('精简口播需要 6789API 低价密钥');
  const targetCharacters = Math.max(8, Math.floor(spokenText.length * (maxSeconds - 0.7) / audioSeconds));
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: job.contentOptions.textModel, messages: speechRevisionMessages(spokenText, job.copyPlan?.visualFacts || [], targetCharacters, maxSeconds), temperature: 0.2 }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(`口播精简失败：${response.status} ${apiError(data, response.statusText)}`);
  const revised = parseSpeechRevision(data, spokenText);
  job.copyPlan.spokenText = revised;
  await updateJob(job, {});
  return revised;
}

function publicImageJob(job) {
  return {
    ...job,
    sourceFiles: undefined,
    outputFiles: undefined,
    outputUrls: job.outputUrls || [],
  };
}

function imageJobInput(input, group) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('请先填写图片生成指令');
  const model = String(input.model || 'grok-imagine-image-2.0').trim();
  const allowedModels = new Set(['grok-imagine-image-2.0']);
  if (!allowedModels.has(model)) throw new Error(`不支持的生图模型：${model}`);
  const count = Math.max(1, Math.min(4, Number(input.n) || 1));
  const aspectRatio = String(input.aspectRatio || '9:16');
  const quality = String(input.quality || 'medium');
  if (!['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(aspectRatio)) throw new Error('不支持的图片比例');
  if (!['auto', 'low', 'medium', 'high'].includes(quality)) throw new Error('不支持的图片质量');
  return {
    id: crypto.randomUUID(),
    groupId: group.id,
    groupName: group.name,
    prompt: prompt.replaceAll('{group}', group.name),
    model,
    n: count,
    aspectRatio,
    resolution: String(input.resolution || '2k'),
    quality,
    sourceFiles: group.files.map((file) => file.relativePath),
    sourceCount: group.files.length,
    outputUrls: [],
    status: 'processing',
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: '',
  };
}

async function materialDataUri(relativePath) {
  const target = path.resolve(MATERIAL_DIR, relativePath);
  if (!isInside(MATERIAL_DIR, target)) throw new Error('素材路径无效');
  const stat = await fs.stat(target);
  if (stat.size > 12 * 1024 * 1024) throw new Error(`素材过大：${path.basename(target)}（单张图片上限 12 MB）`);
  const buffer = await fs.readFile(target);
  return `data:${mimeForFile(target)};base64,${buffer.toString('base64')}`;
}

async function imagePayload(job) {
  if (!job.sourceFiles?.length) throw new Error('素材组中没有可用图片');
  const images = [];
  for (const relativePath of job.sourceFiles.slice(0, 20)) images.push({ type: 'image_url', url: await materialDataUri(relativePath) });
  const payload = {
    model: job.model,
    prompt: job.prompt,
    n: job.n,
    aspect_ratio: job.aspectRatio,
    resolution: job.resolution,
    quality: job.quality,
    response_format: 'b64_json',
  };
  if (images.length === 1) payload.image = images[0];
  else payload.images = images;
  return payload;
}

async function saveImageOutputs(job, data) {
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.images) ? data.images : [];
  if (!items.length) throw new Error('接口未返回图片数据');
  const outputDir = path.join(config.outputDir, safeFileName(job.groupName));
  await fs.mkdir(outputDir, { recursive: true });
  const outputUrls = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    let buffer;
    let ext = '.png';
    if (item.b64_json) buffer = Buffer.from(String(item.b64_json).replace(/^data:[^;]+;base64,/, ''), 'base64');
    else if (item.url) {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      if (type.includes('jpeg')) ext = '.jpg';
      else if (type.includes('webp')) ext = '.webp';
    } else throw new Error('接口返回的图片缺少 b64_json 或 url');
    const fileName = `${safeFileName(job.groupName)}-${String(index + 1).padStart(2, '0')}${ext}`;
    const target = path.join(outputDir, fileName);
    await fs.writeFile(target, buffer);
    const relative = path.relative(config.outputDir, target).split(path.sep).join('/');
    outputUrls.push(withBasePath(`/outputs/${encodePath(relative)}`));
  }
  updateImageJob(job, { outputUrls });
}

function updateImageJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const saved = persistImageJobs();
  void saved.catch((error) => console.error('图片任务记录保存失败：', error));
  return saved;
}

async function runImageJob(job) {
  try {
    updateImageJob(job, { status: 'processing', error: '' });
    const response = await apiRequest(job, '/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await imagePayload(job)),
    });
    await saveImageOutputs(job, response.data);
    updateImageJob(job, { status: 'succeeded', completedAt: new Date().toISOString() });
  } catch (error) {
    updateImageJob(job, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
  } finally {
    imageWorkerActive -= 1;
    scheduleImageWorkers();
  }
}

function scheduleImageWorkers() {
  if (imageWorkerScheduled) return;
  imageWorkerScheduled = true;
  queueMicrotask(() => {
    imageWorkerScheduled = false;
    const limit = Math.max(1, Math.min(8, Number(config.concurrency) || 2));
    while (imageWorkerActive < limit) {
      const next = imageJobs.find((job) => job.status === 'queued');
      if (!next) break;
      imageWorkerActive += 1;
      void runImageJob(next);
    }
  });
}

function normalizeJob(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const model = String(input.model || DEFAULT_VIDEO_MODEL).trim();
  const duration = Number(input.duration || 10);
  const modelSpec = VIDEO_MODEL_SPECS[model];
  if (!modelSpec) throw new Error(`不支持的模型：${model}`);
  if (!modelSpec.durations.includes(duration)) throw new Error(`${model} 不支持 ${duration} 秒，请按模型选择有效时长`);
  const ratio = String(input.ratio || '9:16');
  if (modelSpec.ratios && !modelSpec.ratios.includes(ratio)) throw new Error(`${model} 不支持 ${ratio} 画面比例`);
  const resolution = String(input.resolution || '720p').toLowerCase();
  if (!modelSpec.resolutions.includes(resolution)) throw new Error(`${model} 不支持 ${resolution}，可选：${modelSpec.resolutions.join('、')}`);
  const imageUrls = Array.isArray(input.imageUrls)
    ? input.imageUrls.map((url) => String(url).trim()).filter(Boolean)
    : String(input.imageUrls || '').split(/[\n,]/).map((url) => url.trim()).filter(Boolean);
  if (imageUrls.length > modelSpec.maxImages) throw new Error(`${model} 最多支持 ${modelSpec.maxImages} 张参考图`);
  const narrationEnabled = input.narrationEnabled === true;
  const narrationSegments = narrationEnabled ? normalizeNarrationSegments(input.narrationSegments) : [];
  const fishVoiceId = String(input.fishVoiceId || '').trim();
  if (fishVoiceId.length > 120) throw new Error('Fish Audio 音色 ID 过长');
  return {
    id: crypto.randomUUID(),
    name: String(input.name || `视频-${new Date().toISOString().slice(0, 10)}`).trim().slice(0, 80),
    prompt,
    model,
    duration,
    ratio,
    resolution,
    imageUrls,
    narrationEnabled,
    narrationSegments,
    fishVoiceId,
    stage: '',
    status: 'queued',
    taskId: '',
    idempotencyKey: crypto.randomUUID(),
    error: '',
    lastFailure: '',
    downloadUrl: '',
    localFile: '',
    createdAt: new Date().toISOString(),
    submittedAt: '',
    startedAt: '',
    completedAt: '',
    autoRetryCount: 0,
    downloadAttempts: 0,
    downloadRetryAt: '',
    downloadState: '',
    updatedAt: new Date().toISOString(),
  };
}

function findJob(id) {
  return jobs.find((job) => job.id === id);
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const saved = persistJobs();
  void saved.catch((error) => console.error('视频任务记录保存失败：', error));
  return saved;
}

function payloadFor(job) {
  const modelSpec = VIDEO_MODEL_SPECS[job.model];
  if (modelSpec?.provider === 'official') {
    return {
      model: modelSpec.apiModel,
      content: [
        { type: 'text', text: job.prompt },
        ...job.imageUrls.map((url) => ({ type: 'image_url', role: 'reference_image', image_url: { url } })),
      ],
      duration: job.duration,
      ratio: job.ratio,
      resolution: job.resolution,
    };
  }
  if (modelSpec?.requestFormat === 'full-2.5') {
    const payload = {
      model: modelSpec.apiModel,
      prompt: job.prompt,
      seconds: job.duration,
      resolution: job.resolution,
      aspect_ratio: job.ratio,
    };
    if (job.imageUrls?.length) payload.reference_images = job.imageUrls;
    return payload;
  }
  if (modelSpec?.requestFormat === 'per-second') {
    const payload = {
      model: modelSpec.apiModel,
      prompt: job.prompt,
      seconds: job.duration,
      metadata: {
        ratio: job.ratio,
        resolution: '720p',
      },
    };
    if (job.imageUrls?.length) payload.images = job.imageUrls;
    return payload;
  }
  const payload = {
    model: modelSpec?.apiModel || job.model,
    prompt: job.prompt,
    duration: job.duration,
    ratio: job.ratio,
    resolution: job.resolution,
  };
  if (job.imageUrls?.length) payload.image_urls = job.imageUrls;
  return payload;
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    return response.json();
  }
  return { raw: await response.text() };
}

function apiError(data, fallback) {
  if (!data) return fallback;
  return data.error?.message || data.error || data.message || data.detail || data.data?.error?.message || data.data?.message || data.raw || fallback;
}

function videoDataFrom(data) {
  if (data && typeof data === 'object' && data.data !== undefined && (data.code !== undefined || (data.id === undefined && data.status === undefined && data.task_id === undefined && data.taskId === undefined))) return data.data;
  return data;
}

function isOfficialJob(job) {
  return VIDEO_MODEL_SPECS[job?.model]?.provider === 'official';
}

function videoEndpoint(job, taskId = '') {
  const collection = isOfficialJob(job) ? '/contents/generations/tasks' : '/v1/videos';
  return taskId ? `${collection}/${encodeURIComponent(taskId)}` : collection;
}

function videoUrlFrom(data) {
  const root = videoDataFrom(data);
  const item = Array.isArray(root) ? root[0] : root;
  return item?.file
    || item?.download_url
    || item?.downloadUrl
    || item?.content?.video_url
    || item?.output?.video_url
    || item?.video_url
    || item?.data?.[0]?.video_url
    || item?.data?.[0]?.url
    || item?.data?.video_url
    || item?.data?.url
    || item?.url
    || item?.metadata?.url
    || item?.content_url
    || item?.contentUrl
    || '';
}

function apiConnection(job, currentConfig = config) {
  if (isOfficialJob(job)) {
    const officialKey = effectiveOfficialApiKey(currentConfig);
    if (!officialKey) throw new Error('请先在画布 API 设置或本页设置中配置火山引擎官方密钥');
    return { base: OFFICIAL_API_BASE_URL, token: officialKey };
  }
  const token = effectiveApiToken(currentConfig);
  if (!token) throw new Error('请先在画布 API 设置或本页设置中配置 6789API 低价密钥');
  const base = effectiveApiBaseUrl(currentConfig);
  if (!base) throw new Error('低价接口地址不能为空');
  return { base, token };
}

async function apiRequest(job, endpoint, options = {}) {
  const { base, token } = apiConnection(job);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(`${base}${endpoint}`, { ...options, headers });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(`${response.status} ${apiError(data, response.statusText)}`);
  if (data && data.code !== undefined && String(data.code) !== '0') throw new Error(`接口错误：${apiError(data, `业务码 ${data.code}`)}`);
  return { response, data };
}

function statusFromRemote(status) {
  const value = String(status || '').toLowerCase();
  if (['succeeded', 'success', 'completed', 'done', 'finished'].includes(value)) return 'succeeded';
  if (['failed', 'error', 'rejected', 'expired'].includes(value)) return 'failed';
  if (['canceled', 'cancelled'].includes(value)) return 'canceled';
  return 'processing';
}

function pollDelayMs(consecutiveErrors = 0) {
  const base = Math.max(1000, Number(config.pollIntervalMs) || 4000);
  return consecutiveErrors ? Math.min(60000, base * (2 ** Math.min(consecutiveErrors - 1, 4))) : base;
}

function prepareAutoRetry(job, reason, { newIdempotencyKey = true } = {}) {
  const retryCount = Math.max(0, Number(job.autoRetryCount) || 0) + 1;
  updateJob(job, {
    status: 'processing',
    taskId: '',
    idempotencyKey: newIdempotencyKey ? crypto.randomUUID() : job.idempotencyKey,
    downloadUrl: '',
    localFile: '',
    submittedAt: '',
    completedAt: '',
    autoRetryCount: retryCount,
    lastFailure: reason || '生成失败',
    error: `${reason || '生成失败'}，正在自动重试第 ${retryCount} 次`,
  });
  return retryCount;
}

function isFishAuthError(error) {
  return /^Fish Audio 配音失败（401）/.test(String(error?.message || ''));
}

function resumableFishJobs(jobList, previousFishKey, previousAutoRetry, nextConfig) {
  if (!nextConfig.autoRetry || !nextConfig.fishApiKey) return [];
  if (nextConfig.fishApiKey === previousFishKey && previousAutoRetry) return [];
  return jobList.filter((job) => job.narrationEnabled && job.status === 'waiting-key');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientApiError(error) {
  const message = String(error?.message || '').toLowerCase();
  return ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)
    || message.includes('fetch failed') || /^(408|425|429|5\d\d)\b/.test(message);
}

async function apiRequestWithRetry(job, endpoint, options, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await apiRequest(job, endpoint, options);
    } catch (error) {
      if (attempt >= attempts || !isTransientApiError(error)) throw error;
      await sleep(pollDelayMs(attempt));
    }
  }
  throw new Error('请求重试失败');
}

function safeFileName(name) {
  const value = String(name || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim();
  return (value || 'video').slice(0, 100);
}

async function saveVideo(job, statusData, { outputDir = config.outputDir, saveJob = true } = {}) {
  let downloadUrl = videoUrlFrom(statusData) || job.downloadUrl;
  const resolvedUrl = downloadUrl && /^https?:\/\//i.test(downloadUrl)
    ? downloadUrl
    : downloadUrl
      ? new URL(downloadUrl, `${apiConnection(job).base}/`).toString()
      : '';
  const isContentEndpoint = (value) => {
    try { return /\/v1\/videos\/[^/]+\/content\/?$/i.test(new URL(value).pathname); } catch { return false; }
  };
  const checkedResponse = async (response) => {
    if (response.ok) return response;
    const data = await parseResponse(response);
    const error = new Error(`下载失败：${response.status} ${apiError(data, response.statusText)}`);
    error.status = response.status;
    throw error;
  };
  const fetchResponse = async () => {
    if (resolvedUrl && !isContentEndpoint(resolvedUrl)) {
      try {
        return { response: await checkedResponse(await fetch(resolvedUrl, { signal: AbortSignal.timeout(180000) })), url: resolvedUrl };
      } catch (error) {
        if (isOfficialJob(job) || ![403, 404, 410, 502, 503, 504].includes(Number(error.status))) throw error;
        downloadUrl = '';
      }
    }
    if (isOfficialJob(job)) throw new Error('官方接口未返回视频下载地址');
    const { base, token } = apiConnection(job);
    let response = await checkedResponse(await fetch(`${base}${videoEndpoint(job, job.taskId)}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'video/*, application/json' },
      signal: AbortSignal.timeout(180000),
    }));
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const data = await response.json();
      const nextUrl = videoUrlFrom(data);
      if (!nextUrl) throw new Error('接口未返回可下载地址');
      const absoluteNextUrl = /^https?:\/\//i.test(nextUrl) ? nextUrl : new URL(nextUrl, `${base}/`).toString();
      if (isContentEndpoint(absoluteNextUrl)) throw new Error('内容接口返回了另一个内容接口地址');
      response = await checkedResponse(await fetch(absoluteNextUrl, { signal: AbortSignal.timeout(180000) }));
      downloadUrl = absoluteNextUrl;
    }
    return { response, url: downloadUrl || resolvedUrl || '' };
  };
  const { target, url } = await downloadVideoFile(fetchResponse, outputDir, `${safeFileName(job.name)}-${job.id.slice(0, 8)}`, {
    onRetry: (error, attempt, attempts) => { if (saveJob) updateJob(job, { error: `下载中断，正在重试（${attempt}/${attempts}）：${error.message}` }); },
  });
  if (saveJob) await updateJob(job, { localFile: target, downloadUrl: url, error: '' });
  return target;
}

async function downloadCompletedJob(job, previousFailures) {
  if (previousFailures && job.taskId) {
    try {
      const result = await apiRequest(job, videoEndpoint(job, job.taskId), { method: 'GET', signal: AbortSignal.timeout(30000) });
      const data = videoDataFrom(result.data) || {};
      if (data.status && statusFromRemote(data.status) !== 'succeeded') throw new Error(`原任务当前状态：${data.status}`);
      const freshUrl = videoUrlFrom(data);
      if (freshUrl) await updateJob(job, { downloadUrl: freshUrl });
    } catch (error) {
      if (isOfficialJob(job) && !job.downloadUrl) throw error;
    }
  }
  await saveVideo(job, { download_url: job.downloadUrl });
}

const downloadQueue = createDownloadRetryQueue({ jobs: () => jobs, download: downloadCompletedJob, update: updateJob });

async function submitJob(job) {
  updateJob(job, { status: 'submitting', startedAt: job.startedAt || new Date().toISOString(), error: '' });
  const result = await apiRequestWithRetry(job, videoEndpoint(job), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': job.idempotencyKey,
    },
    body: JSON.stringify(payloadFor(job)),
  }, isOfficialJob(job) ? 1 : 3);
  const data = videoDataFrom(result.data) || {};
  const taskId = data.id || data.task_id || data.taskId;
  if (!taskId) throw new Error('创建任务成功，但响应中没有任务 ID');
  await updateJob(job, {
    taskId,
    downloadUrl: videoUrlFrom(data),
    status: statusFromRemote(data.status),
    submittedAt: new Date().toISOString(),
  });
}

async function pollJob(job) {
  while (true) {
    if (job.status === 'canceled') break;
    if (!job.taskId) await submitJob(job);
    let consecutiveErrors = 0;
    while (!TERMINAL_STATUSES.has(job.status)) {
      await sleep(pollDelayMs(consecutiveErrors));
      if (job.status === 'canceled') break;
      if (TERMINAL_STATUSES.has(job.status)) break;
      try {
        const result = await apiRequest(job, videoEndpoint(job, job.taskId), { method: 'GET' });
        const data = videoDataFrom(result.data) || {};
        const nextStatus = statusFromRemote(data.status);
        consecutiveErrors = 0;
        updateJob(job, {
          status: nextStatus,
          downloadUrl: videoUrlFrom(data) || job.downloadUrl,
          error: data.error?.message || data.error || (nextStatus === 'failed' ? '远端任务失败' : ''),
          ...(nextStatus === 'failed' ? { lastFailure: data.error?.message || data.error || '远端任务失败' } : {}),
        });
        if (nextStatus === 'failed' || nextStatus === 'canceled') break;
      } catch (error) {
        if (job.status === 'canceled') break;
        consecutiveErrors += 1;
        updateJob(job, {
          status: 'processing',
          error: `状态查询暂时失败，将继续重试（第 ${consecutiveErrors} 次）：${error.message}`,
        });
      }
    }
    if (job.status !== 'failed' || !config.autoRetry) break;
    const retryCount = prepareAutoRetry(job, job.error || '视频接口返回生成失败');
    await sleep(pollDelayMs(retryCount));
    if (job.status === 'canceled') break;
    if (!config.autoRetry) {
      updateJob(job, { status: 'failed', completedAt: new Date().toISOString() });
      break;
    }
  }
  if (job.status === 'succeeded' && !job.localFile) downloadQueue.schedule();
  if (TERMINAL_STATUSES.has(job.status)) {
    updateJob(job, { completedAt: job.completedAt || new Date().toISOString() });
  }
}

async function runJob(job) {
  try {
    if (job.narrationEnabled) await runNarratedJob(job);
    else await pollJob(job);
  } catch (error) {
    if (job.status === 'canceled') return;
    if (job.narrationEnabled) {
      if (isFishAuthError(error)) {
        updateJob(job, {
          status: 'waiting-key',
          stage: '',
          error: config.autoRetry
            ? 'Fish Audio API Key 无效（401）。请在设置中更换密钥，保存后自动继续。'
            : 'Fish Audio API Key 无效（401）。请在设置中更换密钥后点击重试。',
          lastFailure: error.message,
        });
      } else if (config.autoRetry) {
        const retryCount = prepareAutoRetry(job, error.message);
        await sleep(pollDelayMs(retryCount));
        if (job.status !== 'canceled') await updateJob(job, { status: 'queued', stage: '等待重新生成' });
      } else {
        updateJob(job, { status: 'failed', stage: '', error: error.message, lastFailure: error.message, completedAt: new Date().toISOString() });
      }
    } else if (job.taskId) {
      updateJob(job, { status: 'queued', error: `状态轮询中断，将继续检查：${error.message}`, completedAt: '' });
    } else if (config.autoRetry && isTransientApiError(error)) {
      const retryCount = prepareAutoRetry(job, `提交失败：${error.message}`, { newIdempotencyKey: false });
      await sleep(pollDelayMs(retryCount));
      if (job.status === 'canceled') return;
      if (!config.autoRetry) updateJob(job, { status: 'failed', completedAt: new Date().toISOString() });
      else updateJob(job, { status: 'queued' });
    } else {
      updateJob(job, { status: 'failed', error: error.message, lastFailure: error.message, completedAt: new Date().toISOString() });
    }
  } finally {
    workerActive -= 1;
    scheduleWorkers();
  }
}

async function runNarratedJob(job) {
  await updateJob(job, { status: 'processing', startedAt: job.startedAt || new Date().toISOString(), error: '' });
  const assertActive = () => { if (job.status === 'canceled') throw new Error('任务已停止跟踪'); };
  const createVideo = async (segment, index, duration, tempDir) => {
    const shot = {
      ...job,
      name: job.name,
      prompt: `${job.prompt}\n只生成画面，不生成人声、音乐、音效、字幕或画面文字。`,
      duration,
      taskId: segment.taskId,
      downloadUrl: segment.downloadUrl,
      idempotencyKey: segment.idempotencyKey || crypto.randomUUID(),
    };
    if (!shot.taskId) {
      segment.idempotencyKey = shot.idempotencyKey;
      await updateJob(job, {});
      const result = await apiRequestWithRetry(shot, videoEndpoint(shot), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': shot.idempotencyKey },
        body: JSON.stringify(payloadFor(shot)),
      }, isOfficialJob(shot) ? 1 : 3);
      const data = videoDataFrom(result.data) || {};
      segment.taskId = data.id || data.task_id || data.taskId;
      if (!segment.taskId) throw new Error('视频接口未返回任务 ID');
      segment.downloadUrl = videoUrlFrom(data);
      await updateJob(job, { submittedAt: job.submittedAt || new Date().toISOString() });
    }
    shot.taskId = segment.taskId;
    let status = 'processing';
    let consecutiveErrors = 0;
    while (status === 'processing') {
      assertActive();
      try {
        const result = await apiRequest(shot, videoEndpoint(shot, shot.taskId), { method: 'GET', signal: AbortSignal.timeout(30000) });
        const data = videoDataFrom(result.data) || {};
        status = statusFromRemote(data.status);
        consecutiveErrors = 0;
        segment.downloadUrl = videoUrlFrom(data) || segment.downloadUrl;
        await updateJob(job, {});
        if (status === 'failed' || status === 'canceled') {
          segment.taskId = '';
          segment.idempotencyKey = crypto.randomUUID();
          await updateJob(job, {});
          throw new Error(`画面生成失败：${apiError(data, status)}`);
        }
      } catch (error) {
        if (status !== 'processing') throw error;
        if (!isTransientApiError(error) && !/^404\b/.test(String(error.message))) throw error;
        consecutiveErrors += 1;
        await updateJob(job, { stage: `画面生成中，状态查询重试 ${consecutiveErrors} 次` });
      }
      if (status === 'processing') await sleep(pollDelayMs(consecutiveErrors));
    }
    assertActive();
    shot.downloadUrl = segment.downloadUrl;
    let attempts = 0;
    while (true) {
      assertActive();
      try {
        await updateJob(job, { stage: attempts ? `视频下载重试 ${attempts} 次` : '下载视频画面' });
        return await saveVideo(shot, { download_url: segment.downloadUrl }, { outputDir: tempDir, saveJob: false });
      } catch (error) {
        if (!retryableDownloadError(error)) throw error;
        attempts += 1;
        await sleep(Math.min(30000, 4000 * attempts));
      }
    }
  };
  const target = await renderNarration({
    job, fishApiKey: config.fishApiKey, fishProxyUrl: config.fishProxyUrl,
    audioCacheDir: path.join(FISH_AUDIO_CACHE_DIR, job.id),
    durations: VIDEO_MODEL_SPECS[job.model].durations.filter((seconds) => seconds <= job.duration),
    outputDir: config.outputDir, createVideo, assertActive, safeFileName,
    reviseSpeech: (speech, seconds, maxSeconds) => reviseCopySpeech(job, speech, seconds, maxSeconds),
    stage: (stage) => updateJob(job, { stage }),
  });
  await updateJob(job, { status: 'succeeded', localFile: target, stage: '', completedAt: new Date().toISOString(), error: '' });
}

function scheduleWorkers() {
  if (workerScheduled) return;
  workerScheduled = true;
  queueMicrotask(() => {
    workerScheduled = false;
    const limit = Math.max(1, Math.min(8, Number(config.concurrency) || 2));
    let activeCount = jobs.filter((job) => job.status === 'submitting' || job.status === 'processing').length;
    workerActive = activeCount;
    while (activeCount < limit) {
      const next = jobs.find((job) => job.status === 'queued');
      if (!next) break;
      if (!VIDEO_MODEL_SPECS[next.model]) {
        updateJob(next, { status: 'failed', error: `模型已停用：${next.model}`, completedAt: new Date().toISOString() });
        continue;
      }
      updateJob(next, { status: 'submitting', startedAt: next.startedAt || new Date().toISOString(), error: '' });
      activeCount += 1;
      workerActive = activeCount;
      void runJob(next);
    }
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/fish-voices') return json(res, 200, { voices: publicFishVoicesWithBase() });
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig());
  if (req.method === 'GET' && url.pathname === '/api/model-references') {
    return json(res, 200, { references: await describeModelReferences(modelReferenceNames) });
  }
  if (req.method === 'POST' && url.pathname === '/api/model-references') {
    try {
      const upload = await readMaterialUpload(req);
      return json(res, 201, { references: await saveModelReferences(upload.files) });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  const modelReferenceMatch = url.pathname.match(/^\/api\/model-references\/([^/]+)$/);
  if (req.method === 'DELETE' && modelReferenceMatch) {
    const id = decodeURIComponent(modelReferenceMatch[1]);
    if (!modelReferenceNames.includes(id)) return json(res, 404, { error: '模特参考图不存在' });
    modelReferenceNames = modelReferenceNames.filter((name) => name !== id);
    await writeModelReferences(modelReferenceNames);
    return json(res, 200, { references: await describeModelReferences(modelReferenceNames) });
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, { jobs });
  if (req.method === 'GET' && url.pathname === '/api/material-groups') return json(res, 200, { groups: await scanMaterialGroups() });
  if (req.method === 'GET' && url.pathname === '/api/image-jobs') return json(res, 200, { jobs: imageJobs.map(publicImageJob) });

  if (req.method === 'POST' && url.pathname === '/api/material-groups') {
    try {
      const upload = await readMaterialUpload(req);
      const name = validMaterialGroupName(upload.fields.name || upload.fields.groupName);
      const groupDir = path.resolve(MATERIAL_DIR, name);
      if (!isInside(MATERIAL_DIR, groupDir)) throw new Error('素材组路径无效');
      try {
        await fs.access(groupDir);
        return json(res, 409, { error: `素材组已存在：${name}` });
      } catch {}
      await fs.mkdir(groupDir, { recursive: true });
      try {
        const uploaded = await saveMaterialFiles(name, upload.files);
        const group = (await scanMaterialGroups()).find((item) => item.id === name);
        return json(res, 201, { group, uploaded });
      } catch (error) {
        await fs.rm(groupDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const materialUploadMatch = url.pathname.match(/^\/api\/material-groups\/([^/]+)\/files$/);
  if (req.method === 'POST' && materialUploadMatch) {
    try {
      const groupId = decodeURIComponent(materialUploadMatch[1]);
      if (groupId === '__root__') throw new Error('未分组素材不能直接上传，请先新建素材组');
      const upload = await readMaterialUpload(req);
      const groupDir = path.resolve(MATERIAL_DIR, validMaterialGroupName(groupId));
      try {
        await fs.access(groupDir);
      } catch {
        return json(res, 404, { error: `素材组不存在：${groupId}` });
      }
      const uploaded = await saveMaterialFiles(groupId, upload.files);
      const group = (await scanMaterialGroups()).find((item) => item.id === groupId);
      return json(res, 201, { group, uploaded });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'DELETE' && materialUploadMatch) {
    try {
      const groupId = decodeURIComponent(materialUploadMatch[1]);
      const body = await readBody(req);
      const relativePath = String(body.relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '').trim();
      if (!relativePath) throw new Error('缺少图片路径');
      const targetPath = path.resolve(MATERIAL_DIR, relativePath);
      if (!isInside(MATERIAL_DIR, targetPath)) throw new Error('图片路径无效');
      if (groupId === '__root__') {
        if (path.resolve(path.dirname(targetPath)) !== path.resolve(MATERIAL_DIR)) throw new Error('图片不属于未分组素材');
      } else {
        const safeGroupId = validMaterialGroupName(groupId);
        const groupDir = path.resolve(MATERIAL_DIR, safeGroupId);
        if (!isInside(groupDir, targetPath) || path.resolve(targetPath) === path.resolve(groupDir)) throw new Error('图片不属于该素材组');
      }
      try {
        await fs.unlink(targetPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: '图片不存在或已删除' });
        throw error;
      }
      const group = (await scanMaterialGroups()).find((item) => item.id === groupId) || null;
      return json(res, 200, { group });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const materialGroupMatch = url.pathname.match(/^\/api\/material-groups\/([^/]+)$/);
  if (req.method === 'PATCH' && materialGroupMatch) {
    try {
      const groupId = decodeURIComponent(materialGroupMatch[1]);
      if (groupId === '__root__') throw new Error('未分组素材不支持重命名');
      const safeOld = validMaterialGroupName(groupId);
      const body = await readBody(req);
      const safeNew = validMaterialGroupName(body.name);
      const oldDir = path.resolve(MATERIAL_DIR, safeOld);
      const newDir = path.resolve(MATERIAL_DIR, safeNew);
      if (!isInside(MATERIAL_DIR, oldDir) || !isInside(MATERIAL_DIR, newDir)) throw new Error('素材组路径无效');
      try {
        await fs.access(oldDir);
      } catch {
        return json(res, 404, { error: `素材组不存在：${safeOld}` });
      }
      if (safeOld !== safeNew) {
        const sameCaseInsensitive = safeOld.toLowerCase() === safeNew.toLowerCase();
        if (!sameCaseInsensitive) {
          let exists = false;
          try { await fs.access(newDir); exists = true; } catch {}
          if (exists) return json(res, 409, { error: `素材组已存在：${safeNew}` });
        }
        await fs.rename(oldDir, newDir);
        if (usedMaterialGroups[safeOld]) {
          usedMaterialGroups[safeNew] = usedMaterialGroups[safeOld];
          delete usedMaterialGroups[safeOld];
          await persistUsedMaterialGroups();
        }
      }
      const group = (await scanMaterialGroups()).find((item) => item.id === safeNew);
      return json(res, 200, { group });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'DELETE' && materialGroupMatch) {
    try {
      const groupId = decodeURIComponent(materialGroupMatch[1]);
      if (groupId === '__root__') throw new Error('未分组素材不支持整组删除，请逐张删除图片');
      const safeGroupId = validMaterialGroupName(groupId);
      const groupDir = path.resolve(MATERIAL_DIR, safeGroupId);
      if (!isInside(MATERIAL_DIR, groupDir) || path.resolve(groupDir) === path.resolve(MATERIAL_DIR)) {
        throw new Error('素材组路径无效');
      }
      try {
        await fs.access(groupDir);
      } catch {
        return json(res, 404, { error: `素材组不存在：${safeGroupId}` });
      }
      await fs.rm(groupDir, { recursive: true, force: true });
      if (usedMaterialGroups[safeGroupId]) {
        delete usedMaterialGroups[safeGroupId];
        await persistUsedMaterialGroups();
      }
      return json(res, 200, { deleted: safeGroupId });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readBody(req);
    const previousFishKey = config.fishApiKey;
    const previousAutoRetry = config.autoRetry;
    let fishProxyUrl;
    try { if (body.fishProxyUrl !== undefined) fishProxyUrl = normalizeFishProxyUrl(body.fishProxyUrl); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (body.apiBaseUrl !== undefined) config.apiBaseUrl = cleanBaseUrl(body.apiBaseUrl);
    if (body.materialPublicBaseUrl !== undefined) config.materialPublicBaseUrl = cleanBaseUrl(body.materialPublicBaseUrl);
    if (body.clearApiToken) config.apiToken = '';
    else if (body.apiToken !== undefined && body.apiToken !== '') config.apiToken = String(body.apiToken).trim();
    if (body.clearOfficialApiKey) config.officialApiKey = '';
    else if (body.officialApiKey !== undefined && body.officialApiKey !== '') config.officialApiKey = String(body.officialApiKey).trim();
    if (body.fishApiKey !== undefined && body.fishApiKey !== '') config.fishApiKey = String(body.fishApiKey).trim();
    if (body.fishProxyUrl !== undefined) config.fishProxyUrl = fishProxyUrl;
    if (body.concurrency !== undefined) config.concurrency = Math.max(1, Math.min(8, Number(body.concurrency) || 2));
    if (body.pollIntervalMs !== undefined) config.pollIntervalMs = Math.max(1000, Math.min(60000, Number(body.pollIntervalMs) || 4000));
    if (body.autoRetry !== undefined) config.autoRetry = Boolean(body.autoRetry);
    if (body.outputDir !== undefined && String(body.outputDir).trim()) config.outputDir = path.resolve(String(body.outputDir).trim());
    if (body.sftp && typeof body.sftp === 'object') {
      const nextSftp = {
        ...(config.sftp || DEFAULT_SFTP_CONFIG),
        enabled: body.sftp.enabled !== undefined ? Boolean(body.sftp.enabled) : config.sftp?.enabled !== false,
        host: body.sftp.host !== undefined ? String(body.sftp.host).trim() : config.sftp?.host || '',
        port: body.sftp.port !== undefined ? (String(body.sftp.port).trim() ? Math.max(1, Math.min(65535, Number(body.sftp.port) || 22)) : '') : config.sftp?.port ?? '',
        username: body.sftp.username !== undefined ? String(body.sftp.username).trim() : config.sftp?.username || '',
        remoteDir: body.sftp.remoteDir !== undefined ? (String(body.sftp.remoteDir).trim() ? cleanRemotePath(body.sftp.remoteDir) : '') : config.sftp?.remoteDir || '',
      };
      if (String(body.sftp.privateKeyText || '').trim()) {
        try { nextSftp.privateKeyPath = await saveSftpPrivateKey(body.sftp.privateKeyText, DATA_DIR); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      config.sftp = nextSftp;
    }
    await fs.mkdir(config.outputDir, { recursive: true });
    await persistConfig();
    for (const job of resumableFishJobs(jobs, previousFishKey, previousAutoRetry, config)) {
      await updateJob(job, { status: 'queued', stage: '等待重新生成', error: '', completedAt: '', autoRetryCount: 0 });
    }
    scheduleWorkers();
    scheduleImageWorkers();
    downloadQueue.schedule();
    return json(res, 200, publicConfig());
  }

  if (req.method === 'POST' && url.pathname === '/api/image-jobs') {
    const body = await readBody(req);
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String) : [];
    if (!groupIds.length) return json(res, 400, { error: '请至少选择一个素材组' });
    const groups = await scanMaterialGroups();
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    try {
      const created = groupIds.map((groupId) => {
        const group = groupMap.get(groupId);
        if (!group) throw new Error(`素材组不存在：${groupId}`);
        return imageJobInput(body, group);
      });
      imageJobs = [...created, ...imageJobs].slice(0, 500);
      await persistImageJobs();
      return json(res, 201, { jobs: created.map(publicImageJob) });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/copy-plan') {
    try {
      const body = await readBody(req);
      const options = normalizeContentOptions({ ...body.contentOptions, copywriting: true });
      const group = (await scanMaterialGroups()).find((item) => item.id === String(body.groupId));
      if (!group) throw new Error('素材组不存在');
      const modelReferences = await selectedModelReferences(body.modelReferenceIds, options.modelEnabled);
      const modelSpec = VIDEO_MODEL_SPECS[String(body.model || DEFAULT_VIDEO_MODEL)];
      if (!modelSpec) throw new Error('视频模型无效');
      if (group.files.length + modelReferences.length > modelSpec.maxImages) throw new Error(`${group.name} 加上模特图超过当前模型的 ${modelSpec.maxImages} 张参考图上限`);
      const result = await createCopyPlan(group, body, options, modelReferences);
      for (const [id, saved] of copyPlans) {
        if (Date.now() - saved.createdAt > COPY_PLAN_TTL_MS) copyPlans.delete(id);
      }
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/group-video-jobs') {
    const body = await readBody(req);
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String) : [];
    if (!groupIds.length) return json(res, 400, { error: '请至少选择一个素材组' });
    const requestedModel = String(body.model || DEFAULT_VIDEO_MODEL);
    if (!VIDEO_MODEL_SPECS[requestedModel]) return json(res, 400, { error: `不支持的模型：${requestedModel}` });
    if (isOfficialJob({ model: requestedModel }) && !effectiveOfficialApiKey()) return json(res, 400, { error: '请先在画布 API 设置或本页设置中配置火山引擎官方密钥' });
    if (!isOfficialJob({ model: requestedModel }) && !effectiveApiToken()) return json(res, 400, { error: '请先在画布 API 设置或本页设置中配置 6789API 低价密钥' });
    if (body.narrationEnabled && !config.fishApiKey) return json(res, 400, { error: '请先在设置中填写 Fish Audio API Key' });
    const groups = await scanMaterialGroups();
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    try {
      const contentOptions = normalizeContentOptions(body.contentOptions);
      if (body.narrationEnabled && (!contentOptions.voiceover || !contentOptions.copywriting || contentOptions.subtitles)) throw new Error('Fish 配音需开启人声口播与文案专家，并关闭画面字幕');
      const modelReferences = await selectedModelReferences(body.modelReferenceIds, contentOptions.modelEnabled);
      const selectedGroups = groupIds.map((groupId) => {
        const group = groupMap.get(groupId);
        if (!group) throw new Error(`素材组不存在：${groupId}`);
        if (!group.files.length) throw new Error(`${group.name} 没有图片素材`);
        if (group.files.some((file) => !file.publicUrl)) throw new Error(`请先配置“素材公网地址前缀”，第三方接口无法读取本地文件：${group.name}`);
        const model = String(body.model || DEFAULT_VIDEO_MODEL);
        const modelSpec = VIDEO_MODEL_SPECS[model];
        if (!modelSpec) throw new Error(`不支持的模型：${model}`);
        if (group.files.length + modelReferences.length > modelSpec.maxImages) throw new Error(`${group.name} 的 ${group.files.length} 张素材加 ${modelReferences.length} 张模特图，超过 ${model} 最多 ${modelSpec.maxImages} 张参考图`);
        return group;
      });
      const selectedPlans = new Map();
      if (contentOptions.copywriting) {
        for (const group of selectedGroups) {
          const saved = copyPlans.get(String(body.planIds?.[group.id] || ''));
          if (!saved || saved.groupId !== group.id || saved.fingerprint !== groupFingerprint(group)
            || saved.modelFingerprint !== groupFingerprint({ files: modelReferences })
            || JSON.stringify(saved.modelReferenceIds) !== JSON.stringify(modelReferences.map((reference) => reference.id))
            || saved.prompt !== String(body.prompt || '').trim() || saved.duration !== Number(body.duration)
            || saved.options !== JSON.stringify(contentOptions) || Date.now() - saved.createdAt > COPY_PLAN_TTL_MS) {
            throw new Error(`${group.name} 的图片或策划设置已变化，请重新生成文案`);
          }
          selectedPlans.set(group.id, saved.plan);
        }
      }
      if (contentOptions.reviewPrompt) {
        const reviewed = body.reviewedPrompts;
        if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)) throw new Error('请先审核每个素材组的视频提示词');
        for (const group of selectedGroups) {
          videoPromptForGroup(body.prompt, group.name, contentOptions, selectedPlans.get(group.id), modelReferences.length, reviewed[group.id], body.narrationEnabled === true);
          if (body.narrationEnabled) {
            const speech = String(body.reviewedSpeech?.[group.id] || '').trim();
            if (!speech || speech.length > 500) throw new Error(`${group.name} 审核后的口播必须在 1–500 字以内`);
          }
        }
      }
      await syncMaterialGroups([...selectedGroups, ...(modelReferences.length ? [{ files: modelReferences }] : [])]);
      const created = selectedGroups.map((group) => {
        const savedPlan = selectedPlans.get(group.id) || null;
        const plan = savedPlan && body.narrationEnabled && contentOptions.reviewPrompt
          ? { ...savedPlan, spokenText: String(body.reviewedSpeech[group.id]).trim() } : savedPlan;
        let prompt = videoPromptForGroup(body.prompt, group.name, contentOptions, plan, modelReferences.length, body.reviewedPrompts?.[group.id], body.narrationEnabled === true);
        if (body.narrationEnabled && contentOptions.reviewPrompt) prompt += '\n仅生成无声画面，口播由 Fish Audio 单独合成；不要生成人声、音乐、音效、字幕或画面文字。';
        const narrationSegments = body.narrationEnabled ? [{ text: plan.spokenText, visualPrompt: plan.videoPrompt }] : [];
        const job = normalizeJob({ ...body, narrationSegments, name: group.name, prompt, imageUrls: [...modelReferences, ...group.files].map((file) => file.publicUrl) });
        Object.assign(job, { groupId: group.id, groupName: group.name, sourceCount: group.files.length + modelReferences.length, modelReferenceFiles: modelReferences.map((reference) => reference.id), modelReferenceCount: modelReferences.length, contentOptions, copyPlan: plan, sourceFingerprint: groupFingerprint(group), modelFingerprint: groupFingerprint({ files: modelReferences }) });
        return job;
      });
      jobs = [...created, ...jobs].slice(0, 500);
      await persistJobs();
      await markMaterialGroupsUsed(selectedGroups);
      for (const group of selectedGroups) copyPlans.delete(String(body.planIds?.[group.id] || ''));
      scheduleWorkers();
      return json(res, 201, { jobs: created });
    } catch (error) {
      return json(res, error.message.startsWith('SFTP 上传失败') || error.message.startsWith('启动 SFTP') || error.message.startsWith('找不到 sftp') ? 502 : 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readBody(req);
    const inputs = Array.isArray(body.items) ? body.items : [];
    if (!inputs.length) return json(res, 400, { error: '至少添加一个任务' });
    try {
      const created = inputs.map(normalizeJob);
      jobs = [...created, ...jobs].slice(0, 500);
      await persistJobs();
      return json(res, 201, { jobs: created });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  const actionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(start|retry|cancel|download)$/);
  if (req.method === 'POST' && actionMatch) {
    const job = findJob(decodeURIComponent(actionMatch[1]));
    if (!job) return json(res, 404, { error: '任务不存在' });
    const action = actionMatch[2];
    if (action === 'start') {
      if (!VIDEO_MODEL_SPECS[job.model]) return json(res, 400, { error: `模型已停用：${job.model}` });
      try { apiConnection(job); } catch (error) { return json(res, 400, { error: error.message }); }
      if (!TERMINAL_STATUSES.has(job.status)) updateJob(job, { status: 'queued', error: '' });
      scheduleWorkers();
      return json(res, 202, { job });
    }
    if (action === 'retry') {
      if (!VIDEO_MODEL_SPECS[job.model]) return json(res, 400, { error: `模型已停用：${job.model}` });
      try { apiConnection(job); } catch (error) { return json(res, 400, { error: error.message }); }
      try {
        if (job.groupId && config.sftp?.enabled) {
          const groups = await scanMaterialGroups();
          const group = groups.find((item) => item.id === String(job.groupId));
          if (!group) throw new Error(`素材组不存在：${job.groupId}`);
          if (group.files.some((file) => !file.publicUrl)) throw new Error(`请先配置“素材公网地址前缀”：${group.name}`);
          const references = await describeModelReferences(job.modelReferenceFiles || []);
          if (job.copyPlan && (job.sourceFingerprint !== groupFingerprint(group) || job.modelFingerprint !== groupFingerprint({ files: references }))) {
            throw new Error('素材或模特图片已变化，请重新生成文案后新建任务');
          }
          await syncMaterialGroups([group, ...(references.length ? [{ files: references }] : [])]);
          updateJob(job, { imageUrls: [...references, ...group.files].map((file) => file.publicUrl), sourceCount: group.files.length + references.length });
        }
        updateJob(job, { status: 'queued', taskId: '', idempotencyKey: crypto.randomUUID(), error: '', lastFailure: '', localFile: '', submittedAt: '', completedAt: '', autoRetryCount: 0, downloadAttempts: 0, downloadRetryAt: '', downloadState: '' });
        scheduleWorkers();
        return json(res, 202, { job });
      } catch (error) {
        const isSftpError = error.message.startsWith('SFTP 上传失败') || error.message.startsWith('启动 SFTP') || error.message.startsWith('找不到 sftp');
        return json(res, isSftpError ? 502 : 400, { error: error.message });
      }
    }
    if (action === 'cancel') {
      if (TERMINAL_STATUSES.has(job.status)) return json(res, 409, { error: '任务状态已变化，请刷新后重试' });
      updateJob(job, { status: 'canceled', error: '', completedAt: new Date().toISOString() });
      return json(res, 200, { job });
    }
    if (action === 'download') {
      if (!job.taskId && !job.downloadUrl) return json(res, 409, { error: '没有可查询的中转任务，无法取回视频' });
      try {
        if (job.status === 'succeeded') {
          if (job.localFile) return json(res, 200, { job });
          await updateJob(job, { downloadRetryAt: '', downloadState: 'retrying' });
          downloadQueue.schedule();
          return json(res, 202, { job });
        }
        let statusData = { download_url: job.downloadUrl };
        if (job.taskId) {
          const result = await apiRequest(job, videoEndpoint(job, job.taskId), { method: 'GET' });
          statusData = videoDataFrom(result.data) || statusData;
          const remoteStatus = statusFromRemote(statusData.status);
          if (remoteStatus === 'processing') return json(res, 409, { error: '中转任务仍在生成，请稍后再取回视频' });
          if (remoteStatus !== 'succeeded') return json(res, 409, { error: '中转任务未生成成功，无法取回视频' });
        }
        await updateJob(job, { status: 'succeeded', error: '', downloadUrl: videoUrlFrom(statusData) || job.downloadUrl, downloadRetryAt: '', downloadState: 'retrying', completedAt: new Date().toISOString() });
        downloadQueue.schedule();
        return json(res, 202, { job });
      } catch (error) {
        updateJob(job, { error: error.message });
        return json(res, 502, { error: error.message });
      }
    }
  }

  const imageActionMatch = url.pathname.match(/^\/api\/image-jobs\/([^/]+)\/(start|retry|cancel)$/);
  if (req.method === 'POST' && imageActionMatch) {
    const job = imageJobs.find((item) => item.id === decodeURIComponent(imageActionMatch[1]));
    if (!job) return json(res, 404, { error: '图片任务不存在' });
    const action = imageActionMatch[2];
    if (action === 'start') {
      if (!TERMINAL_STATUSES.has(job.status)) updateImageJob(job, { status: 'queued', error: '' });
      scheduleImageWorkers();
      return json(res, 202, { job: publicImageJob(job) });
    }
    if (action === 'retry') {
      updateImageJob(job, { status: 'queued', error: '', outputUrls: [], completedAt: '' });
      scheduleImageWorkers();
      return json(res, 202, { job: publicImageJob(job) });
    }
    updateImageJob(job, { status: 'canceled', error: '已由用户取消', completedAt: new Date().toISOString() });
    return json(res, 200, { job: publicImageJob(job) });
  }

  if (req.method === 'POST' && url.pathname === '/api/image-jobs/start-all') {
    for (const job of imageJobs) {
      if (job.status === 'queued') {
        job.status = 'queued';
      }
    }
    await persistImageJobs();
    scheduleImageWorkers();
    return json(res, 202, { jobs: imageJobs.map(publicImageJob) });
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs/start-all') {
    for (const job of jobs) {
      if (job.status === 'queued') {
        job.status = 'queued';
      }
    }
    await persistJobs();
    scheduleWorkers();
    return json(res, 202, { jobs });
  }

  const videoMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/video$/);
  if ((req.method === 'GET' || req.method === 'HEAD') && videoMatch) {
    const job = findJob(decodeURIComponent(videoMatch[1]));
    if (!job) return json(res, 404, { error: '任务不存在' });
    if (!job.localFile) return json(res, 404, { error: '视频尚未下载到本地' });
    const resolvedFile = path.resolve(String(job.localFile));
    const ext = path.extname(resolvedFile).toLowerCase();
    if (!['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return json(res, 403, { error: '不支持的视频文件类型' });
    return streamVideoFile(req, res, resolvedFile);
  }

  const openJobFolderMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/open-folder$/);
  if (req.method === 'POST' && openJobFolderMatch) {
    const job = findJob(decodeURIComponent(openJobFolderMatch[1]));
    if (!job) return json(res, 404, { error: '任务不存在' });
    try {
      let target = config.outputDir;
      let selectFile = false;
      if (job.localFile) {
        const candidate = path.resolve(String(job.localFile));
        try {
          await fs.access(candidate);
          target = candidate;
          selectFile = true;
        } catch {}
      }
      await fs.mkdir(selectFile ? path.dirname(target) : target, { recursive: true });
      openLocalPathInExplorer(target, selectFile);
      return json(res, 200, { ok: true, path: target });
    } catch (error) {
      return json(res, 500, { error: `打开目录失败：${error.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/open-dir') {
    const body = await readBody(req);
    const targetKey = String(body.target || '').trim();
    const dirPath = targetKey === 'material' ? MATERIAL_DIR : targetKey === 'output' ? config.outputDir : '';
    if (!dirPath) return json(res, 400, { error: '未知目录类型' });
    try {
      await fs.mkdir(dirPath, { recursive: true });
      openLocalPathInExplorer(dirPath, false);
      return json(res, 200, { ok: true, path: dirPath });
    } catch (error) {
      return json(res, 500, { error: `打开目录失败：${error.message}` });
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
    const includeFailedParam = url.searchParams.get('includeFailed');
    const includeFailed = includeFailedParam === null ? true : includeFailedParam === '1' || includeFailedParam === 'true';
    const removed = jobs.filter((job) => {
      if (job.status === 'succeeded' && job.localFile) return true;
      if (includeFailed && TERMINAL_STATUSES.has(job.status) && job.status !== 'succeeded') return true;
      return false;
    });
    jobs = jobs.filter((job) => !removed.includes(job));
    await persistJobs();
    await Promise.all(removed.filter((job) => job.narrationEnabled).map((job) => {
      const cacheDir = path.resolve(FISH_AUDIO_CACHE_DIR, String(job.id));
      return isInside(FISH_AUDIO_CACHE_DIR, cacheDir)
        ? fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {})
        : Promise.resolve();
    }));
    return json(res, 200, { jobs, removedCount: removed.length });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/image-jobs') {
    imageJobs = imageJobs.filter((job) => !TERMINAL_STATUSES.has(job.status));
    await persistImageJobs();
    return json(res, 200, { jobs: imageJobs.map(publicImageJob) });
  }
  return json(res, 404, { error: '接口不存在' });
}

async function serveLocalAsset(req, res, url, baseDir) {
  const prefix = baseDir === MATERIAL_DIR ? '/materials/' : '/outputs/';
  const relative = decodeURIComponent(url.pathname.slice(prefix.length));
  const filePath = path.resolve(baseDir, relative);
  if (!isInside(baseDir, filePath)) return json(res, 403, { error: '禁止访问' });
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeForFile(filePath), 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: '文件不存在' });
  }
}

async function serveThumbnail(req, res, url) {
  const relative = decodeURIComponent(url.pathname.slice('/thumbnails/'.length));
  const source = path.resolve(MATERIAL_DIR, relative);
  if (!isInside(MATERIAL_DIR, source) || !IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase())) return json(res, 403, { error: '禁止访问' });
  let stat;
  try { stat = await fs.stat(source); } catch { return json(res, 404, { error: '图片不存在' }); }
  if (!stat.isFile()) return json(res, 404, { error: '图片不存在' });
  const version = `${Math.trunc(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
  const cacheKey = crypto.createHash('sha256').update(`${source}\0${version}`).digest('hex');
  const thumbnail = path.join(THUMBNAIL_DIR, `${cacheKey}.webp`);
  try {
    await fs.access(thumbnail);
  } catch {
    if (!thumbnailPromises.has(cacheKey)) {
      const pending = (async () => {
        await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
        await sharp(source).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(thumbnail);
      })();
      thumbnailPromises.set(cacheKey, pending);
      pending.finally(() => thumbnailPromises.delete(cacheKey)).catch(() => {});
    }
    try {
      await thumbnailPromises.get(cacheKey);
    } catch {
      const raw = await fs.readFile(source);
      res.writeHead(200, { 'Content-Type': mimeForFile(source), 'Cache-Control': 'no-cache' });
      res.end(raw);
      return;
    }
  }
  const data = await fs.readFile(thumbnail);
  res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': url.searchParams.get('v') === version ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(data);
}

async function serveModelReferenceThumbnail(res, url) {
  const id = url.pathname.slice('/model-reference-thumbnails/'.length);
  if (!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(id)) return json(res, 403, { error: '禁止访问' });
  try {
    const data = await sharp(path.join(MODEL_REFERENCE_DIR, id)).rotate().resize(160, 160, { fit: 'cover' }).webp({ quality: 75 }).toBuffer();
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  } catch {
    json(res, 404, { error: '模特图片不存在' });
  }
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/static/')) {
    const staticRel = pathname.slice('/static/'.length);
    const hostFile = path.resolve(HOST_STATIC_DIR, staticRel);
    if (!isInside(HOST_STATIC_DIR, hostFile)) return json(res, 403, { error: '禁止访问' });
    try {
      const data = await fs.readFile(hostFile);
      const ext = path.extname(hostFile).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch {
      return json(res, 404, { error: '静态资源不存在' });
    }
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '禁止访问' });
  try {
    let data = await fs.readFile(filePath);
    if (pathname === '/index.html') {
      const voices = JSON.stringify(publicFishVoicesWithBase()).replaceAll('<', '\\u003c');
      data = Buffer.from(data.toString('utf8').replace('__FISH_VOICES__', voices));
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    if (pathname.startsWith('/voice-previews/')) return json(res, 404, { error: '试听音频不存在' });
    if (pathname !== '/index.html') return serveStatic(req, res, new URL('/', 'http://localhost'));
    json(res, 404, { error: '文件不存在' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/internal/canvas-sync') {
      const provided = String(req.headers['x-canvas-sync-token'] || '').trim();
      if (!CANVAS_SYNC_TOKEN || provided !== CANVAS_SYNC_TOKEN) {
        return json(res, 403, { error: '禁止访问' });
      }
      const body = await readBody(req);
      canvasLinked = {
        enabled: true,
        apiBaseUrl: cleanBaseUrl(body.apiBaseUrl || ''),
        apiToken: String(body.apiToken || '').trim(),
        officialApiKey: String(body.officialApiKey || '').trim(),
        officialProviderName: String(body.officialProviderName || '火山引擎').trim() || '火山引擎',
        lowCostProviderName: String(body.lowCostProviderName || '6789API').trim() || '6789API',
      };
      scheduleWorkers();
      scheduleImageWorkers();
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' && url.pathname.startsWith('/thumbnails/')) await serveThumbnail(req, res, url);
    else if (req.method === 'GET' && url.pathname.startsWith('/model-reference-thumbnails/')) await serveModelReferenceThumbnail(res, url);
    else if (req.method === 'GET' && url.pathname.startsWith('/materials/')) await serveLocalAsset(req, res, url, MATERIAL_DIR);
    else if (req.method === 'GET' && url.pathname.startsWith('/outputs/')) await serveLocalAsset(req, res, url, config.outputDir);
    else if (req.method === 'GET') await serveStatic(req, res, url);
    else json(res, 405, { error: 'Method Not Allowed' });
  } catch (error) {
    json(res, 500, { error: error.message || '服务器错误' });
  }
});

export { normalizeJob, payloadFor, videoEndpoint, videoUrlFrom, apiConnection, statusFromRemote, isFishAuthError, resumableFishJobs };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureStorage();
  const port = Number(process.env.PORT || 3456);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const browserUrl = `http://${browserHost}:${port}`;
    console.log(`批量视频工作台已启动：${browserUrl}`);
    if (process.env.OPEN_BROWSER === 'true' && process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', browserUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    scheduleWorkers();
    scheduleImageWorkers();
    downloadQueue.schedule();
  });
}
