const state = {
  groups: [],
  jobs: [],
  config: null,
  selected: new Set(),
  groupPage: 1,
  jobPage: 1,
  groupSearch: '',
  filterUnusedOnly: false,
  pollTimer: null,
  pollPending: false,
  renderedJobsSignature: '',
  generationJobIds: new Set(),
  generationPhase: '',
  uploadGroupId: '',
  manageGroupId: '',
  previewJobId: '',
  pendingFiles: [],
  modelReferences: [],
  fishVoices: [],
  pendingReview: null,
  voiceSource: 'video',
};

const PROMPT_TEMPLATES = {
  multi_shot: '参考这些图片做一个真实商品实拍展示视频，6-8个流畅镜头切换，保持商品外观、材质与场景一致，先展示整体效果，再切近景呈现关键细节，自然光影、真实买家秀质感。',
  detail_closeup: '参考这些商品图制作高质感细节种草短视频，镜头先给产品主视觉定场，再缓慢推进特写展示纹理、做工与使用效果，节奏轻快干净，真实自然光线。',
  scene_tour: '参考这些图片制作空间与商品结合的漫游展示视频，8-10个自然衔接镜头，全景带入使用环境并穿插核心商品特写，光线柔和真实，模拟手持实拍体验。',
};

const JOB_PAGE_SIZE = 10;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SVG_ICONS = {
  upload: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
  manage: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
  play: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>',
  stop: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>',
  close: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  trash: '<svg class="ui-icon xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>',
  spinner: '<svg class="ui-icon sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>',
  playOutline: '<svg class="ui-icon sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
};

const els = {
  groupGrid: $('#groupGrid'),
  jobsBody: $('#jobsBody'),
  groupsEmpty: $('#groupsEmpty'),
  groupsFilterEmpty: $('#groupsFilterEmpty'),
  jobsEmpty: $('#jobsEmpty'),
  toast: $('#toast'),
  toastMessage: $('#toastMessage'),
  toastCloseButton: $('#toastCloseButton'),
  settingsModal: $('#settingsModal'),
  materialModal: $('#materialModal'),
  groupManageModal: $('#groupManageModal'),
  videoPreviewModal: $('#videoPreviewModal'),
  clearJobsModal: $('#clearJobsModal'),
  errorDetailModal: $('#errorDetailModal'),
  scriptModal: $('#scriptModal'),
  connectionCard: $('#connectionCard'),
  generateButton: $('#generateButton'),
  generateIcon: $('#generateIcon'),
  generateLabel: $('#generateLabel'),
  generationStatus: $('#generationStatus'),
  newGroupButton: $('#newGroupButton'),
  materialGroupNameField: $('#materialGroupNameField'),
  materialGroupNameInput: $('#materialGroupNameInput'),
  materialFilesInput: $('#materialFilesInput'),
  uploadDropzone: $('#uploadDropzone'),
  pendingFiles: $('#pendingFiles'),
  materialModalTitle: $('#materialModalTitle'),
  materialTargetName: $('#materialTargetName'),
  materialSaveState: $('#materialSaveState'),
  saveMaterialButton: $('#saveMaterialButton'),
  closeMaterialButton: $('#closeMaterialButton'),
  cancelMaterialButton: $('#cancelMaterialButton'),
  chooseMaterialFiles: $('#chooseMaterialFiles'),
};

const statusLabels = {
  queued: '待处理',
  submitting: '提交中',
  processing: '生成中',
  'waiting-key': '待更新密钥',
  succeeded: '已完成',
  downloading: '下载中',
  'download-retry': '等待重试',
  failed: '失败',
  canceled: '已停止跟踪',
};

const officialVideoModel = 'doubao-seedance-2-5-260628';
const availableVideoModels = new Set([
  officialVideoModel,
  'seedance-2.0（按秒）',
  'seedance-2.0-fast（按秒）',
  'seedance2.5（满血版）',
  'seedance2.5（满血版）线路1',
  'seedance2.5（满血版）线路3',
  'seedance2.5（满血版）线路4',
  'seedance-2.5（按秒）',
]);

let voicePreviewAudio = null;
let activePreviewButton = null;
const fishWaveforms = new Map();
let userPickedModel = false;
const modalReturnFocus = new WeakMap();

/* ---------- 通用弹窗管理与焦点陷阱 ---------- */
function focusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hidden && el.offsetParent !== null);
}

function openModal(backdrop, focusTarget = null) {
  if (!backdrop) return;
  if (backdrop.hidden) {
    modalReturnFocus.set(backdrop, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    const target = focusTarget && !focusTarget.disabled && focusTarget.offsetParent !== null
      ? focusTarget
      : focusableElements(backdrop)[0];
    target?.focus();
  });
}

function closeModal(backdrop) {
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  const opener = modalReturnFocus.get(backdrop);
  modalReturnFocus.delete(backdrop);
  if (opener && document.contains(opener) && opener.offsetParent !== null) {
    opener.focus();
  }
}

function activeModalBackdrop() {
  const ordered = [
    els.errorDetailModal,
    els.clearJobsModal,
    els.videoPreviewModal,
    els.scriptModal,
    els.materialModal,
    els.groupManageModal,
    els.settingsModal,
  ];
  return ordered.find((item) => item && !item.hidden) || null;
}

