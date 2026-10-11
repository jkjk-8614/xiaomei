(() => {
  if (document.querySelector('[data-xiaomei-image-copy]')) return;
  const style = document.createElement('style');
  style.textContent = `
    [data-xiaomei-image-copy] { position:fixed; z-index:2147483001; height:32px; padding:0 12px;
      border:1px solid rgba(255,255,255,.4); border-radius:8px; background:rgba(31,25,64,.94);
      color:#fff; box-shadow:0 4px 16px rgba(0,0,0,.22); font:600 12px/1 system-ui,"Microsoft YaHei",sans-serif; cursor:pointer; }
    [data-xiaomei-image-copy][hidden] { display:none; }
    [data-xiaomei-image-copy]:disabled { cursor:wait; opacity:.75; }
  `;
  document.head.appendChild(style);
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.xiaomeiImageCopy = '1';
  button.textContent = '复制图片';
  button.hidden = true;
  document.body.appendChild(button);
  let image = null;
  let hideTimer;
  let feedbackTimer;
  const imageSelector = 'button[data-variant] img, [role="dialog"][aria-modal="true"] img';
  const previewImage = () => document.querySelector('[role="dialog"][aria-modal="true"] img');
  const position = () => {
    const preview = previewImage();
    if (preview) image = preview;
    if (!image?.isConnected) { button.hidden = true; return; }
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    if (preview) {
      button.style.left = Math.max(8, (innerWidth - button.offsetWidth) / 2) + 'px';
      button.style.top = Math.max(8, innerHeight - button.offsetHeight - 24) + 'px';
    } else {
      button.style.left = Math.max(8, Math.min(innerWidth - button.offsetWidth - 8, rect.right - button.offsetWidth - 4)) + 'px';
      button.style.top = Math.max(8, Math.min(innerHeight - button.offsetHeight - 8, rect.bottom - button.offsetHeight - 4)) + 'px';
    }
  };
  const hide = () => {
    if (previewImage() || button.disabled || button.matches(':hover, :focus')) return;
    image = null;
    button.hidden = true;
  };
  document.addEventListener('pointerover', event => {
    if (!event.target.matches?.(imageSelector)) return;
    clearTimeout(hideTimer);
    image = event.target;
    position();
  }, true);
  document.addEventListener('pointerout', event => {
    if (event.target === image) hideTimer = setTimeout(hide, 250);
  }, true);
  document.addEventListener('focusin', event => {
    const focusedImage = event.target.querySelector?.('img');
    if (focusedImage?.matches(imageSelector)) { image = focusedImage; position(); }
  });
  button.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  button.addEventListener('pointerleave', () => { hideTimer = setTimeout(hide, 250); });
  button.addEventListener('blur', hide);
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (!image || button.disabled) return;
    const target = image;
    clearTimeout(feedbackTimer);
    button.disabled = true;
    button.textContent = '复制中…';
    try {
      const response = await fetch(target.currentSrc || target.src, { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
      let blob = await response.blob();
      if (blob.type.toLowerCase() !== 'image/png') {
        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片转换失败')), 'image/png'));
        } finally { bitmap.close(); }
      }
      const result = await window.xiaomeiHarnessClipboard.writeImage(await blob.arrayBuffer());
      if (!result?.ok) throw new Error(result?.message || '剪贴板写入失败');
      button.textContent = '已复制图片';
      button.title = '';
    } catch (error) {
      button.textContent = '复制失败，点击重试';
      button.title = error?.message || '复制失败';
    } finally {
      button.disabled = false;
      feedbackTimer = setTimeout(() => { button.textContent = '复制图片'; button.title = ''; hide(); }, 1800);
    }
  });
  // Lightboxes are rendered into body portals after the thumbnail is clicked.
  new MutationObserver(position).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('scroll', () => { if (previewImage()) position(); else { image = null; button.hidden = true; } }, true);
  window.addEventListener('resize', position);
})();
