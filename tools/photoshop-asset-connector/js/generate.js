(function () {
  const { net, ps, state, ui, generationTasks: tasks } = DX;
  const controls = {};
  for (const key of ['Modes', 'ApiBar', 'Provider', 'Model', 'RhBar', 'RhWorkflow', 'RhWallet',
    'ComfyBar', 'ComfyWorkflow', 'Prompt', 'Params', 'RefsSection', 'Refs', 'Results', 'Run', 'Msg']) {
    controls[key] = document.getElementById('gen' + key);
  }

  const modeButtons = Array.from(controls.Modes.querySelectorAll('[data-mode]'));
  const workflowPickers = { rh: controls.RhWorkflow, comfy: controls.ComfyWorkflow };
  const prefix = { api: 'gen', rh: 'rh', comfy: 'comfy' };
  let mode = 'api';
  let connectionVersion = 0;
  let placement = Promise.resolve();
  let tabs = newTabs();

  function newTabs() {
    return Object.fromEntries(Object.keys(tasks.routes).map((key) => [key, {
      mode: key, catalog: null, listing: false, entry: '', model: '', schemaRead: 0, reading: false, ready: false,
      fields: [], values: new Map(), images: new Map(), manualSeeds: new Set(), uploads: new Set(),
      addingReference: false, refs: [], results: [], running: 0, text: '', tone: '',
    }]));
  }

  const active = () => tabs[mode];
  const picked = ui.pickerValue;
  const esc = ui.esc;
  const isApi = (tab) => tab.mode === 'api';

  function connectionCheck() {
    const version = connectionVersion;
    const host = state.host;
    return () => state.connected && state.host === host && version === connectionVersion;
  }

  function status(tab, message, tone = '') {
    tab.text = message;
    tab.tone = tone;
    if (tab === active()) renderStatus();
  }

  function renderStatus() {
    const tab = active();
    const count = tab.running ? '生成中（' + tab.running + ' 个任务）' : '';
    const loading = tab.listing ? (isApi(tab) ? '正在读取 API 平台 …' : '正在读取工作流 …') : '';
    controls.Msg.textContent = [tab.text || loading, count].filter(Boolean).join('　');
    controls.Msg.className = 'push-msg ' + tab.tone;
  }

  function updateRun() {
    const tab = active();
    controls.Run.disabled = !state.connected || !tab.ready || tab.listing || !tab.entry
      || !!tab.uploads.size || tab.addingReference
      || (isApi(tab) && (!tab.model || !controls.Prompt.value.trim()));
  }

  function renderPickers(tab) {
    if (tab !== active()) return;
    if (isApi(tab)) {
      const provider = tab.catalog?.find(({ value }) => value === tab.entry);
      ui.fillPicker(controls.Provider, tab.catalog || [], tab.entry);
      ui.fillPicker(controls.Model, provider?.models || [], tab.model);
    } else {
      ui.fillPicker(workflowPickers[tab.mode],
        [{ value: '', label: '请选择工作流' }, ...(tab.catalog || [])], tab.entry);
    }
  }

  function chooseModels(tab, entry, model) {
    const provider = tab.catalog?.find(({ value }) => value === entry);
    if (!provider) return '';
    return provider.models.includes(model) ? model : provider.models[0];
  }

  async function choose(tab, entry, model = '') {
    if (entry === tab.entry && model === tab.model && (tab.ready || tab.reading)) return;
    const current = connectionCheck();
    const read = ++tab.schemaRead;
    const selected = () => current() && tab.schemaRead === read;
    tab.entry = entry;
    tab.model = model;
    tab.ready = false;
    tab.reading = false;
    tab.fields = [];
    tab.values = new Map();
    tab.images = new Map();
    tab.manualSeeds = new Set();
    tab.uploads = new Set();
    refreshEditor(tab);
    if (!entry || (isApi(tab) && !model)) {
      status(tab, tab.catalog?.length ? '请选择工作流' : '请先在小美画布添加可用的生成配置');
      return;
    }
    tab.reading = true;
    status(tab, '正在读取生成参数 …');
    try {
      const fields = await tasks.routes[tab.mode].fields(entry, model);
      if (!selected()) return;
      tab.fields = fields;
      tab.values = tasks.initialValues(fields);
      tab.ready = true;
      status(tab, '');
      refreshEditor(tab);
    } catch (error) {
      if (selected()) status(tab, '读取生成参数失败：' + error.message, 'err');
    } finally {
      if (selected()) tab.reading = false;
    }
  }

  async function loadCatalog(tab) {
    if (!state.connected || tab.listing) return;
    if (isApi(tab) && tab.catalog?.length) {
      if (!tab.ready) return choose(tab, tab.entry, tab.model);
      return;
    }
    const current = connectionCheck();
    tab.listing = true;
    if (tab === active()) renderStatus();
    updateRun();
    try {
      tab.catalog = await tasks.routes[tab.mode].catalog();
      if (!current()) return;
      const entry = tab.catalog.some(({ value }) => value === tab.entry)
        ? tab.entry : isApi(tab) ? tab.catalog[0]?.value || '' : '';
      const model = isApi(tab) ? chooseModels(tab, entry, tab.model) : '';
      const configured = choose(tab, entry, model);
      renderPickers(tab);
      await configured;
    } catch (error) {
      if (current()) status(tab, '读取生成配置失败：' + error.message, 'err');
    } finally {
      tab.listing = false;
      if (current()) {
        if (tab === active()) renderStatus();
        updateRun();
      }
    }
  }

  function show(selectedMode) {
    mode = selectedMode;
    const tab = active();
    for (const button of modeButtons) button.classList.toggle('active', button.getAttribute('data-mode') === mode);
    for (const control of [controls.ApiBar, controls.Prompt, controls.RefsSection]) {
      control.classList.toggle('hidden', !isApi(tab));
    }
    controls.RhBar.classList.toggle('hidden', mode !== 'rh');
    controls.ComfyBar.classList.toggle('hidden', mode !== 'comfy');
    renderPickers(tab);
    refreshEditor(tab);
    renderResults(tab);
    renderStatus();
    return loadCatalog(tab);
  }

  function picker(index, role) {
    return '<sp-picker class="gen-dd compact-picker" size="s" data-field="' + index + '" data-role="' + role
      + '"><sp-menu slot="options"></sp-menu></sp-picker>';
  }

  const heading = (label) => '<div class="gen-label">' + esc(label) + '</div>';
  const mini = (label, markup) => '<div class="size-col"><div class="mini-label">' + esc(label) + '</div>' + markup + '</div>';
  const fieldStack = (label, markup) => '<div class="field-stack">' + heading(label) + markup + '</div>';

  function sizeEditor(tab, field, index, countIndex) {
    const value = tab.values.get(field.key);
    const showRatio = !['auto', 'doc', 'custom'].includes(value.res);
    const layout = countIndex >= 0 ? ' triple' : showRatio ? '' : ' single';
    const sizeClass = showRatio ? '' : ' ' + value.res;
    const ratio = showRatio ? mini('比例', picker(index, 'ratio')) : '';
    const count = countIndex >= 0 ? mini('数量', picker(countIndex, 'choice')) : '';
    let detail = '';
    if (value.res === 'doc') {
      const doc = ps.docSize();
      detail = '<div class="size-hint">' + (doc ? '画布尺寸 ' + doc.w + ' × ' + doc.h : '没有打开的文档') + '</div>';
    } else if (value.res === 'auto') {
      detail = '<div class="size-hint">由模型决定输出尺寸</div>';
    } else if (value.res === 'custom') {
      const dimensions = [['w', '宽'], ['h', '高']].map(([axis, label]) =>
        '<input class="gen-input mini-input" type="number" data-dimension="' + axis + '" data-field="' + index
        + '" placeholder="' + label + '" value="' + esc(value[axis]) + '">');
      detail = '<div class="size-inline">' + dimensions.join('') + '</div>';
    }
    return '<div class="size-box' + sizeClass + '">' + heading(field.label || field.key) + '<div class="size-grid'
      + layout + '">' + ratio + mini('分辨率', picker(index, 'resolution')) + count + '</div>'
      + (detail ? '<div class="size-foot">' + detail + '</div>' : '') + '</div>';
  }

  function choiceChips(field, value, index) {
    return '<div class="chip-row">' + field.choices.map((option) => {
      const selected = String(value) === String(option.value) ? ' active' : '';
      return '<button class="chip' + selected + '" type="button" data-choice="' + esc(option.value)
        + '" data-field="' + index + '">' + esc(option.label) + '</button>';
    }).join('') + '</div>';
  }

  function thumb(url) {
    return '<img src="' + esc(net.displayUrl(url, 256)) + '" alt="">';
  }

  function referenceTile(url, name, number, attributes, arrows = '') {
    return '<div class="ref-tile" title="' + esc(name) + '">' + thumb(url) + '<div class="ref-num">' + number
      + '</div><div class="ref-x" ' + attributes + '>×</div>' + arrows + '</div>';
  }

  function addTile(attribute, label) {
    return '<div class="ref-add" ' + attribute + ' title="添加当前画面"><div class="ref-add-plus">＋</div>'
      + '<div class="ref-add-cap">' + label + '</div></div>';
  }

  function fieldEditor(tab, field, index, countIndex) {
    const label = field.label || field.key;
    const value = tab.values.get(field.key);
    const id = ' data-field="' + index + '"';
    if (field.type === 'refs') return '';
    if (field.type === 'size') return sizeEditor(tab, field, index, countIndex);
    if (field.type === 'bool') {
      return '<div class="field-stack"><label class="gen-check"><input type="checkbox" data-value' + id
        + (value ? ' checked' : '') + '> ' + esc(label) + '</label></div>';
    }
    if (field.picker) return fieldStack(label, picker(index, 'choice'));
    if (field.choices.length) return fieldStack(label, choiceChips(field, value, index));
    if (field.type === 'textarea') {
      return fieldStack(label, '<textarea class="gen-input gen-ta" data-value' + id + ' rows="2">' + esc(value) + '</textarea>');
    }
    if (field.type === 'image') {
      const preview = tab.images.get(field.key);
      const tile = preview ? referenceTile(preview.url, preview.name, 1, 'data-remove-image="' + index + '"') : '';
      return fieldStack(label, '<div class="gen-thumbs">' + tile + addTile('data-add-image="' + index + '"',
        preview ? '替换' : '加画面') + '</div>');
    }
    const random = tasks.canRandomize(field);
    const auto = random && !tab.manualSeeds.has(field.key);
    const kind = field.type === 'number' || field.type === 'int' ? 'number' : 'text';
    const input = '<input class="gen-input" type="' + kind + '" data-value' + id + ' value="' + esc(value) + '"'
      + (auto ? ' readonly' : '') + '>';
    if (!random) return fieldStack(label, input);
    const toggle = '<button class="dice-btn' + (auto ? ' active' : '') + '" type="button" data-random' + id
      + ' title="' + (auto ? '关闭随机' : '开启随机') + '">随机</button>';
    return fieldStack(label, '<div class="seed-row">' + input + toggle + '</div>');
  }

  function renderParameters(tab) {
    const size = tab.fields.some(({ type }) => type === 'size');
    const count = size ? tab.fields.findIndex(tasks.isCount) : -1;
    const target = controls.Params;
    target.innerHTML = tab.fields.map((field, index) => index === count ? '' : fieldEditor(tab, field, index, count)).join('');
    const each = (selector, fn) => target.querySelectorAll(selector).forEach(fn);
    const fieldOf = (node) => tab.fields[Number(node.getAttribute('data-field'))];
    each('sp-picker[data-field]', (node) => {
      const field = fieldOf(node);
      const role = node.getAttribute('data-role');
      const value = tab.values.get(field.key);
      const isSize = role !== 'choice';
      const choices = role === 'ratio' ? tasks.options(field.ratios)
        : role === 'resolution' ? tasks.resolutionChoices(field) : field.choices;
      const key = role === 'resolution' ? 'res' : role;
      ui.fillPicker(node, choices, isSize ? value[key] : value);
      ui.onPick(node, () => {
        if (isSize) value[key] = picked(node);
        else tab.values.set(field.key, picked(node));
        if (role === 'resolution') renderParameters(tab);
      });
    });
    each('[data-value]', (node) => node.addEventListener('input', () => {
      if (!node.hasAttribute('readonly')) {
        const field = fieldOf(node);
        tab.values.set(field.key, field.type === 'bool' ? node.checked : node.value);
      }
    }));
    each('[data-dimension]', (node) => node.addEventListener('input', () => {
      tab.values.get(fieldOf(node).key)[node.getAttribute('data-dimension')] = node.value;
    }));
    each('[data-choice]', (node) => node.addEventListener('click', () => {
      tab.values.set(fieldOf(node).key, node.getAttribute('data-choice'));
      renderParameters(tab);
    }));
    each('[data-random]', (node) => node.addEventListener('click', () => {
      const field = fieldOf(node);
      if (tab.manualSeeds.delete(field.key)) tab.values.set(field.key, tasks.randomNumber(field));
      else tab.manualSeeds.add(field.key);
      renderParameters(tab);
    }));
    each('[data-add-image]', (node) => node.addEventListener('click', () => {
      const field = tab.fields[Number(node.getAttribute('data-add-image'))];
      return capture(tab, field);
    }));
    each('[data-remove-image]', (node) => node.addEventListener('click', () => {
      const field = tab.fields[Number(node.getAttribute('data-remove-image'))];
      if (tab.uploads.has(field.key)) return;
      tab.images.delete(field.key);
      tab.values.set(field.key, '');
      renderParameters(tab);
    }));
  }

  function renderReferences(tab) {
    const target = controls.Refs;
    target.innerHTML = tab.refs.map((ref, index) => {
      const arrows = [-1, 1].map((step) => {
        const disabled = index + step < 0 || index + step >= tab.refs.length ? ' disabled' : '';
        return '<button class="ref-arrow" type="button" data-ref-move="' + index + ',' + step + '"' + disabled + '>'
          + (step < 0 ? '‹' : '›') + '</button>';
      }).join('');
      return referenceTile(ref.url, ref.name, index + 1, 'data-ref-remove="' + index + '"',
        '<div class="ref-move">' + arrows + '</div>');
    }).join('') + addTile('data-add-reference', '加画面');
    target.querySelector('[data-add-reference]').addEventListener('click', () => capture(tab, null));
    target.querySelectorAll('[data-ref-remove]').forEach((node) => node.addEventListener('click', () => {
      tab.refs.splice(Number(node.getAttribute('data-ref-remove')), 1);
      renderReferences(tab);
    }));
    target.querySelectorAll('[data-ref-move]').forEach((node) => node.addEventListener('click', () => {
      const [index, step] = node.getAttribute('data-ref-move').split(',').map(Number);
      const next = index + step;
      if (next < 0 || next >= tab.refs.length) return;
      [tab.refs[index], tab.refs[next]] = [tab.refs[next], tab.refs[index]];
      renderReferences(tab);
    }));
  }

  function refreshEditor(tab) {
    if (tab !== active()) return;
    renderParameters(tab);
    if (isApi(tab)) renderReferences(tab);
    updateRun();
  }

  function maxReferences(tab) {
    const limit = Number(tab.fields.find(({ type }) => type === 'refs')?.max);
    return Number.isInteger(limit) && limit >= 0 ? limit : Infinity;
  }

  async function capture(tab, field) {
    if (!state.connected || (field ? tab.uploads.has(field.key) : tab.addingReference)) return;
    if (!field && tab.refs.length >= maxReferences(tab)) {
      status(tab, '参考图已达到当前模型的数量上限', 'err');
      return;
    }
    if (!ps.hasDocument()) {
      status(tab, '请先打开 Photoshop 文档', 'err');
      return;
    }
    const connected = connectionCheck();
    const read = tab.schemaRead;
    const current = () => connected() && (!field || read === tab.schemaRead);
    const pending = tab.uploads;
    if (field) pending.add(field.key);
    else tab.addingReference = true;
    const wallet = controls.RhWallet.checked;
    status(tab, '正在导出并上传画面 …');
    updateRun();
    try {
      const png = await ps.exportCurrentPng();
      const attached = await tasks.attach(tab.mode, png, wallet, current);
      if (!attached) return;
      if (field) {
        tab.images.set(field.key, attached);
        tab.values.set(field.key, attached.value);
      } else {
        tab.refs.push(attached);
      }
      status(tab, field ? '已设置工作流输入图' : '已添加参考图', 'ok');
      refreshEditor(tab);
    } catch (error) {
      if (current()) status(tab, '上传画面失败：' + error.message, 'err');
    } finally {
      if (field) pending.delete(field.key);
      else tab.addingReference = false;
      if (connected()) updateRun();
    }
  }

  function placeImages(items, current) {
    const job = placement.then(async () => {
      let count = 0;
      for (const image of items) {
        if (!current()) break;
        try {
          await ps.placeImage({ ...image, kind: 'image' });
          count += 1;
        } catch (_) {}
      }
      return count;
    });
    placement = job;
    return job;
  }

  function renderResults(tab) {
    if (tab !== active()) return;
    const target = controls.Results;
    target.innerHTML = tab.results.map(({ url, name }, index) =>
      '<div class="gen-thumb result" data-result="' + index + '" title="' + esc(name) + '">' + thumb(url)
      + '<div class="dl">下载到图层</div></div>').join('');
    target.querySelectorAll('[data-result]').forEach((node) => node.addEventListener('click', async () => {
      const current = connectionCheck();
      const image = tab.results[Number(node.getAttribute('data-result'))];
      const count = await placeImages([image], current);
      if (current()) status(tab, count ? '已添加到图层：' + image.name : '无法将图片置入 Photoshop', count ? 'ok' : 'err');
    }));
  }

  function prepare(tab) {
    let redraw = false;
    for (const field of tab.fields) {
      if (!tasks.canRandomize(field) || tab.manualSeeds.has(field.key)) continue;
      tab.values.set(field.key, tasks.randomNumber(field));
      redraw = true;
    }
    if (redraw) renderParameters(tab);
    return {
      entry: tab.entry, model: tab.model, fields: tab.fields, values: new Map(tab.values),
      images: new Map(tab.images), refs: tab.refs.slice(), wallet: controls.RhWallet.checked,
      prompt: controls.Prompt.value.trim(), docSize: isApi(tab) ? ps.docSize() : null,
    };
  }

  async function run() {
    const tab = active();
    if (controls.Run.disabled || !state.connected) return;
    if (isApi(tab) && tab.refs.length > maxReferences(tab)) {
      status(tab, '参考图超过当前模型的数量上限，请移除多余图片', 'err');
      return;
    }
    const current = connectionCheck();
    const form = prepare(tab);
    tab.running += 1;
    status(tab, '');
    try {
      const urls = await tasks.generate(tab.mode, form, current);
      if (!current() || !urls) return;
      if (!urls.length) {
        status(tab, '任务完成，服务没有返回图片', 'err');
        return;
      }
      const timestamp = Date.now();
      const images = urls.map((url, index) => ({
        url, name: prefix[tab.mode] + '_' + timestamp + '_' + (index + 1),
      }));
      tab.results.push(...images);
      renderResults(tab);
      const placed = await placeImages(images, current);
      if (!current()) return;
      if (placed === images.length) status(tab, '已生成并添加 ' + placed + ' 张到图层', 'ok');
      else status(tab, '已生成 ' + images.length + ' 张，已置入 ' + placed + ' 张。可点击结果重试置入。', 'err');
    } catch (error) {
      if (current()) status(tab, '生成失败：' + error.message, 'err');
    } finally {
      tab.running -= 1;
      if (current() && tab === active()) renderStatus();
    }
  }

  for (const button of modeButtons) button.addEventListener('click', () => {
    if (state.connected) return show(button.getAttribute('data-mode'));
  });
  ui.onPick(controls.Provider, () => {
    const tab = active();
    if (!isApi(tab) || !state.connected) return;
    const entry = picked(controls.Provider);
    const next = choose(tab, entry, chooseModels(tab, entry, ''));
    renderPickers(tab);
    return next;
  });
  ui.onPick(controls.Model, () => {
    const tab = active();
    if (isApi(tab) && state.connected) return choose(tab, tab.entry, picked(controls.Model));
  });
  for (const [key, pickerControl] of Object.entries(workflowPickers)) {
    ui.onPick(pickerControl, () => {
      if (mode === key && state.connected) return choose(active(), picked(pickerControl));
    });
  }
  controls.Prompt.addEventListener('input', updateRun);
  controls.Run.addEventListener('click', run);

  DX.generate = {
    ensureLoaded() {
      if (state.connected) return show(mode);
    },
    reset() {
      connectionVersion += 1;
      tabs = newTabs();
      controls.Params.innerHTML = '';
      controls.Refs.innerHTML = '';
      controls.Results.innerHTML = '';
      renderStatus();
      updateRun();
    },
  };
})();
