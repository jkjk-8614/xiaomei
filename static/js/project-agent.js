(function(){
    'use strict';
    const $ = id => document.getElementById(id);
    const summary = $('projectAgentSummary');
    const drawer = $('projectAgentDrawer');
    const memoryList = $('projectAgentMemoryList');
    const memoryForm = $('projectAgentMemoryForm');
    const settingsBox = $('projectAgentSettings');
    const typeLabels = {goal:'目标', product_fact:'产品信息', constraint:'设计要求', style_preference:'风格偏好', decision:'已选方向', todo:'待办'};
    let projectId = '', canvasId = '', currentState = null, activeToken = 0, requestController = null, editing = null;
    let observed = null, pendingTrigger = '', pendingEvents = [], debounceTimer = 0, changeToken = 0, openingCanvas = false;
    let analysisController = null, suggestionItem = null, shownCount = 0, lastShownAt = 0, queuedSuggestion = null, queuedManual = false, feedbackBusy = false;
    let providerChoices = null, providerLoading = null;
    const shared = new URLSearchParams(location.search).get('shared') === '1';

    function base(){ return '/api/project-agent/projects/' + encodeURIComponent(projectId); }
    function notice(message){
        const target = $('toast');
        if(typeof toast === 'function') toast(message);
        else if(target) target.textContent = message;
    }
    async function api(url, options={}){
        const response = await fetch(url, {...options, headers:{'Content-Type':'application/json', ...(options.headers || {})}});
        const data = await response.json().catch(() => ({}));
        if(!response.ok){
            const error = new Error(data.detail?.message || data.detail || data.message || '操作失败，请重试');
            error.code = data.detail?.code || '';
            throw error;
        }
        return data;
    }
    function clearEdit(){
        editing = null;
        $('projectAgentMemoryText').value = '';
        $('projectAgentMemoryType').value = 'goal';
        memoryForm.querySelector('button[type=submit]').textContent = '记住';
    }
    function makeButton(label, action){
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label; button.addEventListener('click', action);
        return button;
    }
    function renderMemories(){
        memoryList.replaceChildren();
        const memories = (currentState?.memories || []).filter(item => item.status === 'confirmed');
        if(!memories.length){
            const empty = document.createElement('p'); empty.textContent = '还没有项目记忆。你可以在下方添加目标或设计要求。';
            memoryList.append(empty); return;
        }
        for(const memory of memories){
            const row = document.createElement('div'); row.className = 'project-agent-memory';
            const copy = document.createElement('span');
            const label = document.createElement('small'); label.textContent = typeLabels[memory.type] || '项目记忆';
            const text = document.createElement('strong'); text.textContent = memory.text;
            copy.append(label, text);
            const actions = document.createElement('div');
            actions.append(makeButton('修改', () => {
                editing = memory;
                $('projectAgentMemoryType').value = memory.type;
                $('projectAgentMemoryText').value = memory.text;
                memoryForm.querySelector('button[type=submit]').textContent = '保存修改';
                $('projectAgentMemoryText').focus();
            }));
            actions.append(makeButton('删除', async () => {
                if(!confirm('删除这条项目记忆？')) return;
                try { await api(base() + '/memories/' + encodeURIComponent(memory.id) + '?revision=' + memory.revision, {method:'DELETE'}); invalidateSuggestions(); await refresh(); }
                catch(error){notice(error.message);}
            }));
            row.append(copy, actions); memoryList.append(row);
        }
    }
    function addChoice(parent, title, description, name, checked){
        const row = document.createElement('div'); row.className = 'project-agent-setting-row';
        const copy = document.createElement('div'); copy.className = 'project-agent-setting-copy';
        const heading = document.createElement('strong'); heading.textContent = title;
        const hint = document.createElement('small'); hint.textContent = description;
        copy.append(heading, hint);
        const choices = document.createElement('div'); choices.className = 'project-agent-choice';
        choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', title);
        for(const [value, label] of [['on','开启'],['off','关闭']]){
            const option = document.createElement('label');
            const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = value; input.checked = checked === (value === 'on');
            const text = document.createElement('span'); text.textContent = label;
            option.append(input, text); choices.append(option);
        }
        row.append(copy, choices); parent.append(row);
        return {row, hint, on:choices.querySelector('input[value=on]'), off:choices.querySelector('input[value=off]')};
    }
    function addField(parent, title, control){
        const label = document.createElement('label'); label.className = 'project-agent-setting-field';
        const text = document.createElement('span'); text.textContent = title;
        label.append(text, control); parent.append(label);
        return control;
    }
    function renderSettings(){
        settingsBox.replaceChildren();
        if(!currentState) return;
        const settings = currentState.settings || {};
        const form = document.createElement('form'); form.className = 'project-agent-settings-form';
        form.addEventListener('input', event => {if(event.target.name !== 'global_enabled') form.dataset.dirty = '1';});
        form.addEventListener('change', event => {if(event.target.name !== 'global_enabled') form.dataset.dirty = '1';});

        const scope = document.createElement('div'); scope.className = 'project-agent-setting-section';
        const globalChoice = addChoice(scope, '所有项目', '关闭后，所有项目都不会主动提示。选择后立即生效。', 'global_enabled', currentState.global_settings?.enabled !== false);
        const projectChoice = addChoice(scope, '当前项目', '', 'proactive_enabled', settings.proactive_enabled !== false && !settings.paused);
        const updateProjectHint = () => {
            projectChoice.hint.textContent = globalChoice.on.checked
                ? '只影响当前项目，保存设置后生效。'
                : '所有项目已关闭，本项目设置暂不生效。';
        };
        updateProjectHint();
        let projectChoiceChanged = false;
        projectChoice.row.addEventListener('change', () => {projectChoiceChanged = true;});
        globalChoice.row.addEventListener('change', async () => {
            const target = globalChoice.on.checked;
            updateProjectHint();
            if(target === (currentState.global_settings?.enabled !== false)) return;
            const token = activeToken;
            globalChoice.on.disabled = globalChoice.off.disabled = true;
            try {
                const result = await api('/api/project-agent/settings', {method:'PUT',body:JSON.stringify({enabled:target,expected_revision:currentState.global_settings?.revision || 0})});
                if(token !== activeToken) return;
                currentState.global_settings = result;
                if(!target){clearTimeout(debounceTimer); pendingTrigger = ''; pendingEvents = []; invalidateSuggestions();}
                notice(target ? '已开启所有项目的主动建议' : '已关闭所有项目的主动建议');
            } catch(error){
                if(token !== activeToken) return;
                globalChoice.on.checked = currentState.global_settings?.enabled !== false;
                globalChoice.off.checked = !globalChoice.on.checked;
                updateProjectHint(); notice(error.message);
                if(error.code === 'revision_conflict'){
                    try {
                        currentState.global_settings = await api('/api/project-agent/settings');
                        globalChoice.on.checked = currentState.global_settings.enabled !== false;
                        globalChoice.off.checked = !globalChoice.on.checked;
                        updateProjectHint();
                    } catch { /* Keep the last confirmed setting visible. */ }
                }
            } finally {
                if(token === activeToken) globalChoice.on.disabled = globalChoice.off.disabled = false;
            }
        });
        const frequency = document.createElement('select'); frequency.name = 'frequency';
        [['quiet','安静'],['standard','标准'],['active','积极']].forEach(([value,label]) => {frequency.add(new Option(label,value));});
        frequency.value = settings.frequency || 'standard';
        const frequencyRow = document.createElement('div'); frequencyRow.className = 'project-agent-setting-row project-agent-frequency-row';
        addField(frequencyRow, '提醒频率', frequency); scope.append(frequencyRow);
        form.append(scope);

        const analysis = document.createElement('div'); analysis.className = 'project-agent-setting-section';
        const analysisChoice = addChoice(analysis, '联网分析', '开启后可用聊天模型分析画布，可能产生费用。', 'allow_model_analysis', !!settings.allow_model_analysis);
        const options = document.createElement('div'); options.className = 'project-agent-model-options';
        const providers = (providerChoices || (typeof apiProviders !== 'undefined' && Array.isArray(apiProviders) ? apiProviders : [])).filter(item => item.enabled !== false && (item.chat_models || []).length);
        const provider = document.createElement('select'); provider.name = 'provider';
        provider.add(new Option('选择聊天平台',''));
        providers.forEach(item => provider.add(new Option(item.name || item.id, item.id)));
        provider.value = settings.provider || '';
        addField(options, '聊天平台', provider);
        const model = document.createElement('select'); model.name = 'model';
        function fillModels(){
            model.replaceChildren(); model.add(new Option('选择聊天模型',''));
            const item = providers.find(entry => entry.id === provider.value);
            (item?.chat_models || []).forEach(value => model.add(new Option(value,value)));
            model.value = settings.model || '';
        }
        provider.addEventListener('change', () => {fillModels(); model.value = '';}); fillModels();
        addField(options, '聊天模型', model);
        const imageChoice = addChoice(options, '分析图片内容', '模型不能看图时，会根据画布节点和文字给建议。', 'allow_image_analysis', !!settings.allow_image_analysis);
        const limit = document.createElement('input'); limit.type='number'; limit.name='daily_limit'; limit.min='0'; limit.max='100'; limit.required = true; limit.value = String(settings.daily_limit ?? 20);
        addField(options, '每天最多分析次数', limit);
        const usage = document.createElement('small'); usage.className = 'project-agent-usage'; usage.textContent = '今天已分析 ' + (currentState.analysis_today?.count || 0) + ' 次'; options.append(usage);
        analysis.append(options); form.append(analysis);
        const updateOptions = () => {options.hidden = !analysisChoice.on.checked;};
        analysisChoice.row.addEventListener('change', updateOptions); updateOptions();

        const submit = document.createElement('button'); submit.type='submit'; submit.className = 'project-agent-save'; submit.textContent='保存本项目设置'; form.append(submit);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const allow = analysisChoice.on.checked;
            if(allow && !settings.allow_model_analysis && !confirm('联网分析可能产生 API 费用，只会发送当前项目必要内容。确定开启？')) return;
            if(allow && (!provider.value || !model.value)){notice('请先选择聊天平台和模型');return;}
            const payload = {
                expected_revision: currentState.revision,
                proactive_enabled: projectChoiceChanged ? projectChoice.on.checked : settings.proactive_enabled !== false,
                paused: projectChoiceChanged ? false : !!settings.paused,
                frequency:frequency.value,
                allow_model_analysis:allow, allow_image_analysis:allow && imageChoice.on.checked,
                provider:allow ? provider.value : (settings.provider || ''), model:allow ? model.value : (settings.model || ''),
                daily_limit:Number(limit.value), consent:allow,
            };
            try {
                await api(base() + '/settings', {method:'PUT', body:JSON.stringify(payload)});
                clearTimeout(debounceTimer); pendingTrigger = ''; pendingEvents = []; invalidateSuggestions();
                await refresh(); notice('本项目设置已保存');
            } catch(error){notice(error.message); if(error.code === 'revision_conflict') await refresh();}
        });
        settingsBox.append(form);
    }
    function renderProgress(){
        const info = currentState?.progress || {};
        const parts = [];
        if(info.goal) parts.push('已确认目标：' + info.goal);
        if(info.failed_count) parts.push('当前画布有 ' + info.failed_count + ' 个任务失败');
        else if(info.running_count) parts.push('当前画布有 ' + info.running_count + ' 个任务进行中');
        else if(info.result_count) parts.push('当前画布已有 ' + info.result_count + ' 张生成结果，尚未确认完成');
        if(info.todos?.length) parts.push('待办：' + info.todos[0]);
        const progress = $('projectAgentProgress');
        progress.textContent = parts.join('。'); progress.hidden = !parts.length;
        $('projectAgentContinue').hidden = !(info.goal || info.todos?.length);
    }
    function renderSuggestionList(){
        const list = $('projectAgentSuggestionList'); list.replaceChildren();
        const items = (currentState?.suggestions || []).filter(item => item.canvas_id === canvasId &&
            ['ready','dismissed','snoozed'].includes(item.status)).slice(-3).reverse();
        if(!items.length){
            const empty = document.createElement('p'); empty.textContent = '当前没有待处理建议。'; list.append(empty); return;
        }
        for(const item of items){
            const row = document.createElement('div'); row.className = 'project-agent-suggestion-row';
            const title = document.createElement('strong'); title.textContent = item.suggestion?.title || '画布建议';
            const body = document.createElement('span'); body.textContent = item.suggestion?.body || '';
            const why = document.createElement('small');
            why.textContent = {assets_added:'根据当前画布中的新素材',task_failed:'根据当前画布中的失败任务',task_succeeded:'根据当前画布中的生成结果',canvas_opened:'根据已确认的项目待办'}[item.trigger] || '根据当前画布和项目记忆';
            row.append(title,body,why);
            if(item.status === 'ready') row.append(makeButton('查看',() => {drawer.hidden = true; window.closeCanvasAgentPanel?.(); queueSuggestion(item,true);}));
            else row.append(makeButton('恢复',async () => {
                try{
                    await api('/api/project-agent/suggestions/' + encodeURIComponent(item.id) + '/restore',{
                        method:'POST',body:JSON.stringify({project_id:projectId,canvas_id:canvasId,
                            expected_canvas_revision:currentState.canvas_revision,idempotency_key:eventKey()})});
                    await refresh(); notice('建议已恢复');
                }catch(error){notice(error.message);}
            }));
            list.append(row);
        }
    }
    function render(){
        if(!currentState) return;
        summary.hidden = false;
        $('projectAgentName').textContent = currentState.project?.name || '当前项目';
        const goals = currentState.memories.filter(item => item.status === 'confirmed' && item.type === 'goal');
        $('projectAgentGoal').textContent = goals.length ? goals[goals.length-1].text : '还没有确定目标';
        renderProgress(); renderSuggestionList(); renderMemories(); renderSettings();
    }
    async function refresh(){
        if(!projectId || shared) return;
        const token = activeToken;
        try{
            const state = await api(base() + '/state?canvas_id=' + encodeURIComponent(canvasId), {signal:requestController?.signal});
            if(token !== activeToken) return;
            currentState = state; render();
            if(openingCanvas){
                openingCanvas = false;
                if(!pendingTrigger && state.progress?.goal && state.progress?.todos?.length && state.global_settings?.enabled !== false && state.settings?.proactive_enabled && !state.settings?.paused){
                    pendingTrigger = 'canvas_opened'; pendingEvents = [eventKey()];
                    clearTimeout(debounceTimer); debounceTimer = setTimeout(flushEvents,800);
                }
            }
        }catch(error){
            if(error.name !== 'AbortError' && token === activeToken){
                if(drawer && !drawer.hidden) notice(error.message);
                summary.hidden = true;
            }
        }
    }
    function openCanvas(nextCanvas){
        if(shared || !nextCanvas?.id) return;
        const nextProject = String(nextCanvas.project || 'default');
        const nextId = String(nextCanvas.id);
        if(projectId === nextProject && canvasId === nextId && currentState) return;
        activeToken += 1; changeToken += 1;
        requestController?.abort(); analysisController?.abort(); clearTimeout(debounceTimer);
        requestController = new AbortController();
        observed = semanticSnapshot(nextCanvas); pendingTrigger = ''; pendingEvents = []; openingCanvas = true;
        suggestionItem = null; queuedSuggestion = null; queuedManual = false; shownCount = 0; lastShownAt = 0;
        $('projectAgentSuggestion').hidden = true;
        projectId = nextProject; canvasId = nextId; currentState = null; clearEdit();
        drawer.hidden = true; summary.hidden = true;
        void refresh();
    }
    async function loadProviderChoices(){
        if(providerLoading) return providerLoading;
        providerLoading = api('/api/providers', {cache:'no-store'}).then(result => {
            if(!Array.isArray(result.providers)) return;
            providerChoices = result.providers;
            if(!drawer.hidden && settingsBox.querySelector('form')?.dataset.dirty !== '1') renderSettings();
        }).catch(() => {}).finally(() => {providerLoading = null;});
        return providerLoading;
    }
    $('projectAgentOpen')?.addEventListener('click', () => {drawer.hidden = false; void refresh(); void loadProviderChoices();});
    $('projectAgentClose')?.addEventListener('click', () => {drawer.hidden = true; clearEdit();});
    memoryForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('projectAgentMemoryText').value.trim();
        const type = $('projectAgentMemoryType').value;
        if(!text) return;
        try{
            if(editing) await api(base() + '/memories/' + encodeURIComponent(editing.id), {method:'PATCH',body:JSON.stringify({revision:editing.revision,type,text})});
            else await api(base() + '/memories', {method:'POST',body:JSON.stringify({type,text,canvas_id:canvasId})});
            invalidateSuggestions(); clearEdit(); await refresh();
        }catch(error){notice(error.message); if(error.code === 'revision_conflict') await refresh();}
    });
    $('projectAgentReset')?.addEventListener('click', async () => {
        if(!confirm('清空当前项目的目标、要求和待办？这个操作不会删除画布。')) return;
        try {await api(base() + '/reset', {method:'POST',body:JSON.stringify({confirm:true})}); invalidateSuggestions(); clearEdit(); await refresh();}
        catch(error){notice(error.message);}
    });
    window.addEventListener('smart-canvas-config-ready', () => {if(currentState) renderSettings();});
    const semanticSnapshot = window.ProjectAgentEvents.snapshot;
    const semanticTrigger = window.ProjectAgentEvents.trigger;
    function eventKey(){
        return globalThis.crypto?.randomUUID?.() || ('evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    }
    function savedCanvas(saved){
        if(shared || !saved?.id || String(saved.id) !== canvasId) return;
        if(String(saved.project || 'default') !== projectId){openCanvas(saved);return;}
        const next = semanticSnapshot(saved);
        const trigger = semanticTrigger(observed, next);
        observed = next;
        if(!trigger) return;
        changeToken += 1; analysisController?.abort();
        void refresh();
        if(suggestionItem) hideSuggestion();
        const priority = {task_failed:10, assets_added:9, task_succeeded:8, node_deleted:5, node_added:4, prompt_committed:3, connection_changed:2, node_content_changed:1};
        if(!pendingTrigger || (priority[trigger] || 0) > (priority[pendingTrigger] || 0)) pendingTrigger = trigger;
        pendingEvents.push(eventKey()); pendingEvents = pendingEvents.slice(-20);
        clearTimeout(debounceTimer); debounceTimer = setTimeout(flushEvents,4000);
    }
    function blockedForSuggestion(){
        return document.hidden || $('canvasAgentPanel')?.classList.contains('open') ||
            $('shell')?.classList.contains('panning') || $('shell')?.classList.contains('canvas-zooming') ||
            !!document.querySelector('.image-edit-modal.open,.canvas-agent-panel.is-running');
    }
    async function flushEvents(){
        clearTimeout(debounceTimer);
        if(!pendingTrigger || !observed || shared || currentState?.global_settings?.enabled === false || !currentState?.settings?.proactive_enabled || currentState?.settings?.paused) return;
        if(blockedForSuggestion()){
            debounceTimer = setTimeout(flushEvents,4000); return;
        }
        const trigger = pendingTrigger, ids = pendingEvents.slice(), token = activeToken, version = changeToken;
        pendingTrigger = ''; pendingEvents = [];
        analysisController?.abort(); analysisController = new AbortController();
        try{
            const data = await api('/api/project-agent/analyze', {method:'POST',signal:analysisController.signal,
                body:JSON.stringify({project_id:projectId, canvas_id:canvasId, canvas_revision:observed.revision,
                    trigger, event_ids:ids, snapshot_digest:'', mode:'automatic'})});
            if(token !== activeToken || version !== changeToken || data.project_id !== projectId || data.canvas_id !== canvasId ||
                data.canvas_revision !== observed.revision || !data.suggestion) return;
            queueSuggestion(data.suggestion);
            void refresh();
        }catch(error){
            if(error.name !== 'AbortError' && error.code === 'project_mismatch'){
                hideSuggestion(); currentState = null; summary.hidden = true;
            }
        }
    }
    function invalidateSuggestions(){
        analysisController?.abort(); changeToken += 1; queuedSuggestion = null; queuedManual = false; hideSuggestion();
    }
    function hideSuggestion(){
        $('projectAgentSuggestion').hidden = true;
        $('projectAgentSuggestion').replaceChildren();
        suggestionItem = null;
    }
    function queueSuggestion(item,manual=false){
        if(!item || item.status !== 'ready' || (!manual && shownCount >= 3)) return;
        queuedSuggestion = item; queuedManual = manual;
        tryShowQueued();
    }
    function tryShowQueued(){
        if(!queuedSuggestion || (!queuedManual && shownCount >= 3) || (!queuedManual && currentState?.global_settings?.enabled === false) || blockedForSuggestion() || suggestionItem) return;
        const frequency = currentState?.settings?.frequency || 'standard';
        const interval = {quiet:600000,standard:300000,active:120000}[frequency] || 300000;
        const delay = queuedManual ? 0 : lastShownAt + interval - Date.now();
        if(delay > 0){setTimeout(tryShowQueued,delay);return;}
        const item = queuedSuggestion, manual = queuedManual; queuedSuggestion = null; queuedManual = false; suggestionItem = item;
        const card = $('projectAgentSuggestion'); card.replaceChildren();
        const title = document.createElement('strong'); title.textContent = item.suggestion?.title || '小美建议';
        const body = document.createElement('p'); body.textContent = item.suggestion?.body || '';
        const close = makeButton('×',() => void feedbackSuggestion('dismiss'));
        close.className = 'project-agent-suggestion-close'; close.setAttribute('aria-label','关闭建议');
        const actions = document.createElement('div'); actions.className = 'project-agent-suggestion-actions';
        for(const option of (item.suggestion?.options || []).slice(0,3)){
            actions.append(makeButton(option.label,() => void feedbackSuggestion('accept',option.key)));
        }
        actions.append(makeButton('稍后',() => void feedbackSuggestion('snooze')));
        card.append(close,title,body,actions); card.hidden = false;
        if(!manual){shownCount += 1; lastShownAt = Date.now();}
    }
    function prepareAgentDraft(result){
        if(!result?.draft) return;
        const panel = $('canvasAgentPanel');
        if(!panel?.classList.contains('open')) $('canvasAgentToggle')?.click();
        const input = $('canvasAgentInput');
        if(!input) return;
        input.value = result.draft;
        input.dispatchEvent(new Event('input',{bubbles:true}));
        const plan = $('canvasAgentPlanMode');
        if(plan && plan.checked !== !!result.plan_mode){
            plan.checked = !!result.plan_mode;
            plan.dispatchEvent(new Event('change',{bubbles:true}));
        }
        input.focus({preventScroll:true});
    }
    async function feedbackSuggestion(action,optionKey=''){
        if(!suggestionItem || feedbackBusy) return;
        if(action === 'accept' && $('canvasAgentInput')?.value.trim() && !confirm('输入框已有内容，要用这条建议替换吗？')) return;
        const item = suggestionItem, token = activeToken;
        feedbackBusy = true;
        try{
            const result = await api('/api/project-agent/suggestions/' + encodeURIComponent(item.id) + '/feedback',{
                method:'POST', body:JSON.stringify({project_id:projectId,canvas_id:canvasId,action,
                    option_key:optionKey,expected_canvas_revision:item.canvas_revision,idempotency_key:eventKey()})});
            if(token !== activeToken) return;
            hideSuggestion();
            await refresh();
            if(action === 'accept') prepareAgentDraft(result);
        }catch(error){
            if(token === activeToken){hideSuggestion(); notice(error.message);}
        }finally{feedbackBusy = false;}
    }
    $('canvasAgentToggle')?.addEventListener('click', () => {
        if(suggestionItem) hideSuggestion();
        setTimeout(tryShowQueued,0);
    });
    document.addEventListener('visibilitychange', () => {
        if(!document.hidden){if(pendingTrigger) void flushEvents(); tryShowQueued();}
    });

    $('projectAgentContinue')?.addEventListener('click', () => {
        if($('canvasAgentInput')?.value.trim() && !confirm('输入框已有内容，要用接着做的草稿替换吗？')) return;
        const info = currentState?.progress || {};
        const notes = (currentState?.memories || []).filter(item => item.status === 'confirmed' && ['constraint','product_fact','style_preference'].includes(item.type)).slice(-6).map(item => item.text);
        let draft = '请根据当前画布和本项目已确认的目标，先给我可编辑的下一步方案，说明会影响哪些节点和生成任务，不要直接执行。';
        if(info.goal) draft += '\n目标：' + info.goal;
        if(info.todos?.length) draft += '\n待办：' + info.todos.slice(0,3).join('；');
        if(notes.length) draft += '\n设计要求：' + notes.join('；');
        drawer.hidden = true;
        prepareAgentDraft({draft,plan_mode:true});
    });
    window.addEventListener('pagehide', () => {requestController?.abort(); analysisController?.abort(); clearTimeout(debounceTimer);});

    window.ProjectAgent = {openCanvas, savedCanvas, refresh};
    if(typeof canvas !== 'undefined' && canvas?.id) openCanvas(canvas);
})();
