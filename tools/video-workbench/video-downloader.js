import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function retryableDownloadError(error) {
  const status = Number(error?.status);
  if (status) return [404, 408, 409, 425, 429].includes(status) || status >= 500;
  const message = String(error?.message || '').toLowerCase();
  return ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)
    || /terminated|fetch failed|socket|timed? out|econnreset|econnaborted|epipe|下载不完整/.test(message);
}

async function saveResponse(response, outputDir, fileNameBase) {
  if (!response.body) throw new Error('下载接口返回空文件');
  await fs.mkdir(outputDir, { recursive: true });
  const temporary = path.join(outputDir, `${fileNameBase}.${crypto.randomUUID()}.part`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    const { size } = await fs.stat(temporary);
    const expectedSize = Number(response.headers.get('content-length'));
    if (!size || (expectedSize > 0 && size !== expectedSize)) throw new Error('视频文件下载不完整');
    const handle = await fs.open(temporary, 'r');
    const header = Buffer.alloc(12);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const isMp4 = size >= 12 && header.toString('ascii', 4, 8) === 'ftyp';
    const isWebm = size >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!isMp4 && !isWebm) throw new Error('下载接口未返回有效视频文件');
    const target = path.join(outputDir, `${fileNameBase}${isWebm ? '.webm' : '.mp4'}`);
    await fs.rename(temporary, target);
    return target;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function downloadVideoFile(fetchResponse, outputDir, fileNameBase, { attempts = 5, onRetry = () => {}, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, url } = await fetchResponse();
      const target = await saveResponse(response, outputDir, fileNameBase);
      return { target, url };
    } catch (error) {
      if (attempt === attempts || !retryableDownloadError(error)) throw error;
      onRetry(error, attempt, attempts);
      await delay(Math.min(15000, 2000 * (2 ** (attempt - 1))));
    }
  }
}
