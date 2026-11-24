import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { ProxyAgent } from 'undici';

const fishProxyAgents = new Map();

export function normalizeFishProxyUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch { throw new Error('Fish 代理地址必须是完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Fish 代理地址只能填写 http://主机:端口 或 https://主机:端口');
  }
  return url.origin;
}

function fishProxyDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (!fishProxyAgents.has(proxyUrl)) fishProxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  return fishProxyAgents.get(proxyUrl);
}

export function normalizeNarrationSegments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error('请填写 1 至 12 段口播分镜');
  return value.map((item, index) => {
    const text = String(item?.text || '').trim();
    const visualPrompt = String(item?.visualPrompt || '').trim();
    if (!text || !visualPrompt) throw new Error(`第 ${index + 1} 段需填写口播和画面`);
    if (text.length > 500 || visualPrompt.length > 3500) throw new Error(`第 ${index + 1} 段内容过长`);
    return { text, visualPrompt, taskId: '', downloadUrl: '', idempotencyKey: '' };
  });
}

export function chooseVideoDuration(durations, speechSeconds) {
  if (!Number.isFinite(speechSeconds) || speechSeconds <= 0) throw new Error('无法读取口播时长');
  const duration = [...durations].sort((a, b) => a - b).find((seconds) => seconds >= speechSeconds + 0.4);
  if (!duration) throw new Error(`口播 ${speechSeconds.toFixed(1)} 秒超过当前视频模型的时长上限`);
  return duration;
}

function runMedia(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000); });
    child.once('error', (error) => reject(new Error(`媒体处理启动失败：${error.message}`)));
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`媒体处理失败：${output.trim() || `退出码 ${code}`}`)));
  });
}

async function mediaDuration(file) {
  const value = await runMedia(ffprobeInstaller.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('无法读取音视频时长');
  return seconds;
}

async function synthesize(text, voiceId, key, target, proxyUrl) {
  const body = { text, format: 'mp3', latency: 'normal' };
  if (voiceId) body.reference_id = voiceId;
  const base = String(process.env.FISH_API_BASE_URL || 'https://api.fish.audio').replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${base}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: 'drama-3' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
      ...(proxyUrl ? { dispatcher: fishProxyDispatcher(proxyUrl) } : {}),
    });
  } catch (error) {
    const detail = error?.cause?.code || error?.message || '连接失败';
    const route = proxyUrl ? `代理 ${new URL(proxyUrl).host}` : '直连';
    throw new Error(`Fish Audio ${route}连接失败：${detail}`);
  }
  if (!response.ok) throw new Error(`Fish Audio 配音失败（${response.status}）：${(await response.text()).slice(0, 300)}`);
  if ((response.headers.get('content-type') || '').includes('application/json')) throw new Error('Fish Audio 未返回音频，请检查音色 ID 与账户额度');
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 100) throw new Error('Fish Audio 返回的音频为空');
  await fs.writeFile(target, audio);
}

async function speechAudio(text, voiceId, key, target, cacheDir, index, proxyUrl) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(['drama-3', voiceId, text])).digest('hex');
  const cached = cacheDir ? path.join(cacheDir, `${index}-${digest}.mp3`) : '';
  if (cached) {
    let found = false;
    try { await fs.copyFile(cached, target); found = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (found) {
      try { return await mediaDuration(target); }
      catch { await fs.rm(cached, { force: true }); }
    }
  }
  await synthesize(text, voiceId, key, target, proxyUrl);
  const seconds = await mediaDuration(target);
  if (cached) {
    await fs.mkdir(cacheDir, { recursive: true });
    const pending = `${cached}.${crypto.randomUUID()}.part`;
    try {
      await fs.copyFile(target, pending);
      await fs.rename(pending, cached);
    } finally { await fs.rm(pending, { force: true }); }
  }
  return seconds;
}

export async function renderNarration({ job, fishApiKey, fishProxyUrl = '', audioCacheDir = '', durations, outputDir, createVideo, reviseSpeech, stage, assertActive, safeFileName }) {
  if (!fishApiKey) throw new Error('请先在设置中填写 Fish Audio API Key');
  fishProxyUrl = normalizeFishProxyUrl(fishProxyUrl);
  if (!ffmpegInstaller.path || !ffprobeInstaller.path) throw new Error('FFmpeg 组件未安装完整');
  if (!durations.includes(job.duration)) throw new Error('所选视频时长不受当前模型支持');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-video-'));
  try {
    const rendered = [];
    for (const [index, segment] of job.narrationSegments.entries()) {
      assertActive();
      await stage('生成口播配音');
      const audio = path.join(tempDir, `audio-${index}.mp3`);
      let audioSeconds;
      let duration;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assertActive();
        audioSeconds = await speechAudio(segment.text, job.fishVoiceId, fishApiKey, audio, audioCacheDir, index, fishProxyUrl);
        try {
          duration = chooseVideoDuration([job.duration], audioSeconds);
          break;
        } catch (error) {
          if (!reviseSpeech || attempt === 2) throw error;
          await stage('口播超时，正在精简文案');
          const revised = await reviseSpeech(segment.text, audioSeconds, job.duration);
          if (!revised || revised.length >= segment.text.length) throw new Error('口播精简后仍无法适配视频时长');
          segment.text = revised;
          await stage('重新生成口播配音');
        }
      }
      await stage('生成视频画面');
      const source = await createVideo(segment, index, duration, tempDir);
      assertActive();
      const videoSeconds = await mediaDuration(source);
      if (videoSeconds + 0.1 < audioSeconds) {
        segment.taskId = '';
        segment.downloadUrl = '';
        segment.idempotencyKey = '';
        await stage('视频画面短于口播，等待重新生成');
        throw new Error('视频画面短于口播，请重试任务');
      }
      const target = path.join(tempDir, `segment-${index}.mp4`);
      const length = job.duration;
      await runMedia(ffmpegInstaller.path, [
        '-y', '-loglevel', 'error', '-i', source, '-i', audio,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
        '-af', 'apad', '-c:a', 'aac', '-b:a', '160k',
        '-t', String(length), '-movflags', '+faststart', target,
      ]);
      rendered.push(target);
    }
    assertActive();
    await stage('合成成片');
    const finalTemp = path.join(tempDir, 'final.mp4');
    if (rendered.length === 1) await fs.copyFile(rendered[0], finalTemp);
    else {
      const list = path.join(tempDir, 'segments.txt');
      await fs.writeFile(list, rendered.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      await runMedia(ffmpegInstaller.path, [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', finalTemp,
      ]);
    }
    assertActive();
    await fs.mkdir(outputDir, { recursive: true });
    const target = path.join(outputDir, `${safeFileName(job.name)}-${job.id.slice(0, 8)}.mp4`);
    const pending = `${target}.partial`;
    try {
      await fs.copyFile(finalTemp, pending);
      assertActive();
      await fs.rename(pending, target);
    } finally { await fs.rm(pending, { force: true }); }
    if (audioCacheDir) await fs.rm(audioCacheDir, { recursive: true, force: true }).catch(() => {});
    return target;
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
}