document.addEventListener('keydown', (event) => {
  const modal = activeModalBackdrop();
  if (!modal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal === els.materialModal) closeMaterialModal();
    else if (modal === els.videoPreviewModal) closeVideoPreview();
    else if (modal === els.settingsModal) closeSettings();
    else closeModal(modal);
    return;
  }
  if (event.key === 'Tab') {
    const items = focusableElements(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

/* ---------- 路径与请求 ---------- */
const BASE_PATH = (() => {
  const pathname = window.location.pathname || '/';
  return pathname === '/video-workbench' || pathname.startsWith('/video-workbench/') ? '/video-workbench' : '';
})();

function withBasePath(url) {
  if (!BASE_PATH || typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return url;
  if (url === BASE_PATH || url.startsWith(`${BASE_PATH}/`)) return url;
  return `${BASE_PATH}${url}`;
}

async function request(url, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const response = await fetch(withBasePath(url), { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function hideToast() {
  clearTimeout(showToast.timer);
  els.toast.classList.remove('show');
}

function showToast(message, isError = false) {
  els.toastMessage.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toastCloseButton.hidden = !isError;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(hideToast, isError ? 6000 : 3400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function statusHtml(job) {
  const status = job.status === 'succeeded' && !job.localFile ? (job.downloadState === 'retrying' ? 'download-retry' : 'downloading') : job.status;
  return `<span class="status ${escapeHtml(status)}">${statusLabels[status] || escapeHtml(status)}</span>`;
}

function formatJobDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replaceAll('/', '-');
}

function missingKeyInfo(model) {
  if (model === officialVideoModel) {
    return state.config?.hasOfficialApiKey ? null : {
      message: '当前所选为官方渠道模型，请先在画布 API 设置或此处填写官方密钥。',
      tab: 'keys',
      focusId: 'officialApiKeyInput',
    };
  }
  return state.config?.hasToken ? null : {
    message: '当前所选为低价渠道模型，请先在画布 API 设置或此处填写低价密钥。',
    tab: 'keys',
    focusId: 'apiTokenInput',
  };
}

function updateGenerateButtonLabel() {
  if (['planning', 'uploading', 'submitting'].includes(state.generationPhase)) {
    els.generateIcon.innerHTML = SVG_ICONS.spinner;
    els.generateLabel.textContent = '处理中…';
    return;
  }
  if (state.generationPhase === 'review') {
    els.generateIcon.innerHTML = SVG_ICONS.playOutline;
    els.generateLabel.textContent = '等待审核';
    return;
  }
  els.generateIcon.innerHTML = SVG_ICONS.playOutline;
  const count = state.selected.size;
  els.generateLabel.textContent = count > 0 ? `生成所选素材组 (${count})` : '生成所选素材组';
}

function setGenerationStatus(message = '', { busy = false, error = false, phase = '' } = {}) {
  state.generationPhase = phase;
  if (phase === 'generating') state.jobPage = 1;
  els.generationStatus.textContent = message;
  els.generationStatus.classList.toggle('error', error);
  els.generateButton.disabled = busy || phase === 'review';
  els.generateButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  updateGenerateButtonLabel();
}

function resolveCategoryValue() {
  const selected = $('#categoryInput').value;
  if (selected === '__custom__') {
    return $('#customCategoryInput').value.trim() || 'general';
  }
  return selected || 'general';
}

function contentOptions() {
  return {
    category: resolveCategoryValue(),
    copywriting: $('#copywritingInput').checked,
    reviewPrompt: $('#reviewPromptInput').checked,
    modelEnabled: $('#modelEnabledInput').checked,
    direction: $('#directionInput').value,
    textModel: $('#textModelInput').value,
    productFacts: $('#productFactsInput').value.trim(),
    voiceover: $('#voiceoverInput').checked,
    subtitles: $('#subtitlesInput').checked,
    voiceGender: $('#voiceGenderInput').value,
    manualSpeech: $('#manualSpeechInput').value.trim(),
  };
}

function syncCategoryField() {
  const isCustom = $('#categoryInput').value === '__custom__';
  $('#customCategoryField').hidden = !isCustom;
  if (isCustom) {
    requestAnimationFrame(() => $('#customCategoryInput').focus());
  }
}

function syncPromptTemplateHighlight() {
  const current = $('#promptInput').value.trim();
  for (const btn of $$('[data-prompt-template]')) {
    const tpl = PROMPT_TEMPLATES[btn.dataset.promptTemplate] || '';
    btn.classList.toggle('active', current === tpl);
  }
}

function syncCreativeControls() {
  const voiceover = $('#voiceoverInput').checked;
  const fish = voiceover && state.voiceSource === 'fish';
  if (fish) {
    $('#copywritingInput').checked = true;
    $('#subtitlesInput').checked = false;
  }
  const copywriting = $('#copywritingInput').checked;
  if (!copywriting) $('#reviewPromptInput').checked = false;
  const subtitles = $('#subtitlesInput').checked;
  $('#copywritingInput').disabled = fish;
  $('#subtitlesInput').disabled = fish;
  $('#fishModeBanner').hidden = !fish;
  $('#copywritingFields').hidden = !copywriting;
  $('#modelReferenceFields').hidden = !$('#modelEnabledInput').checked;
  $('#speechFields').hidden = fish || !(voiceover || (subtitles && !copywriting));
  $('#voiceGenderField').hidden = !voiceover || fish;
  $('#manualSpeechField').hidden = copywriting;
  $('#fishSourceField').hidden = !voiceover;
  $('#fishPanel').hidden = !fish;
  if (!fish) stopFishPreview();
  else {
    ensureFishVoices();
    requestAnimationFrame(redrawFishWaveforms);
  }
}

/* ---------- Fish Audio 音色波形与试听 ---------- */
function selectedFishVoiceId() {
  const preset = document.querySelector('input[name="fishVoicePreset"]:checked')?.value;
  return preset === 'custom' ? $('#fishVoiceIdInput').value.trim() : preset || '';
}

function syncFishVoiceSelection() {
  $('#fishCustomVoiceField').hidden = document.querySelector('input[name="fishVoicePreset"]:checked')?.value !== 'custom';
}

function drawFishWaveform(canvas, progress = 0) {
  if (!canvas || !canvas.clientWidth) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const accentColor = (styles.getPropertyValue('--vw-accent') || '').trim() || '#0e7490';
  const idleColor = (styles.getPropertyValue('--vw-wave-idle') || '').trim() || '#94a3b8';
  const lineColor = (styles.getPropertyValue('--vw-border-strong') || '').trim() || '#d1d1d1';
  const peaks = fishWaveforms.get(canvas.dataset.voiceId);
  if (!peaks) {
    context.fillStyle = lineColor;
    context.fillRect(0, Math.floor(height / 2), width, 1);
    return;
  }
  const step = width / peaks.length;
  const barWidth = Math.max(1, Math.min(2.5, step - 1.5));
  for (let index = 0; index < peaks.length; index += 1) {
    const barHeight = Math.max(3, (peaks[index] / 100) * (height - 2));
    context.fillStyle = index / peaks.length < progress ? accentColor : idleColor;
    context.fillRect(index * step, (height - barHeight) / 2, barWidth, barHeight);
  }
}

function redrawFishWaveforms() {
  for (const canvas of $('#fishVoiceList').querySelectorAll('canvas')) {
    if (canvas.closest('.fish-voice').hidden) continue;
    const progress = activePreviewButton?.contains(canvas) && voicePreviewAudio?.duration
      ? voicePreviewAudio.currentTime / voicePreviewAudio.duration : 0;
    drawFishWaveform(canvas, progress);
  }
}

function showFishVoiceCategory(category, selectFirst = false) {
  const list = $('#fishVoiceList');
  for (const button of $('#fishVoiceCategories').querySelectorAll('button')) {
    const active = button.dataset.voiceCategory === category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const card of list.children) card.hidden = card.dataset.category !== category;
  if (selectFirst) {
    stopFishPreview();
    const first = list.querySelector('.fish-voice:not([hidden]) input');
    if (first) {
      $('#fishPreviewStatus').textContent = '';
      first.checked = true;
    }
    syncFishVoiceSelection();
  }
  requestAnimationFrame(redrawFishWaveforms);
}

function loadFishVoices() {
  const voices = JSON.parse($('#fishVoicesData')?.textContent || 'null');
  if (!Array.isArray(voices) || !voices.length) throw new Error('内置音色列表为空');
  state.fishVoices = voices;
  const list = $('#fishVoiceList');
  const previousSelection = document.querySelector('input[name="fishVoicePreset"]:checked')?.value;
  const activeCategory = state.fishVoices.find((voice) => voice.id === previousSelection)?.category
    || $('#fishVoiceCategories button.active')?.dataset.voiceCategory || '营销宣传';
  $('#fishMarketingCount').textContent = state.fishVoices.filter((voice) => voice.category === '营销宣传').length;
  $('#fishNarrationCount').textContent = state.fishVoices.filter((voice) => voice.category === '旁白朗诵').length;
  list.replaceChildren();
  for (const [index, voice] of state.fishVoices.entries()) {
    fishWaveforms.set(voice.id, voice.waveform);
    const item = document.createElement('div');
    item.className = 'fish-voice';
    item.dataset.category = voice.category;
    const label = document.createElement('label');
    label.className = 'fish-voice-select';
    const radio = document.createElement('input');
    radio.className = 'fish-voice-radio';
    radio.type = 'radio';
    radio.name = 'fishVoicePreset';
    radio.value = voice.id;
    radio.checked = previousSelection ? previousSelection === voice.id : index === 0;
    const name = document.createElement('strong');
    name.textContent = voice.name;
    name.title = voice.name;
    const description = document.createElement('small');
    description.textContent = voice.description;
    label.append(radio, name, description);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'fish-preview-button';
    preview.dataset.voicePreview = voice.previewUrl;
    preview.setAttribute('aria-label', `试听${voice.name}`);
    preview.setAttribute('aria-pressed', 'false');
    preview.title = `试听${voice.name}`;
    const symbol = document.createElement('span');
    symbol.className = 'fish-play-symbol';
    symbol.innerHTML = SVG_ICONS.play;
    const waveform = document.createElement('canvas');
    waveform.dataset.voiceId = voice.id;
    waveform.setAttribute('aria-hidden', 'true');
    preview.append(symbol, waveform);
    item.append(label, preview);
    list.append(item);
  }
  syncFishVoiceSelection();
  showFishVoiceCategory(activeCategory);
}

function ensureFishVoices() {
  if (state.fishVoices.length) return;
  try {
    loadFishVoices();
    $('#fishPreviewStatus').textContent = '';
  } catch (error) {
    $('#fishPreviewStatus').textContent = `内置音色读取失败：${error.message}`;
  }
}

function stopFishPreview() {
  if (voicePreviewAudio) {
    voicePreviewAudio.pause();
    voicePreviewAudio.currentTime = 0;
    voicePreviewAudio = null;
  }
  if (activePreviewButton) {
    const name = activePreviewButton.closest('.fish-voice').querySelector('strong').textContent;
    activePreviewButton.querySelector('.fish-play-symbol').innerHTML = SVG_ICONS.play;
    activePreviewButton.title = `试听${name}`;
    activePreviewButton.setAttribute('aria-label', `试听${name}`);
    activePreviewButton.setAttribute('aria-pressed', 'false');
    drawFishWaveform(activePreviewButton.querySelector('canvas'));
    activePreviewButton = null;
  }
}

async function toggleFishPreview(button) {
  if (activePreviewButton === button) {
    stopFishPreview();
    $('#fishPreviewStatus').textContent = '';
    return;
  }
  stopFishPreview();
  const radio = button.closest('.fish-voice').querySelector('input');
  radio.checked = true;
  syncFishVoiceSelection();
  const name = button.closest('.fish-voice').querySelector('strong').textContent;
  const audio = new Audio(button.dataset.voicePreview);
  voicePreviewAudio = audio;
  activePreviewButton = button;
  button.querySelector('.fish-play-symbol').innerHTML = SVG_ICONS.stop;
  button.title = `停止试听${name}`;
  button.setAttribute('aria-label', `停止试听${name}`);
  button.setAttribute('aria-pressed', 'true');
  $('#fishPreviewStatus').textContent = '试听加载中…';
  audio.addEventListener('ended', () => {
    if (voicePreviewAudio === audio) {
      stopFishPreview();
      $('#fishPreviewStatus').textContent = '';
    }
  });
  audio.addEventListener('error', () => {
    if (voicePreviewAudio === audio) {
      stopFishPreview();
      $('#fishPreviewStatus').textContent = '试听音频加载失败';
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (voicePreviewAudio === audio) drawFishWaveform(button.querySelector('canvas'), audio.currentTime / audio.duration);
  });
  try {
    await audio.play();
    if (voicePreviewAudio === audio) $('#fishPreviewStatus').textContent = '';
  } catch {
    if (voicePreviewAudio === audio) {
      stopFishPreview();
      $('#fishPreviewStatus').textContent = '试听音频无法播放';
    }
  }
}

/* ---------- 模特参考图 ---------- */
function renderModelReferences() {
  $('#modelReferenceList').innerHTML = state.modelReferences.map((reference, index) => `
    <div class="model-reference-item">
      <img src="${escapeHtml(reference.thumbnailUrl)}" alt="模特参考图 ${index + 1}" loading="lazy" />
      <span>图 ${index + 1}</span>
      <button type="button" data-remove-model="${escapeHtml(reference.id)}" aria-label="移除模特参考图 ${index + 1}" title="移除">${SVG_ICONS.close}</button>
    </div>`).join('');
  $('#modelReferenceStatus').textContent = state.modelReferences.length
    ? `按 ${state.modelReferences.length} 张参考图生成`
    : '未上传参考图：将由模型随机生成亚洲女性模特';
}

async function loadModelReferences() {
  const result = await request('/api/model-references');
  state.modelReferences = result.references || [];
  renderModelReferences();
}

async function uploadModelReferences(fileList) {
  const files = [...fileList];
  if (files.length < 1 || files.length > 3) return showToast('请选择 1–3 张模特图片', true);
  const input = $('#modelReferencesInput');
  const status = $('#modelReferenceStatus');
  const form = new FormData();
  for (const file of files) form.append('files', file);
  input.disabled = true;
  status.textContent = '模特图上传中…';
  try {
    const result = await request('/api/model-references', { method: 'POST', body: form });
    state.modelReferences = result.references || [];
    renderModelReferences();
    showToast('模特参考图已保存');
  } catch (error) {
    renderModelReferences();
    showToast(error.message, true);
  } finally {
    input.value = '';
    input.disabled = false;
  }
}

/* ---------- 脚本 / 错误详情 / 成片预览弹窗 ---------- */
function openScript(job) {
  $('#scriptModalTitle').textContent = `${job.groupName || job.name} · 任务脚本`;
  $('#visualFactsSection').hidden = !job.copyPlan?.visualFacts?.length;
  $('#visualFactsList').replaceChildren(...(job.copyPlan?.visualFacts || []).map((fact) => {
    const item = document.createElement('li');
    item.textContent = fact;
    return item;
  }));
  $('#copyPlanSection').hidden = !job.copyPlan;
  $('#copyPlanTitle').textContent = [job.copyPlan?.title, job.copyPlan?.openingHook ? `开场钩子：${job.copyPlan.openingHook}` : ''].filter(Boolean).join('\n');
  $('#copyPlanSpeech').textContent = job.copyPlan?.spokenText || '';
  $('#finalPromptText').textContent = job.prompt || '';
  openModal(els.scriptModal, $('#closeScriptButton'));
}

function openErrorDetail(job) {
  $('#errorDetailTitle').textContent = `${job.groupName || job.name} · 失败详情`;
  $('#errorDetailText').textContent = job.error || '未返回详细报错信息';
  openModal(els.errorDetailModal, $('#copyErrorDetailButton'));
}

function openVideoPreview(job) {
  if (!job?.localFile) return showToast('视频尚未下载到本地', true);
  state.previewJobId = job.id;
  const player = $('#videoPreviewPlayer');
  const videoUrl = withBasePath(`/api/jobs/${encodeURIComponent(job.id)}/video?t=${encodeURIComponent(job.completedAt || Date.now())}`);
  $('#videoPreviewTitle').textContent = `${job.groupName || job.name} · 成片预览`;
  $('#videoPreviewMeta').innerHTML = [
    `<span class="param-tag">${escapeHtml(job.model)}</span>`,
    `<span class="param-tag">${escapeHtml(job.duration)}s</span>`,
    `<span class="param-tag">${escapeHtml(job.ratio)}</span>`,
    `<span class="param-tag">${escapeHtml(job.resolution)}</span>`,
    job.narrationEnabled ? '<span class="param-tag">Fish 独立配音</span>' : '',
  ].filter(Boolean).join('');
  player.src = videoUrl;
  player.load();
  openModal(els.videoPreviewModal, $('#doneVideoPreviewButton'));
  void player.play().catch(() => {});
}

function closeVideoPreview() {
  const player = $('#videoPreviewPlayer');
  player.pause();
  player.removeAttribute('src');
  player.load();
  state.previewJobId = '';
  closeModal(els.videoPreviewModal);
}

async function openJobFolder(jobId) {
  try {
    await request(`/api/jobs/${encodeURIComponent(jobId)}/open-folder`, { method: 'POST', body: '{}' });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openWorkbenchDir(target) {
  try {
    await request('/api/open-dir', { method: 'POST', body: JSON.stringify({ target }) });
  } catch (error) {
    showToast(error.message, true);
  }
}

/* ---------- 统计与分页 ---------- */
function updateGenerationCompletion() {
  if (!state.generationJobIds.size || state.generationPhase !== 'generating') return;
  const tracked = state.jobs.filter((job) => state.generationJobIds.has(job.id));
  if (!tracked.length || tracked.some((job) => ['queued', 'submitting', 'processing', 'waiting-key'].includes(job.status) || (job.status === 'succeeded' && !job.localFile))) return;
  const failed = tracked.filter((job) => job.status !== 'succeeded').length;
  setGenerationStatus(failed ? `任务结束：${failed} 个失败，点击队列错误可查看详情` : `任务完成：${tracked.length} 个视频已保存，可直接在线预览`, { error: failed > 0, phase: 'done' });
  state.generationJobIds.clear();
}

function filteredGroups() {
  const keyword = state.groupSearch.trim().toLowerCase();
  return state.groups.filter((group) => {
    if (state.filterUnusedOnly && group.used) return false;
    if (keyword && !String(group.name || '').toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function renderSummary() {
  const runningCount = state.jobs.filter((job) => ['submitting', 'processing'].includes(job.status)).length;
  const doneCount = state.jobs.filter((job) => job.status === 'succeeded' && job.localFile).length;
  const selectedCount = state.selected.size;
  $('#countGroups').textContent = state.groups.length;
  $('#countSelected').textContent = selectedCount;
  $('#countRunning').textContent = runningCount;
  $('#countDone').textContent = doneCount;
  $('#groupCount').textContent = state.groups.length;
  $('#jobCount').textContent = state.jobs.length;
  $('#metricSelectedChip').classList.toggle('active', selectedCount > 0);
  $('#metricRunningChip').hidden = runningCount === 0;
  $('#metricDoneChip').hidden = doneCount === 0;

  const visible = filteredGroups();
  $('#materialFilters').hidden = state.groups.length === 0;
  $('#selectAllButton').disabled = visible.length === 0;
  $('#clearSelectionButton').disabled = selectedCount === 0;

  const hasTerminalJobs = state.jobs.some((job) => ['succeeded', 'failed', 'canceled'].includes(job.status) && (job.status !== 'succeeded' || job.localFile));
  $('#clearJobsButton').disabled = !hasTerminalJobs;
  updateGenerateButtonLabel();
}

function renderPagination(type, total, pageSize) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, state[`${type}Page`]), pageCount);
  state[`${type}Page`] = page;
  $(`#${type}Pagination`).hidden = total <= pageSize;
  $(`#${type}PageInfo`).textContent = `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} / ${total}`;
  $(`#${type}PagePosition`).textContent = `${page} / ${pageCount}`;
  $(`#${type}PrevButton`).disabled = page === 1;
  $(`#${type}NextButton`).disabled = page === pageCount;
  return page;
}

function groupPageSize() {
  const style = getComputedStyle(els.groupGrid);
  const template = style.gridTemplateColumns.trim();
  const columns = !template || template === 'none'
    ? Math.max(1, Math.floor((els.groupGrid.clientWidth || 880) / 228))
    : template.split(/\s+/).length;
  return Math.max(1, columns) * (columns >= 5 ? 2 : 3);
}

function renderGroups() {
  const hasAnyGroups = state.groups.length > 0;
  const visible = filteredGroups();
  const hasVisible = visible.length > 0;
  els.groupsEmpty.hidden = hasAnyGroups;
  els.groupsFilterEmpty.hidden = !hasAnyGroups || hasVisible;
  const pageSize = groupPageSize();
  if (state.groupPageSize && state.groupPageSize !== pageSize) {
    state.groupPage = Math.floor(((state.groupPage - 1) * state.groupPageSize) / pageSize) + 1;
  }
  state.groupPageSize = pageSize;
  const page = renderPagination('group', visible.length, pageSize);
  els.groupGrid.innerHTML = visible.slice((page - 1) * pageSize, page * pageSize).map((group) => {
    const selected = state.selected.has(group.id);
    const thumbs = group.files.slice(0, 4).map((file) => `<img src="${escapeHtml(file.thumbnailUrl || file.url)}" alt="" loading="lazy" decoding="async" width="320" height="320" />`).join('');
    const thumbLayoutClass = group.files.length === 1 ? 'single-thumb' : group.files.length === 2 ? 'two-thumb' : '';
    const extra = group.files.length > 4 ? `<span class="thumb-more">+${group.files.length - 4}</span>` : '';
    const usedBadge = group.used ? '<span class="used-badge">已使用</span>' : '';
    const uploadButton = group.id === '__root__'
      ? ''
      : `<button class="group-icon-btn" type="button" data-upload-group="${escapeHtml(group.id)}" aria-label="向 ${escapeHtml(group.name)} 追加图片" title="追加图片">${SVG_ICONS.upload}</button>`;
    const manageButton = `<button class="group-icon-btn" type="button" data-manage-group="${escapeHtml(group.id)}" aria-label="管理 ${escapeHtml(group.name)}" title="管理图片与名称">${SVG_ICONS.manage}</button>`;
    const countLabel = group.files.length ? `${group.files.length} 张参考图` : '暂无图片';
    const warnSuffix = group.files.length && group.files.some((file) => !file.publicUrl) ? ' · 待配公网地址' : '';
    return `
      <article class="group-card ${selected ? 'selected' : ''}" data-group-id="${escapeHtml(group.id)}" tabindex="0" aria-label="素材组 ${escapeHtml(group.name)}，${countLabel}">
        <div class="group-check"><input type="checkbox" data-group-check="${escapeHtml(group.id)}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(group.name)}" /></div>
        <div class="thumb-grid ${thumbLayoutClass}">${thumbs || '<span class="thumb-empty">暂无预览</span>'}${extra}</div>
        <div class="group-meta">
          <div>
            <div class="group-name-line"><strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</strong>${usedBadge}</div>
            <span class="group-sub">${countLabel}${warnSuffix}</span>
          </div>
          <div class="group-card-actions">${uploadButton}${manageButton}</div>
        </div>
      </article>`;
  }).join('');
  renderSummary();
}

function renderGroupSelection() {
  for (const card of els.groupGrid.querySelectorAll('[data-group-id]')) {
    const selected = state.selected.has(card.dataset.groupId);
    card.classList.toggle('selected', selected);
    const checkbox = card.querySelector('[data-group-check]');
    if (checkbox) checkbox.checked = selected;
  }
  renderSummary();
}

/* ---------- 素材组管理弹窗 ---------- */
function renderGroupManageModal() {
  const group = state.groups.find((item) => item.id === state.manageGroupId);
  if (!group) {
    closeModal(els.groupManageModal);
    return;
  }
  const isRoot = group.id === '__root__';
  $('#groupManageTitle').textContent = `管理素材组 · ${group.name}`;
  $('#manageRenameRow').hidden = isRoot;
  $('#manageGroupNameInput').value = group.name;
  $('#manageAddFilesButton').hidden = isRoot;
  $('#manageDangerZone').hidden = isRoot;
  $('#deleteGroupConfirmBar').hidden = true;
  $('#manageGroupCount').textContent = `共 ${group.files.length} 张参考图`;

  const grid = $('#manageImageGrid');
  if (!group.files.length) {
    grid.innerHTML = '<div class="empty-state compact"><h3>当前素材组没有图片</h3><p class="empty-desc">点击右上角「追加图片」添加商品参考图</p></div>';
    return;
  }
  grid.innerHTML = group.files.map((file) => `
    <div class="manage-image-item">
      <a href="${escapeHtml(file.url)}" target="_blank" rel="noopener" title="点击查看原图：${escapeHtml(file.name)}">
        <img src="${escapeHtml(file.thumbnailUrl || file.url)}" alt="${escapeHtml(file.name)}" loading="lazy" />
      </a>
      <button class="manage-image-delete" type="button" data-delete-group-file="${escapeHtml(file.relativePath)}" aria-label="删除图片 ${escapeHtml(file.name)}" title="删除此图片">${SVG_ICONS.trash}</button>
      <div class="manage-image-caption" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
    </div>`).join('');
}

function openGroupManageModal(groupId) {
  state.manageGroupId = groupId;
  renderGroupManageModal();
  openModal(els.groupManageModal, $('#closeGroupManageButton'));
}

async function renameManagedGroup() {
  const group = state.groups.find((item) => item.id === state.manageGroupId);
  if (!group || group.id === '__root__') return;
  const nextName = $('#manageGroupNameInput').value.trim();
  if (!nextName) return showToast('素材组名称不能为空', true);
  if (nextName === group.name) return showToast('名称未发生变化');
  const btn = $('#saveGroupRenameButton');
  btn.disabled = true;
  try {
    const result = await request(`/api/material-groups/${encodeURIComponent(group.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nextName }),
    });
    const newId = result.group?.id || nextName;
    if (state.selected.has(group.id)) {
      state.selected.delete(group.id);
      state.selected.add(newId);
    }
    state.manageGroupId = newId;
    await refresh({ groups: true, config: false });
    renderGroupManageModal();
    showToast('素材组名称已更新');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteManagedGroupFile(relativePath) {
  const groupId = state.manageGroupId;
  if (!groupId || !relativePath) return;
  try {
    await request(`/api/material-groups/${encodeURIComponent(groupId)}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ relativePath }),
    });
    await refresh({ groups: true, config: false });
    renderGroupManageModal();
    showToast('图片已删除');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteManagedGroup() {
  const groupId = state.manageGroupId;
  if (!groupId || groupId === '__root__') return;
  const btn = $('#confirmDeleteGroupButton');
  btn.disabled = true;
  try {
    await request(`/api/material-groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    state.selected.delete(groupId);
    state.manageGroupId = '';
    closeModal(els.groupManageModal);
    await refresh({ groups: true, config: false });
    showToast('素材组已删除');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 生成队列 ---------- */
function renderJobs() {
  const page = renderPagination('job', state.jobs.length, JOB_PAGE_SIZE);
  const signature = JSON.stringify([page, state.jobs]);
  if (signature === state.renderedJobsSignature) return;
  state.renderedJobsSignature = signature;
  const hasJobs = state.jobs.length > 0;
  els.jobsEmpty.hidden = hasJobs;
  els.jobsBody.innerHTML = state.jobs.slice((page - 1) * JOB_PAGE_SIZE, page * JOB_PAGE_SIZE).map((job) => {
    const canSubmit = availableVideoModels.has(job.model);
    const hasLocalVideo = Boolean(job.localFile);
    const videoUrl = hasLocalVideo ? withBasePath(`/api/jobs/${encodeURIComponent(job.id)}/video#t=0.1`) : '';
    const thumbHtml = hasLocalVideo
      ? `<button class="job-thumb-btn" type="button" data-action="preview" data-id="${escapeHtml(job.id)}" aria-label="播放预览 ${escapeHtml(job.groupName || job.name)}" title="点击播放预览">
          <video src="${escapeHtml(videoUrl)}" muted playsinline preload="metadata"></video>
          <span class="job-thumb-play" aria-hidden="true">${SVG_ICONS.play}</span>
        </button>`
      : '';
    const previewAction = hasLocalVideo
      ? `<button class="row-action accent" type="button" data-action="preview" data-id="${escapeHtml(job.id)}">预览</button><button class="row-action" type="button" data-action="open-folder" data-id="${escapeHtml(job.id)}" title="在文件管理器中定位该视频">目录</button>`
      : '';
    const statusAction = job.status === 'failed' || job.status === 'canceled' || job.status === 'waiting-key'
      ? (canSubmit ? `<button class="row-action" type="button" data-action="retry" data-id="${escapeHtml(job.id)}" title="重新提交视频任务">重试</button>` : '<span class="retired-model">已停用</span>')
      : job.status === 'queued'
        ? (canSubmit ? `<button class="row-action" type="button" data-action="start" data-id="${escapeHtml(job.id)}">开始</button>` : '<span class="retired-model">已停用</span>')
        : job.status === 'processing' || job.status === 'submitting'
          ? `<button class="row-action" type="button" data-action="cancel" data-id="${escapeHtml(job.id)}" title="仅停止本地跟踪，远端任务可能继续生成">停止跟踪</button>`
          : job.status === 'succeeded' && !job.localFile && job.downloadState === 'retrying'
            ? `<button class="row-action" type="button" data-action="download" data-id="${escapeHtml(job.id)}" title="立即重试下载原任务视频">立即下载</button>`
            : '';
    const recoverAction = ['failed', 'canceled'].includes(job.status) && job.taskId
      ? `<button class="row-action accent" type="button" data-action="download" data-id="${escapeHtml(job.id)}" title="查询原任务并下载成片，不会重新扣费">取回视频</button>`
      : '';
    const name = job.groupName || job.name;
    const retryTime = job.downloadRetryAt ? new Date(job.downloadRetryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const output = hasLocalVideo
      ? '<span class="output-ready">已保存成片</span>'
      : job.status === 'succeeded'
        ? `<span class="output-empty">${job.downloadState === 'retrying' ? (retryTime ? `${escapeHtml(retryTime)} 重试` : '等待重试') : '下载中…'}</span>`
        : '';
    const jobError = job.status === 'canceled' && String(job.error || '').startsWith('已由用户取消') ? '' : job.error;
    const errorHtml = jobError
      ? `<button class="job-error-btn" type="button" data-action="error-detail" data-id="${escapeHtml(job.id)}" title="点击查看完整报错并复制">${escapeHtml(jobError)}</button>`
      : '';
    const submittedAt = job.submittedAt || job.createdAt;
    return `
      <tr>
        <td>
          <div class="job-group">
            ${thumbHtml}
            <div class="job-group-text">
              <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
              <small title="${escapeHtml(job.model)}">${escapeHtml(job.model)}${job.narrationEnabled ? ' · Fish 配音' : ''}</small>
            </div>
          </div>
        </td>
        <td><span class="reference-count">${job.sourceCount || job.imageUrls?.length || 0} 张${job.modelReferenceCount ? ` · 模特 ${job.modelReferenceCount}` : ''}</span></td>
        <td>
          <div class="param-list">
            <span class="param-tag">${escapeHtml(job.duration)}s</span>
            <span class="param-tag">${escapeHtml(job.ratio)}</span>
            <span class="param-tag">${escapeHtml(job.resolution)}</span>
          </div>
          <div class="output-line">${output}</div>
        </td>
        <td><time class="submitted-date" datetime="${escapeHtml(submittedAt || '')}">${formatJobDate(submittedAt)}</time></td>
        <td>
          ${statusHtml(job)}
          ${job.stage ? `<div class="reference-count">${escapeHtml(job.stage)}</div>` : ''}
          ${errorHtml}
        </td>
        <td>
          <div class="row-actions">
            ${previewAction}
            <button class="row-action" type="button" data-action="view" data-id="${escapeHtml(job.id)}">脚本</button>
            ${recoverAction}
            ${statusAction}
          </div>
        </td>
      </tr>`;
  }).join('');
  renderSummary();
}

/* ---------- 顶栏真实就绪状态与设置弹窗 ---------- */
function keySourceLabel(source, fallbackConfigured) {
  if (source === 'canvas') return '画布联动';
  if (source === 'local') return '本页覆盖';
  return fallbackConfigured ? '已配置' : '未配置';
}

function updateConnectionBanner() {
  const config = state.config || {};
  const hasAnyKey = Boolean(config.hasToken || config.hasOfficialApiKey);
  const hasPublicBase = Boolean(config.materialPublicBaseUrl);
  const activeModel = $('#modelInput').value;
  const activeModelMissingKey = Boolean(missingKeyInfo(activeModel));

  els.connectionCard.classList.remove('ready', 'warn', 'disconnected');
  if (!hasAnyKey) {
    els.connectionCard.classList.add('disconnected');
    $('#connectionLabel').textContent = '未连接 API';
    $('#connectionHint').textContent = '点击关联画布或填写密钥';
  } else if (!hasPublicBase) {
    els.connectionCard.classList.add('warn');
    $('#connectionLabel').textContent = '差一步可生成';
    $('#connectionHint').textContent = '需配置素材公网地址前缀';
  } else if (activeModelMissingKey) {
    els.connectionCard.classList.add('warn');
    $('#connectionLabel').textContent = '当前模型缺密钥';
    $('#connectionHint').textContent = activeModel === officialVideoModel ? '请补充火山引擎官方密钥' : '请补充 6789API 低价密钥';
  } else {
    els.connectionCard.classList.add('ready');
    const linked = config.officialKeySource === 'canvas' || config.tokenSource === 'canvas';
    $('#connectionLabel').textContent = linked ? '环境已就绪（画布联动）' : '环境已就绪';
    $('#connectionHint').textContent = `官方${keySourceLabel(config.officialKeySource, config.hasOfficialApiKey)} · 低价${keySourceLabel(config.tokenSource, config.hasToken)}`;
  }
}

function setConnection(config) {
  state.config = config;
  $('#autoRetryComposerInput').checked = config.autoRetry === true;
  $('#materialPath').textContent = config.materialDir || '未设置';
  $('#materialPath').title = config.materialDir || '';
  $('#outputPath').textContent = config.outputDir || '未设置';
  $('#outputPath').title = config.outputDir || '';
  $('#outputPathInline').textContent = config.outputDir || '输出';

  if (!userPickedModel && config.hasOfficialApiKey && !config.hasToken && $('#modelInput').value !== officialVideoModel) {
    const officialOption = document.querySelector(`#modelPickerMenu [data-model="${officialVideoModel}"]`);
    if (officialOption) {
      selectModel(officialOption, { focusButton: false });
      const details = officialOption.closest('details');
      if (details) details.open = true;
    }
  }
  updateConnectionBanner();
}

function switchSettingsTab(tabKey) {
  for (const tab of $$('[data-settings-tab]')) {
    const active = tab.dataset.settingsTab === tabKey;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of $$('[data-tab-panel]')) {
    panel.hidden = panel.dataset.tabPanel !== tabKey;
  }
}

function clearSettingsFieldErrors() {
  for (const field of els.settingsModal.querySelectorAll('.field-error')) {
    field.classList.remove('field-error');
  }
  $('#settingsMissingAlert').hidden = true;
  $('#settingsMissingAlert').textContent = '';
}

function openSettings({ tab = '', focusId = '', errorMessage = '', message = '' } = {}) {
  const config = state.config || {};
  const sftp = config.sftp || {};
  const sync = config.canvasSync || {};
  const officialName = sync.officialProviderName || '火山引擎';
  const lowCostName = sync.lowCostProviderName || '6789API';
  const syncSummary = $('#canvasSyncSummary');
  if (syncSummary) {
    syncSummary.textContent = `${officialName}（官方）：${sync.hasCanvasOfficialKey ? '已联动' : '未在画布配置'} · ${lowCostName}（低价）：${sync.hasCanvasLowCostKey ? '已联动' : '未在画布配置'}`;
  }
  $('#apiBaseUrlInput').value = config.apiBaseUrl || 'https://www.6789api.top';
  $('#apiTokenInput').value = '';
  $('#apiTokenInput').placeholder = config.tokenSource === 'canvas'
    ? `已联动画布 ${lowCostName}（${config.tokenPreview}），留空继续联动`
    : (config.hasToken ? `本页已保存 ${config.tokenPreview}，留空表示不修改` : `留空自动联动 ${lowCostName}，或在此填写覆盖`);
  $('#apiTokenHint').textContent = config.tokenSource === 'canvas'
    ? `当前自动使用画布「${lowCostName}」密钥，修改画布 API 设置后会实时同步。`
    : `默认自动联动小美画布「${lowCostName}」密钥；仅在需要单独覆盖时填写。`;

  $('#officialApiKeyInput').value = '';
  $('#officialApiKeyInput').placeholder = config.officialKeySource === 'canvas'
    ? `已联动画布 ${officialName}（${config.officialKeyPreview}），留空继续联动`
    : (config.hasOfficialApiKey ? `本页已保存 ${config.officialKeyPreview}，留空表示不修改` : `留空自动联动 ${officialName}，或在此填写覆盖`);
  $('#officialApiKeyHint').textContent = config.officialKeySource === 'canvas'
    ? `当前自动使用画布「${officialName}」密钥，修改画布 API 设置后会实时同步。`
    : `默认自动联动小美画布「${officialName}」密钥；仅在需要单独覆盖时填写。`;

  $('#fishApiKeyInput').value = '';
  $('#fishApiKeyInput').placeholder = config.hasFishKey ? `已保存 ${config.fishKeyPreview}，留空表示不修改` : 'Fish Audio API Key';
  $('#fishProxyUrlInput').value = config.fishProxyUrl || '';
  $('#materialPublicBaseUrlInput').value = config.materialPublicBaseUrl || '';
  $('#sftpEnabledInput').checked = sftp.enabled !== false;
  $('#sftpHostInput').value = sftp.host || '';
  $('#sftpPortInput').value = sftp.port ?? '';
  $('#sftpUsernameInput').value = sftp.username || '';
  $('#sftpPrivateKeyInput').value = '';
  $('#sftpPrivateKeyHint').textContent = sftp.hasPrivateKey ? '已配置私钥；留空表示不修改。' : '粘贴完整私钥；保存后不再显示。';
  $('#sftpRemoteDirInput').value = sftp.remoteDir || '';
  $('#concurrencyInput').value = config.concurrency || 2;
  $('#pollIntervalInput').value = String(config.pollIntervalMs || 4000);
  $('#outputDirInput').value = config.outputDir || '';
  $('#saveState').textContent = '';

  clearSettingsFieldErrors();

  const defaultTab = tab || (!config.hasToken && !config.hasOfficialApiKey ? 'keys' : (!config.materialPublicBaseUrl ? 'storage' : 'keys'));
  switchSettingsTab(defaultTab);

  const alertText = errorMessage || message;
  if (alertText) {
    $('#settingsMissingAlert').textContent = alertText;
    $('#settingsMissingAlert').hidden = false;
  }

  const targetEl = focusId ? $(`#${focusId}`) : null;
  if (targetEl) {
    const collapse = targetEl.closest('details');
    if (collapse) collapse.open = true;
    const field = targetEl.closest('.field');
    if (field) field.classList.add('field-error');
  }

  openModal(els.settingsModal, targetEl || $('#tabBtnKeys'));
  if (targetEl) {
    requestAnimationFrame(() => {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.focus();
    });
  }
}

function closeSettings() {
  clearSettingsFieldErrors();
  closeModal(els.settingsModal);
}

async function saveSettings() {
  const payload = {
    apiBaseUrl: $('#apiBaseUrlInput').value,
    materialPublicBaseUrl: $('#materialPublicBaseUrlInput').value,
    fishProxyUrl: $('#fishProxyUrlInput').value,
    sftp: {
      enabled: $('#sftpEnabledInput').checked,
      host: $('#sftpHostInput').value,
      port: $('#sftpPortInput').value,
      username: $('#sftpUsernameInput').value,
      remoteDir: $('#sftpRemoteDirInput').value,
    },
    concurrency: Number($('#concurrencyInput').value),
    pollIntervalMs: Number($('#pollIntervalInput').value),
    outputDir: $('#outputDirInput').value,
  };
  const token = $('#apiTokenInput').value.trim();
  if (token) payload.apiToken = token;
  const officialKey = $('#officialApiKeyInput').value.trim();
  if (officialKey) payload.officialApiKey = officialKey;
  const fishKey = $('#fishApiKeyInput').value.trim();
  if (fishKey) payload.fishApiKey = fishKey;
  const sftpPrivateKey = $('#sftpPrivateKeyInput').value.trim();
  if (sftpPrivateKey) payload.sftp.privateKeyText = sftpPrivateKey;
  try {
    const config = await request('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    setConnection(config);
    $('#sftpPrivateKeyInput').value = '';
    $('#sftpPrivateKeyHint').textContent = config.sftp?.hasPrivateKey ? '已配置私钥；留空表示不修改。' : '粘贴完整私钥；保存后不再显示。';
    await refresh();
    $('#saveState').textContent = '已保存';
    showToast('设置已保存');
    setTimeout(closeSettings, 400);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function toggleAutoRetry() {
  const enabled = $('#autoRetryComposerInput').checked;
  try {
    const config = await request('/api/config', { method: 'POST', body: JSON.stringify({ autoRetry: enabled }) });
    setConnection(config);
    showToast(enabled ? '已开启全局失败自动重试' : '已关闭全局失败自动重试');
  } catch (error) {
    $('#autoRetryComposerInput').checked = state.config?.autoRetry === true;
    showToast(error.message, true);
  }
}

/* ---------- 新建 / 上传素材组（修复 GROUP_PAGE_SIZE 崩溃 + 支持空态直拖） ---------- */
function renderPendingFiles() {
  if (!state.pendingFiles.length) {
    els.pendingFiles.innerHTML = '<span>尚未选择图片</span>';
    return;
  }
  els.pendingFiles.innerHTML = state.pendingFiles.map((file, index) => `
    <span class="pending-file">
      <span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <button type="button" data-remove-file="${index}" aria-label="移除 ${escapeHtml(file.name)}">${SVG_ICONS.close}</button>
    </span>`).join('');
}

function addMaterialFiles(fileList) {
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const incoming = [...fileList];
  const invalid = incoming.filter((file) => !allowed.has(`.${file.name.split('.').pop().toLowerCase()}`));
  if (invalid.length) showToast(`已跳过 ${invalid.length} 个非图片文件`, true);
  const keys = new Set(state.pendingFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  for (const file of incoming.filter((item) => allowed.has(`.${item.name.split('.').pop().toLowerCase()}`))) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!keys.has(key)) {
      state.pendingFiles.push(file);
      keys.add(key);
    }
  }
  renderPendingFiles();
}

function suggestGroupNameFromFiles(files = []) {
  const first = files[0]?.name || '';
  const stem = first.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '').trim();
  const base = stem && stem.length >= 2 ? stem.slice(0, 24) : `素材组-${state.groups.length + 1}`;
  const existing = new Set(state.groups.map((item) => item.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let seq = 2;
  while (existing.has(`${base}-${seq}`.toLowerCase())) seq += 1;
  return `${base}-${seq}`;
}

function openMaterialModal(groupId = '', initialFiles = null) {
  state.uploadGroupId = groupId;
  state.pendingFiles = [];
  els.materialFilesInput.value = '';
  els.materialSaveState.textContent = '';
  if (groupId) {
    const group = state.groups.find((item) => item.id === groupId);
    els.materialModalTitle.textContent = '向素材组追加图片';
    els.materialGroupNameField.hidden = true;
    els.materialTargetName.hidden = false;
    els.materialTargetName.textContent = group ? `目标素材组：${group.name}` : `目标素材组：${groupId}`;
    els.saveMaterialButton.textContent = '上传图片';
  } else {
    els.materialModalTitle.textContent = '新建素材组';
    els.materialGroupNameField.hidden = false;
    els.materialTargetName.hidden = true;
    els.materialGroupNameInput.value = initialFiles?.length ? suggestGroupNameFromFiles([...initialFiles]) : '';
    els.saveMaterialButton.textContent = '创建并上传';
  }
  if (initialFiles?.length) addMaterialFiles(initialFiles);
  else renderPendingFiles();
  openModal(els.materialModal, groupId ? els.chooseMaterialFiles : els.materialGroupNameInput);
}

function closeMaterialModal(force = false) {
  if (els.saveMaterialButton.disabled && !force) return;
  closeModal(els.materialModal);
  state.uploadGroupId = '';
  state.pendingFiles = [];
}

async function saveMaterialGroup() {
  if (!state.pendingFiles.length) return showToast('请先选择或拖入至少一张图片', true);
  const form = new FormData();
  let endpoint = '/api/material-groups';
  if (state.uploadGroupId) {
    endpoint = `/api/material-groups/${encodeURIComponent(state.uploadGroupId)}/files`;
  } else {
    const name = els.materialGroupNameInput.value.trim();
    if (!name) {
      els.materialGroupNameInput.focus();
      return showToast('请填写素材组名称', true);
    }
    form.append('name', name);
  }
  state.pendingFiles.forEach((file) => form.append('files', file, file.name));
  els.saveMaterialButton.disabled = true;
  els.materialSaveState.textContent = `正在上传 ${state.pendingFiles.length} 张图片…`;
  try {
    const result = await request(endpoint, { method: 'POST', body: form });
    const groupId = result.group?.id || state.uploadGroupId;
    const uploadedCount = result.uploaded || state.pendingFiles.length;
    await refresh({ groups: true, config: false });
    if (groupId) {
      state.selected.add(groupId);
      const visible = filteredGroups();
      const groupIndex = visible.findIndex((group) => group.id === groupId);
      if (groupIndex >= 0) {
        const pageSize = groupPageSize();
        state.groupPage = Math.floor(groupIndex / pageSize) + 1;
      }
    }
    renderGroups();
    if (!els.groupManageModal.hidden && state.manageGroupId === groupId) {
      renderGroupManageModal();
    }
    closeMaterialModal(true);
    showToast(`已上传 ${uploadedCount} 张图片`);
  } catch (error) {
    els.materialSaveState.textContent = '上传失败';
    showToast(error.message, true);
  } finally {
    els.saveMaterialButton.disabled = false;
  }
}

/* ---------- 刷新与轮询 ---------- */
async function refresh({ groups = true, config = true } = {}) {
  const [groupsResult, jobsResult, configResult] = await Promise.all([
    groups ? request('/api/material-groups') : Promise.resolve(null),
    request('/api/jobs'),
    config ? request('/api/config') : Promise.resolve(null),
  ]);
  if (groupsResult) {
    state.groups = groupsResult.groups || [];
    const ids = new Set(state.groups.map((group) => group.id));
    state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    renderGroups();
  }
  state.jobs = jobsResult.jobs || [];
  if (configResult) setConnection(configResult);
  renderJobs();
  updateGenerationCompletion();
  ensurePoll();
}

function ensurePoll() {
  const active = state.jobs.some((job) => ['queued', 'submitting', 'processing'].includes(job.status) || (job.status === 'succeeded' && !job.localFile));
  if (active && !state.pollTimer) {
    state.pollTimer = setInterval(async () => {
      if (state.pollPending) return;
      state.pollPending = true;
      try { await refresh({ groups: false, config: false }); }
      catch {}
      finally { state.pollPending = false; }
    }, 2200);
  }
  if (!active && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ---------- 模型与时长分段联动 ---------- */
function renderDurationPresets(values, selectedValue) {
  const presetWrap = $('#durationPresets');
  const select = $('#durationInput');
  if (values.length === 1) {
    presetWrap.hidden = false;
    select.hidden = true;
    presetWrap.innerHTML = `<button type="button" class="active" data-duration="${values[0]}" aria-pressed="true">固定 ${values[0]} 秒</button>`;
    return;
  }
  if (values.length <= 4) {
    presetWrap.hidden = false;
    select.hidden = true;
    presetWrap.innerHTML = values.map((v) => {
      const active = v === selectedValue;
      return `<button type="button" class="${active ? 'active' : ''}" data-duration="${v}" aria-pressed="${active}">${v}s</button>`;
    }).join('');
    return;
  }
  const preferred = [5, 10, 15, 30].filter((v) => values.includes(v));
  const chips = preferred.length >= 3 ? preferred : [10, 15, 20, 30].filter((v) => values.includes(v));
  presetWrap.hidden = false;
  select.hidden = false;
  select.classList.remove('full-width');
  presetWrap.innerHTML = chips.map((v) => {
    const active = v === selectedValue;
    return `<button type="button" class="${active ? 'active' : ''}" data-duration="${v}" aria-pressed="${active}">${v}s</button>`;
  }).join('');
}

function syncDurationOptions() {
  const model = $('#modelInput').value;
  const ranges = {
    [officialVideoModel]: Array.from({ length: 27 }, (_, index) => index + 4),
    'seedance2.5（满血版）': Array.from({ length: 21 }, (_, index) => index + 10),
    'seedance2.5（满血版）线路1': [30],
    'seedance2.5（满血版）线路3': [30],
    'seedance2.5（满血版）线路4': [30],
    'seedance-2.0（按秒）': [5, 10, 15],
    'seedance-2.0-fast（按秒）': [5, 10, 15],
    'seedance-2.5（按秒）': Array.from({ length: 27 }, (_, index) => index + 4),
  };
  const values = ranges[model] || ranges['seedance2.5（满血版）'];
  const current = Number($('#durationInput').value);
  const nextVal = values.includes(current) ? current : (values.includes(10) ? 10 : values[0]);
  $('#durationInput').innerHTML = values.map((value) => `<option value="${value}">${value} 秒</option>`).join('');
  $('#durationInput').value = String(nextVal);
  renderDurationPresets(values, nextVal);

  const ratioInput = $('#ratioInput');
  const ratioLabels = { '9:16': '9:16 竖屏', '16:9': '16:9 横屏', '1:1': '1:1 方形', adaptive: '自适应' };
  const ratioValues = model === 'seedance2.5（满血版）线路3'
    ? ['9:16', '16:9', '1:1', '3:4', '4:3', 'adaptive']
    : ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'];
  const currentRatio = ratioInput.value;
  ratioInput.innerHTML = ratioValues.map((value) => `<option value="${value}">${ratioLabels[value] || value}</option>`).join('');
  ratioInput.value = ratioValues.includes(currentRatio) ? currentRatio : '9:16';

  const resolutionValues = model === officialVideoModel ? ['480p', '720p', '1080p'] : ['720p'];
  const currentResolution = $('#resolutionInput').value;
  $('#resolutionInput').innerHTML = resolutionValues.map((value) => `<option value="${value}">${value.toUpperCase()}</option>`).join('');
  $('#resolutionInput').value = resolutionValues.includes(currentResolution) ? currentResolution : '720p';

  updateConnectionBanner();
}

function setModelMenuOpen(open) {
  $('#modelPickerMenu').hidden = !open;
  $('#modelPickerButton').setAttribute('aria-expanded', String(open));
}

function selectModel(button, { focusButton = true } = {}) {
  const input = $('#modelInput');
  input.value = button.dataset.model;
  const titleEl = button.querySelector('strong');
  $('#modelPickerValue').textContent = (titleEl ? titleEl.textContent : button.textContent).trim();
  $('#modelPickerMeta').textContent = button.dataset.meta || '';
  for (const option of $('#modelPickerMenu').querySelectorAll('[data-model]')) {
    const selected = option === button;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setModelMenuOpen(false);
  if (focusButton) $('#modelPickerButton').focus();
}

/* ---------- 提示词审核与批量提交 ---------- */
function showPromptReview(plans, narrationEnabled = false) {
  const list = $('#promptReviewList');
  list.replaceChildren();
  $('#promptReviewCount').textContent = `${plans.length} 个素材组`;
  for (const result of plans) {
    const item = document.createElement('article');
    item.className = 'prompt-review-item';
    const heading = document.createElement('div');
    heading.className = 'prompt-review-item-heading';
    const name = document.createElement('h4');
    name.textContent = result.groupName;
    const title = document.createElement('span');
    title.textContent = result.plan.title;
    heading.append(name, title);
    const label = document.createElement('label');
    label.className = 'field';
    const labelText = document.createElement('span');
    labelText.textContent = '视频提示词';
    const prompt = document.createElement('textarea');
    prompt.dataset.groupPrompt = result.groupId;
    prompt.rows = 7;
    prompt.maxLength = 6000;
    prompt.value = result.finalPrompt;
    label.append(labelText, prompt);
    const observations = document.createElement('details');
    observations.className = 'prompt-observations';
    const summary = document.createElement('summary');
    summary.textContent = `图片观察 · ${result.plan.visualFacts.length} 条`;
    const facts = document.createElement('ul');
    for (const fact of result.plan.visualFacts) {
      const line = document.createElement('li');
      line.textContent = fact;
      facts.append(line);
    }
    observations.append(summary, facts);
    item.append(heading, label);
    if (narrationEnabled) {
      const speechLabel = document.createElement('label');
      speechLabel.className = 'field';
      const speechTitle = document.createElement('span');
      speechTitle.textContent = '完整口播文案';
      const speech = document.createElement('textarea');
      speech.dataset.groupSpeech = result.groupId;
      speech.rows = 4;
      speech.maxLength = 500;
      speech.value = result.plan.spokenText;
      speechLabel.append(speechTitle, speech);
      item.append(speechLabel);
    }
    item.append(observations);
    list.append(item);
  }
  $('#promptReview').hidden = false;
  $('#promptReview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitVideoBatch(batch, reviewedPrompts, reviewedSpeech) {
  setGenerationStatus('正在上传素材并提交队列…', { busy: true, phase: 'uploading' });
  $('#confirmReviewButton').disabled = true;
  $('#cancelReviewButton').disabled = true;
  try {
    const createdResult = await request('/api/group-video-jobs', {
      method: 'POST',
      body: JSON.stringify({ ...batch, reviewedPrompts, reviewedSpeech }),
    });
    const createdJobs = createdResult.jobs || [];
    state.pendingReview = null;
    $('#promptReview').hidden = true;
    state.generationJobIds = new Set(createdJobs.map((job) => job.id));
    setGenerationStatus('素材已上传，正在生成中…', { phase: 'generating' });
    showToast(`已为 ${batch.groupIds.length} 个素材组开始生成视频`);
    for (const id of batch.groupIds) state.selected.delete(id);
    renderGroupSelection();
    await refresh().catch((error) => showToast(error.message, true));
    ensurePoll();
  } catch (error) {
    const reviewing = Boolean(state.pendingReview);
    setGenerationStatus(`提交失败：${error.message}`, { error: true, phase: reviewing ? 'review' : 'error' });
    showToast(error.message, true);
  } finally {
    $('#confirmReviewButton').disabled = false;
    $('#cancelReviewButton').disabled = false;
  }
}

async function generateSelected() {
  if (['planning', 'uploading', 'submitting', 'review'].includes(state.generationPhase)) return;
  const groupIds = [...state.selected];
  if (!groupIds.length) {
    if (!state.groups.length) {
      openMaterialModal();
      showToast('请先新建并上传至少一个素材组', true);
    } else {
      showToast('请先在上方勾选至少一个素材组', true);
    }
    return;
  }
  const keyMissing = missingKeyInfo($('#modelInput').value);
  if (keyMissing) {
    openSettings(keyMissing);
    showToast(keyMissing.message, true);
    return;
  }
  if (!state.config?.materialPublicBaseUrl) {
    const msg = '第三方视频模型需通过公网 HTTPS 读取参考图，请先填写「素材公网地址前缀」。';
    openSettings({ tab: 'storage', focusId: 'materialPublicBaseUrlInput', errorMessage: msg });
    showToast(msg, true);
    return;
  }
  const prompt = $('#promptInput').value.trim();
  if (!prompt) {
    $('#promptInput').focus();
    return showToast('请填写视频提示词', true);
  }
  const options = contentOptions();
  const narrationEnabled = options.voiceover && state.voiceSource === 'fish';
  if (narrationEnabled && !state.config?.hasFishKey) {
    const msg = '使用 Fish Audio 独立配音前，请先填写 Fish Audio API Key。';
    openSettings({ tab: 'runtime', focusId: 'fishApiKeyInput', errorMessage: msg });
    showToast(msg, true);
    return;
  }
  const fishVoiceId = narrationEnabled ? selectedFishVoiceId() : '';
  if (narrationEnabled && !fishVoiceId) return showToast('请先选择音色或填写自定义音色 ID', true);
  if (options.copywriting && !state.config?.hasToken) {
    const msg = '开启「文案专家」需要 6789API 低价密钥。';
    openSettings({ tab: 'keys', focusId: 'apiTokenInput', errorMessage: msg });
    showToast(msg, true);
    return;
  }
  if (options.modelEnabled && state.modelReferences.length > 3) return showToast('模特参考图最多 3 张', true);
  if (options.modelEnabled && state.modelReferences.length && !state.config?.sftp?.enabled) {
    const msg = '使用已上传的模特图需要开启「生成前自动通过 SFTP 上传素材」。';
    openSettings({ tab: 'storage', focusId: 'sftpEnabledInput', errorMessage: msg });
    showToast(msg, true);
    return;
  }
  const modelReferenceIds = options.modelEnabled ? state.modelReferences.map((reference) => reference.id) : [];
  const maxImages = $('#modelInput').value.includes('（按秒）') ? 9 : 30;
  const oversized = groupIds
    .map((id) => state.groups.find((group) => group.id === id))
    .find((group) => group && group.files.length + modelReferenceIds.length > maxImages);
  if (oversized) return showToast(`${oversized.name} 加上模特图超过当前模型的 ${maxImages} 张上限`, true);

  const duration = Number($('#durationInput').value);
  const planIds = {};
  const plans = [];
  const batch = {
    groupIds,
    prompt,
    model: $('#modelInput').value,
    duration,
    ratio: $('#ratioInput').value,
    resolution: $('#resolutionInput').value,
    contentOptions: options,
    modelReferenceIds,
    planIds,
    narrationEnabled,
    fishVoiceId,
  };
  try {
    if (options.copywriting) {
      setGenerationStatus(`正在识别图片并策划文案 0 / ${groupIds.length}`, { busy: true, phase: 'planning' });
      for (const [index, groupId] of groupIds.entries()) {
        const result = await request('/api/copy-plan', {
          method: 'POST',
          body: JSON.stringify({ groupId, prompt, model: batch.model, duration, contentOptions: options, modelReferenceIds, narrationEnabled }),
        });
        planIds[groupId] = result.planId;
        plans.push(result);
        setGenerationStatus(`正在识别图片并策划文案 ${index + 1} / ${groupIds.length}`, { busy: true, phase: 'planning' });
      }
    }
    if (options.reviewPrompt) {
      state.pendingReview = batch;
      showPromptReview(plans, narrationEnabled);
      setGenerationStatus('策划已完成，等待审核提示词', { phase: 'review' });
      return;
    }
    await submitVideoBatch(batch);
  } catch (error) {
    setGenerationStatus(`生成失败：${error.message}`, { error: true, phase: 'error' });
    showToast(error.message, true);
  }
}

async function rowAction(action, id, button) {
  if (button.disabled) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  if (action === 'download') button.textContent = '取回中…';
  try {
    await request(`/api/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    showToast(action === 'retry' ? '已重新加入队列' : action === 'download' ? '已加入自动下载队列' : '任务状态已更新');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    await refresh({ groups: false, config: false }).catch(() => {});
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

/* ---------- 清理队列二次确认 ---------- */
function openClearJobsModal() {
  const succeededCount = state.jobs.filter((job) => job.status === 'succeeded' && job.localFile).length;
  const failedOrCanceledCount = state.jobs.filter((job) => ['failed', 'canceled'].includes(job.status)).length;
  if (!succeededCount && !failedOrCanceledCount) {
    return showToast('当前没有可清理的已结束任务');
  }
  $('#clearIncludeFailedInput').checked = succeededCount === 0;
  $('#clearFailedCount').textContent = String(failedOrCanceledCount);
  $('#clearFailedOptionWrap').hidden = failedOrCanceledCount === 0;
  $('#clearJobsSummary').textContent = succeededCount > 0
    ? `当前有 ${succeededCount} 条已完成并保存的视频记录，清理仅移除队列记录，不会删除本地视频文件。`
    : '当前没有已完成的成功记录，勾选下方选项可清理失败或已停止的任务记录。';
  openModal(els.clearJobsModal, $('#confirmClearJobsButton'));
}

async function confirmClearJobs() {
  const includeFailed = $('#clearIncludeFailedInput').checked;
  const btn = $('#confirmClearJobsButton');
  btn.disabled = true;
  try {
    const result = await request(`/api/jobs?includeFailed=${includeFailed ? '1' : '0'}`, { method: 'DELETE' });
    closeModal(els.clearJobsModal);
    await refresh({ groups: false, config: false });
    const count = Number(result.removedCount || 0);
    showToast(count > 0 ? `已清理 ${count} 条任务记录` : '没有符合条件的任务被清理');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 事件绑定 ---------- */
els.groupGrid.addEventListener('click', (event) => {
  const uploadButton = event.target.closest('[data-upload-group]');
  if (uploadButton) {
    event.stopPropagation();
    openMaterialModal(uploadButton.dataset.uploadGroup);
    return;
  }
  const manageButton = event.target.closest('[data-manage-group]');
  if (manageButton) {
    event.stopPropagation();
    openGroupManageModal(manageButton.dataset.manageGroup);
    return;
  }
  const card = event.target.closest('[data-group-id]');
  if (!card || event.target.closest('input')) return;
  const id = card.dataset.groupId;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderGroupSelection();
});

els.groupGrid.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  const card = event.target.closest('[data-group-id]');
  if (!card || event.target !== card) return;
  event.preventDefault();
  const id = card.dataset.groupId;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderGroupSelection();
});

els.groupGrid.addEventListener('change', (event) => {
  const id = event.target.dataset.groupCheck;
  if (!id) return;
  event.target.checked ? state.selected.add(id) : state.selected.delete(id);
  renderGroupSelection();
});

for (const type of ['group', 'job']) {
  $(`#${type}PrevButton`).addEventListener('click', () => {
    state[`${type}Page`] -= 1;
    type === 'group' ? renderGroups() : renderJobs();
  });
  $(`#${type}NextButton`).addEventListener('click', () => {
    state[`${type}Page`] += 1;
    type === 'group' ? renderGroups() : renderJobs();
  });
}

$('#groupSearchInput').addEventListener('input', (event) => {
  state.groupSearch = event.target.value;
  state.groupPage = 1;
  renderGroups();
});

$('#filterUnusedButton').addEventListener('click', (event) => {
  state.filterUnusedOnly = !state.filterUnusedOnly;
  event.currentTarget.setAttribute('aria-pressed', String(state.filterUnusedOnly));
  state.groupPage = 1;
  renderGroups();
});

$('#resetGroupFiltersButton').addEventListener('click', () => {
  state.groupSearch = '';
  state.filterUnusedOnly = false;
  $('#groupSearchInput').value = '';
  $('#filterUnusedButton').setAttribute('aria-pressed', 'false');
  state.groupPage = 1;
  renderGroups();
});

$('#selectAllButton').addEventListener('click', () => {
  for (const group of filteredGroups()) state.selected.add(group.id);
  renderGroupSelection();
});

$('#clearSelectionButton').addEventListener('click', () => {
  state.selected.clear();
  renderGroupSelection();
});

$('#refreshButton').addEventListener('click', async () => {
  try {
    await refresh();
    showToast('素材组与队列已刷新');
  } catch (error) {
    showToast(error.message, true);
  }
});

// 空态直接拖拽建组 & 按钮
$('#emptyNewGroupButton').addEventListener('click', () => openMaterialModal());
$('#openMaterialDirFromEmpty').addEventListener('click', () => openWorkbenchDir('material'));
els.groupsEmpty.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.groupsEmpty.classList.add('dragging');
});
els.groupsEmpty.addEventListener('dragleave', (event) => {
  if (!els.groupsEmpty.contains(event.relatedTarget)) els.groupsEmpty.classList.remove('dragging');
});
els.groupsEmpty.addEventListener('drop', (event) => {
  event.preventDefault();
  els.groupsEmpty.classList.remove('dragging');
  const files = event.dataTransfer?.files;
  if (files?.length) openMaterialModal('', files);
});
els.groupsEmpty.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target === els.groupsEmpty) {
    event.preventDefault();
    openMaterialModal();
  }
});

// 快捷提示词模板
for (const btn of $$('[data-prompt-template]')) {
  btn.addEventListener('click', () => {
    const tpl = PROMPT_TEMPLATES[btn.dataset.promptTemplate];
    if (tpl) {
      $('#promptInput').value = tpl;
      syncPromptTemplateHighlight();
    }
  });
}
$('#promptInput').addEventListener('input', syncPromptTemplateHighlight);

// 时长分段按钮与下拉双向同步
$('#durationPresets').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-duration]');
  if (!btn) return;
  const val = Number(btn.dataset.duration);
  $('#durationInput').value = String(val);
  for (const item of $('#durationPresets').querySelectorAll('[data-duration]')) {
    const active = item === btn;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  }
});

$('#durationInput').addEventListener('change', () => {
  const val = Number($('#durationInput').value);
  for (const item of $('#durationPresets').querySelectorAll('[data-duration]')) {
    const active = Number(item.dataset.duration) === val;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  }
});

$('#generateButton').addEventListener('click', generateSelected);
$('#autoRetryComposerInput').addEventListener('change', toggleAutoRetry);
$('#modelInput').addEventListener('change', syncDurationOptions);
$('#categoryInput').addEventListener('change', syncCategoryField);

$('#cancelReviewButton').addEventListener('click', () => {
  state.pendingReview = null;
  $('#promptReview').hidden = true;
  setGenerationStatus('已取消本次提交', { phase: 'idle' });
});

$('#confirmReviewButton').addEventListener('click', async () => {
  if (!state.pendingReview || $('#confirmReviewButton').disabled) return;
  const reviewedPrompts = {};
  const reviewedSpeech = {};
  for (const field of $('#promptReviewList').querySelectorAll('[data-group-prompt]')) {
    const value = field.value.trim();
    if (!value) {
      field.focus();
      showToast('视频提示词不能为空', true);
      return;
    }
    reviewedPrompts[field.dataset.groupPrompt] = value;
  }
  for (const field of $('#promptReviewList').querySelectorAll('[data-group-speech]')) {
    const value = field.value.trim();
    if (!value) {
      field.focus();
      showToast('口播文案不能为空', true);
      return;
    }
    reviewedSpeech[field.dataset.groupSpeech] = value;
  }
  await submitVideoBatch(state.pendingReview, reviewedPrompts, reviewedSpeech);
});

// 模型下拉键盘导航
$('#modelPickerButton').addEventListener('click', () => setModelMenuOpen($('#modelPickerMenu').hidden));
$('#modelPickerMenu').addEventListener('click', (event) => {
  const option = event.target.closest('[data-model]');
  if (option) {
    userPickedModel = true;
    selectModel(option);
  }
});
$('#modelPicker').addEventListener('keydown', (event) => {
  const menu = $('#modelPickerMenu');
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    setModelMenuOpen(false);
    $('#modelPickerButton').focus();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const options = [...menu.querySelectorAll('[data-model]')].filter((item) => item.closest('details')?.open);
    if (event.target === $('#modelPickerButton')) {
      event.preventDefault();
      setModelMenuOpen(true);
      (options[0] || menu.querySelector('summary'))?.focus();
    } else if (!menu.hidden && options.length) {
      const idx = options.indexOf(document.activeElement);
      if (idx >= 0) {
        event.preventDefault();
        const next = options[(idx + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
        next?.focus();
      }
    }
  }
});
$('#modelPicker').addEventListener('focusout', (event) => {
  if (!$('#modelPicker').contains(event.relatedTarget)) setModelMenuOpen(false);
});
document.addEventListener('pointerdown', (event) => {
  if (!$('#modelPicker').contains(event.target)) setModelMenuOpen(false);
});

// 队列操作
$('#clearJobsButton').addEventListener('click', openClearJobsModal);
$('#closeClearJobsButton').addEventListener('click', () => closeModal(els.clearJobsModal));
$('#cancelClearJobsButton').addEventListener('click', () => closeModal(els.clearJobsModal));
$('#confirmClearJobsButton').addEventListener('click', confirmClearJobs);
els.clearJobsModal.addEventListener('click', (event) => { if (event.target === els.clearJobsModal) closeModal(els.clearJobsModal); });

els.jobsBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const job = state.jobs.find((item) => item.id === button.dataset.id);
  const action = button.dataset.action;
  if (action === 'view') { if (job) openScript(job); return; }
  if (action === 'preview') { if (job) openVideoPreview(job); return; }
  if (action === 'open-folder') { if (job) void openJobFolder(job.id); return; }
  if (action === 'error-detail') { if (job) openErrorDetail(job); return; }
  void rowAction(action, button.dataset.id, button);
});

// 页脚打开目录
for (const btn of $$('[data-open-dir]')) {
  btn.addEventListener('click', () => void openWorkbenchDir(btn.dataset.openDir));
}

// 设置弹窗 Tab 与交互
$('#openSettingsButton').addEventListener('click', () => openSettings());
$('#closeSettingsButton').addEventListener('click', closeSettings);
$('#cancelSettingsButton').addEventListener('click', closeSettings);
$('#saveSettingsButton').addEventListener('click', saveSettings);
els.settingsModal.addEventListener('click', (event) => { if (event.target === els.settingsModal) closeSettings(); });
for (const tab of $$('[data-settings-tab]')) {
  tab.addEventListener('click', () => switchSettingsTab(tab.dataset.settingsTab));
}
els.settingsModal.addEventListener('input', (event) => {
  const field = event.target.closest?.('.field-error');
  if (field) field.classList.remove('field-error');
});

// 创作选项
for (const id of ['copywritingInput', 'modelEnabledInput', 'voiceoverInput', 'subtitlesInput']) {
  $(`#${id}`).addEventListener('change', syncCreativeControls);
}

$('#fishSourceField').addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice-source]');
  if (!button) return;
  state.voiceSource = button.dataset.voiceSource;
  for (const item of $('#fishSourceField').querySelectorAll('[data-voice-source]')) {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  }
  syncCreativeControls();
});

$('#fishPanel').addEventListener('change', (event) => {
  if (event.target.matches('input[name="fishVoicePreset"]')) {
    stopFishPreview();
    $('#fishPreviewStatus').textContent = '';
    syncFishVoiceSelection();
  }
});

$('#fishVoiceCategories').addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice-category]');
  if (button) {
    showFishVoiceCategory(button.dataset.voiceCategory, true);
    ensureFishVoices();
  }
});

$('#fishPanel').addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice-preview]');
  if (button) {
    void toggleFishPreview(button);
    return;
  }
  const card = event.target.closest('.fish-voice');
  if (card && !event.target.closest('label')) card.querySelector('input').click();
});

$('#modelReferencesInput').addEventListener('change', (event) => uploadModelReferences(event.target.files || []));
$('#modelReferenceList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-remove-model]');
  if (!button) return;
  try {
    const result = await request(`/api/model-references/${encodeURIComponent(button.dataset.removeModel)}`, { method: 'DELETE' });
    state.modelReferences = result.references || [];
    renderModelReferences();
    showToast('模特参考图已移除');
  } catch (error) {
    showToast(error.message, true);
  }
});

