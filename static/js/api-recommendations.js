let customRecommendedApis = [];
let customRecommendationsLoaded = false;
let customRecommendationsLoading = false;
let customRecommendationsError = '';
let recommendationEditingId = '';
let recommendationBusy = false;
let recommendationReturnFocus = null;

function getRecommendedApis(){
    const tags = {image:'api.tagImageModels', video:'api.tagVideoModels', chat:'api.tagLlmModels'};
    const baseKey = value => {
        try {
            const url = new URL(String(value || '').trim());
            if(!['http:', 'https:'].includes(url.protocol)) return '';
            return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
        } catch(_) { return ''; }
    };
    const configured = sortedProviders().filter(api => !CLI_PROTOCOLS.has(String(api.protocol || '').toLowerCase()) && baseKey(api.base_url));
    const linked = new Set();
    const recommendations = [...RECOMMENDED_APIS, ...customRecommendedApis.map(api => ({
        ...api, custom:true, category:'allround', tagKeys:api.kinds.map(kind => tags[kind])
    }))];
    const configuredCard = (api, card={}) => ({
        ...card, id:card.id || api.id, name:api.name, base_url:api.base_url,
        protocol:api.protocol, category:'allround', existingProviderId:api.id,
        has_key:Boolean(api.has_key || api.api_key), enabled:api.enabled !== false,
        summary:card.custom ? card.summary : api.base_url,
        tagKeys:Object.entries(tags).filter(([kind]) => (api[`${kind}_models`] || []).length).map(([,tag]) => tag)
    });
    const cards = [];
    recommendations.forEach(card => {
        const existing = configured.find(api => api.id === card.id)
            || configured.find(api => baseKey(api.base_url) === baseKey(card.base_url));
        if(!existing){ cards.push(card); return; }
        if(linked.has(existing.id)){
            if(card.custom){
                const index = cards.findIndex(item => item.existingProviderId === existing.id);
                cards[index] = configuredCard(existing, card);
            }
            return;
        }
        linked.add(existing.id);
        cards.push(configuredCard(existing, card));
    });
    configured.forEach(api => {
        if(!linked.has(api.id)) cards.push(configuredCard(api));
    });
    return cards;
}
function openRecommendedProvider(index){
    const api = getRecommendedApis()[index];
    if(api?.existingProviderId && visibleProviders().some(item => item.id === api.existingProviderId)){
        selectProvider(api.existingProviderId);
    }
}
function recommendationAddCardHtml(){
    return `<button type="button" class="recommend-add-card" onclick="${customRecommendationsError ? 'loadCustomRecommendedApis(true)' : 'openRecommendationEditor()'}" ${customRecommendationsLoading ? 'disabled' : ''}>
        <i data-lucide="${customRecommendationsError ? 'refresh-cw' : 'plus'}" class="w-6 h-6"></i>
        <strong>${escapeHtml(tr(customRecommendationsLoading ? 'api.loading' : customRecommendationsError ? 'api.retryRecommendations' : 'api.addRecommendation'))}</strong>
        <span>${escapeHtml(customRecommendationsError || tr('api.addRecommendationHint'))}</span>
    </button>`;
}
function renderRecommendationsKeepingKeys(){
    const keys = new Map();
    const apis = getRecommendedApis();
    recommendPanel?.querySelectorAll('[data-recommend-key]').forEach(input => {
        const api = apis[Number(input.dataset.recommendKey)];
        if(api) keys.set(api.id, input.value);
    });
    return () => {
        renderRecommendApi();
        getRecommendedApis().forEach((api, index) => {
            const input = recommendPanel?.querySelector(`[data-recommend-key="${index}"]`);
            if(input && keys.has(api.id)) input.value = keys.get(api.id);
        });
    };
}
async function recommendationRequest(url, options){
    const response = await fetch(url, options);
    const data = await response.json();
    if(!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : tr('api.saveFailed'));
    if(!Array.isArray(data.items)) throw new Error(tr('api.recommendationsLoadFailed'));
    return data.items;
}
async function loadCustomRecommendedApis(force=false){
    if(customRecommendationsLoading || (customRecommendationsLoaded && !force)) return;
    customRecommendationsLoading = true;
    customRecommendationsError = '';
    renderRecommendationsKeepingKeys()();
    try {
        const items = await recommendationRequest('/api/recommended-apis', {cache:'no-store'});
        const render = renderRecommendationsKeepingKeys();
        customRecommendedApis = items;
        customRecommendationsLoaded = true;
        render();
    } catch(error) {
        customRecommendationsError = `${tr('api.recommendationsLoadFailed')} ${error.message}`;
    } finally {
        customRecommendationsLoading = false;
        renderRecommendationsKeepingKeys()();
    }
}
function openRecommendationEditor(id=''){
    if(!customRecommendationsLoaded || customRecommendationsLoading || recommendationBusy) return;
    const form = document.getElementById('recommendationForm');
    const api = customRecommendedApis.find(item => item.id === id);
    if(id && !api) return;
    recommendationEditingId = id;
    recommendationReturnFocus = document.activeElement;
    form.reset();
    for(const field of ['name','base_url','register_url','summary','protocol','image_request_mode']){
        if(api) form.elements[field].value = api[field] || '';
    }
    form.querySelectorAll('[name="kinds"]').forEach(input => input.checked = (api?.kinds || ['image','video','chat']).includes(input.value));
    document.getElementById('recommendationEditorTitle').textContent = tr(id ? 'api.editRecommendation' : 'api.addRecommendation');
    document.getElementById('recommendationError').textContent = '';
    const overlay = document.getElementById('recommendationEditor');
    overlay.style.display = 'flex';
    form.elements.name.focus();
}
function closeRecommendationEditor(){
    if(recommendationBusy) return;
    document.getElementById('recommendationEditor').style.display = 'none';
    if(recommendationReturnFocus?.isConnected) recommendationReturnFocus.focus();
    else recommendPanel?.querySelector('.recommend-add-card')?.focus();
}
async function submitRecommendation(event){
    event.preventDefault();
    if(recommendationBusy) return;
    const form = event.currentTarget;
    if(!form.reportValidity()) return;
    const errorEl = document.getElementById('recommendationError');
    errorEl.textContent = '';
    const payload = Object.fromEntries(['name','base_url','register_url','summary','protocol','image_request_mode'].map(key => [key,form.elements[key].value.trim()]));
    payload.kinds = [...form.querySelectorAll('[name="kinds"]:checked')].map(input => input.value);
    if(!payload.kinds.length){ errorEl.textContent = tr('api.chooseRecommendationKinds'); return; }
    for(const field of ['base_url','register_url']){
        if(!payload[field] && field === 'register_url') continue;
        try {
            const url = new URL(payload[field]);
            if(!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(payload[field])) throw new Error();
        } catch(_) { errorEl.textContent = tr('api.recommendationUrlInvalid'); form.elements[field].focus(); return; }
    }
    recommendationBusy = true;
    form.querySelector('fieldset').disabled = true;
    try {
        const items = await recommendationRequest('/api/recommended-apis' + (recommendationEditingId ? '/' + encodeURIComponent(recommendationEditingId) : ''), {
            method:recommendationEditingId ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
        });
        const render = renderRecommendationsKeepingKeys();
        customRecommendedApis = items;
        render();
        recommendationBusy = false;
        closeRecommendationEditor();
    } catch(error) {
        errorEl.textContent = `${tr('api.saveFailed')}：${error.message}`;
    } finally {
        recommendationBusy = false;
        form.querySelector('fieldset').disabled = false;
    }
}
async function removeCustomRecommendation(id){
    const api = customRecommendedApis.find(item => item.id === id);
    if(!api || recommendationBusy || !confirm(trf('api.confirmRemoveRecommendation', {name:api.name}))) return;
    recommendationBusy = true;
    try {
        const items = await recommendationRequest('/api/recommended-apis/' + encodeURIComponent(id), {method:'DELETE'});
        const render = renderRecommendationsKeepingKeys();
        customRecommendedApis = items;
        render();
    } catch(error) { alert(`${tr('api.removeRecommendationFailed')}：${error.message}`); }
    finally { recommendationBusy = false; }
}
document.addEventListener('keydown', event => {
    const overlay = document.getElementById('recommendationEditor');
    if(overlay.style.display !== 'flex') return;
    if(event.key === 'Escape'){ event.preventDefault(); closeRecommendationEditor(); }
    if(event.key === 'Tab'){
        const focusable = [...overlay.querySelectorAll('button,input,select,textarea')].filter(el => !el.matches(':disabled'));
        const first = focusable[0], last = focusable.at(-1);
        if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
        else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
    }
});
