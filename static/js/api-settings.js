let providers = [];
let selectedId = '';
let providerDraftVersion = 0;
let providerSavedVersion = 0;
let providerSavePromise = null;
let providerSaveError = '';
let providerSaveFocus = null;
const providerList = document.getElementById('providerList');
const editorTitle = document.getElementById('editorTitle');
const statusEl = document.getElementById('status');
const nameInput = document.getElementById('nameInput');
const idInput = document.getElementById('idInput');
const baseInput = document.getElementById('baseInput');
const protocolInput = document.getElementById('protocolInput');
const imageRequestModeInput = document.getElementById('imageRequestModeInput');
const imageEditRouteInput = document.getElementById('imageEditRouteInput');
const keyInput = document.getElementById('keyInput');
const keyHint = document.getElementById('keyHint');
const volcArkKeyHint = document.getElementById('volcArkKeyHint');
const volcAkInput = document.getElementById('volcAkInput');
const volcSkInput = document.getElementById('volcSkInput');
const volcAssetKeyHint = document.getElementById('volcAssetKeyHint');
const volcProjectInput = document.getElementById('volcProjectInput');
const volcRegionInput = document.getElementById('volcRegionInput');
const jimengCliPanel = document.getElementById('jimengCliPanel');
const jimengCliStatus = document.getElementById('jimengCliStatus');
const jimengCliAction = document.getElementById('jimengCliAction');
const jimengCliUpdate = document.getElementById('jimengCliUpdate');
const jimengCliUpdateBtn = document.getElementById('jimengCliUpdateBtn');
const jimengCredit = document.getElementById('jimengCredit');
const jimengLoginBox = document.getElementById('jimengLoginBox');
const jimengHelpOverlay = document.getElementById('jimengHelpOverlay');
const jimengHelpCommand = document.getElementById('jimengHelpCommand');
const jimengHelpOutput = document.getElementById('jimengHelpOutput');
const codexCliPanel = document.getElementById('codexCliPanel');
const codexCliStatus = document.getElementById('codexCliStatus');
const codexCliUpdate = document.getElementById('codexCliUpdate');
const codexCliUpdateBtn = document.getElementById('codexCliUpdateBtn');
const codexCliInfo = document.getElementById('codexCliInfo');
const codexHelpOverlay = document.getElementById('codexHelpOverlay');
const codexHelpCommand = document.getElementById('codexHelpCommand');
const codexHelpOutput = document.getElementById('codexHelpOutput');
const geminiCliPanel = document.getElementById('geminiCliPanel');
const geminiCliStatus = document.getElementById('geminiCliStatus');
const geminiCliUpdate = document.getElementById('geminiCliUpdate');
const geminiCliUpdateBtn = document.getElementById('geminiCliUpdateBtn');
const geminiCliTerminalBtn = document.getElementById('geminiCliTerminalBtn');
const geminiCliTerminalStatus = document.getElementById('geminiCliTerminalStatus');
const geminiCliInfo = document.getElementById('geminiCliInfo');
const geminiCliHelpOverlay = document.getElementById('geminiCliHelpOverlay');
const geminiCliHelpCommand = document.getElementById('geminiCliHelpCommand');
const geminiCliHelpOutput = document.getElementById('geminiCliHelpOutput');
const comfyuiConfigBlock = document.getElementById('comfyuiConfigBlock');
const comfyuiInstancesList = document.getElementById('comfyuiInstancesList');
const comfyuiInstanceStatus = document.getElementById('comfyuiInstanceStatus');
const comfyuiWorkflowStatus = document.getElementById('comfyuiWorkflowStatus');
const comfyuiWorkflowList = document.getElementById('comfyuiWorkflowList');
const settingsContent = document.getElementById('settingsContent');
const recommendContent = document.getElementById('recommendContent');
const recommendPanel = document.getElementById('recommendPanel');
const imageModelList = document.getElementById('imageModelList');
const chatModelList = document.getElementById('chatModelList');
const videoModelList = document.getElementById('videoModelList');
const recommendApiOverlay = document.getElementById('recommendApiOverlay');
const recommendApiList = document.getElementById('recommendApiList');
const VOLCENGINE_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const VOLCENGINE_DEFAULT_PROJECT_NAME = 'default';
const VOLCENGINE_DEFAULT_REGION = 'cn-beijing';
const RH_DEFAULT_BASE_URL = 'https://www.runninghub.cn';
const COMFYUI_PROVIDER = {id:'comfyui', name:'ComfyUI', protocol:'comfyui', base_url:'', enabled:true, primary:false, image_models:[], chat_models:[], video_models:[], has_key:false};
const VIP_GPT_DEFAULT_BASE_URL = 'https://www.vip-gpt.net';
const VIP_GPT_REGISTER_URL = 'https://www.vip-gpt.net/vip-gpt/register?aff=YGMS7BDKNY5Y';
const EXAMPLE_BASE_URL = 'https://api.example.com/v1';
let comfyuiInstances = [];
let comfyuiWorkflowCatalog = [];
const JIMENG_DEFAULT_IMAGE_MODELS = ['5.0', '4.7', '4.6', '4.5', '4.1', '4.0', '3.1', '3.0'];
const JIMENG_DEFAULT_VIDEO_MODELS = ['seedance2.0fast_vip', 'seedance2.0_vip'];
const JIMENG_LEGACY_IMAGE_MODELS = new Set(['jimeng-image-2k', 'jimeng-image-4k']);
const JIMENG_LEGACY_VIDEO_MODELS = new Set(['jimeng-video-720p', 'jimeng-video-1080p']);
const CODEX_DEFAULT_IMAGE_MODELS = ['gpt-image-2'];
const CODEX_DEFAULT_CHAT_MODELS = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'];
const GEMINI_CLI_DEFAULT_IMAGE_MODELS = ['auto'];
const GEMINI_CLI_DEFAULT_CHAT_MODELS = ['auto'];
const CLI_PROTOCOLS = new Set(['jimeng', 'codex', 'gemini-cli']);
const API_PROTOCOLS = ['openai', 'apimart', 'gemini', 'volcengine', 'runninghub', 'jimeng', 'codex', 'gemini-cli'];
const CLI_PROVIDER_PRESETS = {
    jimeng:{id:'jimeng', name:'即梦 CLI', protocol:'jimeng'},
    codex:{id:'codex', name:'GPT CLI', protocol:'codex'},
    'gemini-cli':{id:'gemini-cli', name:'Antigravity CLI', protocol:'gemini-cli'}
};
const cliSidebarState = {
    jimeng:{checking:false, checked:false, installed:null, currentVersion:'', latestVersion:'', updateAvailable:null, message:'', versionError:'', statusError:'', installing:false, installMessage:'', installError:'', checkPromise:null},
    codex:{checking:false, checked:false, installed:null, currentVersion:'', latestVersion:'', updateAvailable:null, message:'', versionError:'', statusError:'', installing:false, installMessage:'', installError:'', checkPromise:null},
    'gemini-cli':{checking:false, checked:false, installed:null, currentVersion:'', latestVersion:'', updateAvailable:null, message:'', versionError:'', statusError:'', installing:false, installMessage:'', installError:'', checkPromise:null},
};
function isCodexImage25Model(model){
    return /^gpt-image-2\.5-(?:flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?$/i.test(String(model || '').trim());
}
function codexHasImage25Model(models){
    return Array.isArray(models) && models.some(isCodexImage25Model);
}
function applyCliProtocolDefaults(item, protocol){
    if(!item) return;
    const value = String(protocol || item.protocol || '').toLowerCase();
    if(!CLI_PROTOCOLS.has(value)) return;
    item.base_url = '';
    item.protocol = value;
    if(value === 'jimeng'){
        item.image_models = unique([...(item.image_models || []).filter(model => !JIMENG_LEGACY_IMAGE_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_IMAGE_MODELS]);
        item.video_models = unique([...(item.video_models || []).filter(model => !JIMENG_LEGACY_VIDEO_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_VIDEO_MODELS]);
        item.chat_models = unique(item.chat_models || []);
    } else if(value === 'codex'){
        // `auto` 是 Antigravity CLI 的模型占位符，不能残留在 GPT CLI 中。
        const codexModels = model => {
            const normalized = String(model || '').trim().toLowerCase();
            return normalized !== '$imagegen' && normalized !== 'auto';
        };
        const builtInCodexModels = new Set(CODEX_DEFAULT_IMAGE_MODELS.map(model => String(model || '').trim().toLowerCase()));
        const savedImageModels = (item.image_models || []).filter(codexModels);
        const savedCodexModels = savedImageModels.filter(model => {
            const normalized = String(model || '').trim().toLowerCase();
            return !builtInCodexModels.has(normalized);
        });
        const hasManagedSelection = item.model_selection_managed === true;
        // 默认模型只用于初始化。用户通过选择器或行内增删改后，保存列表就是
        // 唯一来源，不能在渲染/保存时再次把已取消的模型补回来。
        item.image_models = hasManagedSelection
            ? unique(savedImageModels)
            : unique([...CODEX_DEFAULT_IMAGE_MODELS, ...savedCodexModels]);
        const savedChatModels = (item.chat_models || []).filter(codexModels);
        item.chat_models = hasManagedSelection
            ? unique(savedChatModels)
            : unique([...savedChatModels, ...CODEX_DEFAULT_CHAT_MODELS]);
        item.video_models = [];
    } else if(value === 'gemini-cli'){
        const hasManagedSelection = item.model_selection_managed === true;
        item.image_models = hasManagedSelection
            ? unique(item.image_models || [])
            : unique([...(item.image_models || []), ...GEMINI_CLI_DEFAULT_IMAGE_MODELS]);
        item.chat_models = hasManagedSelection
            ? unique(item.chat_models || [])
            : unique([...(item.chat_models || []), ...GEMINI_CLI_DEFAULT_CHAT_MODELS]);
        item.video_models = [];
    }
}
let recommendInlineOpen = false;
let providerDragId = '';
const RECOMMENDED_APIS = [
    {
        id:'api-6789',
        name:'6789API',
        category:'allround',
        base_url:'https://www.6789api.top',
        protocol:'openai',
        image_request_mode:'openai',
        register_url:'https://www.6789api.top/sign-up?aff=T8qq',
        tagKeys:['api.tagImageModels','api.tagVideoModels','api.tagLlmModels'],
        icons:['IMG','VID','LLM'],
        summaryKey:'api.recommend6789Summary',
        advantages:['OpenAI 兼容接口', '覆盖图像、视频和文本模型', '保存 Key 后自动拉取账号可用模型'],
        empty_models_on_save:true
    }
];
const RECOMMEND_GROUPS = [
    {key:'allround', titleKey:'api.recommendGroupAllround', icon:'blocks'}
];
const LOCKED_PROVIDER_PROTOCOLS = [
    {id:'exellome', name:'EXELLOME', base_url:'https://new.exellome.online', protocol:'apimart', image_request_mode:'openai-video-proxy'},
    {id:'fhl', name:'FHL', base_url:'https://www.fhl.mom', protocol:'openai', image_request_mode:'openai'}
];
function lockedRecommendedApi(itemOrId){
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    const name = typeof itemOrId === 'string' ? '' : itemOrId?.name;
    const baseUrl = typeof itemOrId === 'string' ? '' : itemOrId?.base_url;
    const normalizedId = String(id || '').trim().toLowerCase();
    const normalizedName = String(name || '').trim().toLowerCase();
    const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    const normalizedHost = (() => {
        try { return new URL(normalizedBase).host.toLowerCase(); } catch(e) { return ''; }
    })();
    return LOCKED_PROVIDER_PROTOCOLS.find(api => {
        const apiBase = String(api.base_url || '').trim().replace(/\/+$/, '').toLowerCase();
        const apiHost = (() => {
            try { return new URL(apiBase).host.toLowerCase(); } catch(e) { return ''; }
        })();
        return normalizedId === api.id
            || normalizedName === String(api.name || '').trim().toLowerCase()
            || (apiBase && normalizedBase === apiBase)
            || (apiHost && normalizedHost === apiHost);
    }) || null;
}
function hasLockedRecommendedProtocol(itemOrId){
    return Boolean(lockedRecommendedApi(itemOrId));
}
function applyLockedRecommendedProtocol(item){
    const api = lockedRecommendedApi(item);
    if(!item || !api) return false;
    item.protocol = String(api.protocol || 'openai').toLowerCase();
    item.image_request_mode = normalizeImageRequestMode(api.image_request_mode);
    return true;
}

function refreshIcons(){ if(window.lucide) lucide.createIcons(); }
function tr(key){ return window.StudioI18n ? window.StudioI18n.t(key) : key; }
function trf(key, vars={}){
    let text = tr(key);
    Object.entries(vars).forEach(([name, value]) => {
        text = text.replaceAll(`{${name}}`, String(value ?? ''));
    });
    return text;
}
function setStatus(text){ statusEl.textContent = text || ''; }
function hasKeyProfileDraft(){
    return keyProfiles.hasDraft();
}
function hasUnsavedProviderChanges(){
    return providerDraftVersion !== providerSavedVersion || hasKeyProfileDraft();
}
function confirmDiscardKeyProfileDraft(){
    if(!hasKeyProfileDraft()) return true;
    if(!confirm(tr('api.confirmDiscardAccountDraft'))) return false;
    keyProfiles.clearDraftInputs();
    return true;
}
function renderProviderSaveState(){
    const label = document.getElementById('providerSaveState');
    const retry = document.getElementById('retryProviderSave');
    if(!label) return;
    const state = providerSavePromise || keyProfiles.busy() ? 'saving' : providerSaveError ? 'failed' : hasUnsavedProviderChanges() ? 'unsaved' : 'saved';
    label.dataset.state = state;
    label.textContent = tr(`api.saveState.${state}`);
    label.title = providerSaveError;
    if(retry) retry.hidden = state !== 'failed';
}
function markProviderDirty(){
    providerDraftVersion += 1;
    providerSaveError = '';
    renderProviderSaveState();
}
function confirmLeaveApiSettings(){
    if(providerSavePromise || keyProfiles.busy()){ setStatus(tr('api.waitForSave')); return false; }
    return !hasUnsavedProviderChanges() || confirm(tr('api.confirmLeaveUnsaved'));
}
window.confirmLeaveApiSettings = confirmLeaveApiSettings;
window.addEventListener('beforeunload', event => {
    if(!hasUnsavedProviderChanges() && !providerSavePromise && !keyProfiles.busy()) return;
    event.preventDefault();
    event.returnValue = '';
});
function setProviderSaveBusy(busy){
    if(busy) providerSaveFocus = document.activeElement;
    for(const element of [settingsContent, recommendContent, document.querySelector('.layout > .sidebar')]){
        if(element) element.inert = busy;
    }
    settingsContent?.setAttribute('aria-busy', String(busy));
    if(!busy && providerSaveFocus?.isConnected && document.activeElement === document.body) providerSaveFocus.focus();
    if(!busy) providerSaveFocus = null;
}
function externalBrowserApi(){
    try {
        return window.electronAPI || window.parent?.electronAPI || window.top?.electronAPI || null;
    } catch(e) {
        return null;
    }
}
function openExternalWebPage(event, url){
    const href = String(url || '').trim();
    const api = externalBrowserApi();
    if(!href || !api?.openExternal) return true;
    event?.preventDefault();
    event?.stopPropagation();
    Promise.resolve(api.openExternal(href)).then(result => {
        if(result && result.ok === false) setStatus(result.message || '无法打开外部网页');
    }).catch(error => setStatus(error?.message || '无法打开外部网页'));
    return false;
}
function broadcastStudioApiChange(type='providers-changed'){
    const message = { type, updated_at:Date.now() };
    try { new BroadcastChannel('studio-api').postMessage(message); } catch(e) {}
    try { window.parent?.postMessage(message, '*'); } catch(e) {}
    try { window.top?.postMessage(message, '*'); } catch(e) {}
}
function normalizeId(value){
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-').slice(0, 40);
}
// 平台 Key 按 ID 写入 API/.env；首次保存后保持 ID 稳定，避免改名导致 Key 看起来丢失。
function deriveIdFromName(name, existingId){
    if(existingId) return existingId;
    let id = normalizeId(name);
    if(!id){
        id = 'api-' + Math.random().toString(36).slice(2, 8);
    }
    let candidate = id, i = 2;
    while(providers.some(p => p.id === candidate)){
        candidate = `${id}-${i++}`;
    }
    return candidate;
}
function newProviderId(item, name=item.name, baseUrl=item.base_url){
    if(!item._idDraft) return item.id;
    let base = '';
    try {
        const url = new URL(String(baseUrl || '').trim());
        if(['http:', 'https:'].includes(url.protocol)){
            const host = url.hostname.toLowerCase();
            base = host === 'soonstudio.ai' || host.endsWith('.soonstudio.ai') ? 'soon'
                : host === 'scnet.cn' || host.endsWith('.scnet.cn') ? 'scnet'
                : host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter'
                : host === 'qianwenaiapi.com' || host.endsWith('.qianwenaiapi.com') ? 'qwen'
                : normalizeId(host.replace(/^(?:(?:api\d*|www)\.)+/, '') + (url.port ? '-' + url.port : ''));
        }
    } catch(_) {}
    if(!base) base = normalizeId(name) === 'api' ? '' : normalizeId(name);
    base = base.length >= 2 ? base : item.id;
    let id = base, suffix = 2;
    const keyId = value => String(value || '').replace(/-/g, '_').toLowerCase();
    while(providers.some(other => other !== item && keyId(other.id) === keyId(id))){
        const tail = '-' + suffix++;
        id = base.slice(0, 40 - tail.length) + tail;
    }
    return id;
}
function updateIdPreview(){
    const item = provider();
    if(!item) return;
    const isBuiltin = item.id === 'comfly' || item.id === 'runninghub' || item.id === 'volcengine' || item.id === 'jimeng' || item.id === 'comfyui';
    const idPreview = document.getElementById('idPreview');
    if(!idPreview) return;
    if(isBuiltin){
        idPreview.textContent = item.id;
        return;
    }
    idPreview.textContent = newProviderId(item, nameInput.value, baseInput.value);
}
function provider(){
    const available = visibleProviders();
    return available.find(item => item.id === selectedId) || available[0] || null;
}
function isProviderTemporarilyHidden(item){
    return false;
}
function visibleProviders(){
    const hiddenFromApiSettings = new Set(['comfyui', 'runninghub', 'modelscope', 'volcengine']);
    return (providers || []).filter(item => !hiddenFromApiSettings.has(item.id) && !isProviderTemporarilyHidden(item));
}
function isFixedProvider(itemOrId){
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    // 即梦 CLI 不再是固定平台：可删除、可排序，未添加则不存在。
    return id === 'runninghub' || id === 'volcengine' || id === 'comfyui';
}
function unique(values){
    const seen = new Set();
    return values.map(v => String(v || '').trim()).filter(v => v && !seen.has(v) && seen.add(v));
}
function volcengineArkKeyHintText(item){
    return item?.has_key ? `方舟 API Key 已保存：${item.key_env || 'API/.env'} ${item.key_preview || ''}` : '还没有保存方舟 API Key。';
}
function volcengineAssetKeyHintText(item){
    const ak = item?.has_volcengine_access_key ? `AK 已保存：${item.volcengine_access_key_env || 'API/.env'} ${item.volcengine_access_key_preview || ''}` : 'AK 未保存';
    const sk = item?.has_volcengine_secret_key ? `SK 已保存：${item.volcengine_secret_key_env || 'API/.env'} ${item.volcengine_secret_key_preview || ''}` : 'SK 未保存';
    return `${ak} · ${sk}`;
}
function isApimartProviderContext(item){
    const baseUrl = String(baseInput?.value || item?.base_url || '').trim().toLowerCase();
    return baseUrl.includes('apimart.ai');
}
function updateApimartDomesticHint(item=provider()){
    const hasKey = Boolean(item?.has_key || (keyInput?.value || '').trim());
    document.body.classList.toggle('show-apimart-domestic-hint', Boolean(isApimartProviderContext(item) && hasKey));
}
function syncEditor(){
    const item = provider();
    if(!item) return;
    if(item.id === 'comfyui') return;
    const oldId = item.id;
    const isBuiltin = item.id === 'comfly' || item.id === 'runninghub' || item.id === 'volcengine' || item.id === 'jimeng' || item.id === 'comfyui';
    // 首次保存前从网站地址生成 ID；已保存的平台保持原 ID。
    const nextId = isBuiltin ? item.id : newProviderId(item, nameInput.value, baseInput.value);
    item.id = nextId;
    if(oldId !== item.id) selectedId = item.id;
    item.name = nameInput.value.trim() || item.id;
    const lockedApi = lockedRecommendedApi(item);
    const selectedProtocol = lockedApi
        ? lockedApi.protocol
        : item.id === 'runninghub'
        ? 'runninghub'
        : item.id === 'volcengine'
        ? 'volcengine'
        : (protocolInput?.value || 'openai');
    item.base_url = CLI_PROTOCOLS.has(selectedProtocol) ? '' : baseInput.value.trim();
    // 固定平台不从协议下拉读取
    item.protocol = selectedProtocol;
    item.image_request_mode = normalizeImageRequestMode(
        item.id === 'runninghub' || item.id === 'volcengine' || CLI_PROTOCOLS.has(selectedProtocol)
            ? 'openai'
            : lockedApi
            ? lockedApi.image_request_mode
            : (imageRequestModeInput?.value || item.image_request_mode)
    );
    item.image_edit_route = normalizeImageEditRoute(
        item.id === 'runninghub' || item.id === 'volcengine' || CLI_PROTOCOLS.has(selectedProtocol)
            ? 'general'
            : (imageEditRouteInput?.value || item.image_edit_route)
    );
    item.image_generation_endpoint = '';
    item.image_edit_endpoint = '';
    const key = keyInput.value.trim();
    if(key && !keyProfiles.ownsDraft(item) && !keyProfiles.supports(item)) item.api_key = key;
    if(item.id === 'volcengine'){
        const ak = volcAkInput?.value.trim() || '';
        const sk = volcSkInput?.value.trim() || '';
        if(ak) item.volcengine_access_key_id = ak;
        if(sk) item.volcengine_secret_access_key = sk;
        item.volcengine_project_name = (volcProjectInput?.value.trim() || VOLCENGINE_DEFAULT_PROJECT_NAME);
        item.volcengine_region = (volcRegionInput?.value.trim() || VOLCENGINE_DEFAULT_REGION);
    }
}
function updateProtocolFromInput(){
    const item = provider();
    if(!item || !protocolInput || item.id === 'runninghub' || item.id === 'volcengine' || item.id === 'comfyui') return;
    if(applyLockedRecommendedProtocol(item)){
        protocolInput.value = item.protocol;
        if(imageRequestModeInput) imageRequestModeInput.value = item.image_request_mode;
        return;
    }
    const value = String(protocolInput.value || 'openai').toLowerCase();
    item.protocol = API_PROTOCOLS.includes(value) ? value : 'openai';
    if(CLI_PROTOCOLS.has(item.protocol)) item.base_url = '';
    applyCliProtocolDefaults(item, item.protocol);
    document.body.classList.toggle('show-jimeng', item.protocol === 'jimeng');
    document.body.classList.toggle('show-codex', item.protocol === 'codex');
    document.body.classList.toggle('show-gemini-cli', item.protocol === 'gemini-cli');
    clearVerifyResult();
    // 协议会改变整个表单（如即梦 CLI 账户面板、默认模型、Key 占位）。renderEditor 是唯一切换这些的入口，
    // 这里复跑一次让面板立即出现；保存并恢复 Key 输入框，避免推荐流程里先填的 Key 被 renderEditor 清空。
    const savedKey = keyInput ? keyInput.value : '';
    renderEditor();
    if(keyInput) keyInput.value = savedKey;
    updateApimartDomesticHint(item);
}
function isVolcengineProvider(item){
    return String(item?.protocol || '').toLowerCase() === 'volcengine';
}
function mergeComfyUiWorkflowCatalog(workflows=[], appEntries=[]){
    const merged = new Map();
    const add = (raw, source='workflow') => {
        if(!raw || typeof raw !== 'object') return;
        // 普通工作流目录使用 name，ComfyUI 应用库使用 workflow。保留可执行
        // 的 custom/app_*.json 路径，配置字段和画布执行都沿用现有工作流接口。
        const name = String(raw.name || raw.workflow || raw.workflow_ref || '').trim();
        if(!name || !/\.json$/i.test(name)) return;
        const previous = merged.get(name) || {};
        const fields = Array.isArray(raw.fields) ? raw.fields : previous.fields;
        const isApp = source === 'app' || raw.entry_type === 'app';
        const readiness = raw.readiness && typeof raw.readiness === 'object'
            ? raw.readiness
            : (previous.readiness || {});
        const fieldCount = Math.max(0, Number(raw.field_count ?? previous.field_count ?? (Array.isArray(fields) ? fields.length : 0)) || 0);
        merged.set(name, {
            ...previous,
            ...raw,
            name,
            title:String(raw.title || previous.title || name.replace(/\.json$/i, '')).trim(),
            field_count:fieldCount,
            fields:Array.isArray(fields) ? fields : [],
            app_id:String(raw.id || raw.app_id || previous.app_id || '').trim(),
            entry_type:isApp ? 'app' : (previous.entry_type || 'workflow'),
            source_kind:isApp ? 'app-library' : (previous.source_kind || 'workflow-library'),
            readiness,
        });
    };
    (Array.isArray(workflows) ? workflows : []).forEach(item => add(item, 'workflow'));
    (Array.isArray(appEntries) ? appEntries : []).forEach(item => add(item, 'app'));
    return [...merged.values()].sort((a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name), 'zh-CN'));
}
function renderComfyUiWorkflowCatalog(){
    if(!comfyuiWorkflowList) return;
    const list = Array.isArray(comfyuiWorkflowCatalog) ? comfyuiWorkflowCatalog : [];
    if(!list.length){
        comfyuiWorkflowList.innerHTML = '<div class="comfyui-workflow-empty">暂未发现本地工作流。请先在 ComfyUI 工作台导入或配置工作流，然后点击“刷新”。</div>';
        return;
    }
    comfyuiWorkflowList.innerHTML = list.map(item => {
        const name = String(item?.name || '').trim();
        const title = String(item?.title || name.replace(/\.json$/i, '') || '未命名工作流').trim();
        const fieldCount = Math.max(0, Number(item?.field_count || 0));
        const configured = fieldCount > 0;
        const canRun = item?.readiness?.can_run !== false && item?.workflow_status !== 'conversion_failed';
        const statusLabel = canRun ? (configured ? `已配置 ${fieldCount} 个参数` : '可运行，未配置可编辑参数') : (item?.readiness?.summary || '工作流需要检查');
        return `<article class="comfyui-workflow-card">
            <div class="comfyui-workflow-card-icon"><i data-lucide="workflow"></i></div>
            <div class="comfyui-workflow-card-main">
                <div class="comfyui-workflow-card-title">${escapeHtml(title)}</div>
                <div class="comfyui-workflow-card-name">${escapeHtml(name)}</div>
                <div class="comfyui-workflow-card-meta"><span class="comfyui-workflow-badge ${canRun ? 'is-ready' : ''}">${escapeHtml(statusLabel)}</span><span>独立 ComfyUI 节点</span></div>
            </div>
            <div class="comfyui-workflow-card-actions">
                <button class="action-btn comfyui-workflow-action" type="button" onclick="openComfyWorkflowLibrary('${escapeAttr(name)}')"><i data-lucide="settings-2" class="w-3.5 h-3.5"></i><span>配置字段</span></button>
                <button class="action-btn primary-btn comfyui-workflow-action" type="button" onclick="sendComfyWorkflowToCanvas('${escapeAttr(name)}')"><i data-lucide="plus" class="w-3.5 h-3.5"></i><span>添加到画布</span></button>
            </div>
        </article>`;
    }).join('');
    refreshIcons();
}
function renderComfyUiInstances(){
    if(!comfyuiInstancesList) return;
    if(!comfyuiInstances.length){
        comfyuiInstancesList.innerHTML = '<div class="comfyui-workflow-empty">还没有配置 ComfyUI 后端地址。</div>';
        return;
    }
    comfyuiInstancesList.innerHTML = comfyuiInstances.map((address, index) => `
        <div class="comfyui-instance-row">
            <span class="comfyui-instance-index">${index + 1}</span>
            <input class="comfyui-instance-input" type="text" value="${escapeAttr(address)}" placeholder="127.0.0.1:8188" oninput="updateComfyUiInstance(${index}, this.value)">
            <button class="comfyui-instance-remove" type="button" onclick="removeComfyUiInstance(${index})" title="删除"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </div>
    `).join('');
    refreshIcons();
}
function addComfyUiInstance(){
    comfyuiInstances = [...comfyuiInstances, ''];
    renderComfyUiInstances();
}
function updateComfyUiInstance(index, value){
    if(index < 0 || index >= comfyuiInstances.length) return;
    comfyuiInstances[index] = value;
}
function removeComfyUiInstance(index){
    comfyuiInstances = comfyuiInstances.filter((_, i) => i !== index);
    renderComfyUiInstances();
}
function setComfyUiStatus(text, kind=''){
    if(!comfyuiInstanceStatus) return;
    comfyuiInstanceStatus.textContent = String(text || '');
    comfyuiInstanceStatus.className = `comfyui-status ${kind}`.trim();
}
async function saveComfyUiSettings(){
    const cleaned = comfyuiInstances.map(value => String(value || '').trim()).filter(Boolean);
    if(!cleaned.length){
        setComfyUiStatus('请至少保留一个 ComfyUI 后端地址', 'bad');
        return false;
    }
    setComfyUiStatus('保存中…', 'loading');
    try {
        const response = await fetch('/api/comfyui/instances', {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({instances:cleaned})
        });
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || '保存 ComfyUI 后端地址失败');
        comfyuiInstances = Array.isArray(data.instances) ? data.instances : cleaned;
        renderComfyUiInstances();
        setComfyUiStatus('ComfyUI 后端地址已保存', 'ok');
        broadcastStudioApiChange('comfy-instances-changed');
        renderProviderList();
        return true;
    } catch(error) {
        setComfyUiStatus(error.message || '保存 ComfyUI 后端地址失败', 'bad');
        return false;
    }
}
async function loadComfyUiCatalog(showStatus=false){
    if(showStatus && comfyuiWorkflowStatus) comfyuiWorkflowStatus.textContent = '正在刷新本地 ComfyUI…';
    try {
        const [instanceResult, workflowResult, appResult] = await Promise.all([
            fetch('/api/comfyui/instances', {cache:'no-store'}).then(async response => {
                const data = await response.json().catch(() => ({}));
                if(!response.ok) throw new Error(data.detail || '读取 ComfyUI 后端地址失败');
                return data;
            }),
            fetch('/api/workflows', {cache:'no-store'}).then(async response => {
                const data = await response.json().catch(() => ({}));
                if(!response.ok) throw new Error(data.detail || '读取本地工作流失败');
                return data;
            }),
            fetch('/api/comfy-apps/catalog', {cache:'no-store'}).then(async response => {
                if(!response.ok) return {entries:[]};
                return response.json().catch(() => ({}));
            }).catch(() => ({entries:[]})),
        ]);
        comfyuiInstances = Array.isArray(instanceResult.instances) ? instanceResult.instances : [];
        const appEntries = Array.isArray(appResult.entries) ? appResult.entries : (Array.isArray(appResult.apps) ? appResult.apps : []);
        comfyuiWorkflowCatalog = mergeComfyUiWorkflowCatalog(
            Array.isArray(workflowResult.workflows) ? workflowResult.workflows : [],
            appEntries
        );
        renderComfyUiInstances();
        renderComfyUiWorkflowCatalog();
        if(comfyuiWorkflowStatus) comfyuiWorkflowStatus.textContent = `已发现 ${comfyuiWorkflowCatalog.length} 个工作流`;
        renderProviderList();
        return true;
    } catch(error) {
        comfyuiWorkflowCatalog = [];
        renderComfyUiInstances();
        renderComfyUiWorkflowCatalog();
        if(comfyuiWorkflowStatus) comfyuiWorkflowStatus.textContent = error.message || '读取本地 ComfyUI 失败，请检查服务是否启动。';
        renderProviderList();
        return false;
    }
}
function sendComfyWorkflowToCanvas(workflowName){
    const name = String(workflowName || '').trim();
    if(!name) return;
    const item = comfyuiWorkflowCatalog.find(entry => entry.name === name) || {};
    const payload = {
        workflow_ref:name,
        workflow_title:String(item.title || name.replace(/\.json$/i, '')).trim(),
        workflow_description:String(item.description || '').trim(),
        workflow_source:'workflow-library',
        fields:Array.isArray(item.fields) ? item.fields : [],
        readiness:item.readiness && typeof item.readiness === 'object' ? item.readiness : {},
        queued_at:Date.now()
    };
    try { localStorage.setItem('comfy_canvas_workflow_inbox_v1', JSON.stringify(payload)); } catch(e) {}
    try {
        const target = window.parent && window.parent !== window ? window.parent : window.top;
        target?.postMessage({type:'comfy-workflow-to-canvas', payload}, '*');
    } catch(e) {}
}
function openComfyWorkflowLibrary(workflowName=''){
    if(window.parent && window.parent !== window){
        const name = String(workflowName || '').trim();
        window.parent.postMessage(name ? {type:'open-comfyui-workflow-settings', workflowName:name} : {type:'open-comfyui'}, '*');
        return;
    }
    const name = String(workflowName || '').trim();
    window.location.href = name
        ? `/static/comfyui-settings.html?workflow=${encodeURIComponent(name)}`
        : '/static/comfyui.html';
}
function openRecommendApi(){
    syncEditor();
    recommendInlineOpen = true;
    syncRecommendView();
    renderRecommendApi();
    loadCustomRecommendedApis();
}
function closeRecommendApi(){
    if(recommendApiOverlay) recommendApiOverlay.style.display = 'none';
    recommendInlineOpen = false;
    syncRecommendView();
    renderRecommendApi();
    renderEditor();
}
function syncRecommendView(){
    if(settingsContent) settingsContent.hidden = recommendInlineOpen;
    if(recommendContent) recommendContent.hidden = !recommendInlineOpen;
    const recommendTitle = recommendContent?.querySelector('.editor-title');
    const recommendSub = recommendContent?.querySelector('.editor-sub');
    if(recommendTitle) recommendTitle.textContent = tr('api.recommendPanelTitle');
    if(recommendSub) recommendSub.textContent = tr('api.recommendPanelSub');
    document.body.classList.toggle('show-recommend-mode', recommendInlineOpen);
}
(function bindWebSearchSettings(){
    const dialog = document.getElementById('webSearchDialog');
    const open = document.getElementById('openWebSearch');
    const close = document.getElementById('closeWebSearch');
    const form = document.getElementById('webSearchForm');
    const provider = document.getElementById('webSearchProvider');
    const activeLabel = document.getElementById('webSearchActiveProvider');
    const keyLink = document.getElementById('webSearchKeyLink');
    const input = document.getElementById('webSearchKey');
    const state = document.getElementById('webSearchState');
    const notice = document.getElementById('webSearchNotice');
    const save = document.getElementById('saveWebSearch');
    const test = document.getElementById('testWebSearch');
    const clear = document.getElementById('clearWebSearch');
    let busy = false;
    let settings = null;
    const name = value => Array.from(provider.options).find(option => option.value === value)?.textContent;

    function syncControls(){
        const hasKey = settings?.has_keys[provider.value] === true;
        const draft = input.value.trim();
        const canActivate = hasKey && settings.provider !== provider.value;
        close.disabled = busy;
        provider.disabled = input.disabled = clear.disabled = busy || !settings;
        input.placeholder = hasKey ? '••••••••' : '';
        save.disabled = busy || !settings || (!draft && !canActivate);
        save.dataset.i18n = canActivate && !draft ? 'api.webSearchActivate' : 'api.save';
        save.textContent = tr(save.dataset.i18n);
        test.disabled = busy || !settings || (!hasKey && !draft);
        clear.hidden = !hasKey;
        keyLink.href = provider.selectedOptions[0].dataset.keyUrl;
        activeLabel.textContent = settings ? trf('api.webSearchActiveProvider',{name:name(settings.provider)}) : '';
        state.dataset.i18n = settings ? (hasKey ? 'api.keyProfileSavedStatus' : 'api.keyProfileMissingStatus') : '';
        state.textContent = state.dataset.i18n ? tr(state.dataset.i18n) : '';
    }
    async function update(method, testing=false){
        if(busy) return;
        busy = true;
        notice.textContent = tr('api.keyProfileWorking');
        notice.classList.remove('recommendation-error');
        syncControls();
        try {
            const path = '/api/search-settings' + (method === 'GET' ? '' : '/' + provider.value + (testing ? '/test' : ''));
            const response = await fetch(path, {
                method,cache:'no-store',
                ...(method === 'PUT' || testing ? {
                    headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({api_key:input.value.trim()})
                } : {})
            });
            const result = await response.json().catch(() => ({}));
            if(!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '');
            if(testing){
                if(result.ok !== true) throw new Error();
                notice.textContent = trf('api.webSearchConnected',{name:name(provider.value)});
            } else {
                if(!result.has_keys || !name(result.provider)) throw new Error();
                settings = result;
                if(method === 'GET') provider.value = settings.provider;
                input.value = '';
                notice.textContent = method === 'PUT' ? tr('api.saved') : '';
            }
        } catch(error) {
            notice.classList.add('recommendation-error');
            notice.textContent = error.message || tr('api.webSearchRequestFailed');
        } finally {
            busy = false;
            syncControls();
            if(method === 'GET' && dialog.open) (settings ? provider : close).focus();
        }
    }
    open.addEventListener('click', () => {
        settings = null;
        dialog.showModal();
        void update('GET');
    });
    dialog.addEventListener('cancel', event => { if(busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { input.value = ''; });
    provider.addEventListener('change', () => {
        input.value = '';
        notice.textContent = '';
        syncControls();
        input.focus();
    });
    window.addEventListener('studio-lang-change', () => { if(dialog.open) syncControls(); });
    input.addEventListener('input', syncControls);
    form.addEventListener('submit', event => {
        event.preventDefault();
        if(!save.disabled) void update('PUT');
    });
    test.addEventListener('click', () => { void update('POST',true); });
    clear.addEventListener('click', () => {
        if(window.confirm(trf('api.webSearchConfirmRemove',{name:name(provider.value)}))) void update('DELETE');
    });
})();
let recommendFilter = 'all';
const RECOMMEND_FILTERS = ['all', 'pending', 'ready'];
// 筛选会把未配置的行整段重画，正在输入的 Key 先记在这里，切回来不会丢。
const recommendKeyDrafts = new Map();
function rememberRecommendKey(id, value){
    if(!id) return;
    if(value) recommendKeyDrafts.set(id, value);
    else recommendKeyDrafts.delete(id);
}
function setRecommendFilter(key){
    if(!RECOMMEND_FILTERS.includes(key) || key === recommendFilter) return;
    const restoreFocus = recommendPanel?.querySelector('.rec-filter:focus') != null;
    recommendFilter = key;
    renderRecommendationsKeepingKeys()();
    if(restoreFocus) recommendPanel?.querySelector(`.rec-filter[data-filter="${key}"]`)?.focus({preventScroll:true});
}
function recommendHasSavedKey(api){
    return Boolean(api.existingProviderId && api.has_key);
}
// 平台地址收敛成「站点 + 路径」，列表里比整条 https:// 更好扫读。
function recommendHostText(value){
    const raw = String(value || '').trim();
    if(!raw) return '';
    try {
        const url = new URL(raw);
        if(!['http:', 'https:'].includes(url.protocol)) return raw;
        return `${url.host}${url.pathname.replace(/\/+$/, '')}`;
    } catch(_) { return raw; }
}
function providerHostText(item){
    const raw = String(item?.base_url || '').trim();
    if(!raw) return '未配置地址';
    return recommendHostText(raw) || raw;
}
// 平台图标：有站点 favicon 就显示图片，取不到时退回首字母色块（比通用链条图标更容易区分）。
function recommendIconHtml(api){
    const name = String(api?.name || '').trim();
    const letter = (Array.from(name)[0] || '?').toUpperCase();
    let hue = 0;
    for(const ch of name) hue = (hue * 31 + (ch.codePointAt(0) || 0)) % 360;
    const src = providerIconSrc({base_url:api?.base_url, name});
    const usable = src && !providerIconFailed.has(src);
    const loaded = usable && providerIconLoaded.has(src) ? ' is-loaded' : '';
    return `<span class="rec-icon" style="--rec-hue:${hue}">${
        usable
            ? `<img class="rec-icon-img${loaded}" src="${escapeAttr(src)}" alt="" data-icon-src="${escapeAttr(src)}" onload="markProviderFaviconLoaded(this)" onerror="markProviderFaviconFailed(this)">`
            : ''
    }<span class="rec-icon-letter" aria-hidden="true">${escapeHtml(letter)}</span></span>`;
}
function recommendRowClick(event, index){
    if(event?.target?.closest?.('a,button,input,textarea,select,label')) return;
    const api = getRecommendedApis()[index];
    if(api?.existingProviderId){
        openRecommendedProvider(index);
        return;
    }
    const input = recommendPanel?.querySelector(`[data-recommend-key="${index}"]`);
    if(input){
        input.focus();
        input.scrollIntoView({block:'nearest', inline:'nearest'});
    }
}
function renderRecommendApi(){
    if(!recommendPanel) return;
    if(!recommendInlineOpen){
        recommendPanel.innerHTML = '';
        return;
    }
    const recommendProtocolBadge = api => api.id === 'runninghub' || api.protocol === 'runninghub'
        ? 'RH'
        : api.protocol === 'apimart'
        ? 'APIMart'
        : api.protocol === 'gemini' ? 'Gemini' : api.protocol === 'volcengine' ? 'Ark' : 'OpenAI';
    const recommendRowHtml = (api, index) => {
        const ready = Boolean(api.existingProviderId);
        const off = ready && api.enabled === false;
        const hasKey = recommendHasSavedKey(api);
        const stateClass = off ? 'is-off' : hasKey ? 'is-ready' : 'is-pending';
        const stateText = off ? tr('api.recommendationDisabled') : hasKey ? tr('api.recommendStateReady') : ready ? tr('api.recommendationKeyMissing') : tr('api.recommendStatePending');
        const perks = api.perks || (api.perkKey ? [{key:api.perkKey, className:api.perkClass || ''}] : []);
        const kinds = api.tagKeys || [];
        const desc = ready ? '' : String(api.summaryKey ? tr(api.summaryKey) : (api.summary || '')).trim();
        const host = recommendHostText(api.base_url);
        const keyLinks = api.register_url_cn
            ? `<a class="rec-btn rec-btn-ghost" href="${escapeAttr(api.register_url)}" target="_blank" rel="noopener noreferrer" onclick="openExternalWebPage(event, this.href)"><i data-lucide="key-round" class="w-3.5 h-3.5"></i><span>${escapeHtml(tr('api.getKeyGlobal'))}</span></a>
               <a class="rec-btn rec-btn-ghost" href="${escapeAttr(api.register_url_cn)}" target="_blank" rel="noopener noreferrer" onclick="openExternalWebPage(event, this.href)"><i data-lucide="key-round" class="w-3.5 h-3.5"></i><span>${escapeHtml(tr('api.getKeyCn'))}</span></a>`
            : `<a class="rec-btn rec-btn-ghost" href="${escapeAttr(api.register_url || api.base_url)}" target="_blank" rel="noopener noreferrer" onclick="openExternalWebPage(event, this.href)"><i data-lucide="key-round" class="w-3.5 h-3.5"></i><span>${escapeHtml(tr('api.getKey'))}</span></a>`;
        return `
        <div class="rec-row ${stateClass}" style="--recommend-index:${index}" onclick="recommendRowClick(event, ${index})">
            ${recommendIconHtml(api)}
            <div class="rec-main">
                <div class="rec-title">
                    <span class="rec-name" title="${escapeAttr(api.name)}">${escapeHtml(api.name)}</span>
                    <span class="rec-proto">${escapeHtml(recommendProtocolBadge(api))}</span>
                    ${perks.map(perk => `<span class="rec-perk ${escapeAttr(perk.className || '')}"><i data-lucide="gift" class="w-3 h-3"></i><span>${escapeHtml(tr(perk.key))}</span></span>`).join('')}
                    ${api.custom ? `<span class="rec-custom-actions">
                        <button type="button" class="rec-icon-btn" onclick="openRecommendationEditor('${escapeAttr(api.id)}')" aria-label="${escapeAttr(tr('api.editRecommendation'))}" title="${escapeAttr(tr('api.editRecommendation'))}"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                        <button type="button" class="rec-icon-btn is-danger" onclick="removeCustomRecommendation('${escapeAttr(api.id)}')" aria-label="${escapeAttr(tr('api.removeRecommendation'))}" title="${escapeAttr(tr('api.removeRecommendation'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </span>` : ''}
                </div>
                <div class="rec-meta">
                    <span class="rec-host" title="${escapeAttr(api.base_url || '')}">${escapeHtml(host || '—')}</span>
                </div>
                ${desc ? `<div class="rec-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            <div class="rec-capabilities">
                ${kinds.length ? `<span class="rec-kinds">${kinds.map(tag => `<span class="rec-kind${tag === 'api.tagSeedance' ? ' is-seedance' : ''}">${escapeHtml(tr(tag))}</span>`).join('')}</span>` : `<span class="rec-models-empty">${escapeHtml(tr('api.recommendModelsNotFetched'))}</span>`}
            </div>
            <div class="rec-side">
                <span class="rec-state"><i aria-hidden="true"></i>${escapeHtml(stateText)}</span>
                ${ready
                    ? `<button class="rec-btn" type="button" aria-label="${escapeAttr(api.name + ' · ' + tr('api.manageRecommendationProvider'))}" onclick="event.stopPropagation();openRecommendedProvider(${index})"><span>${escapeHtml(tr('api.manageRecommendationProvider'))}</span><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></button>`
                    : keyLinks}
            </div>
            ${ready ? '' : `<div class="rec-setup">
                <label class="rec-key">
                    <input type="password" data-recommend-key="${index}" autocomplete="off" spellcheck="false" value="${escapeAttr(recommendKeyDrafts.get(api.id) || '')}" oninput="rememberRecommendKey('${escapeAttr(api.id)}', this.value)" aria-label="${escapeAttr(trf('api.recommendKeyPlaceholder', {name:api.name}))}" placeholder="${escapeAttr(trf('api.recommendKeyPlaceholder', {name:api.name}))}">
                </label>
                <button class="rec-btn rec-btn-primary" type="button" onclick="event.stopPropagation();saveRecommendedApi(${index})"><span>${escapeHtml(tr('api.save'))}</span></button>
            </div>`}
        </div>`;
    };
    const all = getRecommendedApis();
    const readyCount = all.filter(recommendHasSavedKey).length;
    const pendingCount = all.length - readyCount;
    const visible = all
        .map((api, index) => ({api, index}))
        .filter(({api}) => recommendFilter === 'ready' ? recommendHasSavedKey(api)
            : recommendFilter === 'pending' ? !recommendHasSavedKey(api) : true);
    // 只有一个分组时不再画分组标题，避免「推荐API / 平台注册 / 全部可用」三层标题叠在一起。
    const multiGroup = new Set(all.map(api => api.category || 'cheap')).size > 1;
    let rows = '';
    let lastCategory = '';
    visible.forEach(({api, index}) => {
        const category = api.category || 'cheap';
        if(multiGroup && category !== lastCategory){
            const group = RECOMMEND_GROUPS.find(item => item.key === category);
            if(group) rows += `<div class="rec-group-head rec-group-${escapeAttr(group.key)}"><i data-lucide="${escapeAttr(group.icon)}" class="w-3.5 h-3.5"></i><span>${escapeHtml(tr(group.titleKey))}</span></div>`;
            lastCategory = category;
        }
        rows += recommendRowHtml(api, index);
    });
    const filterBtn = (key, label, count) => `<button type="button" data-filter="${key}" class="rec-filter${recommendFilter === key ? ' is-active' : ''}" aria-pressed="${recommendFilter === key}" onclick="setRecommendFilter('${key}')">${escapeHtml(label)}<b>${count}</b></button>`;
    recommendPanel.innerHTML = `
        <div class="rec-head">
            <div class="rec-head-text">
                <div class="rec-head-title">${escapeHtml(tr('api.recommendPanelTitle'))}</div>
                <div class="rec-head-sub">${escapeHtml(tr('api.recommendPanelSub'))}</div>
            </div>
            <div class="rec-filters" role="group" aria-label="${escapeAttr(tr('api.recommendFilterLabel'))}">
                ${filterBtn('all', tr('api.recommendFilterAll'), all.length)}
                ${filterBtn('pending', tr('api.recommendFilterPending'), pendingCount)}
                ${filterBtn('ready', tr('api.recommendFilterReady'), readyCount)}
            </div>
        </div>
        <div class="rec-columns" aria-hidden="true">
            <span>${escapeHtml(tr('api.recommendColumnProvider'))}</span>
            <span>${escapeHtml(tr('api.recommendationKinds'))}</span>
            <span>${escapeHtml(tr('api.recommendColumnActions'))}</span>
        </div>
        <div class="rec-list">
            ${rows || `<div class="rec-empty">${escapeHtml(tr(recommendFilter === 'pending' ? 'api.recommendEmptyPending' : 'api.recommendEmptyReady'))}</div>`}
            ${recommendationAddCardHtml()}
        </div>
        <div class="rec-note"><i data-lucide="info" aria-hidden="true"></i><span>${escapeHtml(tr('api.recommendApiNote'))}</span></div>
    `;
    refreshIcons();
}
function recommendedProviderForApi(api){
    let item = providers.find(provider =>
        (api.id && String(provider.id || '').toLowerCase() === String(api.id).toLowerCase())
        || (api.custom && String(provider.base_url || '').replace(/\/+$/, '').toLowerCase() === api.base_url.replace(/\/+$/, '').toLowerCase())
        || (!api.custom && String(provider.name || '').toLowerCase() === api.name.toLowerCase())
    );
    if(item){
        item.base_url = api.base_url || item.base_url || '';
        item.protocol = api.protocol || item.protocol || 'openai';
        item.image_request_mode = normalizeImageRequestMode(api.image_request_mode || item.image_request_mode);
        item.image_edit_route = normalizeImageEditRoute(api.image_edit_route || item.image_edit_route);
        if(Array.isArray(api.video_models)) item.video_models = [...api.video_models];
        if(api.empty_models_on_save){
            item.image_models = [];
            item.chat_models = [];
            item.video_models = [];
            item.model_protocols = {};
        }
        return item;
    }
    const baseId = api.custom ? newProviderId({id:'custom-api', _idDraft:true}, api.name, api.base_url) : normalizeId(api.id || api.name) || 'custom-api';
    let id = baseId;
    let suffix = 2;
    while(providers.some(provider => provider.id === id)) id = `${baseId}-${suffix++}`;
    item = {
        id,
        name:api.name,
        base_url:api.base_url,
        protocol:api.protocol,
        image_request_mode:normalizeImageRequestMode(api.image_request_mode),
        image_edit_route:normalizeImageEditRoute(api.image_edit_route),
        image_generation_endpoint:'',
        image_edit_endpoint:'',
        enabled:true,
        primary:false,
        image_models:api.empty_models_on_save ? [] : (Array.isArray(api.image_models) ? [...api.image_models] : []),
        chat_models:api.empty_models_on_save ? [] : (Array.isArray(api.chat_models) ? [...api.chat_models] : []),
        video_models:api.empty_models_on_save ? [] : (Array.isArray(api.video_models) ? [...api.video_models] : []),
        model_protocols:api.empty_models_on_save ? {} : ((api.model_protocols && typeof api.model_protocols === 'object') ? {...api.model_protocols} : {}),
        has_key:false,
        key_preview:''
    };
    providers.push(item);
    return item;
}
async function saveRecommendedApi(index){
    const api = getRecommendedApis()[index];
    if(!api) return;
    const input = recommendPanel?.querySelector(`[data-recommend-key="${index}"]`);
    const key = input?.value.trim() || '';
    if(!key){ alert(tr('api.enterApiKey')); return; }
    while(keyProfiles.busy()) await keyProfiles.settled();
    const previousProviders = structuredClone(providers);
    const previousSelectedId = selectedId;
    rememberRecommendKey(api.id, key);
    const finishSave = ok => {
        if(ok){
            recommendKeyDrafts.delete(api.id);
            setStatus(trf('api.recommendSaved', {name:api.name}));
            return;
        }
        providers = previousProviders;
        selectedId = previousSelectedId;
        recommendInlineOpen = true;
        syncRecommendView();
        renderProviderList();
        renderEditor();
    };
    const item = recommendedProviderForApi(api);
    if(api.id === 'runninghub'){
        // RunningHub 只恢复到推荐卡片，不重新加入左侧平台列表。
        // 这里直接写入隐藏的兼容 provider，避免 provider() 因界面过滤而取不到它。
        item.base_url = RH_DEFAULT_BASE_URL;
        item.protocol = 'runninghub';
        item.enabled = true;
        item.api_key = key;
        item.image_request_mode = 'openai';
        item.image_edit_route = 'general';
        item.image_models = unique(item.image_models || []);
        item.chat_models = unique(item.chat_models || []);
        item.video_models = unique(item.video_models || []);
        recommendInlineOpen = false;
        syncRecommendView();
        const ok = await saveProviders();
        finishSave(ok);
        return;
    }
    selectedId = item.id;
    recommendInlineOpen = false;
    syncRecommendView();
    renderProviderList();
    renderEditor();
    keyInput.value = key;
    if(protocolInput){
        protocolInput.value = api.protocol;
        protocolInput.dispatchEvent(new Event('change'));
    }
    if(imageRequestModeInput){
        imageRequestModeInput.value = normalizeImageRequestMode(api.image_request_mode);
        imageRequestModeInput.dispatchEvent(new Event('change'));
    }
    syncEditor();
    const ok = await saveProviders();
    finishSave(ok);
}
function sortedProviders(){
    const order = ['api-6789', 'comfly', 'volcengine'];
    return visibleProviders().sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        if(ai === -1 && bi === -1) return 0;
        if(ai === -1) return 1;
        if(bi === -1) return -1;
        return ai - bi;
    });
}
function cliKindForProvider(item){
    const protocol = String(item?.protocol || '').trim().toLowerCase();
    return CLI_PROTOCOLS.has(protocol) ? protocol : '';
}
function cliSidebarInstallState(state){
    if(state?.installing) return {label:'安装中', className:'checking'};
    if(state?.installed === true) return {label:'已安装', className:'installed'};
    if(state?.installed === false) return {label:'未安装', className:'missing'};
    return {label:'检测中', className:'checking'};
}
function cliSidebarUpdateState(state){
    if(state?.installing) return {label:'安装中', className:'checking'};
    if(state?.checking) return {label:'检查中', className:'checking'};
    if(!state?.checked) return {label:'未检查更新', className:'unknown'};
    if(state.updateAvailable === true) return {label:'有新版本', className:'update'};
    if(state.updateAvailable === false && state.currentVersion) return {label:'最新版本', className:'latest'};
    if(state.installed === false && state.latestVersion) return {label:`可安装 ${state.latestVersion}`, className:'update'};
    if(state.installed === true && !state.currentVersion) return {label:'无法确认', className:'unknown'};
    return {label:'无法确认更新', className:'unknown'};
}
function cliProviderDetails(kind){
    const state = cliSidebarState[kind] || {};
    const install = cliSidebarInstallState(state);
    const update = cliSidebarUpdateState(state);
    const current = state.currentVersion;
    const latest = state.latestVersion;
    const versions = [current && "当前版本：" + current, latest && "最新版本：" + latest];
    const title = [state.installMessage, state.message, ...versions].filter(Boolean).join("；");
    return {
        kind, install, update,
        title: title || (install.label + "，" + update.label),
        version: current || (latest ? "最新 " + latest : ""),
    };
}

const providerIconLoaded = new Set();
const providerIconFailed = new Set();
function providerIconSrc(item){
    const baseUrl = String(item?.base_url || '').trim();
    if(!/^https?:\/\//i.test(baseUrl)) return '';
    // name 只用于站点自己没有 favicon 时按品牌官网补图标，缓存仍按站点来源。
    const name = String(item?.name || '').trim();
    const suffix = name ? `&name=${encodeURIComponent(name)}` : '';
    return `/api/provider-icon?url=${encodeURIComponent(baseUrl)}${suffix}`;
}
function markProviderFaviconLoaded(img){
    if(!img) return;
    const src = img.dataset.iconSrc || img.getAttribute('src') || '';
    if(providerIconFailed.has(src)){ img.classList.remove('is-loaded'); return; }
    if(src) providerIconLoaded.add(src);
    img.classList.add('is-loaded');
}
function markProviderFaviconFailed(img){
    if(!img) return;
    const src = img.dataset.iconSrc || img.getAttribute('src') || '';
    if(src){ providerIconFailed.add(src); providerIconLoaded.delete(src); }
    img.dataset.failed = '1';
    img.classList.remove('is-loaded');
}
// 拉取模型成功说明站点可达：允许重新请求一次之前失败的图标。
function resetProviderIcon(item){
    const src = providerIconSrc(item);
    if(!src) return;
    providerIconFailed.delete(src);
    providerIconLoaded.delete(src);
}
function renderProviderList(){
    const entries = sortedProviders().map(item => {
        const kind = cliKindForProvider(item);
        const configured = item.has_key || item.has_wallet_key || kind;
        return {
            id: item.id,
            name: item.name || item.id,
            protocol: String(item.protocol || 'openai').toUpperCase(),
            selected: item.id === selectedId,
            sortable: !isFixedProvider(item),
            status: item.enabled === false ? 'is-disabled' : configured ? 'has-key' : 'missing-key',
            address: item.base_url || '',
            host: providerHostText(item),
            icon: kind ? '' : providerIconSrc(item),
            cli: kind ? cliProviderDetails(kind) : null,
        };
    });
    ApiSettingsNavigation.render(providerList, document.getElementById('providerCount'), entries, {
        select: selectProvider,
        dragStart: handleProviderDragStart,
        dragOver: handleProviderDragOver,
        drop: handleProviderDrop,
        dragEnd: handleProviderDragEnd,
    }, {
        loaded: providerIconLoaded,
        failed: providerIconFailed,
        onLoad: markProviderFaviconLoaded,
        onError: markProviderFaviconFailed,
    });
    refreshIcons();
}
function handleProviderDragStart(event, id){
    const item = providers.find(provider => provider.id === id);
    if(!item || isFixedProvider(item)){
        event.preventDefault();
        return;
    }
    providerDragId = id;
    event.currentTarget.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
}
function handleProviderDragOver(event, id){
    if(!providerDragId || providerDragId === id || isFixedProvider(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    providerList?.querySelectorAll('.provider-card-drop-target').forEach(el => el.classList.remove('provider-card-drop-target'));
    event.currentTarget.classList.add('provider-card-drop-target');
}
function handleProviderDrop(event, targetId){
    event.preventDefault();
    providerList?.querySelectorAll('.provider-card-drop-target').forEach(el => el.classList.remove('provider-card-drop-target'));
    const sourceId = providerDragId || event.dataTransfer.getData('text/plain');
    providerDragId = '';
    if(!sourceId || sourceId === targetId || isFixedProvider(sourceId) || isFixedProvider(targetId)) return;
    const sourceIndex = providers.findIndex(item => item.id === sourceId);
    const targetIndex = providers.findIndex(item => item.id === targetId);
    if(sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = providers.splice(sourceIndex, 1);
    const adjustedTargetIndex = providers.findIndex(item => item.id === targetId);
    providers.splice(adjustedTargetIndex, 0, moved);
    renderProviderList();
    markProviderDirty();
    saveProviders();
}
function handleProviderDragEnd(){
    providerDragId = '';
    providerList?.querySelectorAll('.is-dragging,.provider-card-drop-target').forEach(el => {
        el.classList.remove('is-dragging', 'provider-card-drop-target');
    });
}
function renderEditor(){
    const item = provider();
    if(!item) return;
    const isComfyUi = item.id === 'comfyui';
    document.body.classList.remove('show-comfyui', 'show-ms', 'show-volcengine', 'show-volcengine-standalone', 'show-jimeng', 'show-codex', 'show-gemini-cli');
    settingsContent?.classList.toggle('comfyui-selected', isComfyUi);
    if(isComfyUi){
        editorTitle.textContent = 'ComfyUI';
        const editorSub = document.querySelector('#settingsContent .content-head .editor-sub');
        if(editorSub) editorSub.textContent = '配置本地 ComfyUI 后端、工作流设置入口和画布节点';
        document.body.classList.add('show-comfyui');
        if(protocolInput){ protocolInput.value = 'openai'; protocolInput.disabled = true; }
        if(baseInput) baseInput.value = '';
        if(keyInput) keyInput.value = '';
        if(comfyuiConfigBlock){ comfyuiConfigBlock.hidden = false; comfyuiConfigBlock.style.display = 'flex'; }
        const deleteBtn = document.getElementById('deleteBtn');
        if(deleteBtn) deleteBtn.style.display = 'none';
        renderComfyUiInstances();
        renderComfyUiWorkflowCatalog();
        renderProviderList();
        return;
    }
    if(comfyuiConfigBlock){ comfyuiConfigBlock.hidden = true; comfyuiConfigBlock.style.display = 'none'; }
    const editorSub = document.querySelector('#settingsContent .content-head .editor-sub');
    if(editorSub) editorSub.textContent = tr('api.editorSub');
    const pendingKeyProfileKey = keyProfiles.editing(item) ? keyInput.value : '';
    editorTitle.textContent = item.name || item.id;
    nameInput.value = item.name || '';
    idInput.value = item.id || '';
    clearVerifyResult();
    baseInput.placeholder = EXAMPLE_BASE_URL;
    baseInput.value = item.base_url || '';
    updateIdPreview();
    const lockedApi = lockedRecommendedApi(item);
    if(lockedApi) applyLockedRecommendedProtocol(item);
    if(protocolInput){
        protocolInput.value = item.id === 'runninghub' ? 'runninghub' : item.id === 'volcengine' ? 'volcengine' : (item.protocol || 'openai');
        protocolInput.disabled = FIXED_PROTOCOL_PROVIDER_IDS.has(item.id) || Boolean(lockedApi);
        protocolInput.title = lockedApi ? '推荐平台使用固定协议' : (protocolInput.disabled ? '内置平台使用固定协议' : '');
    }
    if(imageRequestModeInput){
        imageRequestModeInput.value = normalizeImageRequestMode(item.image_request_mode);
        imageRequestModeInput.disabled = Boolean(lockedApi) || item.id === 'runninghub' || item.id === 'volcengine' || CLI_PROTOCOLS.has(String(protocolInput?.value || item.protocol || '').toLowerCase());
        imageRequestModeInput.title = lockedApi ? '推荐平台使用固定图片协议' : '';
    }
    if(imageEditRouteInput){
        imageEditRouteInput.value = normalizeImageEditRoute(item.image_edit_route);
        imageEditRouteInput.disabled = item.id === 'runninghub' || item.id === 'volcengine' || CLI_PROTOCOLS.has(String(protocolInput?.value || item.protocol || '').toLowerCase());
    }
    keyInput.value = pendingKeyProfileKey;
    keyInput.placeholder = item.has_key ? `${tr('api.keepCurrentKey')} ${item.key_preview || ''}` : tr('api.enterKey');
    keyHint.textContent = item.has_key ? `${tr('api.keySaved')}${item.key_env || 'API/.env'}` : tr('api.noKey');
    const isVolcengine = item.id === 'volcengine' || String(protocolInput?.value || item.protocol || '').toLowerCase() === 'volcengine';
    const isStandaloneVolcengine = item.id === 'volcengine';
    const isJimeng = String(protocolInput?.value || item.protocol || '').toLowerCase() === 'jimeng';
    const isCodex = String(protocolInput?.value || item.protocol || '').toLowerCase() === 'codex';
    const isGeminiCli = String(protocolInput?.value || item.protocol || '').toLowerCase() === 'gemini-cli';
    if(isVolcengine){
        item.base_url = item.base_url || VOLCENGINE_DEFAULT_BASE_URL;
        item.protocol = 'volcengine';
        item.volcengine_project_name = item.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
        item.volcengine_region = item.volcengine_region || VOLCENGINE_DEFAULT_REGION;
        keyInput.placeholder = item.has_key ? `保持当前方舟 API Key ${item.key_preview || ''}` : '输入方舟 API Key';
        keyHint.textContent = volcengineArkKeyHintText(item);
        if(volcArkKeyHint) volcArkKeyHint.textContent = volcengineArkKeyHintText(item);
        if(volcAkInput){
            volcAkInput.value = '';
            volcAkInput.placeholder = item.has_volcengine_access_key ? `保持当前 AK ${item.volcengine_access_key_preview || ''}` : 'Access Key ID';
        }
        if(volcSkInput){
            volcSkInput.value = '';
            volcSkInput.placeholder = item.has_volcengine_secret_key ? `保持当前 SK ${item.volcengine_secret_key_preview || ''}` : 'Secret Access Key';
        }
        if(volcAssetKeyHint) volcAssetKeyHint.textContent = volcengineAssetKeyHintText(item);
        if(volcProjectInput) volcProjectInput.value = item.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
        if(volcRegionInput) volcRegionInput.value = item.volcengine_region || VOLCENGINE_DEFAULT_REGION;
    }
    if(isJimeng){
        item.base_url = '';
        item.protocol = 'jimeng';
        item.image_models = unique([...(item.image_models || []).filter(model => !JIMENG_LEGACY_IMAGE_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_IMAGE_MODELS]);
        item.video_models = unique([...(item.video_models || []).filter(model => !JIMENG_LEGACY_VIDEO_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_VIDEO_MODELS]);
        keyInput.placeholder = '即梦 CLI 使用本机 dreamina login，无需 API Key';
        keyHint.textContent = '请先在终端安装 dreamina CLI，并执行 dreamina login';
    }
    if(isCodex){
        applyCliProtocolDefaults(item, 'codex');
        keyInput.placeholder = 'OpenAI CLI 使用本机 codex login，无需 API Key';
        keyHint.textContent = '请先安装 OpenAI Codex CLI，并执行 codex 登录';
    }
    if(isGeminiCli){
        applyCliProtocolDefaults(item, 'gemini-cli');
        keyInput.placeholder = 'Antigravity CLI 使用本机 agy 登录态，无需 API Key';
        keyHint.textContent = '安装或更新后会打开 agy 终端，请在终端完成登录';
    }
    document.body.classList.toggle('show-volcengine', isVolcengine);
    document.body.classList.toggle('show-volcengine-standalone', isStandaloneVolcengine);
    document.body.classList.toggle('show-jimeng', isJimeng);
    document.body.classList.toggle('show-codex', isCodex);
    document.body.classList.toggle('show-gemini-cli', isGeminiCli);
    keyProfiles.render(item);
    updateApimartDomesticHint(item);
    renderRecommendApi();
    if(jimengCliPanel){
        jimengCliPanel.hidden = !isJimeng;
        jimengCliPanel.style.display = isJimeng ? 'flex' : 'none';
        if(isJimeng){
            refreshJimengStatus(false);
            ensureCliSidebarStatus('jimeng');
        }
    }
    if(codexCliPanel){
        codexCliPanel.hidden = !isCodex;
        codexCliPanel.style.display = isCodex ? 'flex' : 'none';
        if(isCodex){
            refreshCodexStatus(false);
            ensureCliSidebarStatus('codex');
        }
    }
    if(geminiCliPanel){
        geminiCliPanel.hidden = !isGeminiCli;
        geminiCliPanel.style.display = isGeminiCli ? 'flex' : 'none';
        if(isGeminiCli){
            refreshGeminiCliStatus(false);
            ensureCliSidebarStatus('gemini-cli');
        }
    }
    const deleteBtn = document.getElementById('deleteBtn');
    if(deleteBtn) deleteBtn.style.display = isFixedProvider(item) ? 'none' : 'inline-flex';
    const context = modelFetchContext(item);
    if((pendingModelRequest && pendingModelRequest.context !== context) ||
       (modelCatalog && modelCatalog.context !== context)){
        clearFetchedModelState();
    }
    renderModels('image');
    renderModels('chat');
    renderModels('video');
    renderProviderList();
}
function showVerifyResult(html){ const el = document.getElementById('verifyResult'); if(el){ el.style.display = 'block'; el.innerHTML = html; } }
function clearVerifyResult(){ const el = document.getElementById('verifyResult'); if(el){ el.style.display = 'none'; el.innerHTML = ''; } }
function prettyJson(value){
    try { return JSON.stringify(value, null, 2); } catch(_) { return String(value || ''); }
}
function jimengCreditText(raw){
    if(raw === null || raw === undefined || raw === '') return '';
    const parts = [];
    const seen = new Set();
    const labels = {
        total_credit: '当前积分', totalcredit: '当前积分',
        credit: '积分', credits: '积分',
        balance: '余额', quota: '额度',
        gift_credit: '赠送积分', giftcredit: '赠送积分',
        purchase_credit: '购买积分', purchasecredit: '购买积分',
        vip_credit: '会员积分', vipcredit: '会员积分',
        point: '积分', points: '积分', coin: '积分', coins: '积分',
        user_id: '即梦账号', userid: '即梦账号',
    };
    let zeroTotalCredit = false;
    let accountId = '';
    const add = (key, item) => {
        if(item === null || item === undefined || typeof item === 'object') return;
        const normalized = String(key || '').toLowerCase().replace(/[\s-]/g, '_');
        if(normalized === 'user_id' || normalized === 'userid') accountId = String(item);
        if(normalized === 'total_credit' || normalized === 'totalcredit') zeroTotalCredit = Number(item) === 0;
        if(!/credit|balance|quota|point|coin|积分|余额/.test(normalized) && normalized !== 'user_id' && normalized !== 'userid') return;
        const label = labels[normalized] || String(key);
        const text = `${label}：${item}`;
        if(!seen.has(text)){ seen.add(text); parts.push(text); }
    };
    const visit = value => {
        if(value === null || value === undefined) return;
        if(typeof value === 'string'){
            try {
                const parsed = JSON.parse(value);
                if(parsed && typeof parsed === 'object') visit(parsed);
            } catch(_) {}
            return;
        }
        if(typeof value !== 'object') return;
        Object.entries(value).forEach(([key, item]) => {
            add(key, item);
            visit(item);
        });
    };
    visit(raw);
    if(parts.length){
        if(zeroTotalCredit && accountId) parts.push('如网页积分不同，请退出 CLI 后用同一即梦账号重新扫码登录');
        return parts.join(' · ');
    }
    if(raw && typeof raw === 'object' && (raw._stdout || raw.text)){
        return '即梦已返回账户信息，但未识别到积分字段，请查看 CLI 原始输出。';
    }
    return prettyJson(raw);
}
function setJimengStatus(text, ok=null){
    if(!jimengCliStatus) return;
    jimengCliStatus.textContent = text || '未检测';
    jimengCliStatus.classList.toggle('ok', ok === true);
    jimengCliStatus.classList.toggle('bad', ok === false);
}
const cliUpdateViews = {
    jimeng: {result:jimengCliUpdate, button:jimengCliUpdateBtn},
    codex: {result:codexCliUpdate, button:codexCliUpdateBtn},
    'gemini-cli': {result:geminiCliUpdate, button:geminiCliUpdateBtn},
};
const cliStatusActionViews = {
    jimeng: {button:jimengCliAction},
    codex: {button:codexCliStatus},
    'gemini-cli': {button:geminiCliStatus},
};
function cliErrorMessage(error, scope='local'){
    const raw = String(error?.message || error || '').trim();
    const lower = raw.toLowerCase();
    if(/dreamina_cli.*使用权限|使用权限.*dreamina_cli|仅限.*会员|会员等级/.test(lower)){
        return '当前账号有网页积分，但暂未开通即梦 CLI 权限。是否需要额外充值要看官方账号资格；积分和 CLI 权限是两回事，请在即梦官网查看会员权益或 CLI 资格。';
    }
    if(/未检测到有效登录态|登录态无效|未登录|login required|not logged in|unauthorized|authentication required|dreamina login/.test(lower)){
        return '即梦 CLI 当前没有登录成功。请点击“扫码登录”，用与网页端相同的即梦账号完成授权，再点击“查询积分”。';
    }
    if(/failed to fetch|fetch failed|networkerror|network error|econnrefused|connection refused|socket hang up|httpsconnectionpool|connectionerror|proxyerror|newconnectionerror|name or service not known|remote end closed|dns/.test(lower)){
        return scope === 'version'
            ? '无法连接官方版本源，请检查网络后重试。'
            : '无法连接小美画布服务，请确认服务正在运行后重试。';
    }
    if(/timeout|timed out|etimedout/.test(lower)){
        return scope === 'version'
            ? '版本检查超时，请稍后重试。'
            : '服务响应超时，请稍后重试。';
    }
    if(/官方版本源返回|官方版本源没有|无法获取.+最新版本|version source/.test(lower)){
        return '官方版本源暂不可用，请稍后重试。';
    }
    if(/enoent|command not found|not found/.test(lower)) return '未找到 CLI，请先安装。';
    return raw || (scope === 'version' ? '无法获取版本信息，请稍后重试。' : '请求失败，请稍后重试。');
}
function cliVersionMessage(data={}){
    const current = String(data.current_version || '').trim();
    const latest = String(data.latest_version || '').trim();
    if(data.update_available === true && latest){
        return `当前不是最新版：当前 ${current || '未知'}，最新 ${latest}。请点击“安装 / 更新”。`;
    }
    if(data.update_available === false && current){
        const serverMessage = String(data.message || '').trim();
        if(/高于当前官方查询版本/.test(serverMessage)) return serverMessage;
        return `已是最新版本：${current}。`;
    }
    if(data.installed === false && latest){
        return `未安装。可安装版本：${latest}。`;
    }
    if(latest && data.installed === true && !current){
        return `已找到 CLI，但无法识别当前版本。最新版本：${latest}。`;
    }
    const message = String(data.message || '').trim();
    return message ? cliErrorMessage(message, 'version') : (data.ok ? '版本检查完成。' : '无法获取 CLI 版本信息，请稍后重试。');
}
function cliStatusActionState(state={}){
    if(state.installing) return {label:'安装中…', className:'loading', disabled:true, title:'正在安装 CLI，请稍候。'};
    if(state.checking || !state.checked) return {label:'检测中…', className:'loading', disabled:true, title:'正在检查 CLI 版本，请稍候。'};
    if(state.versionError || state.statusError){
        return {label:'检测失败', className:'bad', disabled:true, title:state.versionError || state.statusError};
    }
    if(state.installed === false) return {label:'安装', className:'warning', disabled:false, title:'点击安装 CLI。'};
    if(state.updateAvailable === true) return {label:'更新', className:'warning', disabled:false, title:'点击更新 CLI。'};
    if(state.updateAvailable === false && state.currentVersion){
        return {label:'最新版本', className:'ok', disabled:true, title:`当前为最新版本 ${state.currentVersion}。`};
    }
    if(state.installed === true) return {label:'已安装', className:'ok', disabled:true, title:'CLI 已安装。'};
    return {label:'未检测', className:'loading', disabled:true, title:'尚未检测 CLI 状态。'};
}
function renderCliStatusAction(kind){
    const state = cliSidebarState[kind];
    const actionView = cliStatusActionViews[kind];
    if(!state || !actionView?.button) return;
    const action = cliStatusActionState(state);
    const button = actionView.button;
    button.textContent = action.label;
    button.disabled = action.disabled;
    button.title = action.title;
    button.setAttribute('aria-label', action.label);
    button.setAttribute('aria-busy', String(state.checking || state.installing));
    button.classList.remove('loading', 'ok', 'warning', 'bad');
    if(action.className) button.classList.add(action.className);

    const updateButton = cliUpdateViews[kind]?.button;
    if(updateButton && updateButton !== button){
        updateButton.disabled = state.checking || state.installing;
        updateButton.setAttribute('aria-busy', String(state.checking || state.installing));
    }
}
function setCliUpdateState(kind, text, state=''){
    const view = cliUpdateViews[kind];
    if(!view?.result) return;
    view.result.textContent = text || '';
    view.result.classList.remove('loading', 'ok', 'warning', 'bad');
    if(['loading', 'ok', 'warning', 'bad'].includes(state)) view.result.classList.add(state);
}
function applyCliSidebarUpdate(kind, data={}){
    const state = cliSidebarState[kind];
    if(!state) return;
    state.checking = false;
    state.checked = true;
    state.versionError = '';
    if(typeof data.installed === 'boolean') state.installed = data.installed;
    state.currentVersion = String(data.current_version || state.currentVersion || '').trim();
    state.latestVersion = String(data.latest_version || '').trim();
    state.updateAvailable = data.update_available === true ? true : data.update_available === false ? false : null;
    state.message = cliVersionMessage(data);
    state.versionError = data.ok === false
        ? cliErrorMessage(data.source_error || data.message || '无法获取官方版本信息，请稍后重试。', 'version')
        : '';
    state.checkedAt = data.checked_at || '';
    state.lastVersionData = data;
    renderCliStatusAction(kind);
    renderProviderList();
}
function refreshCliSidebarStatus(kind){
    const state = cliSidebarState[kind];
    if(!state) return Promise.resolve();
    if(state.checkPromise) return state.checkPromise;
    state.checking = true;
    state.checked = false;
    state.currentVersion = '';
    state.latestVersion = '';
    state.updateAvailable = null;
    state.message = '';
    state.versionError = '';
    renderProviderList();
    renderCliStatusAction(kind);
    const task = (async () => {
        try {
            const response = await fetch(`/api/cli/update-check?kind=${encodeURIComponent(kind)}`, {cache:'no-store'});
            let data = {};
            try { data = await response.json(); } catch(_) {}
            if(!response.ok) throw new Error(data.detail || '检查 CLI 更新失败');
            applyCliSidebarUpdate(kind, data);
        } catch(e){
            state.checking = false;
            state.checked = true;
            state.updateAvailable = null;
            state.versionError = cliErrorMessage(e, 'version');
            state.message = state.versionError;
            renderCliStatusAction(kind);
            renderProviderList();
        }
    })();
    state.checkPromise = task;
    return task.finally(() => {
        if(state.checkPromise === task) state.checkPromise = null;
    });
}
async function refreshCliSidebarStatuses(){
    const kinds = [...new Set((providers || []).map(cliKindForProvider).filter(Boolean))];
    await Promise.all(kinds.map(kind => refreshCliSidebarStatus(kind)));
}
function ensureCliSidebarStatus(kind){
    const state = cliSidebarState[kind];
    if(!state) return Promise.resolve();
    if(state.checked || state.checking) return state.checkPromise || Promise.resolve();
    return refreshCliSidebarStatus(kind);
}
function cliUpdateCheckedAt(value){
    if(!value) return '';
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return '';
    return `检查于 ${date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}`;
}
async function checkCliUpdate(kind){
    const view = cliUpdateViews[kind];
    const state = cliSidebarState[kind];
    if(!view || view.button?.disabled || !state || state.checking || state.installing) return;
    state.checking = true;
    state.checked = false;
    state.currentVersion = '';
    state.latestVersion = '';
    state.updateAvailable = null;
    state.message = '';
    state.versionError = '';
    renderProviderList();
    renderCliStatusAction(kind);
    if(view.button){
        view.button.disabled = true;
        view.button.setAttribute('aria-busy', 'true');
    }
    setCliUpdateState(kind, '检查中，请稍候...', 'loading');
    try {
        const response = await fetch(`/api/cli/update-check?kind=${encodeURIComponent(kind)}`, {cache:'no-store'});
        let data = {};
        try { data = await response.json(); } catch(_) {}
        if(!response.ok) throw new Error(data.detail || '检查更新失败');
        const checkedAt = cliUpdateCheckedAt(data.checked_at);
        const message = cliVersionMessage(data);
        let resultState = 'warning';
        if(data.ok && data.update_available === false && data.current_version) resultState = 'ok';
        if(data.update_available === true) resultState = 'warning';
        if(!data.ok) resultState = 'bad';
        applyCliSidebarUpdate(kind, data);
        setCliUpdateState(kind, checkedAt ? `${message} · ${checkedAt}` : message, resultState);
    } catch(e){
        if(state){
            state.checking = false;
            state.checked = true;
            state.updateAvailable = null;
            state.versionError = cliErrorMessage(e, 'version');
            state.message = state.versionError;
            renderCliStatusAction(kind);
            renderProviderList();
        }
        setCliUpdateState(kind, cliErrorMessage(e, 'version'), 'bad');
    } finally {
        if(state) state.checking = false;
        renderCliStatusAction(kind);
        if(view.button){
            view.button.disabled = false;
            view.button.removeAttribute('aria-busy');
        }
    }
}
const cliInstallViews = {
    codex: {result:codexCliUpdate, path:'/api/codex/install', label:'GPT CLI'},
    jimeng: {result:jimengCliUpdate, path:'/api/jimeng/install', label:'即梦 CLI'},
    'gemini-cli': {result:geminiCliUpdate, path:'/api/gemini-cli/install', label:'Antigravity CLI'},
};
const cliInstallTimers = {};
const cliInstallBusy = {};
function renderCliInstall(kind, data={}){
    const view = cliInstallViews[kind];
    if(!view) return;
    const busy = data.status === 'running';
    cliInstallBusy[kind] = busy;
    const sidebarState = cliSidebarState[kind];
    if(sidebarState){
        sidebarState.installing = busy;
        if(data.message) sidebarState.installMessage = cliErrorMessage(data.message, 'install');
        if(data.log_path) sidebarState.installLog = String(data.log_path);
        if(data.status === 'succeeded') sidebarState.installError = '';
        if(data.status === 'failed') sidebarState.installError = cliErrorMessage(data.message || '安装失败，请重试。', 'install');
    }
    renderCliStatusAction(kind);
    if(view.result){
        const message = [data.message ? cliErrorMessage(data.message, 'install') : '', data.log_path ? `安装日志：${data.log_path}` : ''].filter(Boolean).join(' · ');
        view.result.textContent = data.supported === false
            ? '内置安装目前支持 Windows；请运行 CLI 目录下对应系统的安装脚本。'
            : message;
        view.result.classList.remove('loading', 'ok', 'bad');
        if(busy) view.result.classList.add('loading');
        if(data.status === 'succeeded') view.result.classList.add('ok');
        if(data.status === 'failed') view.result.classList.add('bad');
    }
    clearTimeout(cliInstallTimers[kind]);
    if(busy) cliInstallTimers[kind] = setTimeout(() => refreshCliInstall(kind), 2000);
    if(sidebarState) renderProviderList();
}
async function refreshCliInstall(kind){
    const view = cliInstallViews[kind];
    if(!view) return;
    const wasBusy = Boolean(cliInstallBusy[kind]);
    try {
        const response = await fetch(view.path, {cache:'no-store'});
        const data = await response.json();
        if(!response.ok) throw new Error(data.detail || `无法读取 ${view.label} 安装状态`);
        renderCliInstall(kind, data);
        if(wasBusy && !cliInstallBusy[kind]){
            await refreshCliSidebarStatus(kind);
            if(kind === 'codex') await refreshCodexStatus(true, false);
            if(kind === 'jimeng') await refreshJimengStatus(true, false);
            if(kind === 'gemini-cli') await refreshGeminiCliStatus(true, false);
        }
    } catch(e){
        if(view.result){
            view.result.textContent = `${cliErrorMessage(e, 'local')}；请稍候，正在重新连接安装服务。`;
            view.result.classList.remove('loading', 'ok', 'bad');
            view.result.classList.add('bad');
        }
        clearTimeout(cliInstallTimers[kind]);
        if(cliInstallBusy[kind]) cliInstallTimers[kind] = setTimeout(() => refreshCliInstall(kind), 5000);
    }
}
async function installCli(kind){
    const view = cliInstallViews[kind];
    if(!view || cliInstallBusy[kind]) return;
    renderCliInstall(kind, {status:'running', message:'正在启动安装…'});
    try {
        const response = await fetch(view.path, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
        const data = await response.json();
        if(!response.ok){
            renderCliInstall(kind, {status:'failed', message:cliErrorMessage(data.detail || '无法启动安装，请重试。', 'install')});
            return;
        }
        renderCliInstall(kind, data);
    } catch(e){
        // 请求断开不代表后台没有启动，先查询任务，避免重复安装。
        await refreshCliInstall(kind);
    }
}
function handleCliStatusAction(kind){
    const state = cliSidebarState[kind];
    if(!state || state.checking || state.installing) return;
    if(state.installed === false || state.updateAvailable === true) return installCli(kind);
    if(!state.checked) return refreshCliSidebarStatus(kind);
}
function installJimengCli(){ return installCli('jimeng'); }
function installGeminiCli(){ return installCli('gemini-cli'); }
async function openGeminiCliTerminal(){
    if(!geminiCliTerminalBtn) return;
    geminiCliTerminalBtn.disabled = true;
    if(geminiCliTerminalStatus){
        geminiCliTerminalStatus.hidden = false;
        geminiCliTerminalStatus.textContent = '正在打开 agy 终端…';
        geminiCliTerminalStatus.classList.remove('ok', 'bad');
        geminiCliTerminalStatus.classList.add('loading');
    }
    try {
        const response = await fetch('/api/gemini-cli/terminal', {method:'POST'});
        const data = await response.json();
        if(!response.ok) throw new Error(data.detail || '无法打开 agy 终端。');
        if(geminiCliTerminalStatus){
            geminiCliTerminalStatus.textContent = data.message || '已打开 agy 终端。';
            geminiCliTerminalStatus.classList.replace('loading', 'ok');
        }
    } catch(e){
        if(geminiCliTerminalStatus){
            geminiCliTerminalStatus.textContent = cliErrorMessage(e, 'local');
            geminiCliTerminalStatus.classList.replace('loading', 'bad');
        }
    } finally {
        geminiCliTerminalBtn.disabled = false;
    }
}
function jimengLoginTextField(text, key){
    const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text || '').match(new RegExp(`^\\s*${escaped}\\s*:\\s*(\\S+)\\s*$`, 'im'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}
function normalizeJimengLoginUrl(value){
    let current = String(value || '').trim().replace(/^["']|["']$/g, '');
    for(let i = 0; i < 3 && !/^https?:\/\//i.test(current); i++){
        try {
            const decoded = decodeURIComponent(current);
            if(decoded === current) break;
            current = decoded;
        } catch(_) { break; }
    }
    if(!/^https?:\/\//i.test(current)){
        const embedded = current.match(/https?:\/\/[^\s"'<>]+/i);
        current = embedded ? embedded[0] : '';
    }
    return current;
}
function jimengLoginImageUrl(value){
    const url = String(value || '').trim();
    if(/^data:image\//i.test(url)) return url;
    if(!/^https?:\/\//i.test(url)) return '';
    return /(?:qrcode|qr-code|\/qr(?:[/?#]|$)|\.(?:png|jpe?g|gif|webp)(?:[?#]|$))/i.test(url) ? url : '';
}
function jimengLoginPayload(data){
    const text = data?.text || '';
    const complete = normalizeJimengLoginUrl(
        data?.verification_uri_complete || data?.verification_url || jimengLoginTextField(text, 'verification_uri_complete') || jimengLoginTextField(text, 'verification_url')
    );
    if(complete) return complete;
    const base = normalizeJimengLoginUrl(data?.verification_uri || jimengLoginTextField(text, 'verification_uri') || '');
    const userCode = String(data?.user_code || jimengLoginTextField(text, 'user_code') || '').trim();
    if(!base || !userCode) return base;
    try {
        const url = new URL(base);
        if(!Array.from(url.searchParams.keys()).some(key => /^(?:user_code|scan_user_code)$/i.test(key))){
            url.searchParams.set('user_code', userCode);
        }
        return url.toString();
    } catch(_) {
        return base;
    }
}
function jimengLoginQrDataUrl(payload){
    if(!payload || typeof window.qrcode !== 'function') return '';
    try {
        const qr = window.qrcode(0, 'M');
        qr.addData(payload);
        qr.make();
        return qr.createDataURL(4, 16);
    } catch(_) {
        return '';
    }
}
function jimengLoginLinkMarkup(url){
    if(!url) return '';
    return `<a class="jimeng-login-link" href="${escapeAttr(url)}" target="_blank" rel="noreferrer" onclick="openExternalWebPage(event, this.href)">在浏览器打开即梦登录页面</a>`;
}
function openJimengLoginInBrowser(data){
    const url = jimengLoginPayload(data);
    if(!url) return;
    const api = externalBrowserApi();
    if(api?.openExternal){
        Promise.resolve(api.openExternal(url)).then(result => {
            if(result?.ok === false) setStatus(result.message || '无法打开即梦登录页面，请点击二维码下方的浏览器链接。');
            else setStatus('已在浏览器打开即梦登录页面，请完成登录；二维码仍可作为备用。');
        }).catch(() => setStatus('无法打开即梦登录页面，请点击二维码下方的浏览器链接。'));
        return;
    }
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    setStatus(popup ? '已打开即梦登录页面，请完成登录；二维码仍可作为备用。' : '请点击二维码下方的浏览器链接打开即梦登录页面。');
}
function jimengLoginQrMarkup(data){
    const directImageUrl = jimengLoginImageUrl(data?.qr_url);
    const payload = jimengLoginPayload(data);
    const imageUrl = directImageUrl || jimengLoginQrDataUrl(payload);
    const text = data?.text || '';
    const userCode = String(data?.user_code || jimengLoginTextField(text, 'user_code') || '').trim();
    const loginLink = jimengLoginLinkMarkup(payload);
    if(imageUrl){
        return `<div class="jimeng-qr-card"><img class="jimeng-qr-img" src="${escapeAttr(imageUrl)}" alt="即梦登录二维码" draggable="false"><div class="jimeng-qr-tip">请使用即梦 App 扫码</div>${loginLink}</div>`;
    }
    if(payload || userCode){
        return `<div class="jimeng-qr-card jimeng-qr-fallback"><div class="jimeng-qr-fallback-title">二维码暂不可用</div><div class="jimeng-qr-tip">请点击下方链接完成登录${userCode ? `，验证码：<code>${escapeHtml(userCode)}</code>` : ''}</div>${loginLink}</div>`;
    }
    return '';
}
function renderJimengLoginBox(data){
    if(!jimengLoginBox) return;
    const text = data?.text || '';
    const qrHtml = jimengLoginQrMarkup(data);
    const permissionHint = /dreamina_cli.*使用权限|使用权限.*dreamina_cli|仅限.*会员/i.test(text)
        ? '<div class="jimeng-cli-hint" style="grid-column:1/-1;padding:8px 10px;border:1px solid #fcd34d;border-radius:8px;background:#fffbeb;color:#92400e;font-size:12px;font-weight:700;line-height:1.5">说明：账号登录成功，但当前账号暂未开通 CLI 资格；不一定需要额外充值，网页积分和 CLI 权限是两回事。</div>'
        : '';
    jimengLoginBox.hidden = false;
    jimengLoginBox.innerHTML = `${qrHtml}${permissionHint}<pre>${escapeHtml(text || '等待 CLI 输出登录二维码...')}</pre>`;
}
let jimengLoginTimer = null;
async function copyJimengInstallCommand(){
    const command = document.getElementById('jimengInstallCommand');
    const status = document.getElementById('jimengInstallCopyStatus');
    if(!command || !status) return;
    try {
        await navigator.clipboard.writeText(command.textContent.trim());
        status.textContent = '已复制。请在小美画布文件夹中打开 PowerShell，粘贴后按回车运行。';
    } catch(_) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(command);
        selection?.removeAllRanges();
        selection?.addRange(range);
        status.textContent = '无法自动复制，请选中上方命令，按 Ctrl+C（Mac 按 Command+C）复制。';
    }
}
async function refreshJimengStatus(showCredit=true, checkInstall=true){
    if(!jimengCliPanel || jimengCliPanel.hidden) return;
    if(checkInstall) refreshCliInstall('jimeng');
    setJimengStatus('检测中...');
    try {
        const response = await fetch('/api/jimeng/status', {cache:'no-store'});
        const data = await response.json();
        if(!response.ok) throw new Error(data.detail || '检测即梦 CLI 失败，请重试。');
        if(cliSidebarState.jimeng){
            cliSidebarState.jimeng.installed = typeof data.installed === 'boolean' ? data.installed : cliSidebarState.jimeng.installed;
            cliSidebarState.jimeng.statusError = '';
            renderCliStatusAction('jimeng');
        }
        setJimengStatus(data.logged_in ? '已登录' : (data.installed ? '未登录' : '未安装'), data.logged_in === true);
        const guide = document.getElementById('jimengInstallGuide');
        if(guide) guide.open = !data.installed;
        if(data.installed && data.version_ok === false && jimengCredit){
            jimengCredit.textContent = `⚠ 检测到 dreamina CLI 版本 ${data.cli_version || '未知'}，低于推荐的 ${data.min_version || '1.4.2'}。旧版本任务状态可能无法更新，请升级 CLI。`;
        } else if(showCredit && data.raw && jimengCredit){
            jimengCredit.textContent = jimengCreditText(data.raw);
        } else if(jimengCredit){
            jimengCredit.textContent = !data.installed
                ? '未找到即梦 CLI，请按上方“安装 / 更新方法”完成安装，再重启小美画布。'
                : (data.message ? cliErrorMessage(data.message, 'local') : (data.logged_in ? '已连接即梦账户，可点击“查询积分”查看余额。' : '请点击“扫码登录”连接即梦账户。'));
        }
    } catch(e){
        setJimengStatus('检测失败', false);
        const message = cliErrorMessage(e, 'local');
        if(cliSidebarState.jimeng) cliSidebarState.jimeng.statusError = message;
        renderCliStatusAction('jimeng');
        if(jimengCredit) jimengCredit.textContent = message;
    }
}
async function startJimengLogin(){
    setJimengStatus('等待扫码...');
    if(jimengCredit) jimengCredit.textContent = '';
    try {
        const data = await fetch('/api/jimeng/login/start', {method:'POST'}).then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '启动登录失败');
            return json;
        });
        renderJimengLoginBox(data);
        openJimengLoginInBrowser(data);
        clearInterval(jimengLoginTimer);
        jimengLoginTimer = setInterval(pollJimengLogin, 2500);
        refreshIcons();
    } catch(e){
        setJimengStatus('登录失败', false);
        if(jimengLoginBox){
            jimengLoginBox.hidden = false;
            jimengLoginBox.innerHTML = `<pre>${escapeHtml(cliErrorMessage(e, 'local'))}</pre>`;
        }
    }
}
async function pollJimengLogin(){
    try {
        const data = await fetch('/api/jimeng/login/status').then(r => r.json());
        renderJimengLoginBox(data);
        if(data.logged_in){
            clearInterval(jimengLoginTimer);
            setJimengStatus('已登录', true);
            if(jimengCredit) jimengCredit.textContent = jimengCreditText(data.raw);
        } else if(data.running){
            setJimengStatus('等待扫码...');
        } else {
            setJimengStatus('未登录', false);
        }
    } catch(e){
        clearInterval(jimengLoginTimer);
        setJimengStatus('登录检测失败', false);
    }
}
async function refreshJimengCredit(){
    setJimengStatus('查询余额...');
    try {
        const data = await fetch('/api/jimeng/credit').then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '查询余额失败');
            return json;
        });
        setJimengStatus('已登录', true);
        if(jimengCredit) jimengCredit.textContent = jimengCreditText(data.raw);
    } catch(e){
        setJimengStatus('未登录', false);
        if(jimengCredit) jimengCredit.textContent = cliErrorMessage(e, 'local');
    }
}
async function logoutJimeng(){
    if(!confirm('确认退出即梦 CLI 登录？')) return;
    try {
        const data = await fetch('/api/jimeng/logout', {method:'POST'}).then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '退出登录失败');
            return json;
        });
        setJimengStatus('已退出', false);
        if(jimengCredit) jimengCredit.textContent = prettyJson(data.raw);
        if(jimengLoginBox) jimengLoginBox.hidden = true;
    } catch(e){
        setJimengStatus('退出失败', false);
        if(jimengCredit) jimengCredit.textContent = cliErrorMessage(e, 'local');
    }
}
function openJimengHelp(){
    if(!jimengHelpOverlay) return;
    jimengHelpOverlay.style.display = 'flex';
    loadJimengHelp();
}
function closeJimengHelp(){
    if(jimengHelpOverlay) jimengHelpOverlay.style.display = 'none';
}
async function loadJimengHelp(){
    if(!jimengHelpOutput) return;
    jimengHelpOutput.textContent = '加载中...';
    try {
        const command = jimengHelpCommand?.value || '';
        const data = await fetch('/api/jimeng/help', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({command})
        }).then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '加载帮助失败');
            return json;
        });
        jimengHelpOutput.textContent = data.text || prettyJson(data.raw);
    } catch(e){
        jimengHelpOutput.textContent = cliErrorMessage(e, 'local');
    }
}
function renderCodexInstall(data){
    renderCliInstall('codex', data);
}
async function refreshCodexInstall(){
    return refreshCliInstall('codex');
}
async function installCodexCli(){
    return installCli('codex');
}
function setCodexStatus(text, ok=null, error=''){
    const state = cliSidebarState.codex;
    if(state){
        state.statusError = error
            ? cliErrorMessage(error, 'local')
            : (ok === false && /失败|错误/.test(String(text || '')) ? String(text || '').trim() : '');
        renderCliStatusAction('codex');
    }
}
async function refreshCodexStatus(showInfo=true, checkInstall=true){
    if(!codexCliPanel || codexCliPanel.hidden) return;
    if(checkInstall) refreshCodexInstall();
    setCodexStatus('检测中...');
    try {
        const data = await fetch('/api/codex/status').then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '检测 GPT CLI 失败，请重试。');
            return json;
        });
        if(cliSidebarState.codex && typeof data.installed === 'boolean') cliSidebarState.codex.installed = data.installed;
        setCodexStatus(data.installed ? '已安装' : '未安装', data.installed === true);
        if(showInfo && codexCliInfo){
            const parts = [];
            if(data.version) parts.push(data.version);
            if(data.path) parts.push(data.path);
            if(data.message) parts.push(cliErrorMessage(data.message, 'local'));
            codexCliInfo.textContent = parts.join(' · ');
        }
    } catch(e){
        const message = cliErrorMessage(e, 'local');
        setCodexStatus('检测失败', false, message);
        if(codexCliInfo) codexCliInfo.textContent = message;
    }
}
function openCodexHelp(){
    if(!codexHelpOverlay) return;
    codexHelpOverlay.style.display = 'flex';
    loadCodexHelp();
}
function closeCodexHelp(){
    if(codexHelpOverlay) codexHelpOverlay.style.display = 'none';
}
async function loadCodexHelp(){
    if(!codexHelpOutput) return;
    codexHelpOutput.textContent = '加载中...';
    try {
        const command = codexHelpCommand?.value || '';
        const data = await fetch('/api/codex/help', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({command})
        }).then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '加载帮助失败');
            return json;
        });
        codexHelpOutput.textContent = data.text || prettyJson(data.raw);
    } catch(e){
        codexHelpOutput.textContent = cliErrorMessage(e, 'local');
    }
}
function setGeminiCliStatus(text, ok=null, error=''){
    const state = cliSidebarState['gemini-cli'];
    if(state){
        state.statusError = error
            ? cliErrorMessage(error, 'local')
            : (ok === false && /失败|错误/.test(String(text || '')) ? String(text || '').trim() : '');
        renderCliStatusAction('gemini-cli');
    }
}
async function refreshGeminiCliStatus(showInfo=true, checkInstall=true){
    if(!geminiCliPanel || geminiCliPanel.hidden) return;
    if(checkInstall) refreshCliInstall('gemini-cli');
    setGeminiCliStatus('检测中...');
    try {
        const data = await fetch('/api/gemini-cli/status').then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '检测 Antigravity CLI 失败，请重试。');
            return json;
        });
        if(cliSidebarState['gemini-cli'] && typeof data.installed === 'boolean') cliSidebarState['gemini-cli'].installed = data.installed;
        setGeminiCliStatus(data.installed ? '已安装' : '未安装', data.installed === true);
        if(showInfo && geminiCliInfo){
            const parts = [];
            if(data.version) parts.push(data.version);
            if(data.path) parts.push(data.path);
            if(data.message) parts.push(cliErrorMessage(data.message, 'local'));
            if(data.local_ai_upscale?.message) parts.push(data.local_ai_upscale.message);
            geminiCliInfo.textContent = parts.join(' · ');
        }
    } catch(e){
        const message = cliErrorMessage(e, 'local');
        setGeminiCliStatus('检测失败', false, message);
        if(geminiCliInfo) geminiCliInfo.textContent = message;
    }
}
function openGeminiCliHelp(){
    if(!geminiCliHelpOverlay) return;
    geminiCliHelpOverlay.style.display = 'flex';
    loadGeminiCliHelp();
}
function closeGeminiCliHelp(){
    if(geminiCliHelpOverlay) geminiCliHelpOverlay.style.display = 'none';
}
async function loadGeminiCliHelp(){
    if(!geminiCliHelpOutput) return;
    geminiCliHelpOutput.textContent = '加载中...';
    try {
        const command = geminiCliHelpCommand?.value || '';
        const data = await fetch('/api/gemini-cli/help', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({command})
        }).then(async r => {
            const json = await r.json();
            if(!r.ok) throw new Error(json.detail || '加载帮助失败');
            return json;
        });
        geminiCliHelpOutput.textContent = data.text || prettyJson(data.raw);
    } catch(e){
        geminiCliHelpOutput.textContent = cliErrorMessage(e, 'local');
    }
}
function providerSupportsKeyProfiles(item){
    if(!item) return false;
    const id = String(item.id || '').trim().toLowerCase();
    const protocol = String(item.protocol || protocolInput?.value || '').trim().toLowerCase();
    return !['runninghub', 'jimeng', 'codex', 'gemini-cli'].includes(id)
        && !CLI_PROTOCOLS.has(protocol)
        && protocol !== 'runninghub';
}
const keyProfiles = window.ApiSettingsAccounts.bind({
    translate: tr,
    format: trf,
    provider,
    lookup: id => providers.find(item => item.id === id),
    supports: providerSupportsKeyProfiles,
    saving: () => Boolean(providerSavePromise),
    sync: syncEditor,
    refresh: renderEditor,
    draftChanged: renderProviderSaveState,
    status: setStatus,
    saved(target, status, credentialsChanged){
        if(provider() === target){
            if(credentialsChanged) clearFetchedModelState();
            renderEditor();
            setStatus(status);
        } else {
            renderProviderList();
        }
        renderProviderSaveState();
        broadcastStudioApiChange('providers-changed');
    },
});
function normalizeImageRequestMode(value){
    const mode = String(value || '').trim().toLowerCase();
    return ['openai', 'openai-json', 'openai-video-proxy', 'openai-responses'].includes(mode) ? mode : 'openai';
}
function normalizeImageEditRoute(value){
    const route = String(value || '').trim().toLowerCase();
    return ['general', 'auto', 'chat'].includes(route) ? route : 'general';
}
function imageRequestModeLabel(mode){
    const normalized = normalizeImageRequestMode(mode);
    if(normalized === 'openai-json') return 'OpenAI JSON';
    if(normalized === 'openai-video-proxy') return 'OpenAI 中转';
    if(normalized === 'openai-responses') return 'OpenAI RS';
    return 'OpenAI 标准';
}
function isRunningHubContext(item, baseUrl=''){
    const protocol = String(protocolInput?.value || item?.protocol || '').trim().toLowerCase();
    const url = String(baseUrl || baseInput?.value || item?.base_url || '').trim().toLowerCase();
    return item?.id === 'runninghub'
        || protocol === 'runninghub'
        || url.includes('runninghub.cn')
        || url.includes('runninghub.ai');
}
function applyDetectedImageRequestMode(mode){
    const item = provider();
    if(!item || !imageRequestModeInput) return false;
    if(applyLockedRecommendedProtocol(item)){
        if(protocolInput) protocolInput.value = item.protocol;
        imageRequestModeInput.value = item.image_request_mode;
        return false;
    }
    const detected = normalizeImageRequestMode(mode);
    const changed = normalizeImageRequestMode(item.image_request_mode) !== detected || normalizeImageRequestMode(imageRequestModeInput.value) !== detected;
    imageRequestModeInput.value = detected;
    item.image_request_mode = detected;
    return changed;
}
function applyDetectedProtocol(protocol){
    const item = provider();
    const detected = String(protocol || '').toLowerCase();
    if(!item || !protocolInput || !API_PROTOCOLS.includes(detected)) return false;
    if(applyLockedRecommendedProtocol(item)){
        protocolInput.value = item.protocol;
        if(imageRequestModeInput) imageRequestModeInput.value = item.image_request_mode;
        return false;
    }
    if(String(protocolInput.value || '').toLowerCase() === detected && String(item.protocol || '').toLowerCase() === detected) return false;
    protocolInput.value = detected;
    item.protocol = detected;
    item.base_url = CLI_PROTOCOLS.has(detected) ? '' : (baseInput?.value.trim() || item.base_url || '');
    if(detected === 'volcengine'){
        item.video_models = unique(item.video_models || []);
        item.volcengine_project_name = item.volcengine_project_name || VOLCENGINE_DEFAULT_PROJECT_NAME;
        item.volcengine_region = item.volcengine_region || VOLCENGINE_DEFAULT_REGION;
    }
    if(detected === 'runninghub'){
        item.base_url = item.base_url || RH_DEFAULT_BASE_URL;
        item.image_models = unique(item.image_models || []);
        item.chat_models = unique(item.chat_models || []);
        item.video_models = unique(item.video_models || []);
    }
    applyCliProtocolDefaults(item, detected);
    protocolInput.dispatchEvent(new Event('change'));
    return true;
}

