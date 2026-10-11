'use strict';
// 商品页（淘宝/1688 等外部站点）会整站改写 console，console.log 信号不可靠。
// 右下角小美入口球用 contextBridge 提供直达 IPC 的点击通道，不依赖页面 console。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xiaomeiProductBridge', {
  notifyAgentOrbClick: () => ipcRenderer.send('commerce:product-agent-orb-click'),
});
