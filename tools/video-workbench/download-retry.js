export function downloadRetryDelayMs(failures) {
  return Math.min(30 * 60 * 1000, 30 * 1000 * (2 ** Math.min(Math.max(0, failures - 1), 6)));
}

export function createDownloadRetryQueue({ jobs, download, update, retryDelay = downloadRetryDelayMs, now = Date.now, concurrency = 2 }) {
  const active = new Set();
  let scheduled = false;
  let timer = null;
  let stopped = false;

  function schedule() {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(dispatch);
  }

  function dispatch() {
    scheduled = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;

    const pending = jobs().filter((job) => job.status === 'succeeded' && !job.localFile && !active.has(job.id));
    const currentTime = now();
    let slots = Math.max(0, concurrency - active.size);
    let nextTime = Infinity;
    for (const job of pending) {
      const readyAt = Date.parse(job.downloadRetryAt || '') || 0;
      if (readyAt > currentTime) {
        nextTime = Math.min(nextTime, readyAt);
      } else if (slots > 0) {
        active.add(job.id);
        slots -= 1;
        void run(job).catch((error) => console.error('自动下载任务失败：', error));
      }
    }
    if (slots > 0 && Number.isFinite(nextTime)) {
      timer = setTimeout(schedule, Math.max(1, nextTime - currentTime));
    }
  }

  async function run(job) {
    const previousFailures = Math.max(0, Number(job.downloadAttempts) || 0);
    try {
      await update(job, {
        downloadState: 'downloading',
        downloadRetryAt: '',
        error: '',
      });
      await download(job, previousFailures);
      await update(job, { downloadState: 'saved', downloadAttempts: 0, downloadRetryAt: '', error: '' });
    } catch (error) {
      if (job.status === 'succeeded' && !job.localFile) {
        const failures = previousFailures + 1;
        const readyAt = new Date(now() + retryDelay(failures)).toISOString();
        await update(job, {
          downloadState: 'retrying',
          downloadAttempts: failures,
          downloadRetryAt: readyAt,
          error: `自动下载失败：${error.message}；稍后自动重试`,
        });
      }
    } finally {
      active.delete(job.id);
      schedule();
    }
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { schedule, stop, isDownloading: (jobId) => active.has(jobId) };
}