function runninghubModelSourceNote(data){
    const raw = data?.raw || {};
    const source = String(raw.source || '').toLowerCase();
    const sourceLabel = source === 'openapi'
        ? '官方 OpenAPI'
        : source === 'github'
        ? 'GitHub 注册表'
        : source === 'local'
        ? '本地注册表'
        : source === 'llm'
        ? 'LLM 网关'
        : source === 'fallback'
        ? '内置兜底'
        : '';
    const parts = [];
    if(sourceLabel) parts.push(`来源：${sourceLabel}`);
    if(raw.openapi_count !== undefined) parts.push(`直连 ${Number(raw.openapi_count || 0)}`);
    if(raw.llm_count !== undefined) parts.push(`LLM ${Number(raw.llm_count || 0)}`);
    const text = parts.join(' · ');
    const warning = source === 'fallback' ? ' · 官方模型列表未拉到完整数据' : '';
    return text ? ` · ${text}${warning}` : '';
}

async function probeAsync(){
    const item = provider();
    if(!item) return;
    const btn = document.getElementById('probeAsyncBtn');
    const baseUrl = baseInput.value.trim();
    const isCliProtocol = CLI_PROTOCOLS.has(String(protocolInput?.value || item.protocol || '').toLowerCase());
    if(!baseUrl && !isCliProtocol){ alert('请先填写请求地址'); return; }
    const request = beginModelRequest(item, btn, '检测中...', '验证协议');
    showVerifyResult(`<span style="color:var(--muted);font-size:11px;font-weight:700">正在检测协议类型...</span>`);
    try {
        const apiKey = keyInput.value.trim();
        const currentProtocol = String(protocolInput?.value || item.protocol || 'openai').toLowerCase();
        if(isRunningHubContext(item, baseUrl)){
            const data = await fetch('/api/providers/test-connection', {
                method:'POST',
                cache:'no-store', signal:request.controller.signal,
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({
                    base_url:baseUrl,
                    api_key:apiKey,
                    provider_id:'runninghub',
                    protocol:'runninghub',
                    image_request_mode:'openai'
                })
            }).then(async r => {
                if(!r.ok) throw new Error((await r.json()).detail || '请求失败');
                return r.json();
            });
            if(!acceptModelResponse(request)) return;
            applyDetectedProtocol('runninghub');
            setFetchedModelState(data);
            showVerifyResult(`<span style="color:#15803d;font-size:11px;font-weight:800">✓ RunningHub OpenAPI 验证通过 · 找到 ${data.model_count || data.total || 0} 个模型${runninghubModelSourceNote(data)}</span>`);
            return;
        }
        const data = await fetch('/api/providers/probe-async', {
            method: 'POST',
            cache: 'no-store', signal:request.controller.signal,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                base_url: baseUrl,
                api_key: apiKey,
                provider_id: item.id,
                protocol: currentProtocol,
                image_request_mode: imageRequestModeInput?.value || item.image_request_mode || 'openai'
            })
        }).then(async r => {
            if(!r.ok) throw new Error((await r.json()).detail || '请求失败');
            return r.json();
        });
        if(!acceptModelResponse(request)) return;
        const detectedProtocol = String(data.protocol || '').toLowerCase();
        const isAsync = data.ok === true && detectedProtocol === 'apimart';
        const isOpenAiCompat = data.ok === true && detectedProtocol === 'openai';
        const keepManualProtocol = ['gemini', 'volcengine', 'jimeng', 'codex', 'gemini-cli'].includes(currentProtocol);
        if(protocolInput && !keepManualProtocol){
            applyDetectedProtocol(detectedProtocol || (isAsync ? 'apimart' : 'openai'));
        }
        if(data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
        const rawJson = JSON.stringify(data.raw, null, 2);
        const probeMessage = String(data.message || '');
        const hideTasksEndpointTip = probeMessage.includes('/v1/tasks/');
        const color = (isAsync || isOpenAiCompat || data.ok === true) ? '#15803d' : data.ok === null ? '#b45309' : '#64748b';
        const icon = (isAsync || isOpenAiCompat || data.ok === true) ? '✓' : '⚠';
        const proto = detectedProtocol === 'volcengine'
            ? '方舟/Ark 任务协议'
            : isAsync
                ? 'APIMart 异步'
                : detectedProtocol === 'openai'
                    ? 'OpenAI 兼容'
                    : keepManualProtocol
                    ? (currentProtocol === 'gemini' ? 'Gemini' : currentProtocol.toUpperCase())
                    : 'OpenAI 兼容';
        showVerifyResult(`
            ${hideTasksEndpointTip ? '' : `<div style="font-size:11px;font-weight:800;color:${color}">${icon} ${escapeHtml(probeMessage)}</div>`}
            <div style="font-size:11px;color:var(--muted);font-weight:700;margin-top:2px">${keepManualProtocol ? '协议已验证为' : '协议已自动设置为'}：<strong style="color:var(--text)">${proto}</strong> · 图片接口：<strong style="color:var(--text)">${imageRequestModeLabel(imageRequestModeInput?.value || item.image_request_mode)}</strong></div>
            <details style="margin-top:6px">
                <summary style="font-size:10.5px;color:var(--muted);cursor:pointer;font-weight:700;user-select:none">▸ 查看原始响应 (HTTP ${data.status_code})</summary>
                <pre style="margin-top:6px;padding:10px 12px;border-radius:10px;background:var(--soft);border:1px solid var(--line-2);font-size:10.5px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:var(--text);max-height:200px;overflow:auto">${escapeHtml(rawJson)}</pre>
            </details>`);
    } catch(e){
        if(!request.accepted && !acceptModelResponse(request)) return;
        const keepManualProtocol = ['gemini', 'volcengine', 'jimeng', 'codex', 'gemini-cli'].includes(String(protocolInput?.value || item.protocol || '').toLowerCase());
        if(protocolInput && !keepManualProtocol){ protocolInput.value = 'openai'; protocolInput.dispatchEvent(new Event('change')); }
        const suffix = keepManualProtocol ? '，已保留当前手动选择的协议' : '，协议已设为 OpenAI 兼容';
        showVerifyResult(`<div style="font-size:11px;font-weight:800;color:#b45309">⚠ ${escapeHtml(e.message || String(e))}${suffix}</div>`);
    } finally {
        releaseModelRequest(request);
    }
}

