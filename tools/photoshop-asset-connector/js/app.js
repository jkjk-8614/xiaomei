(function () {
  const { state, LS, net, sources, socket, ps, ui } = DX;
  const ids = ['dot', 'selectA', 'selectB', 'search', 'refreshBtn', 'count', 'grid', 'placeBtn', 'exportBtn',
    'pushMsg', 'server', 'connectBtn', 'connMsg', 'liveToggle', 'exportLayerToggle', 'githubBtn'];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const panels = [...document.querySelectorAll('[data-view]')];
  const sourceButtons = [...document.querySelectorAll('[data-source]')];
  const previewsPerPage = 60;
  const parallelPreviews = 6;
  const galleries = new Map();
  const invalidated = new Map();
  let serial = 0;
  let catalogRead = 0;
  let gallery = null;
  let activePreviews = 0;
  let loading = false;
  let connecting = false;
  let placing = false;
  let exporting = false;
  let reloadTimer;
  let searchTimer;

  function status(node, text, tone) {
    node.className = (node === elements.connMsg ? 'conn-msg' : 'push-msg') + (tone ? ' ' + tone : '');
    node.textContent = text;
  }

  const assetStatus = (text, tone) => status(elements.pushMsg, text, tone);
  const connectionStatus = (text, tone) => status(elements.connMsg, text, tone);
  const adapter = () => sources.adapters[state.source];
  const choices = (options) => options.map(({ id, name }) => ({ value: id, label: name }));
  const resolveChoice = (options, previous) => options.some(({ id }) => id === previous) ? previous : options[0]?.id || '';
  const items = () => adapter().items(state.aId, state.bId);
  const selected = () => items().find((item) => String(item.id) === state.selectedId);
  const destination = () => adapter().exportTarget(state.aId, state.bId);

  function enableActions() {
    elements.connectBtn.disabled = connecting || exporting || placing;
    elements.placeBtn.disabled = !state.connected || placing || !sources.itemIsImage(selected());
    elements.exportBtn.disabled = !state.connected || exporting || !destination() || !ps.hasDocument();
    elements.refreshBtn.disabled = !state.connected || loading;
    for (const button of sourceButtons) button.disabled = loading;
  }

  function showDestination() {
    if (placing || exporting) return;
    const target = destination();
    if (!target) assetStatus(state.source === 'canvas' ? '画布资产可浏览和置入。' : '请选择可上传的素材分组。');
    else if (!ps.hasDocument()) assetStatus('打开 Photoshop 文档后可上传当前画面。');
    else assetStatus('上传将存入：' + target.label);
  }

  function activate(buttons, attribute, value) {
    for (const button of buttons) {
      const enabled = button.getAttribute(attribute) === value;
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-pressed', String(enabled));
    }
  }

  function showTab(tab) {
    state.tab = tab;
    activate(tabs, 'data-tab', tab);
    for (const panel of panels) panel.classList.toggle('active', panel.getAttribute('data-view') === tab);
    if (tab === 'settings') {
      setTimeout(() => {
        if (state.tab === 'settings') elements.server.focus?.();
      }, 30);
    }
    if (tab === 'generate') DX.generate?.ensureLoaded();
    if (tab === 'agent') DX.agent?.ensureLoaded();
    if (tab === 'assets') retryPreviews(false);
  }

  function renderFilters() {
    activate(sourceButtons, 'data-source', state.source);
    const primary = adapter().optionsA();
    elements.selectA.classList.toggle('hidden', !primary);
    ui.fillPicker(elements.selectA, choices(primary || []), state.aId);
    ui.fillPicker(elements.selectB, choices(adapter().optionsB(state.aId) || []), state.bId);
  }

  function invalidateGallery(source) {
    for (const [key, view] of galleries) {
      if (view.source === source) galleries.delete(key);
    }
  }

  function thumbnail(record) {
    const box = record.node;
    box.innerHTML = '<img alt="">';
    const image = box.querySelector('img');
    return new Promise((resolve) => {
      const timeout = setTimeout(() => finish(false), 8000);
      const loaded = () => finish(true);
      const failed = () => finish(false);
      function finish(ok) {
        clearTimeout(timeout);
        image.removeEventListener('load', loaded);
        image.removeEventListener('error', failed);
        if (!ok && image.parentNode === box) box.removeChild(image);
        resolve(ok);
      }
      image.addEventListener('load', loaded);
      image.addEventListener('error', failed);
      image.src = record.url;
    });
  }

  async function fetchPreview(record) {
    record.state = 'loading';
    activePreviews += 1;
    let ok = false;
    try {
      ok = await thumbnail(record);
      if (!ok) ok = await thumbnail(record);
    } catch (_) {
      ok = false;
    } finally {
      activePreviews -= 1;
      record.state = ok ? 'ready' : 'failed';
      if (!ok) record.node.innerHTML = '<div class="thumb-ph">无预览</div>';
      pumpPreviews();
    }
  }

  function pumpPreviews() {
    if (!gallery || state.tab !== 'assets') return;
    for (const preview of gallery.previews) {
      if (activePreviews >= parallelPreviews) return;
      if (preview.state === 'queued') fetchPreview(preview);
    }
  }

  function retryPreviews(showStatus) {
    const retry = gallery?.previews.filter((preview) => preview.state === 'failed') || [];
    for (const preview of retry) preview.state = 'queued';
    if (showStatus) assetStatus(retry.length ? '正在重试 ' + retry.length + ' 张缩略图 …' : '当前没有空白缩略图。');
    pumpPreviews();
  }

  function markSelection(view) {
    for (const card of view.cards) {
      const selected = card.getAttribute('data-id') === state.selectedId;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
  }

  function chooseItem(view, id) {
    state.selectedId = id;
    markSelection(view);
    enableActions();
    showDestination();
  }

  function addCard(view, item) {
    const card = document.createElement('button');
    const image = sources.itemIsImage(item);
    const name = item.name || '未命名';
    const id = String(item.id);
    card.type = 'button';
    card.className = 'card';
    card.title = name;
    card.setAttribute('data-id', id);
    card.innerHTML = '<div class="thumb">' + (image ? '' : '<span class="badge">' + ui.esc(item.kind || '文件') + '</span>')
      + '</div><div class="meta">' + ui.esc(name) + '</div>';
    if (image) {
      const display = net.needsJpeg(item.url) ? net.displayUrl(item.url, 256) : net.thumbUrl(item.url, 256);
      view.previews.push({ node: card.querySelector('.thumb'), url: display, state: 'queued' });
    }
    card.addEventListener('click', () => chooseItem(view, id));
    card.addEventListener('dblclick', () => {
      chooseItem(view, id);
      place();
    });
    view.cards.push(card);
    view.element.appendChild(card);
  }

  function renderCount(view) {
    const total = view.rows.length;
    elements.count.textContent = total + ' 个素材' + (view.cards.length < total ? '（已显示 ' + view.cards.length + '）' : '');
  }

  function addPage(view) {
    view.more?.remove();
    const start = view.cards.length;
    for (const item of view.rows.slice(start, start + previewsPerPage)) addCard(view, item);
    const left = view.rows.length - view.cards.length;
    if (left) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'more';
      button.setAttribute('data-more', '');
      button.textContent = '加载更多（还有 ' + left + '）';
      button.addEventListener('click', () => addPage(view));
      view.element.appendChild(button);
      view.more = button;
    }
    markSelection(view);
    renderCount(view);
    pumpPreviews();
  }

  function renderGallery() {
    const query = elements.search.value.trim().toLowerCase();
    const rows = items().filter((item) => item.kind !== 'video' && item.kind !== 'audio'
      && (!query || (item.search || '').includes(query)));
    const target = elements.grid;
    gallery = null;
    target.classList.toggle('empty', !rows.length);
    if (!rows.length) {
      elements.count.textContent = '没有素材';
      target.innerHTML = '<div class="empty-state">这里没有匹配的素材。</div>';
      enableActions();
      return;
    }
    const key = JSON.stringify([state.source, state.aId, state.bId]);
    let view = query ? null : galleries.get(key);
    if (!view) {
      const element = document.createElement('div');
      element.className = 'grid-inner';
      view = { source: state.source, rows, element, cards: [], previews: [], more: null };
      if (!query) galleries.set(key, view);
    }
    gallery = view;
    if (target.firstElementChild !== view.element) {
      target.innerHTML = '';
      target.appendChild(view.element);
    }
    if (view.cards.length) {
      markSelection(view);
      renderCount(view);
      pumpPreviews();
    } else {
      addPage(view);
    }
    enableActions();
  }

  async function browse(source, retain = false) {
    const number = ++catalogRead;
    const requested = sources.adapters[source];
    const dirty = invalidated.get(source);
    loading = true;
    elements.count.textContent = '加载中 …';
    enableActions();
    try {
      if (!state.raw[source] || dirty !== undefined) {
        const data = await requested.load();
        if (number !== catalogRead) return;
        state.raw[source] = data;
        if (dirty === invalidated.get(source)) invalidated.delete(source);
        invalidateGallery(source);
      }
      state.source = source;
      state.aId = resolveChoice(requested.optionsA() || [], retain ? state.aId : '');
      state.bId = resolveChoice(requested.optionsB(state.aId) || [], retain ? state.bId : '');
      if (!retain || !selected()) state.selectedId = '';
      renderFilters();
      renderGallery();
      showDestination();
    } catch (error) {
      if (number === catalogRead && state.connected) {
        if (gallery) renderCount(gallery);
        else elements.count.textContent = '没有素材';
      }
      throw error;
    } finally {
      if (number === catalogRead) {
        loading = false;
        enableActions();
      }
    }
  }

  function markStale(source) {
    invalidated.set(source, ++serial);
  }

  function scheduleReload(source) {
    if (!state.connected || !elements.liveToggle.checked) return;
    for (const name of source ? [source] : Object.keys(sources.adapters)) markStale(name);
    if (source && source !== state.source) return;
    clearTimeout(reloadTimer);
    const reload = () => {
      if (!state.connected || !elements.liveToggle.checked) return;
      if (loading || exporting) {
        reloadTimer = setTimeout(reload, 500);
        return;
      }
      if (invalidated.has(state.source)) browse(state.source, true).catch(() => {});
    };
    reloadTimer = setTimeout(reload, 500);
  }

  const live = { isLive: () => elements.liveToggle.checked, onUpdate: scheduleReload };

  async function connect() {
    if (connecting || exporting || placing) return;
    const host = net.parseHost(elements.server.value);
    if (!host) {
      connectionStatus('请输入服务地址，例如 127.0.0.1:3000', 'err');
      return;
    }
    connecting = true;
    clearTimeout(reloadTimer);
    socket.closeSocket();
    galleries.clear();
    invalidated.clear();
    gallery = null;
    state.connected = false;
    state.host = host;
    state.raw = DX.emptyCatalog();
    elements.dot.className = 'dot busy';
    elements.dot.title = '正在连接';
    connectionStatus('正在连接 ' + host + ' …');
    try {
      await browse(state.source);
      state.connected = true;
      localStorage.setItem(LS.host, host);
      elements.dot.className = 'dot on';
      elements.dot.title = '已连接';
      connectionStatus('已连接 ' + host, 'ok');
      DX.generate?.reset();
      DX.agent?.reset();
      socket.openSocket(live);
      showTab('assets');
    } catch (error) {
      elements.dot.className = 'dot err';
      elements.dot.title = '连接失败';
      elements.count.textContent = '未连接';
      connectionStatus('连接失败：' + error.message, 'err');
    } finally {
      connecting = false;
      enableActions();
    }
  }

  async function place() {
    const item = selected();
    if (!state.connected || placing || !sources.itemIsImage(item)) return;
    placing = true;
    enableActions();
    assetStatus('正在下载到图层 …');
    try {
      await ps.placeImage(item);
      assetStatus('已下载到图层：' + item.name, 'ok');
    } catch (error) {
      assetStatus('下载失败：' + error.message, 'err');
    } finally {
      placing = false;
      enableActions();
    }
  }

  async function upload() {
    const target = destination();
    if (!state.connected || exporting || !target || !ps.hasDocument()) return;
    const { source, aId, bId } = state;
    const sender = adapter();
    exporting = true;
    enableActions();
    assetStatus(state.exportLayer ? '正在导出选中图层 …' : '正在导出文档 …');
    try {
      const { name, buffer } = await ps.exportCurrentPng();
      assetStatus('正在上传到小美画布 …');
      await sender.doExport(aId, bId, name, buffer);
      markStale(source);
      const message = '已上传到「' + target.label + '」：' + name;
      if (state.source === source && !loading) {
        try {
          await browse(source, true);
        } catch (_) {
          assetStatus(message + '。素材列表刷新失败。', 'ok');
          return;
        }
      }
      assetStatus(message, 'ok');
    } catch (error) {
      assetStatus('上传失败：' + error.message, 'err');
    } finally {
      exporting = false;
      enableActions();
    }
  }

  for (const tab of tabs) tab.addEventListener('click', () => showTab(tab.getAttribute('data-tab')));
  for (const button of sourceButtons) button.addEventListener('click', async () => {
    const source = button.getAttribute('data-source');
    if (loading || source === state.source) return;
    if (!state.connected) {
      state.source = source;
      activate(sourceButtons, 'data-source', source);
      return;
    }
    try {
      await browse(source);
      localStorage.setItem(LS.source, source);
    } catch (error) {
      renderGallery();
      assetStatus('加载素材失败：' + error.message, 'err');
    }
  });
  ui.onPick(elements.selectA, () => {
    state.aId = ui.pickerValue(elements.selectA);
    state.bId = resolveChoice(adapter().optionsB(state.aId) || [], '');
    state.selectedId = '';
    renderFilters();
    renderGallery();
    showDestination();
  });
  ui.onPick(elements.selectB, () => {
    state.bId = ui.pickerValue(elements.selectB);
    state.selectedId = '';
    renderGallery();
    showDestination();
  });
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderGallery, 200);
  });
  elements.refreshBtn.addEventListener('click', () => {
    if (!loading) retryPreviews(true);
  });
  elements.connectBtn.addEventListener('click', connect);
  elements.server.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) connect();
  });
  elements.liveToggle.addEventListener('change', () => {
    if (elements.liveToggle.checked && state.connected) {
      socket.openSocket(live);
      scheduleReload();
    } else socket.closeSocket();
  });
  elements.exportLayerToggle.addEventListener('change', () => {
    state.exportLayer = elements.exportLayerToggle.checked;
    localStorage.setItem(LS.exportLayer, state.exportLayer ? '1' : '0');
  });
  elements.githubBtn.addEventListener('click', async () => {
    try {
      await ps.openUrl('https://github.com/hero8152/Infinite-Canvas');
    } catch (error) {
      connectionStatus('打开来源链接失败：' + error.message, 'err');
    }
  });
  elements.placeBtn.addEventListener('click', place);
  elements.exportBtn.addEventListener('click', upload);
  ps.onDocChange(() => {
    if (state.tab === 'assets') {
      enableActions();
      showDestination();
    }
  });

  const savedHost = localStorage.getItem(LS.host);
  const savedSource = localStorage.getItem(LS.source);
  if (Object.keys(sources.adapters).includes(savedSource)) state.source = savedSource;
  state.exportLayer = localStorage.getItem(LS.exportLayer) === '1';
  elements.exportLayerToggle.checked = state.exportLayer;
  elements.server.value = savedHost || '127.0.0.1:3000';
  if (savedHost) connectionStatus('点击「连接」恢复上次的连接。');
  activate(sourceButtons, 'data-source', state.source);
  enableActions();
  showTab('settings');
})();