// 素材组管理弹窗事件
$('#closeGroupManageButton').addEventListener('click', () => closeModal(els.groupManageModal));
$('#doneGroupManageButton').addEventListener('click', () => closeModal(els.groupManageModal));
els.groupManageModal.addEventListener('click', (event) => { if (event.target === els.groupManageModal) closeModal(els.groupManageModal); });
$('#saveGroupRenameButton').addEventListener('click', renameManagedGroup);
$('#manageGroupNameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void renameManagedGroup();
  }
});
$('#manageAddFilesButton').addEventListener('click', () => {
  if (state.manageGroupId) openMaterialModal(state.manageGroupId);
});
$('#manageImageGrid').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-delete-group-file]');
  if (btn) void deleteManagedGroupFile(btn.dataset.deleteGroupFile);
});
$('#deleteGroupButton').addEventListener('click', () => {
  $('#deleteGroupConfirmBar').hidden = false;
  $('#confirmDeleteGroupButton').focus();
});
$('#cancelDeleteGroupButton').addEventListener('click', () => {
  $('#deleteGroupConfirmBar').hidden = true;
});
$('#confirmDeleteGroupButton').addEventListener('click', deleteManagedGroup);

// 视频预览弹窗事件
$('#closeVideoPreviewButton').addEventListener('click', closeVideoPreview);
$('#doneVideoPreviewButton').addEventListener('click', closeVideoPreview);
els.videoPreviewModal.addEventListener('click', (event) => { if (event.target === els.videoPreviewModal) closeVideoPreview(); });
$('#videoPreviewOpenDirButton').addEventListener('click', () => { if (state.previewJobId) void openJobFolder(state.previewJobId); });
$('#videoPreviewScriptButton').addEventListener('click', () => {
  const job = state.jobs.find((item) => item.id === state.previewJobId);
  if (job) {
    closeVideoPreview();
    openScript(job);
  }
});