async function testConnection(){
    const item = provider();
    if(!item) return;
    const btn = document.getElementById('testUrlBtn');
    const baseUrl = baseInput.value.trim();
    const isJimeng = (protocolInput?.value || '') === 'jimeng';
    const currentProtocol = String(protocolInput?.value || item.protocol || '').toLowerCase();
    const isCliProtocol = CLI_PROTOCOLS.has(currentProtocol);
    if(!baseUrl && !isJimeng && !isCliProtocol){ alert('请先填写请求地址'); return; }
    const request = beginModelRequest(item, btn, tr('api.testingUrl') || '验证中...', tr('api.testUrl') || '验证地址');
    showVerifyResult(`<span style="color:var(--muted);font-size:11px;font-weight:700">验证中...</span>`);
    try {
        const apiKey = keyInput.value.trim();
        const runninghubContext = isRunningHubContext(item, baseUrl);
        const data = await fetch('/api/providers/test-connection', {
            method: 'POST', cache: 'no-store', signal:request.controller.signal, headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                base_url: baseUrl,
                api_key: apiKey,
                provider_id: runninghubContext ? 'runninghub' : item.id,
                protocol: runninghubContext ? 'runninghub' : (protocolInput?.value || 'openai'),
                image_request_mode: imageRequestModeInput?.value || item.image_request_mode || 'openai'
            })
        }).then(async r => {
            if(!r.ok) throw new Error((await r.json()).detail || (tr('api.urlInvalid') || '验证失败'));
            return r.json();
        });
        if(!acceptModelResponse(request)) return;
        if(data.ok){
            const detectedProtocol = String(data.protocol || '').toLowerCase();
            if(detectedProtocol && detectedProtocol !== String(protocolInput?.value || '').toLowerCase()){
                applyDetectedProtocol(detectedProtocol);
            }
            if(data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
            // 存入 picker 状态并启用「选择模型」按钮，但不自动弹出
            setFetchedModelState(data);
            const isRunningHubNow = runninghubContext || detectedProtocol === 'runninghub';
            const isVolcengineNow = !isRunningHubNow && (detectedProtocol === 'volcengine' || isVolcengineProvider(item));
            const volcengineNote = isVolcengineNow
                ? `<div style="margin-top:6px;color:#92400e;font-size:11px;font-weight:700">${detectedProtocol === 'volcengine' ? '已自动识别为方舟/Ark 任务协议。' : ''}火山协议提示：模型列表只代表可见模型，聊天模型建议填写你在方舟控制台创建的 <code>ep-...</code> 推理接入点。</div>`
                : '';
            const jimengNote = isJimeng ? `<div style="margin-top:6px;color:#15803d;font-size:11px;font-weight:700">即梦 CLI 已可用，可在画布里选择“即梦 CLI”生成。</div>` : '';
            const codexNote = currentProtocol === 'codex'
                ? `<div style="margin-top:6px;color:#15803d;font-size:11px;font-weight:700">${codexHasImage25Model(data.image_models) ? '已检测到 Codex image_generation 能力声明支持 GPT Image 2.5，可在画布里选择 Flare / Sunburst 或 GPT Image 2。' : '当前只检测到 Codex image_generation 能力声明支持 GPT Image 2，未检测到 GPT Image 2.5，因此不会显示 2.5。'} 继续使用本机 Codex 登录态，无需 API Key。</div>`
                : '';
            const geminiCliNote = currentProtocol === 'gemini-cli' ? `<div style="margin-top:6px;color:#15803d;font-size:11px;font-weight:700">Antigravity CLI 已可用；图片任务会调用原生 generate_image 工具，结果由画布自动回收。</div>` : '';
            const imageModeNote = ` · 图片接口：${imageRequestModeLabel(imageRequestModeInput?.value || item.image_request_mode)}`;
            const runninghubNote = isRunningHubNow
                ? ` · RunningHub OpenAPI${runninghubModelSourceNote(data)}`
                : imageModeNote;
            const newapiGroupNote = (data.model_groups && Object.keys(data.model_groups).length)
                ? `<div style="margin-top:6px;color:#92400e;font-size:11px;font-weight:700">${escapeHtml(data.message || '')}</div>`
                : '';
            showVerifyResult(`<span style="color:#15803d;font-size:11px;font-weight:800">✓ 地址验证通过 · 找到 ${data.model_count} 个模型${runninghubNote}</span>${newapiGroupNote}${volcengineNote}${jimengNote}${codexNote}${geminiCliNote}`);
        } else {
            showVerifyResult(`
                <div style="font-size:11px;font-weight:800;color:#b45309">⚠ 地址验证未通过 (HTTP ${data.status})</div>
                <div style="font-size:11px;color:var(--muted);font-weight:600;margin-top:3px">${escapeHtml((data.message || '').slice(0,200))}</div>`);
        }
    } catch(e){
        if(!request.accepted && !acceptModelResponse(request)) return;
        showVerifyResult(`<div style="font-size:11px;font-weight:800;color:#b45309">⚠ ${escapeHtml(e.message || String(e))}</div>`);
    } finally {
        releaseModelRequest(request);
    }
}
let modelCatalog = null;
let pendingModelRequest = null;

