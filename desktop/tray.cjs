const { app, Tray, Menu } = require('electron');

function installDesktopTray(window, lifecycle, iconPath, appName) {
  const tray = new Tray(iconPath);
  let hidden = false;
  const updateMenu = () => {
    tray.setToolTip(hidden ? `${appName} · 后台运行中` : appName);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `打开${appName}`, click: show },
      { label: '隐藏到托盘', enabled: !hidden, click: hide },
      { type: 'separator' },
      { label: `退出${appName}`, click: () => { show(); app.quit(); } },
    ]));
  };
  function show() {
    if (lifecycle.isClosing()) return;
    hidden = false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
    updateMenu();
  }
  function hide() {
    if (lifecycle.isClosing() || tray.isDestroyed()) {
      return { ok: false, message: '窗口正在关闭或托盘不可用，请稍后重试。' };
    }
    hidden = true;
    window.hide();
    updateMenu();
    return { ok: true };
  }
  tray.on('click', show);
  tray.on('double-click', show);
  // 通知等入口恢复窗口时，也同步托盘状态。
  window.on('show', () => { hidden = false; updateMenu(); });
  const destroy = () => { if (!tray.isDestroyed()) tray.destroy(); };
  window.once('closed', destroy);
  app.once('will-quit', destroy);
  updateMenu();
  return { hide, show, isHidden: () => hidden };
}

module.exports = { installDesktopTray };