// 错误详情 & 脚本 & Toast 事件
$('#closeErrorDetailButton').addEventListener('click', () => closeModal(els.errorDetailModal));
$('#doneErrorDetailButton').addEventListener('click', () => closeModal(els.errorDetailModal));
els.errorDetailModal.addEventListener('click', (event) => { if (event.target === els.errorDetailModal) closeModal(els.errorDetailModal); });
$('#copyErrorDetailButton').addEventListener('click', async () => {
  const text = $('#errorDetailText').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('报错信息已复制到剪贴板');
  } catch {
    showToast('复制失败，请手动选中复制', true);
  }
});

$('#closeScriptButton').addEventListener('click', () => closeModal(els.scriptModal));
els.scriptModal.addEventListener('click', (event) => { if (event.target === els.scriptModal) closeModal(els.scriptModal); });
els.toastCloseButton.addEventListener('click', hideToast);

// 新建/追加素材弹窗事件
els.newGroupButton.addEventListener('click', () => openMaterialModal());
els.chooseMaterialFiles.addEventListener('click', (event) => { event.stopPropagation(); els.materialFilesInput.click(); });
els.materialFilesInput.addEventListener('change', (event) => { addMaterialFiles(event.target.files || []); event.target.value = ''; });
els.uploadDropzone.addEventListener('click', (event) => { if (event.target.closest('button') || event.target === els.materialFilesInput) return; els.materialFilesInput.click(); });
els.uploadDropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); els.materialFilesInput.click(); } });
els.uploadDropzone.addEventListener('dragover', (event) => { event.preventDefault(); els.uploadDropzone.classList.add('dragging'); });
els.uploadDropzone.addEventListener('dragleave', (event) => { if (!els.uploadDropzone.contains(event.relatedTarget)) els.uploadDropzone.classList.remove('dragging'); });
els.uploadDropzone.addEventListener('drop', (event) => { event.preventDefault(); els.uploadDropzone.classList.remove('dragging'); addMaterialFiles(event.dataTransfer?.files || []); });
els.pendingFiles.addEventListener('click', (event) => { const button = event.target.closest('[data-remove-file]'); if (!button) return; state.pendingFiles.splice(Number(button.dataset.removeFile), 1); renderPendingFiles(); });
els.saveMaterialButton.addEventListener('click', saveMaterialGroup);
els.closeMaterialButton.addEventListener('click', () => closeMaterialModal());
els.cancelMaterialButton.addEventListener('click', () => closeMaterialModal());
els.materialModal.addEventListener('click', (event) => { if (event.target === els.materialModal) closeMaterialModal(); });