function modelFetchContext(item){
    const address = String(baseInput?.value ?? item?.base_url ?? '').trim().replace(/\/+$/, '');
    const protocol = String(protocolInput?.value || item?.protocol || 'openai').trim().toLowerCase();
    const imageMode = normalizeImageRequestMode(imageRequestModeInput?.value || item?.image_request_mode || 'openai');
    return JSON.stringify([item?.id, address, protocol, imageMode, item?.active_key_profile_id || '']);
}

function enableModelPicker(enabled){
    const button = document.getElementById('openPickerBtn');
    button.disabled = !enabled;
    button.style.opacity = enabled ? '1' : '.5';
}

function releaseModelRequest(request){
    if(pendingModelRequest !== request) return;
    pendingModelRequest = null;
    if(request.button){
        request.button.disabled = false;
        request.button.querySelector('span').textContent = request.idle;
    }
}

function clearFetchedModelState(){
    if(pendingModelRequest){
        const request = pendingModelRequest;
        releaseModelRequest(request);
        request.controller.abort();
        if(request.button?.id === 'fetchModelsBtn') setStatus('');
        else clearVerifyResult();
    }
    modelCatalog = null;
    enableModelPicker(false);
}

function beginModelRequest(item, button, busy, idle){
    clearFetchedModelState();
    const request = {context: modelFetchContext(item), controller: new AbortController(), button, idle};
    pendingModelRequest = request;
    if(button){
        button.disabled = true;
        button.querySelector('span').textContent = busy;
    }
    return request;
}

