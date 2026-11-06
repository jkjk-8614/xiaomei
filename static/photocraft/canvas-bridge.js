(() => {
  if (window.frameElement?.id !== 'frame-photocraft') return;

  const bar = document.getElementById('photocraft_canvas_bar');
  const status = document.getElementById('photocraft_canvas_status');
  const save = document.getElementById('photocraft_save_canvas');
  const surface = document.getElementById('photocraft_canvas');
  const quickExport = 'file.export.quickExportAsPng';
  let exportKey;
  let session;
  let pendingExport;

  function updateShortcut(raw, load) {
    const prefs = JSON.parse(raw ?? '{}');
    const keys = prefs.alternateShortcuts?.[quickExport] || [];
    // Expose PhotoCraft's native PNG encoder through a session-only key binding.
    if (load) {
      if (!exportKey) {
        const assigned = new Set([...Object.values(prefs.shortcuts || {}), ...Object.values(prefs.alternateShortcuts || {}).flat()]);
        exportKey = ['F24', 'F23', 'F22', 'F21', 'F20'].find(key => !assigned.has('Cmd+Alt+Shift+' + key));
      }
      if (!exportKey) return raw;
      prefs.alternateShortcuts ??= {};
      prefs.alternateShortcuts[quickExport] = [...new Set([...keys, 'Cmd+Alt+Shift+' + exportKey])];
    } else if (exportKey && keys.includes('Cmd+Alt+Shift+' + exportKey)) {
      const retained = keys.filter(key => key !== 'Cmd+Alt+Shift+' + exportKey);
      if (retained.length) prefs.alternateShortcuts[quickExport] = retained;
      else delete prefs.alternateShortcuts[quickExport];
    } else {
      return raw;
    }
    return JSON.stringify(prefs);
  }

  function waitForEditor() {
    const loading = document.getElementById('photocraft_loading');
    if (!loading) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('PS 修图尚未就绪，请重新加载后重试'));
      }, 45000);
      const observer = new MutationObserver(() => {
        if (loading.isConnected) return;
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, {childList:true});
    });
  }

  bar.hidden = false;
  status.textContent = '保存当前文档为 PNG。未打开智能画布时会新建画布。';
  const editorReady = waitForEditor();
  editorReady.then(() => {
    if (!session) save.disabled = false;
  }).catch(error => {
    if (!session) status.textContent = error.message;
  });

  async function connectCanvas(link) {
    const active = session = link;
    bar.hidden = false;
    save.disabled = true;
    status.textContent = '正在从画布打开图片…';
    try {
      const [file] = await Promise.all([link.readImage(), editorReady]);
      if (active !== session) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      // A drop outside the document area opens a tab in PhotoCraft.
      surface.dispatchEvent(new DragEvent('drop', {
        dataTransfer:transfer, bubbles:true, cancelable:true, clientX:-1, clientY:-1
      }));
      status.textContent = `保存后将添加到「${link.title || '小美画布'}」`;
      save.disabled = false;
    } catch (error) {
      if (active === session) status.textContent = `${error.message}，请返回画布重试`;
    }
  }

  function capturePng(anchor) {
    if (!pendingExport || pendingExport.session !== session || !(anchor instanceof HTMLAnchorElement)
        || anchor.protocol !== 'blob:' || !/\.png$/i.test(anchor.download)) return false;
    const {receive} = pendingExport;
    pendingExport = null;
    receive(fetch(anchor.href).then(async response => {
      if (!response.ok) throw new Error('无法读取导出的 PNG');
      const name = anchor.download.replace(/\.png$/i, ' · PS 修图.png');
      return new File([await response.blob()], name, {type:'image/png'});
    }));
    return true;
  }

  save.addEventListener('click', async () => {
    const active = session;
    if (save.disabled) return;
    if (active?.isCanvasOpen?.() === false) {
      session = null;
      status.textContent = '原画布已关闭。再次点击即可保存到当前画布，或新建画布。';
      return;
    }
    save.disabled = true;
    status.textContent = '正在保存到画布…';
    const request = {session:active};
    let timeout;
    try {
      if (!exportKey) throw new Error('无法启动快速导出，请重新打开 PS 修图');
      const file = await new Promise((resolve, reject) => {
        request.receive = resolve;
        pendingExport = request;
        timeout = setTimeout(() => reject(new Error('未能导出图片，请选中要保存的文档后重试')), 12000);
        const mac = /Mac/i.test(navigator.platform);
        const key = {key:exportKey, code:exportKey, bubbles:true, cancelable:true, ctrlKey:!mac, metaKey:mac, altKey:true, shiftKey:true};
        surface.focus();
        requestAnimationFrame(() => {
          if (pendingExport !== request || active !== session) return;
          surface.dispatchEvent(new KeyboardEvent('keydown', key));
          requestAnimationFrame(() => surface.dispatchEvent(new KeyboardEvent('keyup', key)));
        });
      });
      if (active !== session) return;
      const isLinked = () => active === session;
      if (active) await active.addImage(file, isLinked);
      else await window.parent.savePhotoCraftImage(window, file, isLinked);
      if (active === session) status.textContent = '修图结果已添加到画布';
    } catch (error) {
      if (active === session) status.textContent = error.message;
    } finally {
      clearTimeout(timeout);
      if (pendingExport === request) pendingExport = null;
      if (active === session) save.disabled = false;
    }
  });

  window.XiaomeiPhotoCraft = {connectCanvas, updateShortcut, capturePng};
})();
