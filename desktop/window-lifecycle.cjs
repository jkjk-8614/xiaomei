const { dialog } = require('electron');

function installWindowLifecycle(window, cleanup) {
  let closing = false;
  let promptPending = false;
  let closeTimer;
  const timers = new Set();
  const cancelTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const confirmClose = async () => {
    if (promptPending || window.isDestroyed()) return;
    promptPending = true;
    clearTimeout(closeTimer);
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        message: '页面未能完成关闭',
        detail: '是否强制关闭窗口？尚未保存的内容可能丢失。',
        buttons: ['继续等待', '强制关闭'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1 && !window.isDestroyed()) window.destroy();
      else closing = false;
    } finally { promptPending = false; }
  };
  window.on('close', () => {
    closing = true;
    cancelTimers();
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { void confirmClose(); }, 3000);
  });
  window.webContents.on('will-prevent-unload', () => {
    if (closing) void confirmClose();
  });
  window.once('closed', () => {
    closing = true;
    clearTimeout(closeTimer);
    cancelTimers();
    cleanup();
  });
  return {
    isClosing: () => closing || window.isDestroyed(),
    schedule(callback, delay) {
      if (closing || window.isDestroyed()) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closing && !window.isDestroyed()) callback();
      }, delay);
      timers.add(timer);
    },
  };
}

module.exports = { installWindowLifecycle };