function acceptModelResponse(request){
    if(pendingModelRequest !== request || request.context !== modelFetchContext(provider())) return false;
    releaseModelRequest(request);
    request.accepted = true;
    return true;
}

function setFetchedModelState(data, item = provider()){
    modelCatalog = ApiSettingsModels.catalog(data, modelFetchContext(item));
    enableModelPicker(modelCatalog.ids.length > 0);
}

function currentModelCatalog(item){
    return modelCatalog?.context === modelFetchContext(item) ? modelCatalog : null;
}

function savedModelLabel(item, id){
    const labels = item?.model_names;
    return labels && Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id] : '';
}

const RH_KNOWN_MODEL_LABELS = {
    'gpt-image-2.0/text-to-image-channel-low-price':'全能图片G2 · 文生图 · 低价渠道版',
    'gpt-image-2.0/edit-channel-low-price':'全能图片G2 · 图片编辑 · 低价渠道版',
    'gpt-image-2/text-to-image-official-stable':'全能图片G2 · 文生图 · 官方稳定版',
    'gpt-image-2/image-to-image-official-stable':'全能图片G2 · 图生图 · 官方稳定版',
    'nano-banana/text-to-image-official-stable':'全能图片 · 文生图 · 官方稳定版',
    'nano-banana/image-to-image-official-stable':'全能图片 · 图生图 · 官方稳定版',
    'nano-banana-pro/text-to-image-official-stable':'全能图片Pro · 文生图 · 官方稳定版',
    'nano-banana-pro/image-to-image-official-stable':'全能图片Pro · 图生图 · 官方稳定版',
};
function isRunningHubLike(item){
    const base = String(item?.base_url || '').toLowerCase();
    return item?.id === 'runninghub' || String(item?.protocol || '').toLowerCase() === 'runninghub' || base.includes('runninghub.cn');
}
function rhActionLabel(text){
    const value = String(text || '').toLowerCase().replace(/[_/-]+/g, ' ');
    if(/start\s+end\s+to\s+video/.test(value)) return '首尾帧视频';
    if(/multimodal\s+video/.test(value)) return '多模态视频';
    if(/image\s+to\s+video|图生视频/.test(value)) return '图生视频';
    if(/text\s+to\s+video|文生视频/.test(value)) return '文生视频';
    if(/image\s+to\s+image|image\s+edit|edit|图生图|图片编辑/.test(value)) return '图片编辑';
    if(/text\s+to\s+image|文生图/.test(value)) return '文生图';
    return '';
}
function runningHubReadableModelName(model, item){
    const raw = String(model || '').trim();
    if(!raw) return '';
    const saved = savedModelLabel(item, raw);
    if(saved && saved !== raw) return saved;
    const fetched = currentModelCatalog(item)?.labels.get(raw);
    if(fetched && fetched !== raw) return fetched;
    if(RH_KNOWN_MODEL_LABELS[raw]) return RH_KNOWN_MODEL_LABELS[raw];
    const lower = raw.toLowerCase();
    const action = rhActionLabel(raw);
    const normalized = raw.replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if(lower.includes('alibaba') || lower.includes('wan-') || lower.includes('wan ')){
        const version = (normalized.match(/wan\s*(\d+(?:\.\d+)?)/i) || [])[1];
        return `阿里 · 万相${version ? ' ' + version : ''}${action ? ' · ' + action : ''}`;
    }
    if(lower.includes('bytedance') || lower.includes('jimeng')){
        const version = (normalized.match(/jimeng\s*(\d+(?:\.\d+)?)/i) || [])[1];
        return `字节 · 即梦${version ? ' ' + version : ''}${action ? ' · ' + action : ''}`;
    }
    if(lower.includes('seedance')){
        const version = (normalized.match(/seedance\s*(\d+(?:\.\d+)?)/i) || [])[1];
        const fast = /fast/i.test(raw) ? ' · Fast' : '';
        return `Seedance${version ? ' · ' + version : ''}${fast}${action ? ' · ' + action : ''}`;
    }
    if(lower.includes('kling')) return `可灵${normalized.match(/\d+(?:\.\d+)?/) ? ' ' + normalized.match(/\d+(?:\.\d+)?/)[0] : ''}${/standard/i.test(raw) ? ' 标准版' : ''}${action ? ' · ' + action : ''}`;
    if(lower.includes('hailuo')) return `海螺${action ? ' · ' + action : ''}`;
    if(lower.includes('luma')) return normalized.replace(/^luma/i, 'Luma').replace(/\bimage edit\b/i, '图片编辑').replace(/\bimage to video\b/i, '图生视频').replace(/\btext to video\b/i, '文生视频');
    if(lower.includes('vidu')) return normalized.replace(/^vidu/i, 'Vidu').replace(/\bimage edit\b/i, '图片编辑').replace(/\bimage to video\b/i, '图生视频').replace(/\btext to video\b/i, '文生视频');
    if(lower.includes('gpt-image-2.5-flare')) return `全能图片 2.5 Flare${action ? ' · ' + action : ''}`;
    if(lower.includes('gpt-image-2.5-sunburst')) return `全能图片 2.5 Sunburst${action ? ' · ' + action : ''}`;
    if(lower.includes('gpt-image-2')) return `全能图片G2${action ? ' · ' + action : ''}`;
    if(lower.includes('nano-banana-pro')) return `全能图片Pro${action ? ' · ' + action : ''}`;
    if(lower.includes('nano-banana')) return `全能图片${action ? ' · ' + action : ''}`;
    if(lower.includes('qwen-image')) return `通义千问图像${lower.includes('pro') ? ' Pro' : ''}${action ? ' · ' + action : ''}`;
    if(lower.includes('seedream')) return `即梦 Seedream${action ? ' · ' + action : ''}`;
    return raw;
}
function modelDisplayName(model, item){
    const raw = String(model || '');
    if(isRunningHubLike(item)) return runningHubReadableModelName(raw, item);
    const saved = savedModelLabel(item, raw);
    if(saved && saved !== raw) return saved;
    const fetched = currentModelCatalog(item)?.labels.get(raw);
    return fetched && fetched !== raw ? fetched : raw;
}
function providerModelBadge(model, label, item){
    const text = `${model || ''} ${label || ''}`.toLowerCase();
    if(text.includes('gpt-image')) return 'G';
    if(text.includes('gemini')) return 'GM';
    if(text.includes('claude')) return 'CL';
    if(text.includes('gpt') || text.includes('oss')) return 'G';
    if(text.includes('nano')) return 'N';
    if(text.includes('qwen')) return 'Q';
    if(text.includes('seedream')) return 'S';
    if(text.includes('seedance')) return 'SD';
    if(text.includes('wan') || text.includes('万相')) return 'W';
    if(text.includes('jimeng') || text.includes('即梦')) return 'J';
    if(text.includes('luma')) return 'L';
    if(text.includes('vidu')) return 'V';
    if(text.includes('alibaba') || text.includes('阿里')) return 'A';
    if(text.includes('bytedance') || text.includes('字节')) return 'B';
    if(isRunningHubLike(item)) return 'RH';
    if(String(model || '').trim().toLowerCase() === 'auto') return 'CLI';
    return 'AI';
}

