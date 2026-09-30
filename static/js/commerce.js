(() => {
    'use strict';

    const WORKFLOW_GROUPS = [
        {id:'main', label:'主流程'},
        {id:'batch', label:'批量生产'},
        {id:'edit', label:'局部处理'}
    ];
    const WORKFLOWS = [
        {id:'detail', group:'main', label:'一键主图', icon:'layout-template', desc:'智能分析产品名称与卖点，先生成可编辑的主图提示词方案。'},
        {id:'detail-v4', group:'main', label:'一键详情页', icon:'panels-top-left', desc:'智能分析产品信息，先生成可编辑、可确认的详情页分段提示词。'},
        {id:'batch', group:'batch', label:'自定分批', icon:'layers-3', desc:'每行一个提示词，共用参考素材，按队列批量生成。'},
        {id:'replicate', group:'batch', label:'批量复制', icon:'copy', desc:'每张参考图建立独立任务，可复刻版式、替换产品或统一改尺寸。'},
        {id:'sku', group:'batch', label:'批量 SKU', icon:'package', desc:'每张产品图配合同一 SKU 模板，生成统一系列视觉。'},
        {id:'scene-crop', group:'edit', label:'局部裁切', icon:'crop', desc:'先在本地选取场景区域，再结合产品素材生成局部构图。'},
        {id:'redraw', group:'edit', label:'局部重绘', icon:'brush', desc:'在原图上涂抹遮罩，只重绘指定区域。'}
    ];
    const DEFAULT_PROMPTS = {
        detail:'生成专业电商视觉。产品图用于锁定产品外观，参考图仅用于风格、配色和版式。不要改变产品型号、结构、颜色或品牌标识。',
        'detail-v4':'生成一套高完成度电商详情视觉，整套风格统一但构图不重复。产品图用于锁定产品一致性，参考图只用于设计风格。',
        batch:'产品白底主图，柔和阴影\n生活方式场景图，突出核心卖点\n材质细节微距特写',
        replicate:'复刻参考图的构图和排版，将参考图中的产品替换为上传的产品，保持产品外观一致，其他内容尽量不变。',
        sku:'图1是当前产品图，图2是统一 SKU 模板。替换模板中的产品，并按对应属性修改名称型号，其他布局保持不变。',
        'scene-crop':'将选定区域替换为产品图中的产品，保持场景光线、透视、阴影和产品比例自然一致。',
        redraw:'只修改遮罩涂抹区域，未涂抹区域保持完全不变。'
    };
    const DETAIL_FONT_OPTIONS = [
        {value:'auto',label:'自动判断'},
        {value:'sans',label:'现代中性无衬线'},
        {value:'humanist',label:'人文柔和无衬线'},
        {value:'rounded',label:'圆润可爱字体'},
        {value:'serif',label:'典雅简约衬线'},
        {value:'song',label:'现代宋意字体'},
        {value:'brush',label:'新中式毛笔字'},
        {value:'tech',label:'几何科技字体'},
        {value:'industrial',label:'工业力量字体'},
        {value:'handwritten',label:'潮流手写展示字体'}
    ];
    const DETAIL_MODEL_MODES = new Set(['none','use']);
    const COMMERCE_IMAGE_CONCURRENCY = 2;
    function normalizeDetailV4Values(values){
        if(!values||typeof values!=='object')return;
        if(!DETAIL_FONT_OPTIONS.some(option=>option.value===values.font))values.font='auto';
        if(!DETAIL_MODEL_MODES.has(values.modelMode))values.modelMode='none';
    }
    const state = {
        active:'detail', providers:[], tasks:[], segments:{detail:[],'detail-v4':[]}, running:false, stopped:false, analyzing:false, planning:false, assetItems:[], assetLibraries:[], assetLibraryId:'', assetCategoryId:'', assetTarget:null,
        pools:{products:[], references:[], batchRefs:[], replicateRefs:[], replicateProducts:[], skuProducts:[], skuTemplate:[], scene:[], sceneProducts:[], redraw:[]},
        values:{
            detail:{prompt:DEFAULT_PROMPTS.detail,workflow:'淘宝 / 主图',count:8,language:'中文',productName:'',userRequirements:'',sellingPoints:''},
            'detail-v4':{prompt:DEFAULT_PROMPTS['detail-v4'],count:11,language:'中文',productName:'',userRequirements:'',sellingPoints:'',copyMode:'required',richness:'medium',font:'auto',modelMode:'none',modelPose:'normal',modelUsage:4,insertReverse:0},
            batch:{prompt:DEFAULT_PROMPTS.batch,count:1}, replicate:{prompt:DEFAULT_PROMPTS.replicate,mode:'replicate',count:1},
            sku:{prompt:DEFAULT_PROMPTS.sku,attributes:'',count:1}, 'scene-crop':{prompt:DEFAULT_PROMPTS['scene-crop'],crop:{x:18,y:18,w:64,h:64}},
            redraw:{prompt:DEFAULT_PROMPTS.redraw,brush:32,mask:''}
        },
        common:{provider:'',model:'',ratio:'1:1',resolution:'2K',quality:'auto',background:'opaque',requestMode:'async'},
        planner:{provider:'',model:''}, planningStartedAt:0, planningError:'', promptGenerationActive:false,
        skills:[], skillId:'', skillQuery:'', skillLoading:false, skillError:'', skillInstructionsFor:'', skillInstructions:'',
        resultColumns:6,resultReverse:false,formGroups:{},longPreviewUrl:'',longPreviewBlob:null,editingTaskIndex:null,merchantBatchIdempotency:'',merchantBatchTaskCap:0
    };
    const PREFERENCES_KEY='xiaomei_commerce_preferences_v1';
    const sharedSkillApi=window.StudioSharedSkill||null;
    const SHARED_SKILL_KEY=sharedSkillApi?.KEY||'xiaomei_agent_skill_selection_v1';
    try{
        const saved=JSON.parse(localStorage.getItem(PREFERENCES_KEY)||'null');
        if(saved&&typeof saved==='object'){
            if(WORKFLOWS.some(item=>item.id===saved.active))state.active=saved.active;
            state.common={...state.common,...(saved.common||{})};
            state.planner={...state.planner,...(saved.planner||{})};
            state.resultColumns=Math.max(5,Math.min(8,Number(saved.resultColumns)||6));
            state.resultReverse=Boolean(saved.resultReverse);
            state.formGroups=saved.formGroups&&typeof saved.formGroups==='object'?saved.formGroups:{};
            state.skillId=String(saved.skillId||'').trim();
            for(const [key,value] of Object.entries(saved.values||{}))if(state.values[key]&&value&&typeof value==='object')state.values[key]={...state.values[key],...value};
            for(const key of ['detail','detail-v4'])if(Array.isArray(saved.segments?.[key]))state.segments[key]=saved.segments[key];
        }
    }catch(error){}
    state.common.background=state.common.background==='transparent'?'transparent':'opaque';
    normalizeDetailV4Values(state.values['detail-v4']);
    try{state.skillId=sharedSkillApi?.getSelected?.()||state.skillId||'';}catch(error){}
    const requestedWorkflow = new URLSearchParams(location.search).get('workflow');
    if(WORKFLOWS.some(item => item.id === requestedWorkflow)) state.active = requestedWorkflow;

    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const attr = esc;
    function merchantChatUserId(){
        const key='gpt_chat_browser_user';
        try{let id=String(localStorage.getItem(key)||'').trim();if(id)return id;id=window.crypto?.randomUUID?.()||`u-${Date.now()}-${Math.random().toString(16).slice(2)}`;localStorage.setItem(key,id);return id;}catch(error){return 'anonymous';}
    }
    const workflow = () => WORKFLOWS.find(item => item.id === state.active) || WORKFLOWS[0];
    const valueState = () => state.values[state.active];
    const isPromptWorkflow = () => state.active === 'detail' || state.active === 'detail-v4';
    const currentSegments = () => state.segments[state.active] || [];
    const groupStorageKey = id => `${state.active}:${id}`;
    function isFormGroupOpen(id){
        const stored=state.formGroups[groupStorageKey(id)];
        return typeof stored==='boolean'?stored:true;
    }
    function setFormGroupOpen(id,open){
        state.formGroups[groupStorageKey(id)]=Boolean(open);
        savePreferences();
    }
    const unique = list => [...new Set((list || []).map(v => String(v || '').trim()).filter(Boolean))];
    function sharedSkillId(){
        try{return sharedSkillApi?.getSelected?.()||String(localStorage.getItem(SHARED_SKILL_KEY)||'').trim();}catch(error){return state.skillId||'';}
    }
    function selectedSkill(){return state.skills.find(skill=>skill.id===state.skillId&&skill.enabled!==false)||null;}
    function renderSharedSkillStatus(){
        const text=$('sharedSkillStatusText'),button=$('sharedSkillStatus');
        if(!text||!button)return;
        const skill=selectedSkill();
        text.textContent=skill?.name||'通用助手';
        button.classList.toggle('selected',Boolean(skill));
        button.title=skill?`当前共享 Skill：${skill.name} · 点击切换`:'当前未选择 Skill · 点击选择并与小美画布同步';
    }
    function savePreferences(){
        const skillId=state.skillId||sharedSkillId();
        try{localStorage.setItem(PREFERENCES_KEY,JSON.stringify({active:state.active,common:state.common,planner:state.planner,values:state.values,segments:state.segments,resultColumns:state.resultColumns,resultReverse:state.resultReverse,formGroups:state.formGroups,skillId}));}catch(error){}
    }
    let preferenceSaveTimer=0;
    function schedulePreferencesSave(){clearTimeout(preferenceSaveTimer);preferenceSaveTimer=setTimeout(savePreferences,250);}

    function toast(message, type=''){
        const item = document.createElement('div'); item.className=`toast ${type}`; item.textContent=message;
        $('toastRegion').appendChild(item); setTimeout(()=>item.remove(),4200);
    }
    function refreshIcons(){ try{ lucide.createIcons(); }catch(e){} }
    function isModelScopeProvider(provider){
        const id=String(provider?.id||'').trim().toLowerCase();
        const name=String(provider?.name||'').trim().toLowerCase();
        return id==='modelscope'||name.includes('modelscope');
    }
    function providerList(){ return state.providers.filter(p => p.enabled !== false && !isModelScopeProvider(p) && unique(p.image_models).length); }
    function currentProvider(){ return providerList().find(p => p.id === state.common.provider) || providerList()[0]; }
    function currentModels(){ return unique(currentProvider()?.image_models || []); }
    function plannerProviderList(){return state.providers.filter(p=>p.enabled!==false&&!isModelScopeProvider(p)&&p.has_key&&unique(p.chat_models).length);}
    function currentPlannerProvider(){return plannerProviderList().find(p=>p.id===state.planner.provider)||plannerProviderList()[0]||null;}
    function currentPlannerModels(){return unique(currentPlannerProvider()?.chat_models||[]);}
    function plannerFields(){
        const disabled=state.analyzing||state.planning?'disabled':'';
        return `<div class="field"><label>分析/策划 API</label><select class="select" data-planner="provider" ${disabled}>${plannerProviderList().map(p=>`<option value="${attr(p.id)}" ${p.id===state.planner.provider?'selected':''}>${esc(p.name||p.id)}</option>`).join('')}</select></div><div class="field"><label>分析/策划模型</label><select class="select" data-planner="model" ${disabled}>${currentPlannerModels().map(model=>`<option value="${attr(model)}" ${model===state.planner.model?'selected':''}>${esc(model)}</option>`).join('')}</select></div>`;
    }
    function modelFamily(model){
        const id=String(model||'').toLowerCase();
        if(/gemini|imagen|nano.?banana|veo/.test(id)) return 'Google / Gemini';
        if(/gpt|dall.?e|o[134](?:-|$)/.test(id)) return 'OpenAI / GPT';
        if(/seedream|doubao|即梦|jimeng/.test(id)) return '字节 / 即梦';
        return '其他模型';
    }
    function isGptImage25Model(model){
        const raw=String(model||'').trim().toLowerCase();
        const normalized=raw.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
        return /(?:^|-)gpt-image-2-5(?:-(?:flare|sunburst))?(?:-|$)/.test(normalized);
    }
    function groupedModelOptions(){
        const groups=new Map(); currentModels().forEach(model=>{const key=modelFamily(model); if(!groups.has(key))groups.set(key,[]); groups.get(key).push(model);});
        return [...groups].map(([label,models])=>`<optgroup label="${attr(label)}">${models.map(model=>`<option value="${attr(model)}" ${model===state.common.model?'selected':''}>${esc(model)}</option>`).join('')}</optgroup>`).join('');
    }
    function commonFields(options={}){
        const showCount=options.count !== false;
        const countValue=Math.max(1,Math.min(options.maxCount||99,Math.trunc(Number(valueState().count)||1)));
        const countField=showCount?`<div class="field"><label>${esc(options.countLabel||'生成数量')}</label><input class="select" type="number" min="1" max="${options.maxCount||99}" step="1" inputmode="numeric" data-value="count" value="${countValue}" title="可自定义 1 至 ${options.maxCount||99} ${esc(options.countUnit||'张')}"></div>`:'';
        const gpt25=isGptImage25Model(state.common.model);
        const qualityOptions=[['auto','自动'],['low','快速'],['medium','标准'],['high','高质量']];
        if(gpt25)qualityOptions.push(['xhigh','极高'],['max','最高']);
        const qualityValue=qualityOptions.some(([value])=>value===state.common.quality)?state.common.quality:'auto';
        const backgroundValue=['opaque','transparent'].includes(state.common.background)?state.common.background:'opaque';
        const backgroundField=gpt25?`<div class="field"><label>背景</label><select class="select" data-common="background"><option value="opaque" ${backgroundValue==='opaque'?'selected':''}>不透明</option><option value="transparent" ${backgroundValue==='transparent'?'selected':''}>透明</option></select></div>`:'';
        const planner=isPromptWorkflow()?`<div class="parameter-subgroup"><div class="parameter-subgroup-head"><strong>策划模型</strong><span>用于分析产品和生成可编辑的提示词方案</span></div><div class="form-grid planner-grid">${plannerFields()}</div></div>`:'';
        const requestMode=!isPromptWorkflow()?`<div class="field"><label>任务模式</label><select class="select" data-common="requestMode"><option value="async" ${state.common.requestMode==='async'?'selected':''}>异步（推荐）</option><option value="sync" ${state.common.requestMode==='sync'?'selected':''}>同步</option></select></div>`:'';
        return `<section class="form-section form-section-generation"><div class="section-title"><div class="section-heading"><h3>生成参数</h3><span>图片模型与分析模型均来自 API 设置实时列表</span></div><span class="section-status">${esc(state.common.requestMode==='sync'?'同步执行':'异步执行')}</span></div><div class="parameter-subgroup"><div class="parameter-subgroup-head"><strong>出图参数</strong><span>决定生成画幅、清晰度与任务数量</span></div><div class="form-grid">
            <div class="field"><label>API 平台</label><select class="select" data-common="provider">${providerList().map(p=>`<option value="${attr(p.id)}" ${p.id===state.common.provider?'selected':''}>${esc(p.name||p.id)}</option>`).join('')}</select></div>
            <div class="field"><label>图片模型</label><select class="select" data-common="model">${groupedModelOptions()}</select></div>
            <div class="field"><label>画面比例</label><select class="select" data-common="ratio">${['1:1','4:5','3:4','2:3','9:16','5:4','4:3','3:2','16:9','21:9'].map(v=>`<option ${v===state.common.ratio?'selected':''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label>清晰度</label><select class="select" data-common="resolution">${['1K','2K','4K'].map(v=>`<option ${v===state.common.resolution?'selected':''}>${v}</option>`).join('')}</select></div>
             <div class="field"><label>生成质量</label><select class="select" data-common="quality">${qualityOptions.map(([value,label])=>`<option value="${value}" ${qualityValue===value?'selected':''}>${label}</option>`).join('')}</select></div>
             ${countField}${requestMode}${backgroundField}
        </div></div>${planner}</section>`;
    }
    function uploadSection(pool,title,subtitle,max=4,compact=false){
        const items=state.pools[pool] || [];
        const unlimited=!Number(max);const countText=unlimited?`${items.length} 张 · 不限数量`:`${items.length}/${max} 张`;
        return `<section class="form-section asset-section"><div class="section-title asset-section-title"><div class="section-heading"><h3>${esc(title)}</h3><span>${esc(subtitle)}</span></div><div class="section-title-actions"><span class="asset-count">${esc(countText)}</span><button class="asset-link" type="button" data-asset-pool="${attr(pool)}" data-asset-max="${unlimited?0:max}" aria-label="从素材库添加${attr(title)}"><i data-lucide="folder-open"></i><span>素材库</span></button></div></div><div class="upload-grid ${compact?'compact':''}">
            ${items.map((item,index)=>`<div class="upload-card"><img src="${attr(item.preview||item.url)}" alt="${attr(item.name||title)}"><button class="upload-remove" type="button" data-remove-pool="${attr(pool)}" data-index="${index}" title="移除"><i data-lucide="x"></i></button></div>`).join('')}
            ${unlimited||items.length<max?`<label class="upload-card add-upload"><span class="upload-empty"><i data-lucide="image-plus"></i><span>添加图片</span><small>拖入或点击</small></span><input type="file" accept="image/*" multiple data-upload-pool="${attr(pool)}" data-max="${unlimited?0:max}"></label>`:''}
        </div></section>`;
    }
    function promptField(label='提示词',tall=true){return `<div class="field full"><label>${esc(label)}</label><textarea class="textarea ${tall?'tall':''}" data-value="prompt">${esc(valueState().prompt||'')}</textarea></div>`;}
    function formGroup(id,title,description,body,options={}){
        const summary=String(options.summary||'').trim();
        return `<details class="form-group ${attr(options.className||'')}" data-form-group="${attr(id)}" ${isFormGroupOpen(id)?'open':''}>
            <summary class="form-group-summary">
                <span class="form-group-step">${esc(options.step||'')}</span>
                <span class="form-group-heading"><strong>${esc(title)}</strong><small>${esc(description)}</small></span>
                ${summary?`<span class="form-group-meta">${esc(summary)}</span>`:''}
                <i data-lucide="chevron-down" class="form-group-chevron"></i>
            </summary>
            <div class="form-group-body">${body}</div>
        </details>`;
    }
    function formShell(body,action){return `<div class="form-shell"><div class="form-stack">${body}</div>${action||''}</div>`;}
    function assetGroupSummary(){return `产品图 ${state.pools.products.length} · 参考图 ${state.pools.references.length}`;}
    function detailDesignSummary(d){return `${d.language||'中文'} · ${d.copyMode==='none'?'无文案':d.copyMode==='empty'?'预留文案':'需要文案'} · ${d.modelMode==='none'?'无模特':'含模特'}`;}
    function generationGroupSummary(options={}){return `${state.common.ratio||'1:1'} · ${state.common.resolution||'2K'} · ${Math.max(1,Math.trunc(Number(valueState().count)||1))} ${options.countUnit||'项'}`;}
    function contentGroupSummary(d){
        const name=String(d.productName||'').trim();
        const points=String(d.sellingPoints||'').trim();
        return name?(points?'产品名 · 卖点已填':'已填写产品名'):'待填写产品信息';
    }
    function generateRow(label='开始生成'){
        return `<div class="generate-row form-action-bar"><button class="primary-btn" id="generateBtn" type="button" ${state.running?'disabled':''}><i data-lucide="sparkles"></i> ${state.running?'任务进行中…':esc(label)}</button>${state.running?`<button class="stop-btn" id="stopBtn" type="button"><i data-lucide="square"></i>停止队列</button>`:''}</div>`;
    }
    function markdownImportControl(){
        const imported=valueState().importedPlanName,currentCount=currentSegments().length,skill=selectedSkill();
        const summary=state.skillLoading?'正在读取共享 Skill 库…':skill?`已关联：${skill.name} · ${skill.category_label||'视觉策划'}`:'未选择 · 默认使用通用电商规划规则';
        const importedText=imported?`已导入 Markdown：${imported} · ${currentCount}${state.active==='detail'?' 组':' 段'}`:'也可导入 SKILL.md / Markdown 作为当前策划草稿';
        return `<section class="shared-skill-card ${skill?'is-selected':''}">
            <span class="shared-skill-icon"><i data-lucide="blocks"></i></span>
            <div class="shared-skill-copy"><strong>共享 Skill</strong><span>${esc(summary)}</span><small>${esc(importedText)}</small></div>
            <div class="shared-skill-actions"><button class="shared-skill-select" type="button" data-open-skill-picker><i data-lucide="sparkles"></i>${skill?'更换 Skill':'选择 Skill'}</button><label class="shared-skill-import" title="导入 Markdown 策划草稿"><i data-lucide="file-up"></i><span>导入 Markdown</span><input id="mdPlanInput" type="file" accept=".md,.markdown,text/markdown,text/plain"></label></div>
        </section>`;
    }
    function renderSkillPicker(){
        const listEl=$('skillList'),emptyEl=$('skillEmpty'),countEl=$('skillCount');
        if(!listEl||!emptyEl||!countEl)return;
        const query=String(state.skillQuery||'').trim().toLocaleLowerCase();
        const visible=state.skills.filter(skill=>{
            if(!query)return true;
            return [skill.name,skill.display_name,skill.description,skill.category_label,skill.status_label].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
        });
        countEl.textContent=query?`${visible.length} / ${state.skills.length}`:`${state.skills.length} 个`;
        if(state.skillLoading){emptyEl.textContent='正在读取 Skill 库…';emptyEl.style.display='block';listEl.innerHTML='';return;}
        if(state.skillError){emptyEl.textContent=state.skillError;emptyEl.style.display='block';listEl.innerHTML='';return;}
        emptyEl.textContent=state.skills.length?(visible.length?'':'没有匹配的 Skill，换个关键词试试。'):'暂无可用 Skill';
        emptyEl.style.display=visible.length?'none':'block';
        listEl.innerHTML=visible.map(skill=>{
            const disabled=skill.enabled===false,active=skill.id===state.skillId;
            const stateLabel=disabled?'已停用':skill.has_scripts?'脚本待适配':skill.status==='warning'?'有警告':skill.status_label||'对话可用';
            const statusClass=disabled?'off':stateLabel==='有警告'||stateLabel==='脚本待适配'?'warn':'';
            return `<button type="button" class="skill-option ${active?'active ':''}${disabled?'disabled':''}" data-shared-skill-id="${attr(skill.id)}" ${disabled?'disabled':''} aria-pressed="${active?'true':'false'}"><span class="skill-option-icon"><i data-lucide="sparkles"></i></span><span class="skill-option-copy"><strong>${esc(skill.name||skill.display_name||'未命名 Skill')}</strong><small><i class="skill-status-dot ${statusClass}"></i>${esc(skill.category_label||'自定义')} · ${esc(stateLabel)}</small><em>${esc(skill.description||'暂无简介')}</em></span><span class="skill-option-action">${disabled?'已停用':active?'当前':'使用'}</span></button>`;
        }).join('');
        refreshIcons();
    }
    function openSkillPicker(){
        const dialog=$('skillPicker');if(!dialog)return;
        state.skillQuery='';if($('skillSearch'))$('skillSearch').value='';renderSkillPicker();
        if(!dialog.open){try{dialog.showModal();}catch(error){dialog.setAttribute('open','');}}
    }
    function selectSharedSkill(skillId){
        const id=String(skillId||'').trim(),skill=state.skills.find(item=>item.id===id&&item.enabled!==false);
        if(id&&!skill)return;
        state.skillId=state.skillId===id?'':id;
        state.skillInstructionsFor='';state.skillInstructions='';
        if(sharedSkillApi?.setSelected)sharedSkillApi.setSelected(state.skillId);
        else{try{localStorage.setItem(SHARED_SKILL_KEY,state.skillId);}catch(error){}}
        savePreferences();renderSharedSkillStatus();renderSkillPicker();renderForm();
        toast(state.skillId?`已启用共享 Skill：${skill?.name||state.skillId}`:'已切换为通用助手');
    }
    async function loadSharedSkillLibrary(){
        state.skillLoading=true;state.skillError='';renderSkillPicker();
        try{
            const result=sharedSkillApi?.load?await sharedSkillApi.load():await fetch('/api/agent-skills',{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error(`Skill API ${response.status}`);return response.json();});
            state.skills=Array.isArray(result)?result:(result?.skills||[]);
            let selected=sharedSkillApi?.getSelected?.()||'';
            if(!selected&&state.skillId&&state.skills.some(skill=>skill.id===state.skillId&&skill.enabled!==false)){selected=state.skillId;if(sharedSkillApi?.setSelected)sharedSkillApi.setSelected(selected);}
            if(state.skills.some(skill=>skill.id===selected&&skill.enabled!==false))state.skillId=selected;
            else{state.skillId='';if(selected&&sharedSkillApi?.setSelected)sharedSkillApi.setSelected('');}
        }catch(error){state.skills=[];state.skillError='Skill 服务暂未加载，请重启一次小美画布服务。';console.warn('[commerce] shared Skill load failed',error);}
        finally{state.skillLoading=false;renderSharedSkillStatus();renderSkillPicker();renderForm();}
    }
    async function sharedSkillPrompt(){
        const id=state.skillId||sharedSkillId();
        if(!id)return '';
        if(state.skillInstructionsFor===id)return state.skillInstructions||'';
        const text=sharedSkillApi?.instructions?await sharedSkillApi.instructions(id):await fetch(`/api/agent-skills/${encodeURIComponent(id)}`,{cache:'no-store'}).then(response=>response.ok?response.json():{}).then(data=>String(data?.instructions||'')).catch(()=> '');
        state.skillInstructionsFor=id;state.skillInstructions=String(text||'').trim();
        return state.skillInstructions;
    }
    function detailForm(){const d=valueState(); return `<div class="form-stack">${uploadSection('products','产品图','支持多张上传，不限制数量',0,true)}${uploadSection('references','参考图（多屏截图最佳）','风格、配色、版式参考，不限制数量',0,true)}<div class="preset-row"><button class="ghost-btn" id="saveDetailPreset" type="button"><i data-lucide="save"></i>保存预设</button><button class="ghost-btn" id="loadDetailPreset" type="button"><i data-lucide="folder-open"></i>加载预设</button></div><section class="form-section"><div class="section-title"><h3>基础参数</h3><span>用于规划主图提示词</span></div><div class="form-grid"><div class="field"><label>工作流</label><select class="select" data-value="workflow"><optgroup label="淘宝"><option value="淘宝 / 主图" ${d.workflow==='淘宝 / 主图'?'selected':''}>淘宝 / 主图</option></optgroup><optgroup label="亚马逊"><option value="亚马逊 / 主图" ${d.workflow==='亚马逊 / 主图'?'selected':''}>亚马逊 / 主图</option></optgroup></select></div><div class="field"><label>输出语言</label><input class="input" data-value="language" value="${attr(d.language||'中文')}"></div></div></section>${commonFields({countLabel:'提示词数量',countUnit:'组'})}<section class="form-section"><div class="section-title"><h3>内容输入（可选）</h3><span>智能分析仅供参考，可手动修改</span></div><button class="analysis-btn" id="analyzeProduct" type="button" ${state.analyzing||!state.pools.products.length?'disabled':''}><i data-lucide="wand-sparkles"></i>${state.analyzing?'正在分析产品…':'智能分析产品名称和卖点'}</button><div class="form-grid content-fields"><div class="field full"><label>产品名称</label><input class="input" data-value="productName" value="${attr(d.productName||'')}" placeholder="例：蓝牙耳机"></div><div class="field full"><label>用户要求</label><textarea class="textarea" data-value="userRequirements" placeholder="产品特征、是否使用模特、是否指定字体、是否不生成文字等">${esc(d.userRequirements||'')}</textarea></div><div class="field full"><label>产品卖点</label><textarea class="textarea tall" data-value="sellingPoints" placeholder="例：防水、轻便、续航 12 小时">${esc(d.sellingPoints||'')}</textarea></div></div></section><div class="generate-row"><button class="primary-btn" id="planPrompts" type="button" ${state.planning?'disabled':''}><i data-lucide="rocket"></i>${state.planning?'正在生成主图提示词…':'生成主图提示词'}</button></div></div>`;}
    function detailV4Form(){const d=valueState(); return `<div class="form-stack">${uploadSection('products','产品图（包含模特）','产品图、参考图均不限制数量',0,true)}${uploadSection('references','参考图（设计风格参考）','风格、配色、版式参考，不限制数量',0,true)}<div class="preset-row"><button class="ghost-btn" id="saveDetailPreset" type="button"><i data-lucide="save"></i>保存预设</button><button class="ghost-btn" id="loadDetailPreset" type="button"><i data-lucide="folder-open"></i>加载预设</button></div><section class="form-section"><div class="section-title"><h3>详情页设计参数</h3><span>先规划分段提示词，不会直接生图</span></div><div class="form-grid"><div class="field"><label>输出语言</label><input class="input" data-value="language" value="${attr(d.language||'中文')}"></div><div class="field"><label>文案设置</label><select class="select" data-value="copyMode"><option value="required" ${d.copyMode==='required'?'selected':''}>需要文案</option><option value="empty" ${d.copyMode==='empty'?'selected':''}>预留文案区域</option><option value="none" ${d.copyMode==='none'?'selected':''}>无文案纯海报</option></select></div><div class="field"><label>画面丰富度</label><select class="select" data-value="richness"><option value="concise" ${d.richness==='concise'?'selected':''}>精简</option><option value="medium" ${d.richness==='medium'?'selected':''}>中等</option><option value="rich" ${d.richness==='rich'?'selected':''}>丰富</option></select></div><div class="field"><label>字体风格</label><select class="select" data-value="font">${DETAIL_FONT_OPTIONS.map(option=>`<option value="${option.value}" ${d.font===option.value?'selected':''}>${option.label}</option>`).join('')}</select></div><div class="field"><label>模特设置</label><select class="select" data-value="modelMode"><option value="none" ${d.modelMode==='none'?'selected':''}>无模特</option><option value="use" ${d.modelMode==='use'?'selected':''}>允许使用模特</option></select></div><div class="field"><label>模特姿态</label><select class="select" data-value="modelPose" ${d.modelMode==='none'?'disabled':''}><option value="normal" ${d.modelPose==='normal'?'selected':''}>常规姿态</option><option value="dynamic" ${d.modelPose==='dynamic'?'selected':''}>动态展示</option><option value="closeup" ${d.modelPose==='closeup'?'selected':''}>局部特写</option></select></div><div class="field"><label>模特使用量</label><select class="select" data-value="modelUsage" ${d.modelMode==='none'?'disabled':''}>${[1,2,3,4,5,6].map(v=>`<option value="${v}" ${Number(d.modelUsage)===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>插入反转屏</label><select class="select" data-value="insertReverse">${[0,1,2,3,4].map(v=>`<option value="${v}" ${d.insertReverse===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field full"><label>补充要求</label><textarea class="textarea" data-value="prompt">${esc(d.prompt||'')}</textarea></div></div></section>${commonFields({countLabel:'分段数量',countUnit:'段',maxCount:12})}<section class="form-section"><div class="section-title"><h3>内容输入（可选）</h3><span>智能分析仅供参考，可手动修改</span></div><button class="analysis-btn" id="analyzeProduct" type="button" ${state.analyzing||!state.pools.products.length?'disabled':''}><i data-lucide="wand-sparkles"></i>${state.analyzing?'正在分析产品…':'智能分析产品名称和卖点'}</button><div class="form-grid content-fields"><div class="field full"><label>产品名称</label><input class="input" data-value="productName" value="${attr(d.productName||'')}" placeholder="例：香槟金相框"></div><div class="field full"><label>用户要求</label><textarea class="textarea" data-value="userRequirements" placeholder="详情页结构、文案、人物、字体及禁止事项">${esc(d.userRequirements||'')}</textarea></div><div class="field full"><label>产品卖点</label><textarea class="textarea tall" data-value="sellingPoints" placeholder="例：圆润边角、稳固支撑、横竖两用">${esc(d.sellingPoints||'')}</textarea></div></div></section><div class="generate-row"><button class="primary-btn" id="planPrompts" type="button" ${state.planning?'disabled':''}><i data-lucide="rocket"></i>${state.planning?'正在生成分段提示词…':'生成分段提示词'}</button></div></div>`;}
    function contentInputSection(d,namePlaceholder='例：蓝牙耳机',sellingPlaceholder='例：防水、轻便、续航 12 小时',requirementsPlaceholder='产品特征、是否使用模特、是否指定字体、是否不生成文字等'){
        return `<section class="form-section content-section"><div class="section-title"><div class="section-heading"><h3>内容输入</h3><span>智能分析仅供参考，生成前可手动修改</span></div><span class="section-status">可选</span></div><button class="analysis-btn" id="analyzeProduct" type="button" ${state.analyzing||!state.pools.products.length?'disabled':''}><i data-lucide="wand-sparkles"></i>${state.analyzing?'正在分析产品…':'自动提取产品名称与卖点'}</button><div class="form-grid content-fields"><div class="field full"><label>产品名称</label><input class="input" data-value="productName" value="${attr(d.productName||'')}" placeholder="${attr(namePlaceholder)}"></div><div class="field full"><label>用户要求</label><textarea class="textarea" data-value="userRequirements" placeholder="${attr(requirementsPlaceholder)}">${esc(d.userRequirements||'')}</textarea></div><div class="field full"><label>产品卖点</label><textarea class="textarea tall" data-value="sellingPoints" placeholder="${attr(sellingPlaceholder)}">${esc(d.sellingPoints||'')}</textarea></div></div></section>`;
    }
    function detailFormV2(){
        const d=valueState();
        const assets=`${markdownImportControl()}${uploadSection('products','产品图','用于锁定产品外观与结构',0,true)}${uploadSection('references','参考图','用于参考风格、配色与版式',0,true)}<div class="preset-row"><button class="ghost-btn" id="saveDetailPreset" type="button"><i data-lucide="save"></i>保存预设</button><button class="ghost-btn" id="loadDetailPreset" type="button"><i data-lucide="folder-open"></i>加载预设</button></div>`;
        const design=`<section class="form-section"><div class="section-title"><div class="section-heading"><h3>基础策略</h3><span>先确定平台场景和提示词语言</span></div></div><div class="form-grid"><div class="field"><label>工作流</label><select class="select" data-value="workflow"><optgroup label="淘宝"><option value="淘宝 / 主图" ${d.workflow==='淘宝 / 主图'?'selected':''}>淘宝 / 主图</option></optgroup><optgroup label="亚马逊"><option value="亚马逊 / 主图" ${d.workflow==='亚马逊 / 主图'?'selected':''}>亚马逊 / 主图</option></optgroup></select></div><div class="field"><label>输出语言</label><input class="input" data-value="language" value="${attr(d.language||'中文')}"></div></div></section>`;
        const body=`${formGroup('assets','素材与参考','产品图锁定产品，参考图控制视觉方向',assets,{step:'01',summary:assetGroupSummary()})}${formGroup('design','主图策略','确定平台、语言和内容输入方式',design,{step:'02',summary:`${d.workflow||'淘宝 / 主图'} · ${d.language||'中文'}`})}${formGroup('generation','生成参数','设置模型、画幅、清晰度和提示词数量',commonFields({countLabel:'提示词数量',countUnit:'组'}),{step:'03',summary:generationGroupSummary({countUnit:'组'})})}${formGroup('content','内容输入','补充产品名称、用户要求和卖点',contentInputSection(d),{step:'04',summary:contentGroupSummary(d)})}`;
        return formShell(body,`<div class="generate-row form-action-bar"><button class="primary-btn" id="planPrompts" type="button" ${state.planning?'disabled':''}><i data-lucide="rocket"></i>${state.planning?'正在生成主图提示词…':'生成主图提示词'}</button></div>`);
    }
    function detailV4FormV2(){
        const d=valueState();
        const assets=`${markdownImportControl()}${uploadSection('products','产品图','产品本体与原有模特来源',0,true)}${uploadSection('references','参考图','设计风格、配色与版式参考',0,true)}<div class="preset-row"><button class="ghost-btn" id="saveDetailPreset" type="button"><i data-lucide="save"></i>保存预设</button><button class="ghost-btn" id="loadDetailPreset" type="button"><i data-lucide="folder-open"></i>加载预设</button></div>`;
        const design=`<section class="form-section design-section"><div class="section-title"><div class="section-heading"><h3>详情页设计参数</h3><span>先规划分段提示词，不会直接生图</span></div><span class="section-status">${d.modelMode==='none'?'无模特':'含模特'}</span></div><div class="form-grid"><div class="field"><label>输出语言</label><input class="input" data-value="language" value="${attr(d.language||'中文')}"></div><div class="field"><label>文案设置</label><select class="select" data-value="copyMode"><option value="required" ${d.copyMode==='required'?'selected':''}>需要文案</option><option value="empty" ${d.copyMode==='empty'?'selected':''}>预留文案区域</option><option value="none" ${d.copyMode==='none'?'selected':''}>无文案纯海报</option></select></div><div class="field"><label>画面丰富度</label><select class="select" data-value="richness"><option value="concise" ${d.richness==='concise'?'selected':''}>精简</option><option value="medium" ${d.richness==='medium'?'selected':''}>中等</option><option value="rich" ${d.richness==='rich'?'selected':''}>丰富</option></select></div><div class="field"><label>字体风格</label><select class="select" data-value="font">${DETAIL_FONT_OPTIONS.map(option=>`<option value="${option.value}" ${d.font===option.value?'selected':''}>${option.label}</option>`).join('')}</select></div><div class="field"><label>模特设置</label><select class="select" data-value="modelMode"><option value="none" ${d.modelMode==='none'?'selected':''}>无模特</option><option value="use" ${d.modelMode==='use'?'selected':''}>允许使用模特</option></select></div><div class="field"><label>模特姿态</label><select class="select" data-value="modelPose" ${d.modelMode==='none'?'disabled':''}><option value="normal" ${d.modelPose==='normal'?'selected':''}>常规姿态</option><option value="dynamic" ${d.modelPose==='dynamic'?'selected':''}>动态展示</option><option value="closeup" ${d.modelPose==='closeup'?'selected':''}>局部特写</option></select></div><div class="field"><label>模特使用量</label><select class="select" data-value="modelUsage" ${d.modelMode==='none'?'disabled':''}>${[1,2,3,4,5,6].map(v=>`<option value="${v}" ${Number(d.modelUsage)===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>插入反转屏</label><select class="select" data-value="insertReverse">${[0,1,2,3,4].map(v=>`<option value="${v}" ${Number(d.insertReverse)===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field full"><label>补充要求</label><textarea class="textarea" data-value="prompt">${esc(d.prompt||'')}</textarea></div></div></section>`;
        const body=`${formGroup('assets','素材与参考','先加入产品图，再用参考图锁定整套视觉风格',assets,{step:'01',summary:assetGroupSummary()})}${formGroup('design','设计方向','控制文案、丰富度、字体和模特使用方式',design,{step:'02',summary:detailDesignSummary(d)})}${formGroup('generation','生成参数','设置出图模型、画幅、清晰度和分段数量',commonFields({countLabel:'分段数量',countUnit:'段',maxCount:12}),{step:'03',summary:generationGroupSummary({countUnit:'段'})})}${formGroup('content','内容输入','补充产品信息，让策划模型更准确',contentInputSection(d,'例：香槟金相框','例：圆润边角、稳固支撑、横竖两用','详情页结构、文案、人物、字体及禁止事项'),{step:'04',summary:contentGroupSummary(d)})}`;
        return formShell(body,`<div class="generate-row form-action-bar"><button class="primary-btn" id="planPrompts" type="button" ${state.planning?'disabled':''}><i data-lucide="rocket"></i>${state.planning?'正在生成分段提示词…':'生成分段提示词'}</button></div>`);
    }
    function generationCount(){return Math.max(1,Math.min(99,Math.trunc(Number(valueState().count)||1)));}
    function batchTaskTotal(){const lines=String(valueState().prompt||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean).length;return lines*generationCount();}
    function replicateTaskTotal(){return state.pools.replicateRefs.length*generationCount();}
    function skuTaskTotal(){return state.pools.skuProducts.length*generationCount();}
    function batchForm(){
        const prompt=`<section class="form-section"><div class="section-title"><div class="section-heading"><h3>提示词列表</h3><span>每行建立一个独立任务</span></div></div>${promptField('每行一个提示词')}<p class="hint">空行会自动忽略；建议先用 1–2 行测试模型兼容性。</p></section>`;
        const body=`${formGroup('assets','统一参考图','所有提示词共同使用，可选',uploadSection('batchRefs','统一参考图','所有提示词共同使用，可选',4),{step:'01',summary:`${state.pools.batchRefs.length} 张`})}${formGroup('prompt','提示词列表','把每条需求拆成独立任务',prompt,{step:'02',summary:`${String(valueState().prompt||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean).length} 条`})}${formGroup('generation','生成参数','设置图片模型与队列方式',commonFields({countLabel:'每条生成数量',countUnit:'张'}),{step:'03',summary:generationGroupSummary({countUnit:'条'})})}`;
        return formShell(body,generateRow(`开始 ${batchTaskTotal()} 个任务`));
    }
    function replicateForm(){
        const d=valueState(),assets=`${uploadSection('replicateRefs','参考图','每张参考图对应一个任务',20,true)}${uploadSection('replicateProducts','产品图','所有任务共同使用，可选',4)}`;
        const rules=`<section class="form-section"><div class="mode-switch"><button type="button" data-mode="replicate" class="${d.mode==='replicate'?'active':''}">批量复制</button><button type="button" data-mode="resize" class="${d.mode==='resize'?'active':''}">批量改尺寸</button></div><div class="form-grid" style="margin-top:12px">${promptField('复制要求')}</div></section>`;
        const body=`${formGroup('assets','素材输入','参考图建立任务，产品图作为统一替换来源',assets,{step:'01',summary:`${state.pools.replicateRefs.length} 参考 · ${state.pools.replicateProducts.length} 产品`})}${formGroup('prompt','处理方式','选择批量复制或统一改尺寸',rules,{step:'02',summary:d.mode==='resize'?'批量改尺寸':'批量复制'})}${formGroup('generation','生成参数','设置图片模型与生成数量',commonFields({countLabel:'每张生成数量',countUnit:'张'}),{step:'03',summary:generationGroupSummary({countUnit:'图'})})}`;
        return formShell(body,generateRow(`开始 ${replicateTaskTotal()} 个任务`));
    }
    function skuForm(){
        const d=valueState(),assets=`${uploadSection('skuProducts','产品图','每张产品图对应一个 SKU 任务',20,true)}${uploadSection('skuTemplate','SKU 模板','统一系列版式',1)}`;
        const rules=`<section class="form-section"><div class="form-grid">${promptField('SKU 替换规则')}<div class="field full"><label>SKU 属性（可选，每行对应一张产品图）</label><textarea class="textarea" data-value="attributes" placeholder="红色 / 128GB\n蓝色 / 256GB">${esc(d.attributes||'')}</textarea></div></div></section>`;
        const body=`${formGroup('assets','SKU 素材','产品图与统一模板保持同一系列',assets,{step:'01',summary:`${state.pools.skuProducts.length} 产品 · ${state.pools.skuTemplate.length} 模板`})}${formGroup('prompt','替换规则','设定名称、属性和版式替换方式',rules,{step:'02',summary:d.attributes?'已填写属性':'可选属性'})}${formGroup('generation','生成参数','设置图片模型与每个 SKU 的数量',commonFields({countLabel:'每个 SKU 生成数量',countUnit:'张'}),{step:'03',summary:generationGroupSummary({countUnit:'SKU'})})}`;
        return formShell(body,generateRow(`开始 ${skuTaskTotal()} 个任务`));
    }
    function sceneCropForm(){
        const scene=state.pools.scene[0],c=valueState().crop;
        const crop=scene?`<section class="form-section"><div class="crop-stage"><img src="${attr(scene.preview||scene.url)}" id="cropImage"><div class="crop-box" id="cropBox" style="left:${c.x}%;top:${c.y}%;width:${c.w}%;height:${c.h}%"></div></div><div class="crop-controls">${[['x','左边'],['y','顶部'],['w','宽度'],['h','高度']].map(([key,label])=>`<label class="range-field"><span>${label}<b id="crop-${key}-value">${c[key]}%</b></span><input type="range" min="0" max="100" value="${c[key]}" data-crop="${key}"></label>`).join('')}</div></section>`:'';
        const body=`${formGroup('assets','素材输入','先选择场景，再加入需要融入的产品',`${uploadSection('scene','场景图','选择需要重新构图的局部',1)}${uploadSection('sceneProducts','产品图','用于替换或融入场景，可选',4)}`,{step:'01',summary:`${state.pools.scene.length} 场景 · ${state.pools.sceneProducts.length} 产品`})}${formGroup('crop','裁切区域','拖动参数选择需要重新构图的部分',`${crop}<section class="form-section">${promptField('局部构图要求')}</section>`,{step:'02',summary:scene?'已选择场景':'待选择场景'})}${formGroup('generation','生成参数','设置图片模型与任务模式',commonFields({count:false}),{step:'03',summary:generationGroupSummary({countUnit:'次'})})}`;
        return formShell(body,generateRow('裁切并生成'));
    }
    function redrawForm(){
        const image=state.pools.redraw[0];
        const edit=image?`<section class="form-section"><div class="paint-stage" id="paintStage"><img id="paintImage" src="${attr(image.preview||image.url)}"><canvas id="maskCanvas"></canvas></div><div class="brush-row"><span class="mask-note">画笔大小</span><input type="range" min="8" max="100" value="${valueState().brush||32}" id="brushSize"><button class="ghost-btn" id="clearMask" type="button"><i data-lucide="eraser"></i>清空遮罩</button></div><p class="hint">红色区域代表将被模型重绘；没有涂抹时不会提交任务。</p></section>`:'';
        const rules=`${edit}<section class="form-section">${promptField('重绘要求')}</section>`;
        const body=`${formGroup('assets','待编辑图片','上传需要修复的原图',uploadSection('redraw','待编辑图片','涂抹需要重绘的区域',1),{step:'01',summary:image?'已选择图片':'待选择图片'})}${formGroup('edit','局部编辑','调整遮罩和重绘要求',rules,{step:'02',summary:valueState().mask?'已绘制遮罩':'未绘制遮罩'})}${formGroup('generation','生成参数','设置图片模型与任务模式',commonFields({count:false}),{step:'03',summary:generationGroupSummary({countUnit:'次'})})}`;
        return formShell(body,generateRow('开始局部重绘'));
    }
    const FORM_RENDERERS={detail:detailFormV2,'detail-v4':detailV4FormV2,batch:batchForm,replicate:replicateForm,sku:skuForm,'scene-crop':sceneCropForm,redraw:redrawForm};

    function renderTabs(){
        $('workflowTabs').innerHTML=WORKFLOW_GROUPS.map(group=>{
            const items=WORKFLOWS.filter(item=>item.group===group.id);
            if(!items.length)return '';
            return `<div class="workflow-nav-group"><div class="workflow-nav-label">${esc(group.label)}</div>${items.map(item=>`<button type="button" class="workflow-tab ${item.id===state.active?'active':''}" data-workflow="${attr(item.id)}" aria-current="${item.id===state.active?'page':'false'}"><i data-lucide="${item.icon}"></i><span>${esc(item.label)}</span></button>`).join('')}</div>`;
        }).join('');
    }
    function renderForm(){
        const item=workflow(); $('workflowIntro').innerHTML=`<div class="intro-icon"><i data-lucide="${item.icon}"></i></div><div class="intro-copy"><h2>${esc(item.label)}</h2><p>${esc(item.desc)}</p></div>`;
        $('workflowForm').innerHTML=FORM_RENDERERS[state.active]();
        bindForm(); refreshIcons(); renderSharedSkillStatus();
        if(state.active==='redraw' && state.pools.redraw[0]) requestAnimationFrame(setupPaintCanvas);
    }
    function renderTasks(){
        if(isPromptWorkflow()&&!state.promptGenerationActive){
            const segments=currentSegments(),isMain=state.active==='detail',resultName=isMain?'主图提示词':'详情页分段提示词',unit=isMain?'组':'段';
            document.querySelector('.result-head .section-kicker').textContent='提示词策划';$('resultTitle').textContent=resultName; $('taskSummary').textContent=`${segments.length} ${unit}`;
            if(!segments.length){
                const elapsed=state.planning?Math.max(0,Math.floor((Date.now()-state.planningStartedAt)/1000)):0,planner=currentPlannerProvider();
                const failed=!state.planning&&Boolean(state.planningError);
                $('taskList').innerHTML=`<div class="empty-results ${failed?'planning-failed':''}"><i class="${state.planning?'planning-spinner':''}" data-lucide="${state.planning?'loader-circle':failed?'circle-alert':'list-tree'}"></i><strong>${state.planning?`正在生成${resultName} · ${elapsed} 秒`:failed?`生成${resultName}失败`:`还没有${resultName}`}</strong><span>${state.planning?`正在使用 ${esc(planner?.name||planner?.id||'分析模型')} / ${esc(state.planner.model||'未选择模型')}，图片分析和多组策划可能需要几分钟`:failed?esc(state.planningError):'先智能分析产品，再生成可编辑的提示词；确认后再进行生图'}</span>${failed?'<button type="button" class="planning-retry" data-retry-planning><i data-lucide="refresh-cw"></i>重新生成提示词</button>':''}</div>`;
                refreshIcons();return;
            }
            const selectedCount=segments.filter(segment=>segment.selected!==false).length;
            $('taskList').innerHTML=`<div class="segment-confirm-bar"><span>已选择 <strong>${selectedCount}</strong>/${segments.length} 段</span><div><button type="button" data-select-all-segments>${selectedCount===segments.length?'取消全选':'全选'}</button><button class="confirm-generate-btn" type="button" data-confirm-generate ${selectedCount?'':'disabled'}><i data-lucide="sparkles"></i>确认生成所选分段</button></div></div>${segments.map((segment,index)=>`<article class="segment-card ${segment.selected===false?'segment-unselected':''}"><div class="segment-head"><button class="segment-select ${segment.selected!==false?'selected':''}" type="button" data-toggle-segment="${index}" aria-pressed="${segment.selected!==false}">${segment.selected!==false?'✓':'○'}</button><span class="segment-number">${index+1}</span><div class="segment-title">${esc(segment.title||(isMain?`主图方案 ${index+1}`:`详情分段 ${index+1}`))}</div><span class="segment-purpose">${esc(segment.purpose||(isMain?'主图规划':'详情页规划'))}</span></div><textarea class="segment-text" data-segment-index="${index}">${esc(segment.prompt||'')}</textarea><div class="segment-actions"><span class="confirm-note">${segment.selected!==false?'已确认待生成':'未选择'}</span><button type="button" data-copy-segment="${index}">复制提示词</button></div></article>`).join('')}`;refreshIcons();return;
        }
        document.querySelector('.result-head .section-kicker').textContent='任务队列';$('resultTitle').textContent='生成结果';
        const tasks=state.tasks; $('taskSummary').textContent=`${tasks.length} 项`;
        if(!tasks.length){$('taskList').innerHTML=`<div class="empty-results"><i data-lucide="layers-3"></i><strong>还没有任务</strong><span>上传素材并设置参数后开始生成</span></div>`; refreshIcons(); return;}
        const list=$('taskList'),ratio=String(state.common.ratio||'1:1').split(':').map(Number);list.style.setProperty('--result-columns',state.resultColumns);list.style.setProperty('--task-ratio',`${ratio[0]||1} / ${ratio[1]||1}`);
        const backBar=state.promptGenerationActive?'<div class="segment-confirm-bar"><span>正在显示确认后的生图结果</span><button type="button" data-back-prompts>返回提示词</button></div>':'';
        const successCount=tasks.filter(task=>task.status==='success'&&task.url).length,selectedCount=tasks.filter(task=>task.selected!==false&&task.status==='success'&&task.url).length;
        const toolbar=`<div class="result-batch-toolbar"><div class="result-view-options"><label>每行显示 <select data-result-columns>${[5,6,7,8].map(value=>`<option value="${value}" ${value===state.resultColumns?'selected':''}>${value}</option>`).join('')}</select></label><label class="result-sort"><input type="checkbox" data-result-reverse ${state.resultReverse?'checked':''}>倒序</label></div><div class="result-batch-actions"><button type="button" data-select-all-tasks>${selectedCount===successCount&&successCount?'取消全选':'全选'}</button><button type="button" data-preview-long ${successCount?'':'disabled'}><i data-lucide="panels-top-left"></i>拼图预览</button><button type="button" data-download-all ${successCount?'':'disabled'}><i data-lucide="folder-down"></i>下载全部</button><button type="button" data-download-selected ${selectedCount?'':'disabled'}><i data-lucide="download"></i>下载选中 (${selectedCount})</button></div></div>`;
        const entries=tasks.map((task,index)=>({task,index}));if(state.resultReverse)entries.reverse();
        list.innerHTML=backBar+toolbar+entries.map(({task,index})=>{
            const elapsed=Math.max(0,Math.round((Date.now()-task.startedAt)/1000));
            let media='';
            if(task.status==='success' && task.url) media=`<img src="${attr(task.url)}" alt="生成结果">`;
            else if(task.status==='failed') media=`<div><div class="failed-mark"><i data-lucide="circle-x"></i></div><div class="progress-label">生成失败</div></div>`;
            else {const status=taskStatusDisplay(task,elapsed); media=`<div><div class="progress-ring ${status.phase}"><span>${status.value}</span></div><div class="progress-label">${status.label}</div></div>`;}
            const refs=(task.refs||[]).map((ref,refIndex)=>`<span class="task-ref" title="图${refIndex+1}：${attr(ref.name||'引用图')}"><img src="${attr(ref.url)}" alt="引用图 ${refIndex+1}" loading="lazy"><b>${refIndex+1}</b></span>`).join('');
            const menu=`<details class="task-menu"><summary title="当前屏操作"><i data-lucide="grip-vertical"></i></summary><div><button type="button" data-edit-task-prompt="${index}"><i data-lucide="pencil"></i>修改提示词</button><button type="button" data-retry-task="${index}" ${state.running?'disabled':''}><i data-lucide="refresh-cw"></i>单屏重新生图</button>${task.url?`<a href="${attr(task.url)}" download><i data-lucide="download"></i>下载当前屏</a>`:''}<button type="button" data-copy-prompt="${index}"><i data-lucide="copy"></i>复制提示词</button></div></details>`;
            const zoom=task.url?`<a class="task-zoom" href="${attr(task.url)}" target="_blank" rel="noopener" title="查看大图"><i data-lucide="zoom-in"></i></a>`:'';
            const failedRetry=task.status==='failed'?`<button class="failed-retry" type="button" data-retry-task="${index}" ${state.running?'disabled':''}><i data-lucide="refresh-cw"></i>重新生图</button>`:'';
            return `<article class="task-card ${task.selected!==false?'task-selected':'task-unselected'}"><div class="task-card-head"><span>${String(index+1).padStart(2,'0')}</span><div class="task-head-actions"><button class="task-quick-retry" type="button" data-retry-task="${index}" ${state.running?'disabled':''} title="仅重新生成这一屏"><i data-lucide="refresh-cw"></i></button>${menu}</div></div><div class="task-media"><button class="task-select ${task.selected!==false?'selected':''}" type="button" data-toggle-task="${index}" aria-pressed="${task.selected!==false}" title="选择此图片">${task.selected!==false?'✓':''}</button>${zoom}${media}${failedRetry}</div><div class="task-prompt-wrap"><button class="task-prompt-line" type="button" data-edit-task-prompt="${index}" title="点击修改，悬停查看完整提示词">${esc(task.prompt||'暂无提示词')}</button><div class="task-prompt-popover"><strong>${esc(task.label||`第 ${index+1} 屏`)}</strong><p>${esc(task.prompt||'暂无提示词')}</p><span>点击下方提示词可修改</span></div></div>${refs?`<div class="task-refs">${refs}</div>`:''}${task.error?`<div class="task-error compact">${esc(task.error)}</div>`:''}</article>`;
        }).join(''); refreshIcons();
    }
    function render(){renderTabs();renderForm();renderTasks();}
    function taskStatusDisplay(task,elapsed=0){
        const upstream=String(task?.upstreamStatus||'').trim().toLowerCase();
        if(task?.status==='pending')return {phase:'queued',value:'排队',label:'队列中 · 等待空位'};
        if(upstream==='queued'||upstream==='pending')return {phase:'queued',value:'排队',label:'已提交 · 上游队列中'};
        if(upstream==='running'||upstream==='processing'||upstream==='in_progress')return {phase:'running',value:'等待',label:`上游生成中 · 已等待 ${elapsed}s`};
        return {phase:'submitting',value:'提交',label:`已提交 · 等待上游结果 ${elapsed}s`};
    }

    async function uploadFiles(pool,files,max){
        const target=state.pools[pool]; const unlimited=!Number(max);const room=unlimited?files.length:Math.max(0,max-target.length); const selected=[...files].slice(0,room);
        for(const file of selected){
            const preview=await fileDataUrl(file);
            const form=new FormData(); form.append('files',file);
            try{
                const response=await fetch('/api/ai/upload',{method:'POST',body:form}); const data=await response.json().catch(()=>({}));
                if(!response.ok || !data.files?.[0]) throw new Error(data.detail||'上传失败');
                target.push({...data.files[0],preview,name:file.name});
            }catch(error){toast(`${file.name}：${error.message||'上传失败'}`,'error');}
        }
        renderForm();
    }
    function fileDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
    function cleanPlanTitle(title,index){
        const cleaned=String(title||'').replace(/^\s*(?:第\s*)?\d+\s*(?:屏|段|页|组)?\s*[.、:：)）-]*\s*/,'').replace(/[*_`#]/g,'').trim();
        return cleaned||(state.active==='detail'?`主图方案 ${index+1}`:`详情分段 ${index+1}`);
    }
    function markdownSections(markdown){
        let text=String(markdown||'').replace(/^\uFEFF/,'').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/,'').trim();
        if(!text)return [];
        const lines=text.split(/\r?\n/),headings=[];
        lines.forEach((line,index)=>{const match=line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);if(match)headings.push({index,level:match[1].length,title:match[2].trim()});});
        const counts=headings.reduce((map,item)=>(map[item.level]=(map[item.level]||0)+1,map),{});
        const level=Object.keys(counts).map(Number).sort((a,b)=>a-b).find(value=>counts[value]>=2);
        let sections=[];
        if(level){
            const boundaries=headings.filter(item=>item.level===level);
            sections=boundaries.map((item,index)=>({title:item.title,body:lines.slice(item.index+1,boundaries[index+1]?.index??lines.length).join('\n').trim()}));
        }else{
            const numbered=[];
            lines.forEach((line,index)=>{const match=line.match(/^\s*(?:(?:第\s*)?\d+\s*(?:屏|段|页|组|[.、:：)）-]))\s*(.+?)\s*$/);if(match)numbered.push({index,title:match[1].trim()});});
            if(numbered.length>=2)sections=numbered.map((item,index)=>({title:item.title,body:lines.slice(item.index+1,numbered[index+1]?.index??lines.length).join('\n').trim()}));
            else {
                const chunks=text.split(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m).map(value=>value.trim()).filter(Boolean);
                sections=chunks.map((body,index)=>{const first=body.split(/\r?\n/,1)[0].replace(/^\s*#{1,6}\s+/,'').trim();return {title:chunks.length>1&&first.length<=48?first:'',body:chunks.length>1&&first.length<=48?body.slice(body.indexOf('\n')+1).trim():body};});
            }
        }
        return sections.map((section,index)=>{
            const titleParts=String(section.title||'').split(/\s*[|｜]\s*/,2);
            const title=cleanPlanTitle(titleParts[0],index),purpose=(titleParts[1]||'MD 导入策划').trim();
            const prompt=String(section.body||'').trim()||title;
            return {title,purpose,prompt,selected:true};
        }).filter(section=>section.prompt);
    }
    async function importMarkdownPlan(file){
        if(!file||!isPromptWorkflow())return;
        if(!/\.(?:md|markdown)$/i.test(file.name||'')&&!/markdown|text\/plain/i.test(file.type||''))return toast('请选择 .md 或 .markdown 文件','error');
        try{
            const segments=markdownSections(await file.text());
            if(!segments.length)throw new Error('没有识别到可用的策划内容');
            syncFormValues();state.segments[state.active]=segments;valueState().importedPlanName=file.name;
            state.promptGenerationActive=false;savePreferences();renderForm();renderTasks();
            toast(`已导入 ${segments.length} ${state.active==='detail'?'组主图':'段详情页'}策划，请编辑确认后再生图`);
        }catch(error){toast(`MD 导入失败：${error.message||error}`,'error');}
    }
    function bindForm(){
        document.querySelectorAll('[data-form-group]').forEach(group=>group.addEventListener('toggle',()=>setFormGroupOpen(group.dataset.formGroup,group.open)));
        document.querySelectorAll('[data-open-skill-picker]').forEach(button=>button.addEventListener('click',openSkillPicker));
        document.querySelectorAll('[data-upload-pool]').forEach(input=>input.addEventListener('change',e=>uploadFiles(input.dataset.uploadPool,e.target.files,Number(input.dataset.max))));
        document.querySelectorAll('[data-asset-pool]').forEach(btn=>btn.addEventListener('click',()=>void openAssetPicker(btn.dataset.assetPool,Number(btn.dataset.assetMax))));
        document.querySelectorAll('[data-remove-pool]').forEach(btn=>btn.addEventListener('click',e=>{e.preventDefault();state.pools[btn.dataset.removePool].splice(Number(btn.dataset.index),1);if(btn.dataset.removePool==='redraw')state.values.redraw.mask='';renderForm();}));
        document.querySelectorAll('[data-common]').forEach(input=>input.addEventListener('change',()=>{
            state.common[input.dataset.common]=input.value;
            if(input.dataset.common==='provider'){state.common.model=currentModels()[0]||'';renderForm();}
            else if(input.dataset.common==='model')renderForm();
            savePreferences();
        }));
        document.querySelectorAll('[data-planner]').forEach(input=>input.addEventListener('change',()=>{
            state.planner[input.dataset.planner]=input.value;
            if(input.dataset.planner==='provider'){state.planner.model=currentPlannerModels()[0]||'';renderForm();}
            savePreferences();
        }));
        document.querySelectorAll('[data-value]').forEach(input=>input.addEventListener('change',()=>{
            const key=input.dataset.value;
            valueState()[key]=key==='count'?Math.max(1,Math.min(99,Math.trunc(Number(input.value)||1))):input.value;
            savePreferences();
            if(key==='count')renderForm();
        }));
        document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{valueState().mode=btn.dataset.mode;savePreferences();renderForm();}));
        document.querySelectorAll('[data-crop]').forEach(input=>input.addEventListener('input',()=>{const c=valueState().crop,key=input.dataset.crop;c[key]=Number(input.value);normalizeCrop(c,key);updateCropBox();savePreferences();}));
        $('generateBtn')?.addEventListener('click',()=>void generateActiveWorkflow()); $('stopBtn')?.addEventListener('click',()=>{state.stopped=true;toast('已停止继续提交新任务');});
        $('brushSize')?.addEventListener('input',e=>{valueState().brush=Number(e.target.value);savePreferences();}); $('clearMask')?.addEventListener('click',()=>{valueState().mask='';savePreferences();setupPaintCanvas(true)});
        $('analyzeProduct')?.addEventListener('click',()=>void analyzeProduct());
        $('planPrompts')?.addEventListener('click',()=>void generateSegmentedPrompts());
        $('mdPlanInput')?.addEventListener('change',event=>{const file=event.target.files?.[0];event.target.value='';if(file)void importMarkdownPlan(file);});
        $('saveDetailPreset')?.addEventListener('click',saveDetailPreset);
        $('loadDetailPreset')?.addEventListener('click',loadDetailPreset);
    }
    function normalizeCrop(c,key){if(key==='x')c.x=Math.min(c.x,100-c.w);if(key==='y')c.y=Math.min(c.y,100-c.h);if(key==='w')c.w=Math.min(c.w,100-c.x);if(key==='h')c.h=Math.min(c.h,100-c.y);}
    function updateCropBox(){const c=valueState().crop,box=$('cropBox');if(box)Object.assign(box.style,{left:`${c.x}%`,top:`${c.y}%`,width:`${c.w}%`,height:`${c.h}%`});for(const k of ['x','y','w','h'])if($(`crop-${k}-value`))$(`crop-${k}-value`).textContent=`${c[k]}%`;}

    function setupPaintCanvas(clear=false){
        const img=$('paintImage'),canvas=$('maskCanvas'); if(!img||!canvas)return;
        const init=()=>{canvas.width=img.naturalWidth||1024;canvas.height=img.naturalHeight||1024;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!clear&&valueState().mask){const saved=new Image();saved.onload=()=>ctx.drawImage(saved,0,0,canvas.width,canvas.height);saved.src=valueState().mask;}let drawing=false;
            const point=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}};
            canvas.onpointerdown=e=>{drawing=true;canvas.setPointerCapture(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y)};
            canvas.onpointermove=e=>{if(!drawing)return;const p=point(e);ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='rgba(239,68,68,.72)';ctx.lineWidth=Number(valueState().brush||32)*canvas.width/Math.max(300,canvas.getBoundingClientRect().width);ctx.lineTo(p.x,p.y);ctx.stroke()};
            canvas.onpointerup=()=>{drawing=false;valueState().mask=canvas.toDataURL('image/png')};canvas.onpointercancel=canvas.onpointerup;
        }; if(img.complete)init();else img.onload=init;
    }

    function syncFormValues(){document.querySelectorAll('[data-value]').forEach(input=>{const key=input.dataset.value;valueState()[key]=key==='count'?Number(input.value):input.value;});document.querySelectorAll('[data-common]').forEach(input=>state.common[input.dataset.common]=input.value);document.querySelectorAll('[data-planner]').forEach(input=>state.planner[input.dataset.planner]=input.value);savePreferences();}
    function chatProvider(){
        const candidates=plannerProviderList();
        return candidates.find(p=>p.id===state.planner.provider)||candidates[0]||null;
    }
    function parseModelJson(text){
        const raw=String(text||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
        const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
        if(start<0||end<=start)throw new Error('分析模型没有返回可识别的 JSON');
        return JSON.parse(raw.slice(start,end+1));
    }
    function analysisLabel(text){
        const label=$('analysisLabel');if(label){label.textContent=text;return;}
        const button=$('analyzeProduct');if(!button)return;
        const textNode=[...button.childNodes].reverse().find(node=>node.nodeType===Node.TEXT_NODE);
        if(textNode)textNode.textContent=text;else button.append(document.createTextNode(text));
    }
    async function compactAnalysisImage(url){
        try{
            const response=await fetch(url);if(!response.ok)throw new Error('image fetch failed');
            const bitmap=await createImageBitmap(await response.blob());
            const maxSide=1280,scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
            const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
            canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
            return canvas.toDataURL('image/jpeg',.78);
        }catch(error){return url;}
    }
    async function prepareAnalysisImages(images){return Promise.all(images.filter(Boolean).slice(0,4).map(compactAnalysisImage));}
    async function callTextModel(message,images=[],systemPrompt='',options={}){
        const provider=chatProvider();if(!provider)throw new Error('没有可用的文本/分析模型，请先在 API 设置中拉取聊天模型');
        const models=unique(provider.chat_models),model=models.includes(state.planner.model)?state.planner.model:(models.find(id=>/vision|\bvl\b|gpt-5|gemini|claude/i.test(id))||models[0]);
        const controller=new AbortController(),timeoutMs=Math.max(15000,Number(options.timeoutMs)||360000),timeout=setTimeout(()=>controller.abort(),timeoutMs);
        try{
            const skillText=await sharedSkillPrompt();
            const finalSystemPrompt=[systemPrompt,skillText?`当前共享 Skill 指令（仅用于视觉、内容与事实边界，优先遵循当前电商工作台的 JSON 输出协议）：\n${skillText}`:'',skillText?'当前宿主约束：只返回本次请求要求的严格 JSON；不要输出 Markdown，不要直接生成图片，不要执行 Skill 包内脚本。':''].filter(Boolean).join('\n\n');
            const response=await fetch('/api/canvas-llm',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({message,images:images.filter(Boolean).slice(0,4),provider:provider.id,model,messages:[],system_prompt:finalSystemPrompt,skill_id:state.skillId||''})});
            if(!response.ok)throw new Error(await responseMessage(response));return response.json();
        }catch(error){if(error?.name==='AbortError')throw new Error(`分析超过 ${Math.round(timeoutMs/1000)} 秒，已自动停止，请检查 Comfly 聊天模型或稍后重试`);throw error;}
        finally{clearTimeout(timeout);}
    }
    async function analyzeProduct(){
        if(state.analyzing)return;syncFormValues();const images=refsFrom('products').map(item=>item.url);if(!images.length)return toast('请先上传产品图','error');
        state.analyzing=true;renderForm();const started=Date.now();
        const ticker=setInterval(()=>analysisLabel(`正在分析产品… ${Math.floor((Date.now()-started)/1000)} 秒`),1000);
        try{
            analysisLabel('正在压缩产品图…');
            const preparedImages=await prepareAnalysisImages(images);
            analysisLabel(`正在请求 ${currentPlannerProvider()?.name||currentPlannerProvider()?.id||'所选模型'} 分析…`);
            const result=await callTextModel('分析这些产品图。只返回 JSON，不要 Markdown：{"product_name":"准确、简短的产品名称","selling_points":["基于画面可确认的卖点1","卖点2"],"visual_features":["必须保持的颜色、材质、结构特征"]}。不得猜测图片中无法确认的功能参数。',preparedImages,'你是严谨的电商产品视觉分析师，只能根据图片可见信息判断，不得虚构。',{timeoutMs:90000});
            const data=parseModelJson(result.text);const d=valueState();
            if(data.product_name)d.productName=String(data.product_name).trim();
            const points=Array.isArray(data.selling_points)?data.selling_points.join('\n'):String(data.selling_points||'').trim();
            const features=Array.isArray(data.visual_features)?data.visual_features.join('\n'):String(data.visual_features||'').trim();
            if(points)d.sellingPoints=points;if(features&&!d.userRequirements)d.userRequirements=`必须保持的产品特征：\n${features}`;
            savePreferences();
            toast('智能分析完成，请核对产品名称和卖点');
        }catch(error){toast(error.message||'智能分析失败','error');}
        finally{clearInterval(ticker);state.analyzing=false;renderForm();}
    }
    async function generateSegmentedPrompts(){
        if(state.planning||state.running||!isPromptWorkflow())return;syncFormValues();const d=valueState(),isMain=state.active==='detail';if(!state.pools.products.length)return toast('请先上传产品图','error');
        const count=Math.max(1,Math.min(isMain?8:12,Number(d.count)||(isMain?8:11)));state.planning=true;state.planningError='';state.planningStartedAt=Date.now();state.segments[state.active]=[];renderForm();renderTasks();
        const strategy=isMain?'':[`文案设置：${d.copyMode}`,`画面丰富度：${d.richness}`,`字体风格：${d.font}`,`模特设置：${d.modelMode}`,`模特姿态：${d.modelPose}`,`模特使用量：${d.modelUsage}`,`插入反转屏：${d.insertReverse}`,d.prompt&&`补充要求：\n${d.prompt}`].filter(Boolean).join('\n');
        const brief=[isMain?`目标主图平台：${d.workflow}`:'目标工作流：电商详情页',`目标图片模型：${state.common.model}`,`输出语言：${d.language}`,`${isMain?'主图提示词数量':'详情页分段数量'}：${count}`,`画面比例：${state.common.ratio}`,`分辨率：${state.common.resolution}`,strategy,d.productName&&`产品名称：${d.productName}`,d.sellingPoints&&`产品卖点：\n${d.sellingPoints}`,d.userRequirements&&`用户要求：\n${d.userRequirements}`,isMain?DEFAULT_PROMPTS.detail:DEFAULT_PROMPTS['detail-v4']].filter(Boolean).join('\n\n');
        try{
            const request=isMain?`请规划 ${count} 组构图不重复、可独立使用的电商主图提示词，严格遵守所选平台的主图规范。产品图用于锁定产品外观，参考图仅用于风格和版式；不要生成详情页长图、详情页分段或上下衔接画面。`:`请先规划 ${count} 个前后连贯、职责明确且构图不重复的电商详情页分段提示词。分段应覆盖首屏吸引、核心卖点、材质细节、使用场景、规格信息、信任证明和收尾转化；产品图用于锁定产品，参考图仅用于风格版式。此步骤只生成提示词供用户确认，绝对不要提交生图任务。`;
            const planImages=await prepareAnalysisImages([...refsFrom('products'),...refsFrom('references')].map(item=>item.url));
            const result=await callTextModel(`${brief}\n\n${request}\n只返回 JSON，不要 Markdown：{"product_name":"产品名称","selling_points":["卖点"],"segments":[{"title":"${isMain?'主图方案标题':'详情分段标题'}","purpose":"该画面的作用","prompt":"可直接交给图片模型的完整中文提示词，明确产品一致性、画面主体、场景、构图、光线、文案策略与禁止修改项"}]}。segments 必须正好 ${count} 项。`,planImages,isMain?'你是资深电商主图视觉策划与提示词导演。你只负责生成多组主图提示词，不生成图片，也不规划详情页。输出必须是严格 JSON。':'你是资深电商详情页视觉策划与提示词导演。你只生成供用户确认的详情页分段提示词，绝不生成图片。输出必须是严格 JSON。',{timeoutMs:360000});
            const data=parseModelJson(result.text);let segments=Array.isArray(data.segments)?data.segments:[];
            segments=segments.slice(0,count).map((item,index)=>({title:String(item.title||(isMain?`主图方案 ${index+1}`:`详情分段 ${index+1}`)),purpose:String(item.purpose||''),prompt:String(item.prompt||item.text||'').trim(),selected:true})).filter(item=>item.prompt);
            if(!segments.length)throw new Error(`分析模型没有生成有效的${isMain?'主图':'详情页分段'}提示词`);
            while(segments.length<count){const index=segments.length;segments.push({title:isMain?`主图方案 ${index+1}`:`详情分段 ${index+1}`,purpose:isMain?'补充主图构图':'补充详情页信息',prompt:`${segments[index%segments.length].prompt}\n这是第 ${index+1}/${count} ${isMain?'组独立主图方案':'个详情页分段'}，保持产品和整套风格一致并使用不同构图。`,selected:true});}
            state.segments[state.active]=segments;
            if(data.product_name&&!d.productName)d.productName=String(data.product_name);
            if(Array.isArray(data.selling_points)&&!d.sellingPoints)d.sellingPoints=data.selling_points.join('\n');
            savePreferences();
            toast(`已生成 ${segments.length} ${isMain?'组主图':'段详情页'}提示词，请编辑确认`);
        }catch(error){state.planningError=String(error.message||`生成${isMain?'主图':'详情页分段'}提示词失败`);console.error('[commerce] prompt planning failed',error);toast(state.planningError,'error');}
        finally{state.planning=false;state.planningStartedAt=0;renderForm();renderTasks();}
    }
    function saveDetailPreset(){syncFormValues();const key=state.active==='detail'?'xiaomei_commerce_main_preset':'xiaomei_commerce_detail_preset';localStorage.setItem(key,JSON.stringify({values:valueState(),common:state.common,planner:state.planner}));toast(`${state.active==='detail'?'主图':'详情页'}提示词预设已保存`);}
    function loadDetailPreset(){const isMain=state.active==='detail',key=isMain?'xiaomei_commerce_main_preset':'xiaomei_commerce_detail_preset';try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(!saved)throw new Error();state.values[state.active]={...valueState(),...(saved.values||saved.detail)};if(!isMain)normalizeDetailV4Values(valueState());if(isMain&&!['淘宝 / 主图','亚马逊 / 主图'].includes(valueState().workflow))valueState().workflow='淘宝 / 主图';state.common={...state.common,...saved.common};state.planner={...state.planner,...saved.planner};if(!providerList().some(p=>p.id===state.common.provider))state.common.provider=providerList()[0]?.id||'';if(!currentModels().includes(state.common.model))state.common.model=currentModels()[0]||'';if(!plannerProviderList().some(p=>p.id===state.planner.provider))state.planner.provider=plannerProviderList()[0]?.id||'';if(!currentPlannerModels().includes(state.planner.model))state.planner.model=currentPlannerModels()[0]||'';savePreferences();renderForm();toast('预设已加载');}catch(error){toast(`还没有可加载的${isMain?'主图':'详情页'}预设`,'error');}}
    async function generateConfirmedSegments(){
        if(state.running||!isPromptWorkflow())return;
        const segmentEntries=currentSegments().map((segment,sourceIndex)=>({segment,sourceIndex})).filter(({segment})=>segment.selected!==false&&String(segment.prompt||'').trim());
        if(!segmentEntries.length)return toast('请至少选择一个确认后的提示词','error');
        const provider=currentProvider();if(!provider?.has_key)return toast('请先选择已配置 Key 的生图平台','error');if(!state.common.model)return toast('请选择图片模型','error');
        const refs=[...refsFrom('products'),...refsFrom('references')];
        state.promptGenerationActive=true;state.running=true;state.stopped=false;
        state.tasks=segmentEntries.map(({segment,sourceIndex},index)=>({id:`prompt-task-${Date.now()}-${index}`,label:segment.title||`分段 ${index+1}`,prompt:segment.prompt,refs,sourceSegmentIndex:sourceIndex,status:'pending',upstreamStatus:'',startedAt:Date.now(),model:state.common.model,url:'',error:'',selected:true}));render();
        const workers=Math.min(COMMERCE_IMAGE_CONCURRENCY,state.tasks.length);let cursor=0;
        const runWorker=async()=>{while(cursor<state.tasks.length&&!state.stopped){const task=state.tasks[cursor++];await runTask(task);}};
        await Promise.all(Array.from({length:workers},runWorker));
        if(state.stopped)state.tasks.filter(task=>task.status==='pending').forEach(task=>{task.status='failed';task.error='队列已停止';});
        state.running=false;renderForm();renderTasks();toast(`确认生成完成：成功 ${state.tasks.filter(task=>task.status==='success').length}/${state.tasks.length}`);
    }
    function normalizeCommerceAssetLibraries(payload){
        const root=payload?.library||payload||{};
        const source=Array.isArray(root.libraries)&&root.libraries.length
            ?root.libraries
            :[{id:root.id||'default',name:root.name||'默认资产库',categories:root.categories||[]}];
        return source.map((library,libraryIndex)=>({
            id:String(library.id||`library_${libraryIndex}`),
            name:String(library.name||`资产库 ${libraryIndex+1}`),
            categories:(library.categories||[]).filter(category=>category.type==='image').map((category,categoryIndex)=>({
                id:String(category.id||`category_${categoryIndex}`),
                name:String(category.name||`分组 ${categoryIndex+1}`),
                items:(category.items||[]).filter(item=>item?.url)
            }))
        })).filter(library=>library.categories.length);
    }
    function selectedAssetLibrary(){return state.assetLibraries.find(library=>library.id===state.assetLibraryId)||state.assetLibraries[0]||null;}
    function refreshAssetPickerFilters(){
        const library=selectedAssetLibrary();
        if(library&&library.id!==state.assetLibraryId)state.assetLibraryId=library.id;
        const categories=library?.categories||[];
        if(state.assetCategoryId&&!categories.some(category=>category.id===state.assetCategoryId))state.assetCategoryId='';
        $('assetLibrarySelect').innerHTML=state.assetLibraries.map(item=>`<option value="${attr(item.id)}"${item.id===state.assetLibraryId?' selected':''}>${esc(item.name)}</option>`).join('');
        $('assetCategorySelect').innerHTML=`<option value="">全部分组</option>${categories.map(item=>`<option value="${attr(item.id)}"${item.id===state.assetCategoryId?' selected':''}>${esc(item.name)}（${item.items.length}）</option>`).join('')}`;
    }
    async function openAssetPicker(pool,max){
        state.assetTarget={pool,max};const dialog=$('assetPicker');
        $('assetPickerGrid').innerHTML='<div class="asset-picker-empty">正在同步图片资产库…</div>';
        if(!dialog.open)dialog.showModal();
        try{
            const response=await fetch('/api/asset-library',{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
            const data=await response.json(),root=data.library||data||{};
            state.assetLibraries=normalizeCommerceAssetLibraries(data);
            const preferred=String(root.active_library_id||'');
            state.assetLibraryId=state.assetLibraries.some(item=>item.id===preferred)?preferred:(state.assetLibraries[0]?.id||'');
            const library=selectedAssetLibrary();state.assetCategoryId=library?.categories[0]?.id||'';
            state.assetItems=state.assetLibraries.flatMap(assetLibrary=>assetLibrary.categories.flatMap(category=>category.items.map(item=>({...item,libraryId:assetLibrary.id,libraryName:assetLibrary.name,categoryId:category.id,category:category.name}))));
            $('assetSearch').value='';$('assetPickerTitle').textContent=pool==='products'?'从资产库选择产品图':'从资产库选择参考图';
            refreshAssetPickerFilters();renderAssetPicker();
        }catch(error){state.assetLibraries=[];state.assetItems=[];refreshAssetPickerFilters();renderAssetPicker();toast('素材库读取失败，请确认资产库服务已启动','error');}
    }
    function renderAssetPicker(){
        const term=String($('assetSearch')?.value||'').trim().toLowerCase(),targetPool=state.assetTarget?state.pools[state.assetTarget.pool]:[];
        const items=state.assetItems.filter(item=>item.libraryId===state.assetLibraryId&&(!state.assetCategoryId||item.categoryId===state.assetCategoryId)).filter(item=>{
            const tags=Array.isArray(item.classification?.tags)?item.classification.tags:[];
            return !term||`${item.name||''} ${item.libraryName||''} ${item.category||''} ${tags.join(' ')}`.toLowerCase().includes(term);
        });
        $('assetPickerCount').textContent=`${items.length} 项`;
        $('assetPickerGrid').innerHTML=items.length?items.map(item=>{
            const selected=targetPool?.some(existing=>existing.url===item.url),index=state.assetItems.indexOf(item);
            return `<button class="asset-choice${selected?' selected':''}" type="button" data-asset-index="${index}" aria-pressed="${selected?'true':'false'}"><img src="${attr(item.url)}" alt="${attr(item.name||'素材')}" loading="lazy"><small>${esc(item.category||'未分组')}</small><span>${esc(item.name||item.category||'素材')}</span>${selected?'<b>已引用</b>':''}</button>`;
        }).join(''):'<div class="asset-picker-empty">当前资产库或分组中没有匹配的图片素材</div>';
    }
    function normalizeGptImage25Size(value){
        const match=String(value||'').trim().match(/^(\d+)\s*[xX*]\s*(\d+)$/);
        if(!match)return value||'auto';
        let width=Number(match[1]),height=Number(match[2]);
        const valid=width%16===0&&height%16===0&&Math.max(width,height)<=3840&&width*height>=655360&&width*height<=8294400&&Math.max(width/height,height/width)<=3;
        if(valid)return `${width}x${height}`;
        const ratioValue=width/height;
        if(ratioValue>3)width=height*3;
        else if(ratioValue<1/3)height=width*3;
        const scale=Math.min(1,3840/Math.max(width,height),Math.sqrt(8294400/Math.max(1,width*height)));
        width=Math.max(16,Math.floor(width*scale/16)*16);
        height=Math.max(16,Math.floor(height*scale/16)*16);
        if(width*height<655360){
            const grow=Math.sqrt(655360/Math.max(1,width*height));
            width=Math.max(16,Math.ceil(width*grow/16)*16);
            height=Math.max(16,Math.ceil(height*grow/16)*16);
        }
        if(width>height*3)width=Math.max(16,Math.floor(height*3/16)*16);
        else if(height>width*3)height=Math.max(16,Math.floor(width*3/16)*16);
        while(Math.max(width,height)>3840||width*height>8294400){
            if(width>=height)width=Math.max(16,width-16);
            else height=Math.max(16,height-16);
        }
        return `${width}x${height}`;
    }
    function sizeFor(ratio,resolution,model=''){
        const [w,h]=String(ratio||'1:1').split(':').map(Number),long={1:1536,2:2048,4:3840}[parseInt(resolution,10)]||2048;
        const round=v=>Math.max(256,Math.round(v/16)*16);
        const value=w>=h?`${long}x${round(long*h/w)}`:`${round(long*w/h)}x${long}`;
        return isGptImage25Model(model)?normalizeGptImage25Size(value):value;
    }
    function refsFrom(pool){return (state.pools[pool]||[]).map((item,index)=>({url:item.url,name:item.name||`图${index+1}`,role:`image_${index+1}`}));}
    function v4Prompt(d){
        const copy={required:'需要清晰克制的商业文案。',empty:'预留文案区域但不生成具体文字。',none:'画面不出现文字。'}[d.copyMode];
        const rich={concise:'画面精简、留白充足。',medium:'画面层次清晰，信息量适中。',rich:'画面丰富但主体明确。'}[d.richness];
        const font=DETAIL_FONT_OPTIONS.find(option=>option.value===d.font)?.label||DETAIL_FONT_OPTIONS[0].label;
        const model={none:'不要新增人物。',use:'可使用适合产品的模特。'}[d.modelMode];
        return [d.prompt,copy,rich,`字体策略：${font}。`,model].filter(Boolean).join('\n');
    }
    async function cropReference(){const item=state.pools.scene[0],c=valueState().crop;if(!item)return null;const img=await loadImage(item.preview||item.url);const sx=img.naturalWidth*c.x/100,sy=img.naturalHeight*c.y/100,sw=img.naturalWidth*c.w/100,sh=img.naturalHeight*c.h/100;const canvas=document.createElement('canvas'),scale=Math.min(1,2048/Math.max(sw,sh));canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));canvas.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,canvas.width,canvas.height);return {url:canvas.toDataURL('image/png'),name:'场景裁切.png',role:'image_1'};}
    function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}
    function buildEditMask(){
        const source=$('maskCanvas'); if(!source)return '';
        const sourceCtx=source.getContext('2d'),pixels=sourceCtx.getImageData(0,0,source.width,source.height).data;
        const mask=document.createElement('canvas');mask.width=source.width;mask.height=source.height;const ctx=mask.getContext('2d');
        const output=ctx.createImageData(mask.width,mask.height);
        for(let i=0;i<pixels.length;i+=4){output.data[i]=255;output.data[i+1]=255;output.data[i+2]=255;output.data[i+3]=pixels[i+3]>8?0:255;}
        ctx.putImageData(output,0,0);return mask.toDataURL('image/png');
    }
    function taskSpecs(){
        const d=valueState();
        if(isPromptWorkflow())throw new Error('请先生成并确认提示词；此步骤不会直接提交生图任务');
        const repeatSpecs=(specs,count=generationCount())=>specs.flatMap(spec=>Array.from({length:count},(_,copyIndex)=>({...spec,label:count>1?`${spec.label} · 第 ${copyIndex+1} 张`:spec.label})));
        if(state.active==='batch'){const lines=String(d.prompt||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);if(!lines.length)throw new Error('请至少填写一行提示词');return repeatSpecs(lines.map((prompt,i)=>({label:`自定任务 ${i+1}`,prompt,refs:refsFrom('batchRefs')})));}
        if(state.active==='replicate'){if(!state.pools.replicateRefs.length)throw new Error('请先上传参考图');return repeatSpecs(refsFrom('replicateRefs').map((ref,i)=>({label:`参考图 ${i+1}`,prompt:d.mode==='resize'?`保持参考图内容不变，只重新构图为 ${state.common.ratio}。`:`${d.prompt}\n图1是参考图，图2起是产品图。`,refs:[ref,...refsFrom('replicateProducts')]})));}
        if(state.active==='sku'){if(!state.pools.skuProducts.length||!state.pools.skuTemplate.length)throw new Error('请上传产品图和 SKU 模板');const attrs=String(d.attributes||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);if(attrs.length&&attrs.length!==state.pools.skuProducts.length)throw new Error(`SKU 属性为 ${attrs.length} 行，但产品图有 ${state.pools.skuProducts.length} 张`);return repeatSpecs(refsFrom('skuProducts').map((product,i)=>({label:`SKU ${i+1}`,prompt:`${d.prompt}${attrs[i]?`\n当前 SKU 属性：${attrs[i]}`:''}`,refs:[product,{...refsFrom('skuTemplate')[0],role:'image_2'}]})));}
        if(state.active==='redraw'){const original=refsFrom('redraw')[0];if(!original)throw new Error('请上传待编辑图片');if(!d.mask)throw new Error('请先在图片上涂抹需要重绘的区域');const editMask=buildEditMask();if(!editMask)throw new Error('遮罩生成失败，请重新涂抹');return [{label:'局部重绘',prompt:d.prompt,refs:[{...original,role:'image_1'},{url:editMask,name:'redraw_mask.png',role:'mask'}]}];}
        return [];
    }
    async function generateActiveWorkflow(){
        if(isPromptWorkflow())return generateSegmentedPrompts();
        if(state.running)return;syncFormValues();const provider=currentProvider();if(!provider) return toast('没有可用的生图平台，请先到 API 设置拉取模型','error');if(!provider.has_key)return toast(`请先为 ${provider.name||provider.id} 配置 API Key`,'error');if(!state.common.model)return toast('请选择图片模型','error');
        let specs;
        try{if(state.active==='scene-crop'){if(!state.pools.scene.length)throw new Error('请先上传场景图');const crop=await cropReference();specs=[{label:'局部裁切',prompt:valueState().prompt,refs:[crop,...refsFrom('sceneProducts')]}];}else specs=taskSpecs();}catch(error){toast(error.message,'error');return;}
        window.XiaomeiGenerationNotifications?.requestPermission?.();
        if(state.merchantBatchTaskCap&&specs.length>state.merchantBatchTaskCap){specs=specs.slice(0,state.merchantBatchTaskCap);toast(`经营助手方案已按安全上限保留前 ${specs.length} 个任务`);}
        state.running=true;state.stopped=false;state.tasks=specs.map((spec,i)=>({id:`task-${Date.now()}-${i}`,label:spec.label,prompt:spec.prompt,refs:spec.refs,status:'pending',upstreamStatus:'',startedAt:Date.now(),model:state.common.model,url:'',error:'',selected:true,clientRequestId:state.active==='batch'&&state.merchantBatchIdempotency?`${state.merchantBatchIdempotency}-${i+1}`:''}));render();
        const workers=Math.min(COMMERCE_IMAGE_CONCURRENCY,state.tasks.length);let cursor=0;
        const runWorker=async()=>{while(cursor<state.tasks.length&&!state.stopped){const index=cursor++,task=state.tasks[index];await runTask(task);}};
        await Promise.all(Array.from({length:workers},runWorker));
        if(state.stopped)state.tasks.filter(t=>t.status==='pending').forEach(t=>{t.status='failed';t.error='队列已停止'});
        state.running=false;renderForm();renderTasks();toast(`任务结束：成功 ${state.tasks.filter(t=>t.status==='success').length}/${state.tasks.length}`);
    }
    async function runTask(task){task.status='running';task.upstreamStatus='submitting';task.upstreamMessage='';task.startedAt=Date.now();renderTasks();const normalizedRefs=(task.refs||[]).map((ref,index)=>({...ref,role:ref.role==='mask'?'mask':`image_${index+1}`}));const payload={prompt:task.prompt,provider_id:state.common.provider,model:state.common.model,history_source:'commerce',size:sizeFor(state.common.ratio,state.common.resolution,state.common.model),quality:state.common.quality,n:1,reference_images:normalizedRefs};if(isGptImage25Model(state.common.model))payload.background=state.common.background==='transparent'?'transparent':'opaque';if(task.clientRequestId)payload.client_request_id=task.clientRequestId;
        try{
            let result;
            result=await XiaomeiImageTaskClient.runImage(payload,{
                mode:state.common.requestMode === 'sync' ? 'sync' : 'async',
                intervalMs:1500,
                fallbackMessage:'生成失败',
                timeoutMessage:'生成任务超时',
                onTaskUpdate(remoteTask){
                    const status=String(remoteTask?.status||remoteTask?.task_status||'').trim().toLowerCase();
                    const message=String(remoteTask?.message||'').trim();
                    if(status&&task.upstreamStatus!==status){task.upstreamStatus=status;renderTasks();}
                    if(message)task.upstreamMessage=message;
                },
                classifyTask(task){
                    if(task?.status === 'jimeng_pending') return {action:'reject',error:new Error(task.message || '任务仍在即梦队列中，请稍后查询')};
                    return null;
                },
            });
            const data=result?.result||result;task.url=XiaomeiImageTaskClient.extractMediaUrls(data)[0] || '';if(!task.url)throw new Error('接口没有返回可用图片');task.status='success';task.upstreamStatus='succeeded';
         }catch(error){task.status='failed';task.upstreamStatus='failed';task.error=String(error.message||error).slice(0,500);}finally{
             window.XiaomeiGenerationNotifications?.notify?.({
                 id:`commerce-${task.id}`,
                 status:task.status==='success'?'success':'failed',
                 model:task.model || state.common.model || '图片模型',
                 outputs:task.url ? [{url:task.url}] : [],
                 error:task.error || '',
             });
             renderTasks();
         }
    }
    function merchantImageUrls(values){
        const rows=[];
        for(const value of Array.isArray(values)?values:[]){
            const url=String(value?.url||value||'').trim();
            if(!url||rows.includes(url))continue;
            try{const parsed=new URL(url,location.href);if(!['http:','https:','data:'].includes(parsed.protocol)&&!url.startsWith('/'))continue;}catch(error){continue;}
            rows.push(url);if(rows.length>=8)break;
        }
        return rows;
    }
    function mergeMerchantReferences(pool,urls){
        const target=state.pools[pool];if(!Array.isArray(target))return;
        merchantImageUrls(urls).forEach((url,index)=>{if(!target.some(item=>item?.url===url))target.push({url,preview:url,name:`经营助手关联图 ${index+1}`});});
    }
    async function loadMerchantChange(changeId){
        const id=String(changeId||'').trim();if(!/^[A-Za-z0-9_-]{8,120}$/.test(id))return;
        try{
            const response=await fetch(`/api/merchant-agent/changes/${encodeURIComponent(id)}`,{headers:{'X-User-ID':merchantChatUserId(),'Cache-Control':'no-cache'}});
            const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.detail||data.message||`变更读取失败（${response.status}）`);
            const change=data?.change||{};if(change.status!=='applied')throw new Error('该方案尚未完成批准与送达');
            const after=change.after&&typeof change.after==='object'?change.after:{};const kind=String(change.kind||'');
            state.running=false;state.stopped=false;state.planning=false;state.planningError='';state.promptGenerationActive=false;
            if(kind==='visual_plan'){
                const target=after.workflow==='detail-v4'?'detail-v4':'detail';const values=state.values[target];
                state.active=target;values.prompt=String(after.summary||values.prompt||'');values.productName=String(after.product_name||values.productName||'');values.sellingPoints=(Array.isArray(after.selling_points)?after.selling_points:[]).map(value=>String(value||'').trim()).filter(Boolean).join('\n')||values.sellingPoints||'';values.userRequirements=String(after.user_requirements||values.userRequirements||'');
                const segments=(Array.isArray(after.segments)?after.segments:[]).slice(0,12).map((item,index)=>({title:String(item?.title||`${target==='detail'?'主图方案':'详情分段'} ${index+1}`),purpose:String(item?.purpose||''),prompt:String(item?.prompt||item?.text||'').trim(),selected:true})).filter(item=>item.prompt);
                if(!segments.length)throw new Error('已批准的视觉方案没有可编辑提示词');state.segments[target]=segments;mergeMerchantReferences('products',after.reference_images);toast(`已载入 ${segments.length} 条${target==='detail'?'主图':'详情页'}提示词，请先核对再确认生图`);
            }else if(kind==='generation_batch'){
                state.active='batch';state.values.batch.prompt=(Array.isArray(after.prompts)?after.prompts:[]).map(value=>String(value||'').trim()).filter(Boolean).join('\n');state.values.batch.count=1;state.merchantBatchIdempotency=String(after.idempotency_key||'').trim();state.merchantBatchTaskCap=Math.max(1,Math.min(20,(Array.isArray(after.prompts)?after.prompts.length:0)||20));if(after.ratio&&/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(String(after.ratio)))state.common.ratio=String(after.ratio);mergeMerchantReferences('batchRefs',after.reference_images);toast('已载入批量生图草稿；开始任务前仍可修改提示词。');
            }else if(kind==='campaign_plan'){
                state.active='detail';const values=state.values.detail;values.userRequirements=[values.userRequirements,String(after.goal||''),String(after.audience||''),...(Array.isArray(after.assets)?after.assets:[])].filter(Boolean).join('\n');values.prompt=String(after.summary||values.prompt||'');toast('已将推广计划送到电商工作台，可继续完善视觉方案。');
            }else{throw new Error('该变更类型暂不支持工作台交接');}
            savePreferences();render();
        }catch(error){toast(error.message||'无法载入经营助手方案','error');}
    }
    function orderedSuccessfulTasks(selectedOnly=false){
        const tasks=state.tasks.filter(task=>task.status==='success'&&task.url&&(!selectedOnly||task.selected!==false));
        return state.resultReverse?[...tasks].reverse():tasks;
    }
    function saveBlob(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
    async function downloadTaskArchive(selectedOnly=false){
        const tasks=orderedSuccessfulTasks(selectedOnly);if(!tasks.length)return toast(selectedOnly?'请先选择要下载的成功图片':'还没有可下载的成功图片','error');
        try{
            toast(`正在打包 ${tasks.length} 张图片…`);
            const items=tasks.map((task,index)=>({url:task.url,name:`${String(index+1).padStart(2,'0')}-${String(task.label||'生成结果').replace(/[\\/:*?"<>|]+/g,'_')}.png`}));
            const response=await fetch('/api/canvas-assets/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items,filename:selectedOnly?'小美画布-选中图片.zip':'小美画布-全部图片.zip'})});
            if(!response.ok)throw new Error(await responseMessage(response));saveBlob(await response.blob(),selectedOnly?'小美画布-选中图片.zip':'小美画布-全部图片.zip');
        }catch(error){toast(`下载失败：${error.message||error}`,'error');}
    }
    async function retryTask(index){
        const task=state.tasks[Number(index)];if(!task||state.running)return toast(state.running?'请等待当前队列结束后再重试':'任务不存在','error');
        const provider=currentProvider();if(!provider?.has_key||!state.common.model)return toast('请先确认生图 API 和模型可用','error');
        state.running=true;task.status='pending';task.upstreamStatus='';task.upstreamMessage='';task.url='';task.error='';task.model=state.common.model;renderForm();renderTasks();
        await runTask(task);state.running=false;renderForm();renderTasks();toast(task.status==='success'?`“${task.label}”重新生成成功`:`“${task.label}”重新生成仍失败` ,task.status==='success'?'':'error');
    }
    function openTaskPromptEditor(index){
        const task=state.tasks[Number(index)];if(!task)return toast('任务不存在','error');
        state.editingTaskIndex=Number(index);$('promptEditorTitle').textContent=`修改提示词 · ${task.label||`第 ${Number(index)+1} 屏`}`;$('taskPromptEditorText').value=task.prompt||'';
        $('promptEditorRefs').innerHTML=(task.refs||[]).length?`<span>本屏引用图</span><div>${task.refs.map((ref,refIndex)=>`<figure><img src="${attr(ref.url)}" alt="引用图 ${refIndex+1}"><figcaption>图${refIndex+1} · ${esc(ref.name||'引用图')}</figcaption></figure>`).join('')}</div>`:'<span>本屏没有引用图</span>';
        $('saveAndRetryPrompt').disabled=state.running;const dialog=$('taskPromptEditor');if(!dialog.open)dialog.showModal();
    }
    async function saveEditedTaskPrompt(regenerate=false){
        const index=state.editingTaskIndex,task=state.tasks[index];if(!task)return;
        const prompt=String($('taskPromptEditorText').value||'').trim();if(!prompt)return toast('提示词不能为空','error');
        task.prompt=prompt;
        if(Number.isInteger(task.sourceSegmentIndex)&&currentSegments()[task.sourceSegmentIndex]){currentSegments()[task.sourceSegmentIndex].prompt=prompt;savePreferences();}
        if(regenerate){if(state.running)return toast('请等待当前队列结束后再重新生图','error');$('taskPromptEditor').close();await retryTask(index);}
        else {$('taskPromptEditor').close();toast(`“${task.label}”提示词已保存`);}
    }
    async function previewLongImage(){
        const tasks=orderedSuccessfulTasks(false);if(!tasks.length)return toast('还没有可用于拼图的成功图片','error');
        const dialog=$('longPreview'),stage=$('longPreviewStage');stage.innerHTML='<div class="long-preview-loading"><i class="planning-spinner" data-lucide="loader-circle"></i><span>正在拼接长图…</span></div>';refreshIcons();if(!dialog.open)dialog.showModal();
        try{
            const response=await fetch('/api/commerce/long-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:tasks.map((task,index)=>({url:task.url,name:`${index+1}-${task.label}`})),filename:'小美画布-长图预览.png'})});
            if(!response.ok)throw new Error(await responseMessage(response));const blob=await response.blob();if(state.longPreviewUrl)URL.revokeObjectURL(state.longPreviewUrl);state.longPreviewBlob=blob;state.longPreviewUrl=URL.createObjectURL(blob);stage.innerHTML=`<img src="${attr(state.longPreviewUrl)}" alt="详情页长图拼接预览">`;$('downloadLongPreview').disabled=false;
        }catch(error){stage.innerHTML=`<div class="long-preview-error">拼图失败：${esc(error.message||error)}</div>`;$('downloadLongPreview').disabled=true;}
    }
    async function responseMessage(response){const data=await response.json().catch(()=>null);return data?.detail||data?.error||await response.text().catch(()=>`请求失败 (${response.status})`);}

    $('workflowTabs').addEventListener('click',e=>{const btn=e.target.closest('[data-workflow]');if(!btn||state.running||state.planning)return;syncFormValues();state.active=btn.dataset.workflow;state.tasks=[];state.promptGenerationActive=false;savePreferences();render();});
    $('clearResults').addEventListener('click',()=>{if(state.running||state.planning)return;if(isPromptWorkflow()&&!state.promptGenerationActive){state.segments[state.active]=[];delete valueState().importedPlanName;}else state.tasks=[];state.promptGenerationActive=false;savePreferences();renderForm();renderTasks()});
    $('taskList').addEventListener('input',e=>{const input=e.target.closest('[data-segment-index]'),segments=currentSegments();if(input&&segments[Number(input.dataset.segmentIndex)]){segments[Number(input.dataset.segmentIndex)].prompt=input.value;schedulePreferencesSave();}});
    $('taskList').addEventListener('change',e=>{
        const columns=e.target.closest('[data-result-columns]');if(columns){state.resultColumns=Math.max(5,Math.min(8,Number(columns.value)||6));savePreferences();renderTasks();return;}
        const reverse=e.target.closest('[data-result-reverse]');if(reverse){state.resultReverse=reverse.checked;savePreferences();renderTasks();}
    });
    $('taskList').addEventListener('click',async e=>{
        if(e.target.closest('[data-retry-planning]')){await generateSegmentedPrompts();return;}
        const toggle=e.target.closest('[data-toggle-segment]');if(toggle){const segment=currentSegments()[Number(toggle.dataset.toggleSegment)];if(segment){segment.selected=segment.selected===false;savePreferences();renderTasks();}return;}
        if(e.target.closest('[data-select-all-segments]')){const segments=currentSegments(),allSelected=segments.length&&segments.every(segment=>segment.selected!==false);segments.forEach(segment=>segment.selected=allSelected?false:true);savePreferences();renderTasks();return;}
        if(e.target.closest('[data-confirm-generate]')){await generateConfirmedSegments();return;}
        if(e.target.closest('[data-back-prompts]')){if(!state.running){state.promptGenerationActive=false;renderTasks();}return;}
        const taskToggle=e.target.closest('[data-toggle-task]');if(taskToggle){const task=state.tasks[Number(taskToggle.dataset.toggleTask)];if(task){task.selected=task.selected===false;renderTasks();}return;}
        if(e.target.closest('[data-select-all-tasks]')){const successful=state.tasks.filter(task=>task.status==='success'&&task.url),allSelected=successful.length&&successful.every(task=>task.selected!==false);successful.forEach(task=>task.selected=allSelected?false:true);renderTasks();return;}
        const retry=e.target.closest('[data-retry-task]');if(retry){await retryTask(retry.dataset.retryTask);return;}
        const editPrompt=e.target.closest('[data-edit-task-prompt]');if(editPrompt){openTaskPromptEditor(editPrompt.dataset.editTaskPrompt);return;}
        if(e.target.closest('[data-preview-long]')){await previewLongImage();return;}
        if(e.target.closest('[data-download-all]')){await downloadTaskArchive(false);return;}
        if(e.target.closest('[data-download-selected]')){await downloadTaskArchive(true);return;}
        const segmentBtn=e.target.closest('[data-copy-segment]');if(segmentBtn){const segment=currentSegments()[Number(segmentBtn.dataset.copySegment)];try{await navigator.clipboard.writeText(segment.prompt);toast(`${state.active==='detail'?'主图':'详情页分段'}提示词已复制`);}catch(error){toast('复制失败','error')}return;}
        const btn=e.target.closest('[data-copy-prompt]');if(!btn)return;const task=state.tasks[Number(btn.dataset.copyPrompt)];try{await navigator.clipboard.writeText(task.prompt);toast('提示词已复制');}catch(error){toast('复制失败','error')}
    });
    $('closeAssetPicker').addEventListener('click',()=>$('assetPicker').close());
    $('assetPicker').addEventListener('cancel',event=>{event.preventDefault();$('assetPicker').close()});
    $('assetSearch').addEventListener('input',renderAssetPicker);
    $('assetLibrarySelect').addEventListener('change',event=>{state.assetLibraryId=event.target.value;state.assetCategoryId=selectedAssetLibrary()?.categories[0]?.id||'';refreshAssetPickerFilters();renderAssetPicker();});
    $('assetCategorySelect').addEventListener('change',event=>{state.assetCategoryId=event.target.value;renderAssetPicker();});
    $('assetPickerGrid').addEventListener('click',e=>{const btn=e.target.closest('[data-asset-index]');if(!btn||!state.assetTarget)return;const item=state.assetItems[Number(btn.dataset.assetIndex)],target=state.pools[state.assetTarget.pool],limited=state.assetTarget.max>0;if(!item||!target)return;if(target.some(existing=>existing.url===item.url))return toast('这个素材已经添加');if(limited&&target.length>=state.assetTarget.max)return toast('当前素材组已达到上限','error');target.push({url:item.url,preview:item.url,name:item.name||'素材',assetId:item.id||'',libraryId:item.libraryId,categoryId:item.categoryId});renderForm();renderAssetPicker();if(limited&&target.length>=state.assetTarget.max)$('assetPicker').close();else toast(`已从「${item.category||'素材库'}」引用素材`);});
    $('sharedSkillStatus')?.addEventListener('click',openSkillPicker);
    $('closeSkillPicker')?.addEventListener('click',()=>$('skillPicker').close());
    $('skillPicker')?.addEventListener('cancel',event=>{event.preventDefault();$('skillPicker').close();});
    $('skillSearch')?.addEventListener('input',event=>{state.skillQuery=event.target.value||'';renderSkillPicker();});
    $('skillSearch')?.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.target.value){event.target.value='';state.skillQuery='';renderSkillPicker();event.stopPropagation();}});
    $('skillList')?.addEventListener('click',event=>{const button=event.target.closest('[data-shared-skill-id]');if(button&&!button.disabled)selectSharedSkill(button.dataset.sharedSkillId);});
    $('closeLongPreview')?.addEventListener('click',()=>$('longPreview').close());
    $('longPreview')?.addEventListener('cancel',event=>{event.preventDefault();$('longPreview').close();});
    $('downloadLongPreview')?.addEventListener('click',()=>{if(state.longPreviewBlob)saveBlob(state.longPreviewBlob,'小美画布-长图预览.png');});
    $('closeTaskPromptEditor')?.addEventListener('click',()=>$('taskPromptEditor').close());
    $('taskPromptEditor')?.addEventListener('cancel',event=>{event.preventDefault();$('taskPromptEditor').close();});
    $('saveTaskPrompt')?.addEventListener('click',()=>void saveEditedTaskPrompt(false));
    $('saveAndRetryPrompt')?.addEventListener('click',()=>void saveEditedTaskPrompt(true));
    setInterval(()=>{if(state.running)document.querySelectorAll('.task-card').length&&renderTasks();if(state.planning&&isPromptWorkflow())renderTasks();},1000);
    window.addEventListener('message',event=>{const type=event.data?.type;if(['providers-changed','studio-api'].includes(type))void loadConfig();if(type==='merchant-change-handoff'){if(event.origin&&event.origin!==location.origin)return;void loadMerchantChange(event.data?.change_id||event.data?.changeId);}});
    try{const channel=new BroadcastChannel('studio-api');channel.addEventListener('message',()=>void loadConfig());}catch(e){}
    window.addEventListener('beforeunload',()=>{syncFormValues();savePreferences();});

    async function loadConfig(){
        try{
            const config=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());state.providers=Array.isArray(config.api_providers)?config.api_providers:[];
            const providers=providerList();if(!providers.some(p=>p.id===state.common.provider))state.common.provider=providers.find(p=>p.has_key)?.id||providers[0]?.id||'';
            if(!currentModels().includes(state.common.model))state.common.model=currentModels()[0]||'';
            const planners=plannerProviderList();if(!planners.some(p=>p.id===state.planner.provider))state.planner.provider=planners[0]?.id||'';
            if(!currentPlannerModels().includes(state.planner.model))state.planner.model=currentPlannerModels()[0]||'';
            savePreferences();
            const ready=currentProvider()?.has_key;$('apiStatus').textContent=ready?`${currentProvider().name||currentProvider().id} · ${currentModels().length} 个图片模型`:'请先配置 API Key 并拉取模型';$('apiStatus').parentElement.classList.toggle('ready',Boolean(ready));render();
        }catch(error){$('apiStatus').textContent='API 配置读取失败';render();}
    }
    if(sharedSkillApi?.subscribe)sharedSkillApi.subscribe(next=>{if(next&&state.skills.length&&!state.skills.some(skill=>skill.id===next&&skill.enabled!==false))return;if(next!==state.skillId){state.skillId=next||'';state.skillInstructionsFor='';state.skillInstructions='';renderSharedSkillStatus();renderSkillPicker();renderForm();}});
    // 先渲染工作台骨架，再异步读取 Skill 和 API 配置。
    // 如果本地服务或网络响应较慢，页面也应先显示流程、参数和结果空状态，
    // 不能只留下静态标题而让整个工作区看起来像消失了。
    render();
    loadSharedSkillLibrary();
    loadConfig();
})();