// 主壳联动 & 响应式事件
window.addEventListener('resize', () => {
  if (state.groupPageSize && groupPageSize() !== state.groupPageSize) renderGroups();
  redrawFishWaveforms();
});
window.addEventListener('studio-theme-change', () => requestAnimationFrame(redrawFishWaveforms));
window.addEventListener('studio-appearance-change', () => requestAnimationFrame(redrawFishWaveforms));

$('#openCanvasApiSettingsButton')?.addEventListener('click', () => {
  closeSettings();
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'studio-switch-ui', page: 'api-settings' }, window.location.origin);
  } else {
    window.open('/static/api-settings.html', '_blank', 'noopener');
  }
});

window.addEventListener('message', (event) => {
  if (event.origin && event.origin !== window.location.origin) return;
  if (event.data?.type === 'providers-changed') void refresh().catch(() => {});
});

try {
  const studioApiChannel = new BroadcastChannel('studio-api');
  studioApiChannel.onmessage = (event) => {
    if (event.data?.type === 'providers-changed') void refresh().catch(() => {});
  };
} catch {}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh().catch(() => {});
});

// 初始化
syncCategoryField();
syncPromptTemplateHighlight();
syncCreativeControls();
syncDurationOptions();
ensureFishVoices();
Promise.all([refresh(), loadModelReferences()]).then(ensurePoll).catch((error) => showToast(error.message, true));