async function fetchModels(){
    const item = provider();
    if(!item) return;
    syncEditor();
    const btn = document.getElementById('fetchModelsBtn');
    const baseUrl = baseInput.value.trim();
    const apiKey = keyInput.value.trim();
    const isJimeng = (protocolInput?.value || '') === 'jimeng';
    const isCliProtocol = CLI_PROTOCOLS.has(String(protocolInput?.value || item.protocol || '').toLowerCase());
    if(!baseUrl && !isJimeng && !isCliProtocol){ alert('请先填写请求地址'); return; }
    const request = beginModelRequest(item, btn, tr('api.fetchingModels') || '拉取中...', tr('api.fetchModels') || '拉取模型');
    setStatus(tr('api.fetchingModels') || '正在从上游拉取模型列表...');
    try {
        const runninghubContext = isRunningHubContext(item, baseUrl);
        const data = await fetch('/api/providers/fetch-models', {
            method:'POST',
            cache:'no-store', signal:request.controller.signal,
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                base_url:baseUrl,
                api_key:apiKey,
                provider_id:runninghubContext ? 'runninghub' : item.id,
                protocol:runninghubContext ? 'runninghub' : (protocolInput?.value || 'openai'),
                image_request_mode:imageRequestModeInput?.value || item.image_request_mode || 'openai',
                name:nameInput?.value.trim() || item.name || ''
            })
        }).then(async r => {
            if(!r.ok) throw new Error((await r.json()).detail || (tr('api.urlInvalid') || '拉取失败'));
            return r.json();
        });
        if(!acceptModelResponse(request)) return;
        const detectedProtocol = String(data.protocol || '').toLowerCase();
        if(detectedProtocol && detectedProtocol !== String(protocolInput?.value || '').toLowerCase()){
            applyDetectedProtocol(detectedProtocol);
        }
        if(data.image_request_mode) applyDetectedImageRequestMode(data.image_request_mode);
        setFetchedModelState(data);
        const extra = (runninghubContext || detectedProtocol === 'runninghub' || item.id === 'runninghub')
            ? ` · RunningHub OpenAPI${runninghubModelSourceNote(data)}`
            : (detectedProtocol === 'volcengine' || isVolcengineProvider(item)) ? ' · 已识别方舟协议，火山聊天建议改填 ep-... 接入点' : '';
        const imageModeExtra = normalizeImageRequestMode(imageRequestModeInput?.value || item.image_request_mode) === 'openai-json' ? ' · 图片接口已设为 OpenAI JSON' : '';
        setStatus(`已拉取 ${data.total} 个模型 · 点「选择模型」勾选要导入的${extra}${imageModeExtra}`);
        // 后端已顺手缓存站点图标，重画列表让左侧立刻换成平台自己的 favicon。
        resetProviderIcon(item);
        renderProviderList();
        if(modelCatalog.ids.length) openModelPicker(btn);
    } catch(e){
        if(!request.accepted && !acceptModelResponse(request)) return;
        alert('拉取失败：' + (e.message || e));
        setStatus('拉取失败');
    } finally {
        releaseModelRequest(request);
    }
}

