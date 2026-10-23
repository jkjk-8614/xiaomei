// DeepSeek 侧栏底部的「MCP 设置」入口：与官方「设置」按钮同一行。
// 点击后由桌面端转交主窗口，打开小美画布的 MCP 设置弹窗；MCP 服务只在
// 小美画布一处维护，这里只提供入口。
(() => {
  if (window.__xiaomeiMcpEntryInstalled) return;
  window.__xiaomeiMcpEntryInstalled = true;

  const PLUG_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1.3"><path d="M6 1.75v2.5M10 1.75v2.5" stroke="currentColor"></path><path d="M4 4.25h8v2.1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V4.25Z" stroke="currentColor"></path><path d="M8 10.35v3.9" stroke="currentColor"></path></svg>';

  const origin = () => document.documentElement.getAttribute('data-xiaomei-origin') || '';

  const settingsTrigger = () => {
    const slot = document.querySelector('[data-slot="settings.trigger"]');
    if (slot?.closest('button')) return slot.closest('button');
    return [...document.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || '').trim() === '设置') || null;
  };

  const insert = () => {
    if (document.querySelector('[data-xiaomei-mcp-entry]')) return;
    const settings = settingsTrigger();
    if (!settings) return;
    // 设置按钮所在的一行（官方把设置放在侧栏底部的行容器里）。
    const row = settings.closest('div[class]') || settings.parentElement;
    if (!row) return;

    const entry = settings.cloneNode(true);
    entry.dataset.xiaomeiMcpEntry = '1';
    entry.setAttribute('aria-label', 'MCP 设置');
    entry.removeAttribute('aria-haspopup');
    entry.removeAttribute('aria-expanded');
    entry.removeAttribute('aria-keyshortcuts');
    entry.style.flex = '0 0 auto';
    entry.style.width = 'auto';
    entry.style.height = '32px';
    entry.style.marginLeft = 'auto';
    entry.style.padding = '0 10px';
    entry.style.gap = '6px';
    for (const holder of entry.querySelectorAll('[data-slot]')) holder.removeAttribute('data-slot');
    for (const label of entry.querySelectorAll('span')) {
      if ((label.textContent || '').trim() === '设置') label.textContent = 'MCP 设置';
    }
    const icon = entry.querySelector('svg');
    if (icon) icon.outerHTML = PLUG_ICON;
    entry.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const base = origin();
      if (!base) return;
      window.open(`${base}/static/index.html?page=mcp`, '_blank');
    });
    row.appendChild(entry);
  };

  insert();
  // 官方侧栏是 React 渲染的，重新渲染后入口会丢失，这里补回。
  new MutationObserver(() => insert()).observe(document.documentElement, { childList: true, subtree: true });
})();
