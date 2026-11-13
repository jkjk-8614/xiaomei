(function () {
  const { net, ps, state, ui } = DX;
  const controls = {};
  for (const key of ['New', 'Delete', 'History', 'ToggleModels', 'Models', 'LlmProvider', 'LlmModel',
    'ImgProvider', 'ImgModel', 'Messages', 'Attach', 'AttachBtn', 'RegionBtn', 'RetryBtn', 'Input', 'Send', 'Status']) {
    controls[key] = document.getElementById('ag' + key);
  }

  const preferences = {
    identity: 'daxiong.agent.uid',
    collapse: 'daxiong.agent.collapsed',
    region: 'daxiong.agent.region',
    chatPlatform: 'daxiong.agent.llmp',
    chatModel: 'daxiong.agent.llmm',
    imagePlatform: 'daxiong.agent.imgp',
    imageModel: 'daxiong.agent.imgm',
  };
  const selectors = [
    { provider: controls.LlmProvider, model: controls.LlmModel, field: 'chat_models',
      platformKey: preferences.chatPlatform, modelKey: preferences.chatModel },
    { provider: controls.ImgProvider, model: controls.ImgModel, field: 'image_models',
      platformKey: preferences.imagePlatform, modelKey: preferences.imageModel },
  ];
  const list = (value) => Array.isArray(value) ? value : [];
  const routes = '/api/conversations';
  const pick = ui.pickerValue;
  const esc = ui.esc;
  const currentView = () => session.view;
  const conversationPath = (id) => routes + '/' + encodeURIComponent(id);
  let session = freshSession();
  let region = localStorage.getItem(preferences.region) === '1';

  function freshView(id = '') {
    return { id, messages: [], attachments: [], input: '', retry: null, edits: new Map(),
      presentation: new Map(), cardTargets: new Map(), attemptedCards: new Set() };
  }

  function freshSession() {
    return { view: freshView(), views: new Map(), catalog: null, loading: null, history: [], historyRead: 0, historyLoaded: false, busy: false };
  }

  function connection(sessionAtStart) {
    const host = state.host;
    return () => sessionAtStart === session && state.connected && state.host === host;
  }

  function identityHeaders() {
    let id = localStorage.getItem(preferences.identity);
    if (!id) {
      id = 'ps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(preferences.identity, id);
    }
    return { 'X-User-Id': id };
  }

  const read = (path) => net.apiGet(path, identityHeaders());
  const write = (method, path, payload) => net.apiSend(method, path, payload, identityHeaders());

  function report(message, kind = '') {
    controls.Status.textContent = message;
    controls.Status.className = 'push-msg ' + kind;
  }

  function selectedModels() {
    return {
      provider: pick(controls.LlmProvider), model: pick(controls.LlmModel),
      image_provider: pick(controls.ImgProvider), image_model: pick(controls.ImgModel),
    };
  }

  function modelsReady() {
    return !!session.catalog && Object.values(selectedModels()).every(Boolean);
  }

  function updateControls() {
    const busy = session.busy || !state.connected;
    const view = currentView();
    controls.Send.disabled = busy || !modelsReady() || !controls.Input.value.trim();
    controls.AttachBtn.disabled = busy;
    controls.New.disabled = busy;
    controls.History.disabled = busy;
    controls.Delete.disabled = busy || !view.id;
    controls.RegionBtn.disabled = busy;
    controls.RetryBtn.disabled = busy || !modelsReady();
    controls.RetryBtn.classList.toggle('show', !!view.retry);
    for (const selector of selectors) {
      selector.provider.disabled = busy;
      selector.model.disabled = busy;
    }
    for (const button of controls.Messages.querySelectorAll('[data-confirm-card]')) {
      button.disabled = busy || !modelsReady();
    }
    for (const button of controls.Messages.querySelectorAll('[data-place-image]')) button.disabled = busy;
  }

  function renderMode() {
    controls.Models.classList.toggle('hidden', localStorage.getItem(preferences.collapse) === '1');
    controls.RegionBtn.classList.toggle('active', region);
    controls.RegionBtn.setAttribute('aria-pressed', String(region));
  }

  function modelList(selector, preference) {
    const provider = session.catalog?.find((entry) => entry.id === pick(selector.provider));
    ui.fillPicker(selector.model, list(provider?.[selector.field]), preference);
  }

  function renderModels() {
    for (const selector of selectors) {
      const options = list(session.catalog).filter((entry) => list(entry[selector.field]).length)
        .map((entry) => ({ value: entry.id, label: entry.name || entry.id }));
      ui.fillPicker(selector.provider, options, localStorage.getItem(selector.platformKey));
      modelList(selector, localStorage.getItem(selector.modelKey));
    }
  }

  function renderHistory() {
    const view = currentView();
    ui.fillPicker(controls.History,
      [{ value: '', label: '历史对话（' + session.history.length + '）' },
        ...session.history.map((entry) => ({ value: entry.id, label: entry.title || '未命名对话' }))], view.id);
  }

  async function refreshHistory(owner, valid) {
    const serial = ++owner.historyRead;
    const data = await read(routes);
    if (!valid() || serial !== owner.historyRead) return;
    owner.history = list(data.conversations);
    owner.historyLoaded = true;
    renderHistory();
  }

  async function ensureLoaded() {
    renderMode();
    if (!state.connected || session.loading) return session.loading;
    const owner = session;
    const valid = connection(owner);
    if (owner.catalog?.length && owner.historyLoaded) return;
    report('正在读取模型和历史对话 …');
    const providersRequest = owner.catalog?.length
      ? Promise.resolve({ providers: owner.catalog }) : net.apiGet('/api/providers');
    const historyRequest = owner.historyLoaded ? Promise.resolve() : refreshHistory(owner, valid);
    owner.loading = Promise.allSettled([providersRequest, historyRequest]);
    try {
      const [providers, history] = await owner.loading;
      if (!valid()) return;
      if (providers.status === 'fulfilled') {
        const source = providers.value.providers || providers.value.api_providers;
        owner.catalog = list(source).filter((entry) => entry.id && entry.enabled !== false);
        renderModels();
      }
      if (providers.status === 'rejected') report('读取模型失败：' + providers.reason.message, 'err');
      else if (!modelsReady()) report('请先在小美画布配置对话模型和生图模型', 'err');
      else if (history.status === 'rejected') report('读取历史对话失败：' + history.reason.message, 'err');
      else report('');
    } finally {
      owner.loading = null;
      if (valid()) updateControls();
    }
  }

  async function perform(operation, errorPrefix, failed) {
    const owner = session;
    const valid = connection(owner);
    if (!valid() || owner.busy) return;
    owner.busy = true;
    updateControls();
    try {
      return await operation(owner, valid);
    } catch (error) {
      if (!valid()) return;
      if (failed) failed(error);
      report(errorPrefix + '：' + error.message, 'err');
    } finally {
      owner.busy = false;
      if (valid()) updateControls();
    }
  }

  function growInput() {
    controls.Input.style.height = 'auto';
    controls.Input.style.height = Math.min(controls.Input.scrollHeight, 160) + 'px';
  }

  function activateView(view) {
    currentView().input = controls.Input.value;
    session.view = view;
    controls.Input.value = view.input;
    growInput();
    renderHistory();
    renderMessages();
    renderAttachments();
    updateControls();
  }

  function applyConversation(view, conversation) {
    if (conversation?.id) view.id = conversation.id;
    if (Array.isArray(conversation?.messages)) {
      view.messages = conversation.messages.filter((row) => row?.role === 'user' || row?.role === 'assistant');
    }
    if (view.id) session.views.set(view.id, view);
  }

  function openConversation(id) {
    if (!id || id === currentView().id) return;
    return perform(async (owner, valid) => {
      report('正在读取对话 …');
      const data = await read(conversationPath(id));
      if (!valid()) return;
      const view = owner.views.get(id) || freshView(id);
      applyConversation(view, data.conversation);
      activateView(view);
      report('');
    }, '读取对话失败', renderHistory);
  }

  function startConversation() {
    if (!state.connected || session.busy) return;
    activateView(freshView());
    report('已开始新对话');
  }

  function deleteConversation() {
    const id = currentView().id;
    if (!id || session.busy) return;
    if (typeof window.confirm === 'function' && !window.confirm('删除当前历史对话？')) return;
    return perform(async (owner, valid) => {
      report('正在删除对话 …');
      await write('DELETE', conversationPath(id));
      if (!valid()) return;
      owner.views.delete(id);
      owner.history = owner.history.filter((entry) => entry.id !== id);
      activateView(freshView());
      await refreshHistory(owner, valid).catch(() => {});
      if (valid()) report('已删除对话', 'ok');
    }, '删除对话失败');
  }

  function references(row) {
    return list(row?.attachments).filter((ref) => ref?.url && (!ref.kind || ref.kind === 'image'))
      .map(({ url, name }) => ({ url, name: name || '', kind: 'image' }));
  }

  function imageUrls(row) {
    const urls = list(row?.image_urls).filter((url) => typeof url === 'string' && url);
    if (row?.image_url && !urls.length) urls.push(row.image_url);
    return urls;
  }

  function thumbnail(url, size) {
    return '<img src="' + esc(net.displayUrl(url, size)) + '" alt="">';
  }

  function planCompleted(view, id) {
    return view.messages.some((row, index) => row.type === 'image_draft'
      && view.messages[index - 1]?.design_plan_id === id
      && view.messages[index - 1]?.design_plan_confirmed);
  }

  function card(view, row, index) {
    const plan = row.type === 'design_plan';
    if (!row.id || (!plan && row.type !== 'image_draft')) return '';
    if (plan ? planCompleted(view, row.id) : row.draft_status === 'generated') {
      return '<div class="agent-note">' + (plan ? '已转为生图草稿' : '已确认并生成') + '</div>';
    }
    const prompt = view.edits.get(row.id) ?? (plan ? row.design_plan?.prompt : row.draft_prompt) ?? '';
    const summary = plan ? row.design_plan?.summary : [row.image_model || row.model, row.size].filter(Boolean).join(' · ');
    return '<div class="agent-card">' + (summary ? '<div class="agent-note">' + esc(summary) + '</div>' : '')
      + '<textarea class="gen-input gen-ta" rows="3" aria-label="生图提示词" data-card-text="' + index + '">'
      + esc(prompt) + '</textarea><button class="btn" type="button" data-confirm-card="' + index + '">'
      + (plan ? '确认方案' : '确认生图') + '</button></div>';
  }

  function renderMessages() {
    const view = currentView();
    const box = controls.Messages;
    if (!view.messages.length) {
      box.innerHTML = '<div class="empty-state">发送文字或添加当前画面。</div>';
      return;
    }
    box.innerHTML = view.messages.map((row, index) => {
      const presentation = view.presentation.get(row.id);
      const body = presentation?.text ?? (row.content || row.agent_reply || '');
      const urls = row.role === 'user' ? references(row).map((ref) => ref.url) : imageUrls(row);
      const photos = urls.map((url) => '<div class="agent-imgtile">' + thumbnail(url, 320)
        + (row.role === 'assistant'
          ? '<button class="agent-dl" type="button" data-place-image="' + esc(url) + '">下载</button>' : '')
        + '</div>').join('');
      return '<div class="agent-msg ' + (row.role === 'user' ? 'user' : 'assistant') + '">'
        + (body ? '<div class="agent-text">' + esc(body) + '</div>' : '')
        + (presentation?.note ? '<div class="agent-note">' + esc(presentation.note) + '</div>' : '')
        + photos + card(view, row, index) + '</div>';
    }).join('');
    box.querySelectorAll('[data-card-text]').forEach((input) => input.addEventListener('input', () => {
      const row = view.messages[Number(input.getAttribute('data-card-text'))];
      view.edits.set(row.id, input.value);
    }));
    box.querySelectorAll('[data-confirm-card]').forEach((button) => button.addEventListener('click', () => {
      const index = Number(button.getAttribute('data-confirm-card'));
      const input = box.querySelector('[data-card-text="' + index + '"]');
      return confirmCard(view, index, input.value.trim());
    }));
    box.querySelectorAll('[data-place-image]').forEach((button) => button.addEventListener('click', () => {
      const url = button.getAttribute('data-place-image');
      return perform(async (_owner, valid) => {
        report('正在置入图片 …');
        await ps.placeImage({ url, name: 'Agent 结果', kind: 'image' });
        if (valid()) report('已置入图层', 'ok');
      }, '置入图片失败');
    }));
    box.scrollTop = box.scrollHeight;
    updateControls();
  }

  function renderAttachments() {
    const view = currentView();
    controls.Attach.innerHTML = view.attachments.map(({ url, name }, index) => '<div class="attach-chip" title="'
      + esc(name) + '">' + thumbnail(url, 120) + '<div class="ref-x" data-remove-reference="' + index + '">×</div></div>').join('');
    controls.Attach.querySelectorAll('[data-remove-reference]').forEach((remove) => remove.addEventListener('click', () => {
      if (session.busy) return;
      view.attachments.splice(Number(remove.getAttribute('data-remove-reference')), 1);
      renderAttachments();
    }));
  }

  function attachCurrent() {
    return perform(async (_owner, valid) => {
      if (!ps.hasDocument()) throw new Error('请先打开 Photoshop 文档');
      report('正在上传当前画面 …');
      const { buffer, name } = await ps.exportCurrentPng();
      if (!valid()) return;
      const url = await net.uploadInputBase64(buffer, name);
      if (!valid()) return;
      currentView().attachments.push({ url, name, kind: 'image' });
      renderAttachments();
      report('已添加参考图', 'ok');
    }, '上传画面失败');
  }

  function requestFor(message, referenceImages, bounds) {
    const pixels = (value) => Math.max(16, Math.ceil(value / 16) * 16);
    const size = bounds ? pixels(bounds.width) + 'x' + pixels(bounds.height) : '1024x1024';
    return { ...selectedModels(), mode: 'agent', message, size, quality: 'auto', reference_images: referenceImages };
  }

  function previousUser(view, index) {
    for (let pos = index - 1; pos >= 0; pos -= 1) {
      if (view.messages[pos].role === 'user') return view.messages[pos];
    }
    return null;
  }

  function turnUser(view, content) {
    for (let index = view.messages.length - 1; index >= 0; index -= 1) {
      const row = view.messages[index];
      if (row.role === 'user' && row.content === content) return row;
    }
    return null;
  }

  async function placeReply(row, target, valid) {
    const urls = imageUrls(row);
    if (!urls.length) {
      report(row?.type === 'image_draft' ? '请核对草稿并确认生图' : '');
      return;
    }
    if (!target) {
      report('图片已生成，可在结果中点击下载到图层', 'ok');
      return;
    }
    let placed = 0;
    let failure = '';
    for (const url of urls) {
      if (!valid()) return;
      const item = { url, name: 'Agent 结果 ' + (placed + 1), kind: 'image' };
      try {
        if (target.bounds) await ps.placeImageAt(item, target.bounds);
        else await ps.placeImage(item);
        placed += 1;
      } catch (error) {
        failure ||= error.message;
      }
    }
    if (!valid()) return;
    const count = '已置入 ' + placed + '/' + urls.length + ' 张';
    report(failure ? count + '。' + failure : count, failure ? 'err' : 'ok');
  }

  async function submit(owner, view, turn, valid, isRetry) {
    if (!view.id) {
      const created = await write('POST', routes, { title: '新对话' });
      if (!valid()) return;
      if (!created.conversation?.id) throw new Error('服务未返回对话 ID');
      applyConversation(view, created.conversation);
    }

    const payload = { ...turn.payload, conversation_id: view.id, retry_failed: isRetry };
    if (!turn.card) {
      const row = { id: 'local-input', role: 'user', content: payload.message, attachments: payload.reference_images };
      view.presentation.set(row.id, turn.display);
      view.messages = view.messages.filter((entry) => entry.id !== row.id);
      view.messages.push(row);
      renderMessages();
    }
    report('Agent 处理中 …');
    const data = await write('POST', '/api/chat/agent', payload);
    if (!valid()) return;

    const reply = data.message;
    if (!reply) throw new Error('服务未返回对话回复');
    if (Array.isArray(data.conversation?.messages)) applyConversation(view, data.conversation);
    else {
      if (data.conversation?.id) applyConversation(view, data.conversation);
      view.messages.push(reply);
      if (turn.card?.type === 'image_draft') turn.card.draft_status = 'generated';
    }
    const sent = turnUser(view, payload.message);
    if (sent && turn.display) view.presentation.set(sent.id, turn.display);
    if (reply.id && (reply.type === 'image_draft' || reply.type === 'design_plan') && turn.target) {
      view.cardTargets.set(reply.id, turn.target);
    }
    if (!turn.card) view.attachments = [];
    view.retry = null;
    renderMessages();
    renderAttachments();
    refreshHistory(owner, valid).catch(() => {});
    const target = reply.generation_draft_id
      ? view.cardTargets.get(reply.generation_draft_id) || null : turn.target;
    if (valid()) await placeReply(reply, target, valid);
  }

  function send(isRetry = false) {
    const view = currentView();
    const entered = controls.Input.value;
    const text = entered.trim();
    let turn = isRetry ? view.retry : null;
    if (!modelsReady() || (isRetry ? !turn : !text)) return;
    return perform(async (owner, valid) => {
      if (!turn) {
        const images = view.attachments.slice();
        let bounds = null;
        if (region) {
          if (!ps.hasDocument()) throw new Error('请先打开 Photoshop 文档');
          report('正在读取选区 …');
          const capture = await ps.exportSelectionJpeg();
          if (!valid()) return;
          if (!capture) throw new Error('请先用矩形选框选中要修改的区域');
          const url = await net.uploadBase64Raw(capture.base64, capture.name, capture.mime);
          if (!valid()) return;
          bounds = capture.bounds;
          images.unshift({ url, name: capture.name, kind: 'image' });
        }
        const message = bounds ? '请按要求修改参考图并生成修改后的图片。修改要求：' + text : text;
        const note = bounds ? '选区 ' + bounds.width + ' × ' + bounds.height : '';
        turn = { payload: requestFor(message, images, bounds), target: { bounds }, display: { text, note } };
        if (controls.Input.value === entered) {
          controls.Input.value = '';
          growInput();
        }
      }
      view.retry = null;
      await submit(owner, view, turn, valid, isRetry);
    }, '发送失败', () => { if (turn) view.retry = turn; });
  }

  function confirmCard(view, index, prompt) {
    if (!prompt) {
      report('请输入生图提示词', 'err');
      return;
    }
    const row = view.messages[index];
    if (!modelsReady() || !view.id || !row || row.draft_status === 'generated') return;
    const target = view.cardTargets.get(row.id) || null;
    const plan = row.type === 'design_plan';
    const inputs = plan ? references(previousUser(view, index)) : [];
    const payload = requestFor(prompt, inputs, target?.bounds);
    if (plan) {
      payload.confirm_design_plan = true;
      payload.design_plan_id = row.id;
    } else {
      payload.confirm_image_generation = true;
      payload.generation_draft_id = row.id;
      payload.size = row.size || payload.size;
      payload.quality = row.quality || payload.quality;
      payload.background = row.background || 'auto';
      payload.image_provider = row.image_provider || payload.image_provider;
      payload.image_model = row.image_model || row.model || payload.image_model;
    }
    payload.generation_prompt = prompt;
    return perform(async (owner, valid) => {
      const retry = view.attemptedCards.has(row.id);
      view.attemptedCards.add(row.id);
      try {
        await submit(owner, view, { payload, target, card: row }, valid, retry);
      } catch (error) {
        if (!valid() || plan || (error.status && error.status !== 409)) throw error;
        const saved = await read(conversationPath(view.id)).catch(() => null);
        if (!valid()) return;
        const draft = list(saved?.conversation?.messages).find((entry) => entry.id === row.id);
        if (draft?.draft_status !== 'generated') throw error;
        applyConversation(view, saved.conversation);
        renderMessages();
        report('图片已生成，可在结果中点击下载到图层', 'ok');
      }
    }, plan ? '确认方案失败' : '确认生图失败');
  }

  for (const selector of selectors) {
    ui.onPick(selector.provider, () => {
      localStorage.setItem(selector.platformKey, pick(selector.provider));
      modelList(selector);
      localStorage.setItem(selector.modelKey, pick(selector.model));
      updateControls();
    });
    ui.onPick(selector.model, () => {
      localStorage.setItem(selector.modelKey, pick(selector.model));
      updateControls();
    });
  }
  ui.onPick(controls.History, () => {
    const id = pick(controls.History);
    return id ? openConversation(id) : renderHistory();
  });
  controls.New.addEventListener('click', startConversation);
  controls.Delete.addEventListener('click', deleteConversation);
  controls.ToggleModels.addEventListener('click', () => {
    const hidden = localStorage.getItem(preferences.collapse) === '1';
    localStorage.setItem(preferences.collapse, hidden ? '0' : '1');
    renderMode();
  });
  controls.RegionBtn.addEventListener('click', () => {
    if (session.busy) return;
    region = !region;
    localStorage.setItem(preferences.region, region ? '1' : '0');
    renderMode();
    report(region ? '发送时将读取并修改当前选区' : '');
  });
  controls.AttachBtn.addEventListener('click', attachCurrent);
  controls.Send.addEventListener('click', () => send());
  controls.RetryBtn.addEventListener('click', () => send(true));
  controls.Input.addEventListener('input', () => { growInput(); updateControls(); });
  controls.Input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!controls.Send.disabled) send();
  });

  DX.agent = {
    ensureLoaded,
    reset() {
      session = freshSession();
      renderModels();
      renderHistory();
      renderMessages();
      renderAttachments();
      renderMode();
      report('');
      updateControls();
    },
  };
})();