const modelPicker = ApiSettingsModels.picker(document.getElementById('modelPickerOverlay'), {
    apply: applyModelPicker,
    pendingSave: () => providerSavePromise,
});

function openModelPicker(returnFocus = document.activeElement){
    const item = provider();
    const catalog = currentModelCatalog(item);
    if(!item || !catalog?.ids.length){
        alert('请先重新拉取当前平台的模型列表');
        return;
    }
    const selection = ApiSettingsModels.selection(catalog, item, id => {
        const label = modelDisplayName(id, item);
        return {label, badge: providerModelBadge(id, label, item)};
    });
    modelPicker.open(selection, returnFocus === document.body ? document.getElementById('fetchModelsBtn') : returnFocus);
}

async function applyModelPicker(){
    const item = provider();
    const session = modelPicker.current();
    if(!item || !session) return;
    if(session.catalog !== currentModelCatalog(item)){
        alert('当前模型列表已过期，请重新拉取后再应用');
        return;
    }
    const selection = ApiSettingsModels.readSelection(session, item, isSoonStudioProvider(item));
    for(const [kind, field] of Object.entries(ApiSettingsModels.fields)) item[field] = selection.lists[kind];
    item.model_selection_managed = true;
    item.model_names = selection.model_names;
    item.model_protocols = selection.model_protocols;
    for(const kind of Object.keys(ApiSettingsModels.fields)) renderModels(kind);
    markProviderDirty();
    modelPicker.close();
    const {image, chat, video} = selection.lists;
    const totals = '生图 ' + image.length + ' / LLM ' + chat.length + ' / 视频 ' + video.length;
    setStatus('正在同步 · ' + totals);
    const ok = await saveProviders();
    if(ok){
        const note = selection.removed ? ' · 已移除 ' + selection.removed + ' 个上游不再提供的模型' : '';
        setStatus('已实时同步 · ' + totals + note);
    }
}
async function saveKeyOnly(){
    const item = provider();
    if(!item) return;
    if(keyProfiles.supports(item)) return keyProfiles.saveProfile(item);
    const key = keyInput.value.trim();
    if(!key){ alert(tr('api.enterKeyAlert') || '请输入 Key'); return; }
    item.api_key = key;
    const ok = await saveProviders();
    if(ok) keyInput.value = '';
}
async function clearKeyOnly(){
    const item = provider();
    if(!item) return;
    if(keyProfiles.supports(item)) return keyProfiles.deleteProfile(item);
    if(!item.has_key && !keyInput.value){ return; }
    if(!confirm(tr('api.confirmClearKey') || '确认清除当前 Key？')) return;
    item._clearKey = true;
    const ok = await saveProviders();
    if(ok) keyInput.value = '';
}
const FIXED_PROTOCOL_PROVIDER_IDS = new Set(['volcengine', 'runninghub']);
function isSoonStudioProvider(item){
    const base = String(item?.base_url || '').trim().toLowerCase();
    try{
        const host = new URL(base).hostname;
        return host === 'soonstudio.ai' || host.endsWith('.soonstudio.ai');
    }catch(e){
        return false;
    }
}
function providerSupportsModelProtocol(item){
    return Boolean(item) && !FIXED_PROTOCOL_PROVIDER_IDS.has(item.id);
}
function renderModels(kind){
    const item = provider();
    const list = {image: imageModelList, chat: chatModelList, video: videoModelList}[kind];
    const models = item?.[ApiSettingsModels.fields[kind]] || [];
    const showProtocol = kind !== 'video' && providerSupportsModelProtocol(item);
    const protocols = item?.model_protocols || {};
    const entries = models.map(id => ({
        id,
        label: modelDisplayName(id, item),
        protocol: showProtocol ? (Object.hasOwn(protocols, String(id || '').trim()) ? protocols[String(id || '').trim()] : '') : null,
    }));
    ApiSettingsModels.editor(list, entries, {
        rename: (index, value) => updateModel(kind, index, value),
        protocol: (index, value) => updateModelProtocol(kind, index, value),
        remove: index => removeModel(kind, index),
    }, {
        empty: tr('api.noModels'),
        id: tr('api.model'),
        protocol: '该模型使用的协议，默认跟随平台全局协议',
        defaultProtocol: '默认',
        remove: tr('api.delete'),
    });
    if(entries.length) refreshIcons();
}
function selectProvider(id){
    if(isProviderTemporarilyHidden(providers.find(item => item.id === id))) return;
    if(!confirmDiscardKeyProfileDraft()) return;
    if(id !== selectedId) clearFetchedModelState();
    keyProfiles.reset();
    recommendInlineOpen = false;
    syncRecommendView();
    renderRecommendApi();
    syncEditor();
    selectedId = id;
    renderEditor();
    renderProviderSaveState();
}
function addProvider(){
    if(!confirmDiscardKeyProfileDraft()) return;
    clearFetchedModelState();
    keyProfiles.reset();
    recommendInlineOpen = false;
    syncRecommendView();
    renderRecommendApi();
    syncEditor();
    const id = deriveIdFromName('api-' + Math.random().toString(36).slice(2, 10));
    providers.push({id, _idDraft:true, name:'API', base_url:'', protocol:'openai', image_request_mode:'openai', image_edit_route:'general', image_generation_endpoint:'', image_edit_endpoint:'', enabled:true, primary:false, image_models:[], chat_models:[], video_models:[], has_key:false, key_preview:''});
    selectedId = id;
    renderEditor();
    markProviderDirty();
}
async function addCliProvider(kind){
    if(!confirmDiscardKeyProfileDraft()) return;
    const preset = CLI_PROVIDER_PRESETS[kind];
    if(!preset) return;
    keyProfiles.reset();
    recommendInlineOpen = false;
    syncRecommendView();
    renderRecommendApi();
    syncEditor();
    // 仅按固定 ID 查找。按协议复用会把正在编辑的其他 CLI 平台误当作新平台。
    let item = providers.find(provider => provider.id === preset.id);
    if(!item){
        item = {
            id:preset.id,
            name:preset.name,
            base_url:'',
            protocol:preset.protocol,
            image_request_mode:'openai',
            image_edit_route:'general',
            image_generation_endpoint:'',
            image_edit_endpoint:'',
            enabled:true,
            primary:false,
            image_models:[],
            chat_models:[],
            video_models:[],
            model_protocols:{},
            has_key:false,
            key_preview:''
        };
        providers.push(item);
    }
    item.id = preset.id;
    item.name = item.name || preset.name;
    item.base_url = '';
    item.protocol = preset.protocol;
    if(preset.protocol === 'jimeng'){
        item.image_models = unique([...(item.image_models || []).filter(model => !JIMENG_LEGACY_IMAGE_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_IMAGE_MODELS]);
        item.video_models = unique([...(item.video_models || []).filter(model => !JIMENG_LEGACY_VIDEO_MODELS.has(String(model || '').trim())), ...JIMENG_DEFAULT_VIDEO_MODELS]);
        item.chat_models = unique(item.chat_models || []);
    } else {
        applyCliProtocolDefaults(item, preset.protocol);
    }
    selectedId = item.id;
    renderProviderList();
    renderEditor();
    if(protocolInput) protocolInput.value = preset.protocol;
    markProviderDirty();
    const ok = await saveProviders();
    if(ok){
        selectedId = item.id;
        renderEditor();
        if(protocolInput) protocolInput.value = preset.protocol;
        setStatus(`${preset.name} 已添加，使用本机登录态，无需填写 API Key。`);
        refreshCliSidebarStatus(preset.protocol);
    }
}
function deleteProvider(){
    const item = provider();
    if(!item) return;
    if(isFixedProvider(item)){ alert(tr('api.defaultNoDelete') || '默认平台不能删除'); return; }
    if(providers.length <= 1){ alert(tr('api.keepOne')); return; }
    if(!confirm(trf('api.confirmDeleteProvider', {name:item.name || item.id}))) return;
    syncEditor();
    providers = providers.filter(p => p.id !== item.id);
    selectedId = providers[0]?.id || '';
    renderEditor();
    markProviderDirty();
    saveProviders();
}
async function saveVolcengineAssetKeys(){
    const item = provider();
    if(!item || item.id !== 'volcengine') return;
    const ak = volcAkInput?.value.trim() || '';
    const sk = volcSkInput?.value.trim() || '';
    if(!ak && !sk){ alert('请输入火山素材库 AK 或 SK'); return; }
    syncEditor();
    const ok = await saveProviders();
    if(ok){
        if(volcAkInput) volcAkInput.value = '';
        if(volcSkInput) volcSkInput.value = '';
    }
}
async function clearVolcengineAssetKeys(){
    const item = provider();
    if(!item || item.id !== 'volcengine') return;
    if(!confirm('确认清除火山素材库 AK/SK？')) return;
    item._clearVolcengineAccessKey = true;
    item._clearVolcengineSecretKey = true;
    const ok = await saveProviders();
    if(ok){
        if(volcAkInput) volcAkInput.value = '';
        if(volcSkInput) volcSkInput.value = '';
    }
}
function addModel(kind){
    const item = provider();
    const key = ApiSettingsModels.fields[kind];
    item.model_selection_managed = true;
    item[key] = [...(item[key] || []), ''];
    renderModels(kind);
    markProviderDirty();
}
let modelListAutoSaveTimer = null;
function scheduleModelListAutoSave(delay = 500){
    clearTimeout(modelListAutoSaveTimer);
    modelListAutoSaveTimer = setTimeout(async () => {
        const ok = await saveProviders();
        if(ok) setStatus('模型列表已实时同步');
    }, delay);
}
function updateModel(kind, index, value){
    const item = provider();
    if(!item || !ApiSettingsModels.editModel(item, kind, index, value)) return;
    markProviderDirty();
    scheduleModelListAutoSave();
}
function updateModelProtocol(kind, index, value){
    const item = provider();
    if(item && ApiSettingsModels.setProtocol(item, kind, index, value)) markProviderDirty();
}
function removeModel(kind, index){
    const item = provider();
    if(!item || !ApiSettingsModels.editModel(item, kind, index)) return;
    renderModels(kind);
    markProviderDirty();
    scheduleModelListAutoSave(120);
}
async function loadProviders(){
    setStatus(tr('api.loading'));
    try {
        const data = await fetch('/api/providers', {cache:'no-store'}).then(r => r.json());
        providers = data.providers || [];
        selectedId = sortedProviders()[0]?.id || '';
        renderEditor();
        refreshCliSidebarStatuses();
        openRecommendApi();
        setStatus('');
        providerSavedVersion = providerDraftVersion;
        renderProviderSaveState();
    } catch(err) {
        setStatus(tr('api.loadFailed'));
    }
}
function saveProviders(){
    if(providerSavePromise) return providerSavePromise;
    if(keyProfiles.busy()) return keyProfiles.settled().then(saveProviders);
    providerDraftVersion += 1;
    clearTimeout(modelListAutoSaveTimer);
    setProviderSaveBusy(true);
    providerSaveError = '';
    providerSavePromise = Promise.resolve().then(performProviderSave).finally(() => {
        providerSavePromise = null;
        setProviderSaveBusy(false);
        renderProviderSaveState();
    });
    renderProviderSaveState();
    return providerSavePromise;
}
async function performProviderSave(){
    syncEditor();
    const submittedVersion = providerDraftVersion;
    let shellBody = null;
    const prepared = XiaomeiShellKernel.prepareProviders(providers, {
        displayName: modelDisplayName,
        selectedId
    });
    if(prepared.error){
        alert(tr('api.duplicateId'));
        providerSaveError = tr('api.duplicateId');
        return false;
    }
    providers = prepared.providers;
    selectedId = prepared.selectedId || selectedId;
    shellBody = XiaomeiShellKernel.wireProviders(providers);

    setStatus(tr('api.saving'));
    try {
        const res = await fetch('/api/providers', {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(shellBody)
        });
        if(!res.ok) throw new Error((await res.json()).detail || tr('api.saveFailed'));
        const data = await res.json();
        providers = data.providers || providers;
        providers.forEach(item => {
            delete item.api_key;
            delete item.wallet_api_key;
            delete item.volcengine_access_key_id;
            delete item.volcengine_secret_access_key;
            delete item._clearKey;
            delete item._clearWalletKey;
            delete item._clearVolcengineAccessKey;
            delete item._clearVolcengineSecretKey;
        });
        selectedId = providers.find(item => item.id === selectedId || (item.legacy_ids || []).includes(selectedId))?.id || providers[0]?.id || '';
        providerSavedVersion = submittedVersion;
        renderEditor();
        setStatus(tr('api.saved'));
        // 广播变更，画布等其他 iframe 立即重新拉取最新平台/模型列表
        broadcastStudioApiChange('providers-changed');
        return true;
    } catch(err) {
        providerSaveError = err.message || tr('api.saveFailed');
        setStatus(trf('api.saveFailedRetry', {reason:providerSaveError}));
        return false;
    }
}
function escapeHtml(str){
    return String(str || '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
function escapeAttr(str){ return escapeHtml(str).replace(/`/g, '&#96;'); }
window.addEventListener('message', event => {
    if(event.data?.type === 'studio-theme' && window.StudioTheme) window.StudioTheme.set(event.data.theme);
    if(event.data?.type === 'studio-lang' && window.StudioI18n) {
        window.StudioI18n.set(event.data.lang);
        if(recommendInlineOpen) renderRecommendApi();
        else renderEditor();
    }
});
recommendApiOverlay?.addEventListener('mousedown', event => {
    if(event.target === recommendApiOverlay) closeRecommendApi();
});
window.addEventListener('studio-lang-change', () => {
    syncEditor();
    syncRecommendView();
    if(recommendInlineOpen) renderRecommendApi();
    else renderEditor();
});
window.onload = () => {
    // 必须把当前主题传进去：无参调用会被当成 light，摘掉 studio-theme-dark/theme-dark。
    if(window.StudioTheme) window.StudioTheme.apply(window.StudioTheme.get());
    if(window.StudioI18n) window.StudioI18n.apply();
    const updateTypeScale = detail => {
        const scale = Math.max(0.58, Number(detail?.scale) || 1);
        document.documentElement.style.setProperty('--api-type-factor', detail?.mode === 'auto' ? String(Math.max(1, 1 / scale)) : '1');
    };
    window.addEventListener('studio-ui-scale-change', event => updateTypeScale(event.detail));
    const scaleMode = window.StudioScale?.getMode() || 'auto';
    updateTypeScale({mode:scaleMode, scale:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--studio-ui-scale')) || 1});
    const trackProviderEdit = event => {
        const input = event.target;
        if(keyProfiles.isDraftInput(input)){
            renderProviderSaveState();
            return;
        }
        if(input.closest('.model-row') || input.id === 'pickerFilter') return;
        if(input.matches('input, select, textarea') && !input.closest('#comfyuiConfigBlock')) markProviderDirty();
    };
    settingsContent?.addEventListener('input', trackProviderEdit);
    settingsContent?.addEventListener('change', trackProviderEdit);
    syncRecommendView();
    loadProviders();
    // 平台名输入时实时预览生成的 ID
    if(nameInput) nameInput.addEventListener('input', updateIdPreview);
    if(protocolInput) protocolInput.addEventListener('change', event => {
        const item = provider();
        if(keyProfiles.ownsDraft(item) && !providerSupportsKeyProfiles({...item, protocol:protocolInput.value})
            && !confirmDiscardKeyProfileDraft()){
            protocolInput.value = item.protocol;
            event.stopPropagation();
            return;
        }
        clearFetchedModelState();
        syncEditor();
        updateProtocolFromInput();
    });
    if(baseInput) baseInput.addEventListener('input', () => {
        clearFetchedModelState();
        updateIdPreview();
        updateApimartDomesticHint();
    });
    if(imageRequestModeInput) imageRequestModeInput.addEventListener('change', () => {
        clearFetchedModelState();
        const item = provider();
        if(!item) return;
        if(applyLockedRecommendedProtocol(item)){
            if(protocolInput) protocolInput.value = item.protocol;
            imageRequestModeInput.value = item.image_request_mode;
            return;
        }
        item.image_request_mode = normalizeImageRequestMode(imageRequestModeInput.value);
    });
    if(imageEditRouteInput) imageEditRouteInput.addEventListener('change', () => {
        const item = provider();
        if(!item) return;
        item.image_edit_route = normalizeImageEditRoute(imageEditRouteInput.value);
    });
    keyInput.addEventListener('input', () => {
        clearFetchedModelState();
        updateApimartDomesticHint();
    });
};
