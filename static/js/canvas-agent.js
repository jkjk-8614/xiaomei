(function(){
    'use strict';
    const sharedCanvasMode = new URLSearchParams(location.search).get('shared') === '1';
    const BROWSER_SKILL_ID = 'browser-agent';
    const $=id=>document.getElementById(id);
    const panel=$('canvasAgentPanel'), messagesEl=$('canvasAgentMessages'), input=$('canvasAgentInput');
    const sendLabelEl=$('canvasAgentSendLabel'), agentInputPlaceholder=input?.getAttribute('placeholder')||'让 Agent 分析图片、粘贴商品链接、策划提示词或修改当前节点…';
    const fontSizeEl=$('canvasAgentFontSize'), fontSizeValueEl=$('canvasAgentFontSizeValue');
    const providerEl=$('canvasAgentProvider'), modelEl=$('canvasAgentModel'), skillEl=$('canvasAgentSkill');
    const settingsEl=$('canvasAgentSettings'), generationSettingsEl=$('canvasAgentGenerationSettings'), historyEl=$('canvasAgentHistory'), skillPopover=$('canvasAgentSkillPopover'), skillQuickPopover=$('canvasAgentSkillQuickPopover');
    const generationToggle=$('canvasAgentComposerGenerationToggle'), generationModelEl=$('canvasAgentGenerationModel');
    const generationModelControl=$('canvasAgentGenerationModelControl'), generationModelTrigger=$('canvasAgentGenerationModelTrigger'), generationModelMenu=$('canvasAgentGenerationModelMenu');
    const generationModelLabelEl=$('canvasAgentGenerationModelLabel'), generationModelProviderEl=$('canvasAgentGenerationModelProvider'), generationModelMetaEl=$('canvasAgentGenerationModelMeta');
    const ratioOptionsEl=$('canvasAgentRatioOptions'), resolutionOptionsEl=$('canvasAgentResolutionOptions');
    const customRatioFieldsEl=$('canvasAgentCustomRatioFields'), customRatioWidthEl=$('canvasAgentCustomRatioWidth'), customRatioHeightEl=$('canvasAgentCustomRatioHeight'), customRatioHintEl=$('canvasAgentCustomRatioHint');
    const skillQuickToggle=$('canvasAgentSkillQuickToggle'), skillQuickCurrentEl=$('canvasAgentSkillQuickCurrent'), skillQuickSearchEl=$('canvasAgentSkillQuickSearch'), skillQuickList=$('canvasAgentSkillQuickList'), skillQuickEmpty=$('canvasAgentSkillQuickEmpty');
    const skillList=$('canvasAgentSkillList'), skillEmpty=$('canvasAgentSkillEmpty');
    const skillSearchEl=$('canvasAgentSkillSearch'), skillCountEl=$('canvasAgentSkillCount');
    const skillCategoryEl=$('canvasAgentSkillCategory'), skillStatusEl=$('canvasAgentSkillStatus');
    const skillTabCountEl=$('canvasAgentSkillTabCount'), skillCurrentEl=$('canvasAgentSkillCurrent');
    const skillCategoryManagerEl=$('canvasAgentSkillCategoryManager'), skillCategoryListEl=$('canvasAgentSkillCategoryList');
    const skillCategoryFormEl=$('canvasAgentSkillCategoryForm'), skillCategoryNameEl=$('canvasAgentSkillCategoryName'), skillCategoryStatusEl=$('canvasAgentSkillCategoryStatus');
    const skillPackageSourceEl=$('canvasAgentSkillPackageSource'), skillPackagePreviewEl=$('canvasAgentSkillPackagePreview'), skillPackageStatusEl=$('canvasAgentSkillPackageStatus');
    const skillPackageDirectoryEl=$('canvasAgentSkillDirectoryInput'), skillPackageSelectionHintEl=$('canvasAgentSkillSelectionHint');
    const planModeEl=$('canvasAgentPlanMode'), harnessModeEl=$('canvasAgentHarnessMode'), scopeEl=$('canvasAgentScope'), scopeLockEl=$('canvasAgentComposerScopeLock');
    const composerStatusEl=$('canvasAgentComposerStatus'), composerStatusTextEl=$('canvasAgentComposerStatusText'), composerStatusDetailEl=$('canvasAgentComposerStatusDetail'), composerStatusTimeEl=$('canvasAgentComposerStatusTime');
    const composerHintEl=$('canvasAgentComposerHint'), composerMenuToggleEl=$('canvasAgentComposerMenuToggle'), composerMenuEl=$('canvasAgentComposerMenu'), composerFileInputEl=$('canvasAgentComposerFileInput'), composerStopEl=$('canvasAgentComposerStop'), composerAttachmentsEl=$('canvasAgentComposerAttachments');
    const sharedSkillApi=window.StudioSharedSkill||null;
    let busy=false, skills=[], skillCategories=[], categoryManagerOpen=false, skillPackageScan=null, skillPackageSourceDir='', skillPackageUploadFiles=[];
    let agentActionWatchTimer=0;
    let runState='idle', runStateText='', runStateDetail='';
    let composerFileReferences=[], composerUploadBusy=false, composerRunStartedAt=0, composerRunTimer=0;
    let activeAgentAbortController=null, activeAgentRunToken=0, activeAgentStopRequested=false, activeHarnessRunId='';
    let store={activeId:'',conversations:[]}, historyTab='conversations';
    let folderBatch=null;
    let editingUserMessageIndex=-1, editingUserMessageDraft='', editingUserMessageOriginal='', editingInputDraft='';
    // Skill 自动路由只是可选的优化步骤，不能因为上游聊天模型无响应而阻塞整个 Agent。
    // 主 Agent 请求保留更长的窗口，避免正常的视觉任务被过早中断。
    const CANVAS_AGENT_SKILL_ROUTING_TIMEOUT_MS=30000;
    // Keep a safe fallback for an older backend. A current backend returns its
    // own value so the browser waits slightly longer than /api/canvas-llm.
    const CANVAS_AGENT_DEFAULT_REQUEST_TIMEOUT_MS=315000;
    let CANVAS_AGENT_REQUEST_TIMEOUT_MS=CANVAS_AGENT_DEFAULT_REQUEST_TIMEOUT_MS;
    const CANVAS_AGENT_ACTION_WATCH_INTERVAL_MS=500;
    const CANVAS_AGENT_LEGACY_ACTION_WINDOW_MS=30*60*1000;
    async function loadCanvasAgentRuntimeConfig(){
        if(sharedCanvasMode)return;
        try{
            const response=await fetch('/api/canvas-agent/runtime-config',{cache:'no-store'});
            if(!response.ok)return;
            const data=await response.json().catch(()=>({}));
            const timeoutMs=Math.round(Number(data?.request_timeout_ms));
            // Guard against a malformed response while still allowing users to
            // raise CANVAS_LLM_TIMEOUT in API/.env for slower reasoning models.
            if(Number.isFinite(timeoutMs)&&timeoutMs>=35000&&timeoutMs<=3660000){
                CANVAS_AGENT_REQUEST_TIMEOUT_MS=timeoutMs;
            }
        }catch(_){
            // The fallback above remains valid when an older server is still
            // running or a local restart is in progress.
        }
    }
    function agentCancelledError(){
        const error=new Error('已停止当前 Agent 任务');
        error.name='AgentCancelledError';
        error.agentCancelled=true;
        return error;
    }
    function isAgentCancelled(error){return Boolean(error?.agentCancelled||error?.name==='AgentCancelledError');}
    function assertAgentRunActive(token=activeAgentRunToken){
        if(activeAgentStopRequested||token!==activeAgentRunToken||activeAgentAbortController?.signal.aborted)throw agentCancelledError();
        return true;
    }
    function beginAgentRun(){
        activeAgentRunToken+=1;
        activeAgentAbortController=new AbortController();
        activeAgentStopRequested=false;
        activeHarnessRunId='';
        composerRunStartedAt=Date.now();
        busy=true;
        syncComposerRunUi();
        return activeAgentRunToken;
    }
    function finishAgentRun(token=activeAgentRunToken){
        if(token!==activeAgentRunToken)return;
        busy=false;
        activeAgentAbortController=null;
        activeAgentStopRequested=false;
        activeHarnessRunId='';
        syncComposerRunUi();
    }
    async function fetchWithTimeout(url,options={},timeoutMs=CANVAS_AGENT_REQUEST_TIMEOUT_MS){
        const controller=new AbortController();
        const inheritedSignal=options.signal||activeAgentAbortController?.signal;
        const forwardAbort=()=>controller.abort();
        let timedOut=false;
        if(inheritedSignal){
            if(inheritedSignal.aborted)controller.abort();
            else inheritedSignal.addEventListener('abort',forwardAbort,{once:true});
        }
        const timer=setTimeout(()=>controller.abort(),Math.max(1000,Number(timeoutMs)||CANVAS_AGENT_REQUEST_TIMEOUT_MS));
        try{
            return await fetch(url,{...options,signal:controller.signal});
        }catch(error){
            if(error?.name==='AbortError'){
                timedOut=Boolean(!inheritedSignal?.aborted);
                if(inheritedSignal?.aborted&&!timedOut)throw agentCancelledError();
                const timeoutError=new Error(`请求超过 ${Math.round(timeoutMs/1000)} 秒，已自动停止`);
                timeoutError.name='TimeoutError';
                throw timeoutError;
            }
            throw error;
        }finally{
            clearTimeout(timer);
            inheritedSignal?.removeEventListener('abort',forwardAbort);
        }
    }
    // Agent 面板位于画布 shell 内。阻止交互事件继续冒泡到画布，
    // 保留输入框、按钮、文本组合输入和滚动的默认行为。
    ['pointerdown','pointermove','pointerup','pointercancel','mousedown','mousemove','mouseup','click','dblclick','contextmenu','wheel','touchstart','touchmove','touchend','keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','selectstart'].forEach(type=>{
        // Capture wheel before it reaches the canvas shell.  The default action
        // is intentionally preserved so the focused list/input can still scroll.
        panel?.addEventListener(type,event=>event.stopPropagation(),type==='wheel'?{passive:true,capture:true}:false);
    });
    const storeKey=()=>`xiaomei_canvas_agent_v2_${canvas?.id||'default'}`;
    const prefKey='xiaomei_canvas_agent_model_v1';
    const fontSizePrefKey='xiaomei_canvas_agent_font_size_v1';
    const skillSelectionKey='xiaomei_agent_skill_selection_v1';
    const generationPrefKey='xiaomei_canvas_agent_generation_v1';
    const generationDefaults={
        auto:true,
        mode:'agent',
        planMode:false,
        media:'image',
        imageProvider:'',
        imageModel:'',
        harnessMode:true,
        ratio:'square',
        customRatio:'',
        customRatioWidth:'',
        customRatioHeight:'',
        resolution:'1k',
        quality:'auto',
        background:'auto',
        videoProvider:'',
        videoModel:'',
        videoAspect:'16:9',
        videoResolution:''
    };
    const generationRatioOptions=[
        ['smart','智能'],['square','1:1'],['wide','16:9'],['story','9:16'],
        ['landscape43','4:3'],['portrait43','3:4'],['landscape','3:2'],['portrait','2:3'],
        ['ratio54','5:4'],['ratio45','4:5'],['ultrawide','21:9'],['custom','自定义']
    ];
    const imageResolutionOptions=[['1k','1K'],['2k','2K'],['4k','4K']];
    const videoResolutionOptions=[['','自动'],['480p','480P'],['720p','720P'],['1080p','1080P']];
    const esc=value=>escapeHtml(String(value||''));
    function agentPreviewUrl(item,size=160){
        const value=item&&typeof item==='object'?item:{url:String(item||'')};
        if(typeof smartMediaPreviewUrl==='function')return smartMediaPreviewUrl(value,size);
        if(typeof displayMediaUrl==='function')return displayMediaUrl(value);
        return String(value?.url||'');
    }
    function agentPreviewImg(item,label,size=160){
        const src=agentPreviewUrl(item,size);
        return `<img src="${esc(src)}" alt="${esc(label)}" title="${esc(label)}" loading="lazy" decoding="async" fetchpriority="low">`;
    }
    const AGENT_FONT_SIZE_MIN=14;
    const AGENT_FONT_SIZE_DEFAULT=15;
    function normalizeFontSize(value){
        const size=Math.round(Number(value));
        return Number.isFinite(size)?Math.min(20,Math.max(AGENT_FONT_SIZE_MIN,size)):AGENT_FONT_SIZE_DEFAULT;
    }
    function savedFontSize(){
        try{
            const stored=localStorage.getItem(fontSizePrefKey);
            if(stored===null||stored==='')return AGENT_FONT_SIZE_DEFAULT;
            // 12px was the previous default and is too small for the desktop panel.
            // Upgrade that legacy value once while preserving larger user choices.
            if(Number(stored)<=12)return AGENT_FONT_SIZE_DEFAULT;
            return normalizeFontSize(stored);
        }catch(_){return AGENT_FONT_SIZE_DEFAULT;}
    }
    function applyFontSize(value=savedFontSize()){
        const size=normalizeFontSize(value);
        panel?.style.setProperty('--canvas-agent-font-size',`${size}px`);
        if(panel&&input){
            panel.style.setProperty('--canvas-agent-input-font-size',`${size}px`);
        }
        if(fontSizeEl){
            fontSizeEl.value=String(size);
            fontSizeEl.setAttribute('aria-valuetext',`${size} 像素`);
        }
        if(fontSizeValueEl)fontSizeValueEl.textContent=`${size} px`;
        resizeComposerInput();
        return size;
    }
    function resizeComposerInput(){
        if(!input)return;
        const style=getComputedStyle(input);
        const minHeight=Math.max(0,parseFloat(style.minHeight)||64);
        const configuredMax=parseFloat(style.maxHeight);
        const maxHeight=Math.max(minHeight,Number.isFinite(configuredMax)?configuredMax:320);
        const borderHeight=(parseFloat(style.borderTopWidth)||0)+(parseFloat(style.borderBottomWidth)||0);
        input.style.height='auto';
        input.style.overflowY='hidden';
        const contentHeight=Math.ceil(input.scrollHeight+borderHeight);
        const height=Math.min(maxHeight,Math.max(minHeight,contentHeight));
        input.style.height=`${height}px`;
        if(contentHeight>height+1)input.style.overflowY='auto';
    }
    function saveFontSize(value){
        const size=applyFontSize(value);
        try{localStorage.setItem(fontSizePrefKey,String(size));}catch(_){ }
        return size;
    }
    function generationRatioGcd(a,b){
        let left=Math.abs(Math.round(Number(a)||0)),right=Math.abs(Math.round(Number(b)||0));
        while(right){const next=left%right;left=right;right=next;}
        return left||1;
    }
    function normalizedGenerationRatioPart(value){
        const number=Number(value);
        return Number.isSafeInteger(number)&&number>0?String(number):'';
    }
    function normalizeGenerationCustomRatio(source={},fallback={}){
        const primary=source&&typeof source==='object'?source:{};
        const secondary=fallback&&typeof fallback==='object'?fallback:{};
        let width=normalizedGenerationRatioPart(primary.customRatioWidth)||normalizedGenerationRatioPart(secondary.customRatioWidth);
        let height=normalizedGenerationRatioPart(primary.customRatioHeight)||normalizedGenerationRatioPart(secondary.customRatioHeight);
        const raw=String(primary.customRatio||secondary.customRatio||'').trim().replace(/[：xX×/]/g,':');
        const match=raw.match(/^(\d+)\s*:\s*(\d+)$/);
        if(match){
            width=width||normalizedGenerationRatioPart(match[1]);
            height=height||normalizedGenerationRatioPart(match[2]);
        }
        return {
            customRatio:width&&height?`${width}:${height}`:'',
            customRatioWidth:width,
            customRatioHeight:height
        };
    }
    function requestedImageCount(text=''){
        const source=String(text||'').trim();
        if(!source)return 0;
        const token='(\\d{1,2}|一|二|两|俩|三|四|五|六|七|八|九|十)';
        const chinese={一:1,二:2,两:2,俩:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
        const patterns=[
            new RegExp(`(?:一共|共|再|请|需要|要|给我|帮我|帮忙)?\\s*(?:生成|生图|出图|输出|绘制|制作|创建|提供|做|来)\\s*${token}\\s*(?:张|幅|个|组|套)(?:\\s*(?:图|图片|图像|结果))?`,'ig'),
            new RegExp(`^(?:一共|共|请|给我|请给我)?\\s*${token}\\s*(?:张|幅|个|组|套)(?:\\s*(?:图|图片|图像|结果))?`,'ig'),
            new RegExp(`(?:数量|张数|结果数|生成数量)\\s*(?:是|为|设为|设置为)?\\s*${token}\\s*(?:张|幅|个|组|套)?`,'ig'),
            new RegExp(`(?:generate|create|make|produce|output)\\s*${token}\\s*(?:images?|pictures?|results?)`,'ig')
        ];
        const negative=/(?:没有说|没说|不要|别|不需要|无需|不用|未|没|不想|不打算|不希望|不)(?:要|去|再|给我|请给我)?$/i;
        const matches=patterns.flatMap(pattern=>[...source.matchAll(pattern)]).sort((a,b)=>(a.index??0)-(b.index??0));
        for(const match of matches){
            const prefix=source.slice(Math.max(0,(match.index??0)-12),match.index??0).replace(/\s+/g,'');
            if(negative.test(prefix))continue;
            const value=String(match[1]||'').toLowerCase();
            const count=/^\d+$/.test(value)?Number(value):chinese[value]||0;
            if(count>0)return Math.max(1,Math.min(8,count));
        }
        return 0;
    }
    function requestedGenerationPreferences(text=''){
        const source=String(text||'').trim();
        if(!source)return {};
        const requested={};
        const count=requestedImageCount(source);
        if(count)Object.assign(requested,{media:'image',count});
        // 优先读取“比例/画幅/宽高比”后面的值，避免把素材尺寸（如 465:453）
        // 误当成用户要求的输出比例。
        const labeled=source.match(/(?:图像|图片|画面|输出|生成|目标|最终)?\s*(?:比例|画幅|宽高比|aspect\s*ratio)\s*(?:是|为|设为|设置为|使用)?\s*(\d{1,3}\s*(?:[:：xX×/]|比)\s*\d{1,3})/i);
        // 只有明确写在“比例/画幅/宽高比”后的数值才是输出约束。不能把
        // 商品、相框等参考物的尺寸（例如 30×30cm）当成画布比例并覆盖右侧选择。
        const ratioMatch=labeled?.[1]||'';
        let width=0,height=0;
        const numeric=ratioMatch.replace(/：/g,':').match(/(\d{1,3})\s*(?:[:xX×/]|比)\s*(\d{1,3})/i);
        if(numeric){width=Number(numeric[1]);height=Number(numeric[2]);}
        else {
            // “相框是正方形”描述的是参考物，不是输出比例。仅在句子明确要求
            // 生成正方形图片，或将正方形写作输出比例时，才把它视为 1:1。
            const squareOutputRequested = /(?:生成|生图|出图|输出)(?:\s*(?:一|1)?\s*张)?\s*(?:一比一|正方形|方形|方图|square)(?:\s*(?:图片|图像|画面))?/i.test(source)
                || /(?:(?:图片|图像|画面|输出|生成|目标|最终)?\s*(?:比例|画幅|宽高比)\s*(?:是|为|设为|设置为|使用)?\s*(?:一比一|正方形|方形|方图|square))/i.test(source)
                || /(?:一比一|正方形|方形|方图|square)\s*(?:图片|图像|画面|画幅|比例|宽高比)/i.test(source)
                || /^(?:一比一|正方形|方形|方图|square)[。！!？?，,;；\s]*$/i.test(source);
            if(squareOutputRequested){width=1;height=1;}
        }
        if(!(width>0&&height>0))return requested;
        const divisor=generationRatioGcd(width,height),normalizedWidth=width/divisor,normalizedHeight=height/divisor;
        const normalized=`${normalizedWidth}:${normalizedHeight}`;
        const preset={
            '1:1':{ratio:'square'},'16:9':{ratio:'wide'},'9:16':{ratio:'story'},
            '4:3':{ratio:'landscape43'},'3:4':{ratio:'portrait43'},'3:2':{ratio:'landscape'},
            '2:3':{ratio:'portrait'},'5:4':{ratio:'ratio54'},'4:5':{ratio:'ratio45'},
            '21:9':{ratio:'ultrawide'},'9:21':{ratio:'ultratall'}
        }[normalized];
        if(preset)return {...requested,...preset,media:'image',ratioLabel:normalized};
        return {
            ...requested,
            media:'image',ratio:'custom',ratioLabel:normalized,
            customRatio:normalized,customRatioWidth:normalizedWidth,customRatioHeight:normalizedHeight
        };
    }
    function generationPreferenceError(requested={},text=''){
        if(requested?.ratio||noGenerationRequested(text))return '';
        const state=effectiveGenerationPreferences();
        if(state.media==='image'&&state.ratio==='custom'&&!normalizeGenerationCustomRatio(state).customRatio){
            return '请先填写完整的自定义比例，例如 710:229';
        }
        return '';
    }
    function requestedPlanNodeSettings(generation={}){
        if(!generation||generation.media!=='image')return null;
        const next={};
        if(generation.ratio)next.ratio=generation.ratio;
        if(generation.ratio==='custom'){
            next.customRatio=String(generation.customRatio||generation.ratioLabel||'');
            next.customRatioWidth=Number(generation.customRatioWidth)||'';
            next.customRatioHeight=Number(generation.customRatioHeight)||'';
        }else if(generation.ratio){
            next.customRatio='';next.customRatioWidth='';next.customRatioHeight='';next.customSize='';
        }
        if(generation.count!==undefined)next.count=Math.max(1,Math.min(8,Number(generation.count)||1));
        if(generation.quality)next.quality=generation.quality;
        if(generation.background)next.background=generation.background;
        return Object.keys(next).length?next:null;
    }
    function requestedGenerationLabel(generation={}){
        if(generation?.media!=='image')return '';
        return [generation.ratioLabel?`图片比例 ${generation.ratioLabel}`:'',generation.count?`生成 ${generation.count} 张独立图片`:''].filter(Boolean).join(' · ');
    }
    const uid=()=>`chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
    function activeConversation(){
        let current=store.conversations.find(item=>item.id===store.activeId);
        if(!current){current={id:uid(),title:'新对话',createdAt:Date.now(),messages:[]};store.conversations.unshift(current);store.activeId=current.id;}
        return current;
    }
    function loadStore(){
        try{store=JSON.parse(localStorage.getItem(storeKey())||'null')||{activeId:'',conversations:[]};}catch(_){store={activeId:'',conversations:[]};}
        activeConversation();saveStore();renderMessages();
    }
    function saveStore(){localStorage.setItem(storeKey(),JSON.stringify(store));}
    function currentMode(){
        let storedMode='';
        try{storedMode=JSON.parse(localStorage.getItem(generationPrefKey)||'{}')?.mode||'';}catch(_){storedMode='';}
        const mode=storedMode||localStorage.getItem('xiaomei_canvas_agent_mode')||'agent';
        return ['skill','agent'].includes(mode)?mode:'agent';
    }
    function providerList(){return (apiProviders||[]).filter(item=>{
        const id=String(item?.id||'').trim().toLowerCase();
        const name=String(item?.name||'').trim().toLowerCase();
        return item.enabled!==false&&id!=='modelscope'&&!name.includes('modelscope')&&(item.chat_models||[]).length;
    });}
    function preferences(){try{return JSON.parse(localStorage.getItem(prefKey)||'{}');}catch(_){return {};}}
    function generationPreferences(){
        let saved={};
        try{saved=JSON.parse(localStorage.getItem(generationPrefKey)||'{}')||{};}catch(_){saved={};}
        const hasStoredAuto=Object.prototype.hasOwnProperty.call(saved,'auto');
        const hasStoredMode=Object.prototype.hasOwnProperty.call(saved,'mode');
        const next={...generationDefaults,...saved};
        next.auto=hasStoredAuto?next.auto!==false:localStorage.getItem('xiaomei_canvas_agent_auto')!=='0';
        next.mode=hasStoredMode&&['skill','agent'].includes(next.mode)?next.mode:currentMode();
        next.planMode=next.planMode===true;
        next.harnessMode=next.harnessMode!==false;
        next.media=next.media==='video'?'video':'image';
        const customRatio=normalizeGenerationCustomRatio(next);
        next.customRatio=customRatio.customRatio;
        next.customRatioWidth=customRatio.customRatioWidth;
        next.customRatioHeight=customRatio.customRatioHeight;
        next.ratio=generationRatioOptions.some(([value])=>value===next.ratio)?next.ratio:'square';
        next.resolution=['1k','2k','4k'].includes(next.resolution)?next.resolution:'1k';
        next.quality=['auto','low','medium','high','xhigh','max'].includes(next.quality)?next.quality:'auto';
        next.background=['auto','opaque','transparent'].includes(next.background)?next.background:'auto';
        next.videoAspect=String(next.videoAspect||'16:9');
        next.videoResolution=videoResolutionOptions.some(([value])=>value===next.videoResolution)?next.videoResolution:'';
        return next;
    }
    function saveGenerationPreferences(partial={}){
        const next={...generationPreferences(),...(partial||{})};
        try{localStorage.setItem(generationPrefKey,JSON.stringify(next));}catch(_){ }
        return next;
    }
    function canonicalSkillId(value){
        const id=String(value||'').trim();
        return sharedSkillApi?.canonicalId?.(id)||id;
    }
    function sharedSkill(){
        try{
            const stored=sharedSkillApi?.getSelected?.()||String(localStorage.getItem(skillSelectionKey)||'').trim();
            const selected=canonicalSkillId(stored);
            if(selected!==stored){
                if(sharedSkillApi?.setSelected)sharedSkillApi.setSelected(selected);
                else localStorage.setItem(skillSelectionKey,selected);
            }
            return selected;
        }catch(_){return '';}
    }
    function hasSharedSkillPreference(){try{return localStorage.getItem(skillSelectionKey)!==null;}catch(_){return false;}}
    function rememberedSkill(){
        const selected=sharedSkill();
        // An empty shared value is an intentional "通用助手" choice, not a
        // reason to revive the per-panel value from an older preference.
        if(hasSharedSkillPreference())return selected;
        return canonicalSkillId(selected||String(skillEl?.value||'').trim()||String(preferences().skill||'').trim());
    }
    function savePreferences({skillChanged=false}={}){
        const skill=skillChanged?canonicalSkillId(skillEl.value):rememberedSkill();
        if(skillChanged&&skillEl.value!==skill)skillEl.value=skill;
        localStorage.setItem(prefKey,JSON.stringify({provider:providerEl.value,model:modelEl.value,skill}));
        if(!skillChanged)return;
        if(sharedSkillApi?.setSelected)sharedSkillApi.setSelected(skill);
        else{try{localStorage.setItem(skillSelectionKey,skill);}catch(_){ }}
    }
    function syncProviders(){
        const pref=preferences(),old=providerEl.value||pref.provider,list=providerList();
        if(!list.length){
            providerEl.innerHTML='<option value="">暂无可用聊天模型</option>';
            modelEl.innerHTML='<option value="">暂无可用聊天模型</option>';
            providerEl.disabled=true;
            modelEl.disabled=true;
            return;
        }
        providerEl.disabled=false;
        providerEl.innerHTML=list.map(item=>`<option value="${esc(item.id)}">${esc(item.name||item.id)}</option>`).join('');
        if(list.some(item=>item.id===old))providerEl.value=old;
        syncModels();
    }
    function syncModels(){
        const pref=preferences(),provider=providerList().find(item=>item.id===providerEl.value)||providerList()[0];
        if(!provider){
            modelEl.innerHTML='<option value="">暂无可用聊天模型</option>';
            modelEl.disabled=true;
            return;
        }
        modelEl.disabled=false;
        const old=modelEl.value||pref.model,models=[...new Set(provider?.chat_models||[])];
        modelEl.innerHTML=models.map(model=>`<option value="${esc(model)}">${esc(model)}</option>`).join('');
        if(models.includes(old))modelEl.value=old;
        savePreferences();
    }
    function generationNode(){
        const node=typeof selectedNode==='function'?selectedNode():null;
        return node&&typeof isSmartRunnableNode==='function'&&isSmartRunnableNode(node)?node:null;
    }
    function settingsForGenerationNode(node){
        try{
            const source=node&&typeof smartSettingsForNode==='function'
                ? smartSettingsForNode(node)
                : (typeof cloneSmartSettings==='function'?cloneSmartSettings(settings):{...(settings||{})});
            return typeof apiOnlySettings==='function'?apiOnlySettings(source):source;
        }catch(_){return {...(settings||{})};}
    }
    function generationProviders(media='image'){
        try{
            return media==='video'
                ? (typeof videoApiProviders==='function'?videoApiProviders():[])
                : (typeof imageProviders==='function'?imageProviders():[]);
        }catch(_){return [];}
    }
    function generationModelEntries(media='image'){
        return generationProviders(media).flatMap(provider=>{
            let models=[];
            try{
                models=media==='video'
                    ? (typeof providerVideoModels==='function'?providerVideoModels(provider.id):(provider.video_models||[]))
                    : (typeof providerImageModels==='function'?providerImageModels(provider.id):(provider.image_models||[]));
            }catch(_){models=[];}
            return [...new Set(models||[])].filter(Boolean).map(model=>({
                provider:String(provider.id||''),
                providerName:String(provider.name||provider.id||''),
                model:String(model)
            }));
        }).filter(item=>item.provider&&item.model);
    }
    function generationModelToken(provider,model){
        return `${encodeURIComponent(String(provider||''))}|${encodeURIComponent(String(model||''))}`;
    }
    function parseGenerationModelToken(value=''){
        const index=String(value).indexOf('|');
        if(index<0)return {provider:'',model:''};
        try{return {provider:decodeURIComponent(value.slice(0,index)),model:decodeURIComponent(value.slice(index+1))};}
        catch(_){return {provider:value.slice(0,index),model:value.slice(index+1)};}
    }
    function canonicalRatioFromSettings(source={},media='image'){
        if(media==='video'){
            const value=String(source.videoAspect||'16:9');
            if(['keep_ratio','adaptive'].includes(value))return 'smart';
            const hit=generationRatioOptions.find(([,label])=>label===value);
            return hit?.[0]||generationRatioOptions.find(([key])=>key===value)?.[0]||'wide';
        }
        const value=String(source.ratio||'square');
        if(value==='source')return 'smart';
        if(value==='custom'){
            const custom=normalizeGenerationCustomRatio(source).customRatio;
            const hit={
                '5:4':'ratio54','4:5':'ratio45','21:9':'ultrawide','16:9':'wide','9:16':'story',
                '4:3':'landscape43','3:4':'portrait43','3:2':'landscape','2:3':'portrait','1:1':'square'
            }[custom];
            return hit||'custom';
        }
        return generationRatioOptions.some(([key])=>key===value)?value:'square';
    }
    function generationStateFromCanvasSettings(source={},fallback={}){
        const media=source.apiKind==='video'?'video':(fallback.media||'image');
        const state={...fallback,media};
        const customRatio=normalizeGenerationCustomRatio(source,fallback);
        state.customRatio=customRatio.customRatio;
        state.customRatioWidth=customRatio.customRatioWidth;
        state.customRatioHeight=customRatio.customRatioHeight;
        if(media==='video'){
            state.videoProvider=String(source.videoProvider||fallback.videoProvider||'');
            state.videoModel=String(source.videoModel||fallback.videoModel||'');
            state.videoAspect=String(source.videoAspect||fallback.videoAspect||'16:9');
            state.videoResolution=String(source.videoResolution||fallback.videoResolution||'');
            state.ratio=canonicalRatioFromSettings(source,'video');
        }else{
            state.imageProvider=String(source.provider_id||fallback.imageProvider||'');
            state.imageModel=String(source.model||fallback.imageModel||'');
            state.ratio=canonicalRatioFromSettings(source,'image');
            state.resolution=['1k','2k','4k'].includes(source.resolution)?source.resolution:(fallback.resolution||'1k');
            state.quality=['auto','low','medium','high','xhigh','max'].includes(source.quality)?source.quality:(fallback.quality||'auto');
            state.background=['auto','opaque','transparent'].includes(source.background)?source.background:(fallback.background||'auto');
        }
        return state;
    }
    function effectiveGenerationPreferences(){
        const saved=generationPreferences(),node=generationNode();
        if(saved.auto&&composer?.classList?.contains('open'))return generationStateFromCanvasSettings(settings,saved);
        if(saved.auto&&node)return generationStateFromCanvasSettings(settingsForGenerationNode(node),saved);
        return saved;
    }
    function syncGenerationPreferencesFromCanvas(source=settings){
        if(!source||source.apiKind==='video')return;
        const saved=generationPreferences();
        const state=generationStateFromCanvasSettings(source,saved);
        const custom=state.ratio==='custom'?normalizeGenerationCustomRatio(state):{customRatio:'',customRatioWidth:'',customRatioHeight:''};
        const patch={media:'image',ratio:state.ratio,...custom};
        if(['1k','2k','4k'].includes(source.resolution))patch.resolution=source.resolution;
        if(Object.entries(patch).some(([key,value])=>saved[key]!==value))saveGenerationPreferences(patch);
        renderGenerationPreferences();
    }
    function folderBatchContext(message=''){
        const requested=requestedGenerationPreferences(message);
        const state={...effectiveGenerationPreferences(),...requested};
        if(message){const error=generationPreferenceError(requested,message);if(error)throw new Error(error);}
        const entries=generationModelEntries('image');
        const preferred=entries.find(item=>item.provider===state.imageProvider&&item.model===state.imageModel)||entries[0];
        const target={engine:'api',apiKind:'image',provider_id:state.imageProvider||preferred?.provider||'',model:state.imageModel||preferred?.model||'',resolution:state.resolution,quality:state.quality,background:state.background};
        ratioForCanvasTarget(target,state.ratio,null,state);
        if(requested.ratioLabel&&state.ratio==='ultratall'){target.ratio='custom';target.customRatio=requested.ratioLabel;}
        // Each folder item supplies its own reference image for source ratios.
        if(state.ratio==='smart')target.ratio='source';
        return {
            canvasId:String(canvas?.id||''),conversationId:activeConversation().id,
            provider:providerEl.value,model:modelEl.value,skillId:canonicalSkillId(skillEl.value),
            generation:{provider_id:target.provider_id,model:target.model,size:sizeForRun(target),aspect_ratio:aspectRatioForRun(target),quality:target.quality,background:typeof normalizeSmartBackground==='function'?normalizeSmartBackground(target.background):target.background}
        };
    }
    function refreshFolderBatch(){
        if(sharedCanvasMode)return;
        if(!folderBatch&&window.CanvasFolderBatch){
            folderBatch=window.CanvasFolderBatch.create({
                root:$('canvasAgentFolderBatch'),getContext:folderBatchContext,
                getMessage:()=>input.value.trim(),previewUrl:agentPreviewUrl,
                onChange:()=>{
                    syncComposerRunUi();
                    if(historyTab==='batches'&&historyEl?.classList.contains('open'))renderBatchHistoryPanel();
                },
                onHistorySelect:()=>{
                    historyEl?.classList.remove('open');
                    $('canvasAgentHistoryToggle')?.classList.remove('active');
                    $('canvasAgentHistoryToggle')?.setAttribute('aria-expanded','false');
                    historyEl?.setAttribute('aria-hidden','true');
                }
            });
        }
        void folderBatch?.refresh();
        return folderBatch;
    }
    function closeGenerationModelMenu(){
        generationModelControl?.classList.remove('is-open');
        generationModelMenu?.setAttribute('hidden','');
        generationModelTrigger?.setAttribute('aria-expanded','false');
    }
    function toggleGenerationModelMenu(){
        if(!generationModelControl||!generationModelTrigger||generationModelTrigger.disabled)return;
        const opening=!generationModelControl.classList.contains('is-open');
        generationModelControl.classList.toggle('is-open',opening);
        generationModelMenu?.toggleAttribute('hidden',!opening);
        generationModelTrigger.setAttribute('aria-expanded',opening?'true':'false');
        if(opening){
            requestAnimationFrame(()=>{
                const active=generationModelMenu?.querySelector('[data-agent-generation-model].active');
                if(!active||!generationModelMenu)return;
                const list=active.closest('.image-model-options');
                if(list)list.scrollTop=Math.max(0,active.offsetTop-list.offsetTop-Math.max(0,(list.clientHeight-active.offsetHeight)/2));
            });
        }
    }
    function generationModelPickerData(state){
        const entries=generationModelEntries(state.media);
        const provider=state.media==='video'?state.videoProvider:state.imageProvider;
        const model=state.media==='video'?state.videoModel:state.imageModel;
        const currentToken=generationModelToken(provider,model);
        const list=entries;
        const groups=[];
        list.forEach(item=>{
            let group=groups.find(value=>value.provider===item.provider);
            if(!group){group={provider:item.provider,name:item.providerName||item.provider,items:[]};groups.push(group);}
            if(!group.items.some(value=>value.model===item.model))group.items.push(item);
        });
        return {groups,list,currentToken};
    }
    function renderGenerationModelPicker(state,data){
        if(!generationModelControl||!generationModelTrigger||!generationModelMenu)return;
        const {groups,list,currentToken}=data;
        const current=list.find(item=>generationModelToken(item.provider,item.model)===currentToken)||list[0];
        const mediaLabel=state.media==='video'?'视频模型':'生图模型';
        const hasModels=Boolean(current);
        generationModelTrigger.disabled=!hasModels;
        generationModelControl.classList.toggle('is-empty',!hasModels);
        if(generationModelLabelEl)generationModelLabelEl.textContent=current?.model||'暂无可用模型';
        if(generationModelProviderEl)generationModelProviderEl.textContent=current?.providerName||'请先在 API 设置中拉取模型';
        const metaText=hasModels?`${groups.length} 个平台 / ${list.length} 个${mediaLabel}`:'未找到可用模型';
        if(generationModelMetaEl)generationModelMetaEl.textContent=metaText;
        generationModelTrigger.title=hasModels
            ? `${mediaLabel}：${current.model} · ${current.providerName} · ${metaText}`
            : '请先在 API 设置中配置图片模型';
        generationModelTrigger.setAttribute('aria-label',hasModels?`${mediaLabel}：${current.model}，${current.providerName}`:'暂无可用图片模型');
        if(!hasModels){
            generationModelMenu.innerHTML='<div class="canvas-agent-generation-model-empty"><i data-lucide="image-off"></i><span>请先在 API 设置中配置图片模型</span></div>';
            closeGenerationModelMenu();
            if(typeof refreshIcons==='function')refreshIcons();
            return;
        }
        const selectedGroup=groups.find(group=>group.provider===current.provider)||groups[0];
        generationModelMenu.innerHTML=`
            <div class="image-model-popover-head"><i data-lucide="sparkles"></i><span>${mediaLabel}</span></div>
            <div class="image-model-picker">
                <div class="image-model-picker-column">
                    <div class="image-model-picker-label">API 平台</div>
                    <div class="image-model-provider-list" role="group" aria-label="API 平台">
                        ${groups.map(group=>`<button type="button" class="image-model-option${group.provider===selectedGroup.provider?' active':''}" aria-pressed="${group.provider===selectedGroup.provider?'true':'false'}" data-agent-generation-provider="${esc(group.provider)}" title="${esc(group.name)}"><span>${esc(group.name)}</span></button>`).join('')}
                    </div>
                </div>
                <div class="image-model-picker-column">
                    <div class="image-model-picker-label">${mediaLabel}<small>${selectedGroup.items.length}</small></div>
                    <div class="image-model-options" role="group" aria-label="${esc(selectedGroup.name)}${mediaLabel}">
                        ${selectedGroup.items.map(item=>{
                            const token=generationModelToken(item.provider,item.model),active=token===currentToken;
                            return `<button type="button" class="image-model-option${active?' active':''}" aria-pressed="${active?'true':'false'}" data-agent-generation-model="${esc(token)}" title="${esc(item.model)}"><span>${esc(item.model)}</span></button>`;
                        }).join('')}
                    </div>
                </div>
            </div>`;
        if(typeof refreshIcons==='function')refreshIcons();
    }
    function syncGenerationModelOptions(state){
        const data=generationModelPickerData(state);
        const {groups,list,currentToken}=data;
        if(!generationModelEl){renderGenerationModelPicker(state,data);return;}
        if(!list.length){
            generationModelEl.innerHTML='<option value="">暂无可用生图模型</option>';
            generationModelEl.disabled=true;
            renderGenerationModelPicker(state,data);
            return;
        }
        generationModelEl.innerHTML=groups.map(group=>`<optgroup label="${esc(group.name)}">${group.items.map(item=>`<option value="${esc(generationModelToken(item.provider,item.model))}">${esc(item.model)}</option>`).join('')}</optgroup>`).join('');
        generationModelEl.value=currentToken;
        if(generationModelEl.value!==currentToken){
            const fallback=list[0];
            generationModelEl.value=generationModelToken(fallback.provider,fallback.model);
            if(!state.auto)saveGenerationPreferences(state.media==='video'
                ?{videoProvider:fallback.provider,videoModel:fallback.model}
                :{imageProvider:fallback.provider,imageModel:fallback.model});
        }
        generationModelEl.disabled=false;
        renderGenerationModelPicker(state,{groups,list,currentToken:generationModelEl.value});
    }
    function generationHasReferenceImage(node){
        try{
            const refs=typeof visibleReferenceImagesFor==='function'&&node?visibleReferenceImagesFor(node):[];
            return refs.some(item=>item?.url&&mediaKindForItem(item)==='image');
        }catch(_){return false;}
    }
    function ratioForCanvasTarget(target,ratio,node,customSource={}){
        const value=ratio||'square';
        if(value==='smart'){
            if(generationHasReferenceImage(node)){
                target.ratio='source';
                return;
            }
            target.ratio='square';
            target.customRatio='';target.customRatioWidth='';target.customRatioHeight='';
            return;
        }
        const map={square:'square',wide:'wide',story:'story',landscape43:'landscape43',portrait43:'portrait43',landscape:'landscape',portrait:'portrait',ultrawide:'ultrawide'};
        if(map[value]){
            target.ratio=map[value];
            target.customRatio='';target.customRatioWidth='';target.customRatioHeight='';
            return;
        }
        if(value==='custom'){
            const custom=normalizeGenerationCustomRatio(customSource);
            target.ratio='custom';
            target.customRatio=custom.customRatio;
            target.customRatioWidth=custom.customRatioWidth;
            target.customRatioHeight=custom.customRatioHeight;
            return;
        }
        const custom=value==='ratio54'?'5:4':value==='ratio45'?'4:5':'';
        if(custom){
            target.ratio='custom';target.customRatio=custom;
            const [w,h]=custom.split(':');target.customRatioWidth=Number(w);target.customRatioHeight=Number(h);
            return;
        }
        target.ratio='square';
        target.customRatio='';target.customRatioWidth='';target.customRatioHeight='';
    }
    function applyGenerationPreferencesToCurrentNode(options={}){
        const node=options.node||generationNode(),saved=generationPreferences();
        if(saved.auto&&node){
            try{settings=typeof cloneSmartSettings==='function'?cloneSmartSettings(settingsForGenerationNode(node)):{...(settings||{})};}catch(_){ }
            if(node&&typeof settingsForStorage==='function')node.runSettings=settingsForStorage(settings);
            if(typeof renderDynamicParams==='function'&&options.render!==false)renderDynamicParams();
            if(typeof scheduleSave==='function')scheduleSave();
            return settings;
        }
        const target=typeof cloneSmartSettings==='function'?cloneSmartSettings(settings):{...(settings||{})};
        const media=saved.media==='video'?'video':'image';
        target.engine='api';target.apiKind=media;
        if(media==='video'){
            const entries=generationModelEntries('video');
            const preferred=entries.find(item=>item.provider===saved.videoProvider&&item.model===saved.videoModel)||entries[0];
            target.videoProvider=saved.videoProvider||preferred?.provider||target.videoProvider||'';
            target.videoModel=saved.videoModel||preferred?.model||target.videoModel||'';
            target.videoAspect=saved.ratio==='smart'
                ?(generationHasReferenceImage(node)?'keep_ratio':'1:1')
                :({wide:'16:9',story:'9:16',square:'1:1',landscape43:'4:3',portrait43:'3:4',landscape:'3:2',portrait:'2:3',ratio54:'5:4',ratio45:'4:5',ultrawide:'21:9'}[saved.ratio]||saved.videoAspect||'16:9');
            target.videoResolution=saved.videoResolution||'';
        }else{
            const entries=generationModelEntries('image');
            const preferred=entries.find(item=>item.provider===saved.imageProvider&&item.model===saved.imageModel)||entries[0];
            target.provider_id=saved.imageProvider||preferred?.provider||target.provider_id||'';
            target.model=saved.imageModel||preferred?.model||target.model||'';
            target.resolution=saved.resolution||'1k';
            ratioForCanvasTarget(target,saved.ratio,node,saved);
        }
        settings=target;
        if(node&&typeof settingsForStorage==='function')node.runSettings=settingsForStorage(settings);
        if(typeof persistActiveSmartSettings==='function')persistActiveSmartSettings();
        if(typeof renderDynamicParams==='function'&&options.render!==false)renderDynamicParams();
        if(typeof scheduleSave==='function')scheduleSave();
        return settings;
    }
    function setManualGenerationPreference(patch={},options={}){
        const saved=generationPreferences();
        const base=saved.auto?effectiveGenerationPreferences():saved;
        const next=saveGenerationPreferences({...base,auto:false,...patch});
        const shouldRender=options.render!==false;
        if(shouldRender)renderGenerationPreferences();
        return next;
    }
    function renderCustomRatioControls(state){
        const active=state.media==='image'&&state.ratio==='custom';
        if(customRatioFieldsEl)customRatioFieldsEl.hidden=!active;
        if(!active)return;
        const custom=normalizeGenerationCustomRatio(state);
        if(customRatioWidthEl)customRatioWidthEl.value=custom.customRatioWidth;
        if(customRatioHeightEl)customRatioHeightEl.value=custom.customRatioHeight;
        renderCustomRatioHint(custom);
    }
    function renderCustomRatioHint(custom=normalizeGenerationCustomRatio({customRatioWidth:customRatioWidthEl?.value,customRatioHeight:customRatioHeightEl?.value})){
        if(!customRatioHintEl)return;
        customRatioHintEl.textContent=custom.customRatio?`当前比例 ${custom.customRatio}`:'请输入宽和高，例如 710:229';
        customRatioHintEl.classList.toggle('is-invalid',!custom.customRatio);
    }
    function generationRatioSwatch(value){
        return `<span class="ratio-icon ${ratioIconClass(value==='smart'?'source':value)}" aria-hidden="true"></span>`;
    }
    function renderGenerationPreferences(){
        const saved=generationPreferences(),state=effectiveGenerationPreferences();
        const autoEl=$('canvasAgentAuto');
        if(autoEl)autoEl.checked=saved.auto;
        if(planModeEl)planModeEl.checked=saved.planMode;
        if(harnessModeEl)harnessModeEl.checked=saved.harnessMode;
        document.querySelectorAll('[data-agent-mode]').forEach(button=>button.classList.toggle('active',button.dataset.agentMode===state.mode));
        document.querySelectorAll('[data-agent-media]').forEach(button=>button.classList.toggle('active',button.dataset.agentMedia===state.media));
        if(ratioOptionsEl){
            const ratioOptions=state.media==='video'?generationRatioOptions.filter(([value])=>value!=='custom'):generationRatioOptions;
            const visibleState=state.media==='video'&&state.ratio==='custom'?{...state,ratio:'wide'}:state;
            ratioOptionsEl.innerHTML=ratioOptions.map(([value,label])=>`<button type="button" class="${value===visibleState.ratio?'active':''}" data-agent-ratio="${esc(value)}" aria-pressed="${value===visibleState.ratio?'true':'false'}" title="${esc(label)}">${generationRatioSwatch(value)}<span class="canvas-agent-ratio-label">${esc(label)}</span></button>`).join('');
            ratioOptionsEl.querySelectorAll('[data-agent-ratio]').forEach(button=>button.onclick=()=>setManualGenerationPreference({ratio:button.dataset.agentRatio}));
        }
        renderCustomRatioControls(state);
        if(resolutionOptionsEl){
            const options=state.media==='video'?videoResolutionOptions:imageResolutionOptions;
            const current=state.media==='video'?state.videoResolution:state.resolution;
            resolutionOptionsEl.innerHTML=options.map(([value,label])=>`<button type="button" class="${value===current?'active':''}" data-agent-resolution="${esc(value)}" aria-pressed="${value===current?'true':'false'}" title="${esc(label)}"><span class="canvas-agent-resolution-label">${esc(label)}</span></button>`).join('');
            resolutionOptionsEl.querySelectorAll('[data-agent-resolution]').forEach(button=>button.onclick=()=>state.media==='video'
                ?setManualGenerationPreference({videoResolution:button.dataset.agentResolution})
                :setManualGenerationPreference({resolution:button.dataset.agentResolution}));
        }
        syncGenerationModelOptions(state);
        const hint=$('canvasAgentGenerationHint');
        if(hint)hint.textContent=state.mode==='skill'
            ?(saved.planMode?'计划模式已开启：先分析并给出多个执行方向，选择后自动编排画布。':'Skill 模式使用当前手动选择的 Skill；普通发送会自动写入当前正式任务并运行。')
            :(saved.planMode?'计划模式已开启：先分析并给出多个执行方向，选择后自动编排画布。':saved.harnessMode?'复杂任务会交给 Codex Harness，简单任务继续走现有单步 Agent。':'Agent 模式会优先使用已选择的 Skill；清除后才按当前任务自动关联 Skill。');
        generationSettingsEl?.classList.toggle('generation-auto-following',saved.auto&&Boolean(generationNode()));
    }
    function skillState(skill){
        if(skill?.enabled===false)return {key:'disabled',label:'已停用',dot:'off'};
        if(skill?.status==='warning'||(skill?.warnings||[]).length)return {key:'warning',label:'有导入警告',dot:'warn'};
        if(skill?.status==='prompt-only'||skill?.has_scripts||(skill?.requirements||[]).length){
            const label=skill?.has_scripts||(skill?.requirements||[]).length
                ?'对话可用·脚本待适配'
                :skill?.authorization_required?'对话可用·需宿主配置':(skill?.status_label||'对话可用');
            return {key:'prompt-only',label,dot:'warn'};
        }
        return {key:'ready',label:skill?.has_references?'对话与参考资料可用':'对话可用',dot:'good'};
    }
    const DEFAULT_SKILL_CATEGORIES=[
        {id:'full-link-operation',name:'全链路运营',builtin:true},
        {id:'visual',name:'视觉内容',builtin:true},
        {id:'other',name:'其他',builtin:true},
        {id:'custom',name:'自定义',builtin:true}
    ];
    function skillCategoryEntries(){
        const map=new Map(DEFAULT_SKILL_CATEGORIES.map(item=>[item.id,{...item}]));
        (skillCategories||[]).forEach(item=>{
            const id=String(item?.id||'').trim();
            const name=String(item?.name||item?.label||'').trim();
            if(id&&name)map.set(id,{id,name,builtin:Boolean(item?.builtin)});
        });
        (skills||[]).forEach(item=>{
            const id=String(item?.category||'').trim();
            if(id&&!map.has(id))map.set(id,{id,name:String(item?.category_label||id),builtin:false});
        });
        return [...map.values()];
    }
    function renderSkillCategoryFilterOptions(){
        if(!skillCategoryEl)return;
        const current=String(skillCategoryEl.value||'all');
        const options=skillCategoryEntries();
        skillCategoryEl.innerHTML='<option value="all">全部分类</option>'+options.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        skillCategoryEl.value=options.some(item=>item.id===current)?current:'all';
    }
    function setSkillCategoryStatus(message,type=''){
        if(!skillCategoryStatusEl)return;
        skillCategoryStatusEl.textContent=String(message||'');
        skillCategoryStatusEl.className=`canvas-agent-skill-category-status ${type||''}`.trim();
    }
    function renderSkillCategoryManager(){
        if(!skillCategoryListEl)return;
        const counts=new Map();
        (skills||[]).forEach(item=>{const id=String(item?.category||'other').trim()||'other';counts.set(id,(counts.get(id)||0)+1);});
        skillCategoryListEl.innerHTML=skillCategoryEntries().map(item=>{
            const actions=item.builtin
                ?'<span class="canvas-agent-skill-category-built-in">内置</span>'
                :`<span class="canvas-agent-skill-category-actions"><button type="button" data-agent-category-rename="${esc(item.id)}">重命名</button><button type="button" data-agent-category-delete="${esc(item.id)}">删除</button></span>`;
            return `<div class="canvas-agent-skill-category-item"><span class="canvas-agent-skill-category-copy"><strong>${esc(item.name)}</strong><small>${counts.get(item.id)||0} 个 Skill · ${item.builtin?'系统分类':'自定义分类'}</small></span>${actions}</div>`;
        }).join('');
        skillCategoryListEl.querySelectorAll('[data-agent-category-rename]').forEach(button=>button.onclick=()=>renameSkillCategory(button.dataset.agentCategoryRename||''));
        skillCategoryListEl.querySelectorAll('[data-agent-category-delete]').forEach(button=>button.onclick=()=>deleteSkillCategory(button.dataset.agentCategoryDelete||''));
        if(typeof refreshIcons==='function')refreshIcons();
    }
    function toggleSkillCategoryManager(force){
        categoryManagerOpen=typeof force==='boolean'?force:!categoryManagerOpen;
        if(skillCategoryManagerEl)skillCategoryManagerEl.hidden=!categoryManagerOpen;
        if(categoryManagerOpen){
            renderSkillCategoryManager();
            requestAnimationFrame(()=>skillCategoryNameEl?.focus());
        }else setSkillCategoryStatus('');
    }
    async function setSkillCategory(skillId,categoryId){
        const id=String(skillId||'').trim();
        const next=String(categoryId||'').trim();
        if(!id||!next)return;
        try{
            const response=await fetch(`/api/agent-skills/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({category_id:next})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'分类更新失败');
            const updated=data.skill||{};
            skills=skills.map(item=>item.id===id?{...item,...updated}:item);
            renderSkillList();
            renderSkillCategoryManager();
            toast(`已将 Skill 移到“${updated.category_label||next}”`);
        }catch(error){toast(`更新 Skill 分类失败：${error.message||error}`);}
    }
    async function createSkillCategory(event){
        event.preventDefault();
        const name=String(skillCategoryNameEl?.value||'').trim();
        if(!name){setSkillCategoryStatus('请先填写分类名称','error');return;}
        const submit=skillCategoryFormEl?.querySelector('button[type="submit"]');
        if(submit)submit.disabled=true;
        try{
            const response=await fetch('/api/agent-skills/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'创建分类失败');
            if(skillCategoryNameEl)skillCategoryNameEl.value='';
            await loadSkills();
            toggleSkillCategoryManager(true);
            setSkillCategoryStatus(`已创建分类“${data.category?.name||name}”`,'success');
        }catch(error){setSkillCategoryStatus(error.message||'创建分类失败','error');}
        finally{if(submit)submit.disabled=false;}
    }
    async function renameSkillCategory(categoryId){
        const item=skillCategoryEntries().find(value=>value.id===categoryId);
        if(!item||item.builtin)return;
        const name=window.prompt('请输入新的分类名称',item.name);
        if(!name||name.trim()===item.name)return;
        try{
            const response=await fetch(`/api/agent-skills/categories/${encodeURIComponent(categoryId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'重命名失败');
            await loadSkills();
            toggleSkillCategoryManager(true);
            setSkillCategoryStatus(`已重命名为“${data.category?.name||name.trim()}”`,'success');
        }catch(error){setSkillCategoryStatus(error.message||'重命名失败','error');}
    }
    async function deleteSkillCategory(categoryId){
        const item=skillCategoryEntries().find(value=>value.id===categoryId);
        if(!item||item.builtin)return;
        if(!window.confirm(`删除“${item.name}”后，其中的 Skill 会移到“自定义”。继续吗？`))return;
        try{
            const response=await fetch(`/api/agent-skills/categories/${encodeURIComponent(categoryId)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({fallback_category_id:'custom'})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'删除分类失败');
            await loadSkills();
            toggleSkillCategoryManager(true);
            setSkillCategoryStatus(`分类已删除，${Number(data.reassigned||0)} 个 Skill 已移到“自定义”`,'success');
        }catch(error){setSkillCategoryStatus(error.message||'删除分类失败','error');}
    }
    function setSkillTab(tab='library'){
        const next=['library','install'].includes(tab)?tab:'library';
        if(next!=='library')toggleSkillCategoryManager(false);
        document.querySelectorAll('[data-canvas-skill-tab]').forEach(button=>{
            const active=button.dataset.canvasSkillTab===next;
            button.classList.toggle('active',active);
            button.setAttribute('aria-selected',active?'true':'false');
        });
        document.querySelectorAll('[data-canvas-skill-pane]').forEach(pane=>{
            const active=pane.dataset.canvasSkillPane===next;
            pane.hidden=!active;
            pane.classList.toggle('active',active);
        });
        if(next==='install')skillPackageSourceEl?.focus();
        if(typeof refreshIcons==='function')refreshIcons();
    }
    function updateSkillCurrent(){
        const selected=skills.find(skill=>skill.id===skillEl?.value);
        const nameEl=skillCurrentEl?.querySelector('strong');
        const detailEl=skillCurrentEl?.querySelector('small');
        const clearButton=$('canvasAgentSkillClear');
        if(nameEl)nameEl.textContent=selected?.name||selected?.display_name||'通用助手';
        if(detailEl)detailEl.textContent=selected?'当前 Agent 对话会加载该 Skill':'当前未加载额外 Skill';
        skillCurrentEl?.classList.toggle('is-selected',Boolean(selected));
        if(clearButton){clearButton.disabled=!selected;clearButton.textContent=selected?'清除':'默认';}
        const currentName=selected?.name||selected?.display_name||'通用助手';
        if(skillQuickCurrentEl)skillQuickCurrentEl.textContent=currentName;
    }
    function renderSkillList(){
        if(!skillList)return;
        renderSkillCategoryFilterOptions();
        const query=String(skillSearchEl?.value||'').trim().toLocaleLowerCase();
        const category=String(skillCategoryEl?.value||'all');
        const status=String(skillStatusEl?.value||'all');
        const visibleSkills=skills.filter(skill=>{
            const state=skillState(skill);
            const haystack=[skill.name,skill.display_name,skill.description,skill.category_label,skill.status_label,skill.slug]
                .filter(Boolean).join(' ').toLocaleLowerCase();
            return (!query||haystack.includes(query))
                && (category==='all'||String(skill.category||'')===category)
                && (status==='all'||state.key===status);
        });
        updateSkillCurrent();
        if(skillCountEl)skillCountEl.textContent=query||category!=='all'||status!=='all'?`${visibleSkills.length} / ${skills.length}`:`${skills.length} 个`;
        if(skillTabCountEl)skillTabCountEl.textContent=String(skills.length);
        if(skillEmpty){
            if(!skills.length)skillEmpty.textContent=skillEmpty.dataset.loadMessage||'暂无 Skill。点击右上角新建，或在“安装 Skill”中导入。';
            else if(!visibleSkills.length)skillEmpty.textContent='没有匹配的 Skill，换个关键词或筛选条件试试。';
            skillEmpty.style.display=visibleSkills.length?'none':'block';
        }
        skillList.innerHTML=visibleSkills.map(skill=>{
            const state=skillState(skill);
            const categoryLabel=skill.category_label||'自定义';
            const description=skill.description||'暂无简介';
            const active=skill.id===skillEl.value;
            const action=state.key==='disabled'?'启用并使用':active?'当前':'使用';
            const toggleLabel=state.key==='disabled'?'启用':'停用';
            const toggleTitle=state.key==='disabled'?'启用此 Skill':'停用此 Skill';
            const canToggle=skill.kind==='package';
            const categoryOptions=skillCategoryEntries().map(item=>`<option value="${esc(item.id)}" ${String(skill.category||'other')===item.id?'selected':''}>${esc(item.name)}</option>`).join('');
            return `<div class="canvas-agent-skill-item ${active?'active ':''}${state.key==='disabled'?'disabled':''}">
                <button type="button" data-agent-skill-id="${esc(skill.id)}" class="canvas-agent-skill-main" aria-pressed="${active?'true':'false'}" title="${esc(description)}">
                    <span class="canvas-agent-skill-option-icon"><i data-lucide="sparkles"></i></span>
                    <span class="canvas-agent-skill-option-copy">
                        <strong>${esc(skill.name||skill.display_name||'未命名 Skill')}</strong>
                        <small><span class="canvas-agent-skill-status-dot ${esc(state.dot)}"></span>${esc(categoryLabel)} · ${esc(state.label)}${skill.version?' · v'+esc(skill.version):''}</small>
                        <em>${esc(description)}</em>
                    </span>
                    <span class="canvas-agent-skill-option-action">${action}</span>
                </button>
                ${canToggle?`<select class="canvas-agent-skill-category-select" data-agent-skill-category="${esc(skill.id)}" aria-label="${esc(`为 ${skill.name||skill.id} 选择分类`)}">${categoryOptions}</select>`:'<span class="canvas-agent-skill-state custom">单文件</span>'}
                ${canToggle?`<button type="button" class="canvas-agent-skill-state ${state.key==='disabled'?'is-disabled':''}" data-agent-skill-toggle="${esc(skill.id)}" title="${esc(toggleTitle)}">${toggleLabel}</button>`:''}
            </div>`;
        }).join('');
        if(typeof refreshIcons==='function')refreshIcons();
        renderSkillCategoryManager();
        skillList.querySelectorAll('[data-agent-skill-id]').forEach(button=>button.onclick=async()=>{
            const skillId=button.dataset.agentSkillId||'';
            const skill=skills.find(item=>item.id===skillId);
            if(!skill)return;
            if(skill.enabled===false){
                const enabled=await setSkillEnabled(skillId,true);
                if(!enabled)return;
            }
            const isActive=skillEl.value===skillId;
            skillEl.value=isActive?'':skillId;
            savePreferences({skillChanged:true});
            renderSkillList();
            skillPopover.classList.remove('open');
            const skillName=button.querySelector('.canvas-agent-skill-option-copy strong')?.textContent||'';
            toast(isActive?`已取消 Skill：${skillName}`:`已启用 Skill：${skillName}`);
        });
        skillList.querySelectorAll('[data-agent-skill-toggle]').forEach(button=>{
            const handler=async()=>{
                const id=button.dataset.agentSkillToggle||'';
                const skill=skills.find(item=>item.id===id);
                if(!skill)return;
                await setSkillEnabled(id,skill.enabled===false);
            };
            button.onclick=handler;
            button.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();handler();}};
        });
        skillList.querySelectorAll('[data-agent-skill-category]').forEach(select=>{
            select.onchange=()=>setSkillCategory(select.dataset.agentSkillCategory||'',select.value);
            select.onclick=event=>event.stopPropagation();
            select.onpointerdown=event=>event.stopPropagation();
        });
    }
    function renderQuickSkillList(){
        if(!skillQuickList)return;
        const query=String(skillQuickSearchEl?.value||'').trim().toLocaleLowerCase();
        const visibleSkills=skills.filter(skill=>{
            if(skill.enabled===false)return false;
            const haystack=[skill.name,skill.display_name,skill.description,skill.category_label,skill.slug]
                .filter(Boolean).join(' ').toLocaleLowerCase();
            return !query||haystack.includes(query);
        });
        const quickPriority=new Map([['buyer-show-generation',0],[BROWSER_SKILL_ID,1]]);
        visibleSkills.sort((a,b)=>{
            const rankA=quickPriority.has(a.id)?quickPriority.get(a.id):100;
            const rankB=quickPriority.has(b.id)?quickPriority.get(b.id):100;
            return rankA-rankB;
        });
        if(skillQuickEmpty){
            skillQuickEmpty.textContent=skills.length
                ?'没有匹配的 Skill，换个关键词试试。'
                :'暂无可用 Skill，请先在 Skill 管理中导入或新建。';
            skillQuickEmpty.style.display=visibleSkills.length?'none':'block';
        }
        skillQuickList.innerHTML=visibleSkills.map(skill=>{
            const active=skill.id===skillEl.value;
            const name=skill.name||skill.display_name||skill.id||'未命名 Skill';
            const description=skill.description||'暂无简介';
            return `<button type="button" role="option" aria-selected="${active?'true':'false'}" class="canvas-agent-skill-quick-item ${active?'active':''}" data-agent-quick-skill-id="${esc(skill.id)}" title="${esc(description)}">
                <span class="canvas-agent-skill-quick-icon"><i data-lucide="sparkles"></i></span>
                <span class="canvas-agent-skill-quick-copy"><strong>${esc(name)}</strong><small>${esc(description)}</small></span>
                <span class="canvas-agent-skill-quick-action">${active?'当前':'使用'}</span>
            </button>`;
        }).join('');
        if(typeof refreshIcons==='function')refreshIcons();
        skillQuickList.querySelectorAll('[data-agent-quick-skill-id]').forEach(button=>button.onclick=()=>{
            const skillId=String(button.dataset.agentQuickSkillId||'').trim();
            const skill=skills.find(item=>item.id===skillId);
            if(!skill)return;
            const active=skillEl.value===skillId;
            skillEl.value=active?'':skillId;
            savePreferences({skillChanged:true});
            renderSkillList();
            renderQuickSkillList();
            skillQuickPopover?.classList.remove('open');
            skillQuickPopover?.setAttribute('aria-hidden','true');
            skillQuickToggle?.classList.remove('active');
            skillQuickToggle?.setAttribute('aria-expanded','false');
            toast(active?`已切换为通用助手`:`已启用 Skill：${skill.name||skill.display_name||skill.id}`);
        });
    }
    async function setSkillEnabled(skillId,enabled){
        const id=String(skillId||'').trim();
        if(!id)return false;
        try{
            const response=await fetch(`/api/agent-skills/${encodeURIComponent(id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:Boolean(enabled)})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'状态更新失败');
            const next=data.skill||{};
            skills=skills.map(item=>item.id===id?{...item,...next}:item);
            if(!enabled&&skillEl.value===id){skillEl.value='';savePreferences({skillChanged:true});}
            renderSkillList();
            renderQuickSkillList();
            toast(enabled?'Skill 已启用':'Skill 已停用');
            return true;
        }catch(error){toast(`更新 Skill 失败：${error.message||error}`);return false;}
    }
    function setSkillPackageStatus(message,type=''){
        if(!skillPackageStatusEl)return;
        skillPackageStatusEl.textContent=String(message||'');
        skillPackageStatusEl.className=`canvas-agent-skill-package-status ${type||''}`.trim();
    }
    function setSkillPackageImportButton(enabled,busy=false){
        const button=$('canvasAgentSkillImport');
        if(!button)return;
        button.disabled=!enabled||busy;
        button.textContent=busy?'正在导入…':'导入';
    }
    function resetSkillPackageInputState(){
        skillPackageScan=null;
        skillPackageSourceDir='';
        skillPackageUploadFiles=[];
        if(skillPackageDirectoryEl)skillPackageDirectoryEl.value='';
        if(skillPackageSelectionHintEl)skillPackageSelectionHintEl.textContent='';
        setSkillPackageImportButton(false);
    }
    function handleSkillPackageDirectory(event){
        skillPackageUploadFiles=Array.from(event?.target?.files||[]);
        skillPackageSourceDir='';
        skillPackageScan=null;
        if(skillPackageSourceEl)skillPackageSourceEl.value='';
        if(skillPackageSelectionHintEl){
            const first=skillPackageUploadFiles[0]?.webkitRelativePath||skillPackageUploadFiles[0]?.name||'';
            const root=first.split('/')[0]||'所选文件夹';
            skillPackageSelectionHintEl.textContent=skillPackageUploadFiles.length?`已选择文件夹“${root}”，共 ${skillPackageUploadFiles.length} 个文件；正在自动检查…`:'';
        }
        setSkillPackageImportButton(false);
        if(skillPackageUploadFiles.length){
            setSkillPackageStatus('正在识别这个文件夹…');
            void inspectSkillPackage();
        }else setSkillPackageStatus('');
    }
    function renderSkillPackagePreview(scan){
        if(!skillPackagePreviewEl)return;
        if(!scan){skillPackagePreviewEl.innerHTML='';return;}
        const entries=Array.isArray(scan.skills)?scan.skills:[];
        const valid=entries.filter(item=>item.valid!==false);
        const invalid=entries.filter(item=>item.valid===false);
        const warningCount=(scan.warnings||[]).length+entries.reduce((sum,item)=>sum+(item.warnings||[]).length,0);
        const names=valid.map(item=>esc(item.name||item.display_name||item.id||'未命名 Skill'));
        skillPackagePreviewEl.innerHTML=valid.length
            ?`<strong>发现 ${valid.length} 个 Skill</strong><span>${names.join('、')}</span><b class="canvas-skill-preview-count">可以导入</b><span class="canvas-skill-preview-note">导入后会加入列表，不会自动切换当前对话。</span>`
            :'<strong>没有找到可导入的 Skill</strong><span class="canvas-skill-preview-note">请选择里面包含 SKILL.md 的文件夹。</span>';
        if(invalid.length)skillPackagePreviewEl.innerHTML+=`<small>无法导入：${invalid.slice(0,5).map(item=>esc(item.id||item.error||'未知')).join('、')}</small>`;
        if(warningCount)skillPackagePreviewEl.innerHTML+=`<span class="canvas-skill-preview-note">有 ${warningCount} 项内容需要注意，但不影响可导入项目。</span>`;
    }
    async function inspectSkillPackage(){
        const source=String(skillPackageSourceEl?.value||'').trim();
        if(!source&&!skillPackageUploadFiles.length){setSkillPackageStatus('请粘贴 Skill 目录路径，或点击“选择文件夹”','error');return null;}
        setSkillPackageImportButton(false);
        setSkillPackageStatus('正在检查这个文件夹…');
        try{
            let response;
            if(skillPackageUploadFiles.length){
                const form=new FormData();
                const relativePaths=skillPackageUploadFiles.map(file=>file.webkitRelativePath||file.name||'');
                skillPackageUploadFiles.forEach(file=>form.append('files',file,file.webkitRelativePath||file.name));
                form.append('relative_paths',JSON.stringify(relativePaths));
                response=await fetch('/api/agent-skills/inspect-upload',{method:'POST',body:form});
            }else{
                response=await fetch('/api/agent-skills/inspect-package',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_dir:source})});
            }
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'扫描失败');
            skillPackageScan=data;
            skillPackageSourceDir=String(data.source_dir||source||'').trim();
            renderSkillPackagePreview(data);
            const validCount=Number(data.valid_count||0);
            const warningCount=(data.warnings||[]).length+(data.skills||[]).reduce((sum,item)=>sum+(item.warnings||[]).length,0);
            setSkillPackageImportButton(validCount>0);
            setSkillPackageStatus(validCount?`发现 ${validCount} 个 Skill，可以导入${warningCount?'，有少量内容需要注意':''}`:'没有找到可以导入的 Skill',validCount?'success':'error');
            return data;
        }catch(error){resetSkillPackageInputState();renderSkillPackagePreview(null);setSkillPackageStatus(`无法读取这个文件夹：${error.message||error}`,'error');return null;}
    }
    async function importSkillPackage(replace=false){
        const scan=skillPackageScan||await inspectSkillPackage();
        if(!scan)return;
        const source=String(skillPackageSourceDir||skillPackageSourceEl?.value||'').trim();
        if(!source){setSkillPackageStatus('扫描结果已失效，请重新扫描','error');return;}
        setSkillPackageImportButton(true,true);
        setSkillPackageStatus(replace?'正在更新已有 Skill…':'正在导入 Skill…');
        try{
            const response=await fetch('/api/agent-skills/import-package',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_dir:source,replace:Boolean(replace)})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'导入失败');
            const imported=data.imported||[],skipped=data.skipped||[],conflicts=data.conflicts||[],errors=data.errors||[];
            if(conflicts.length&&!replace){
                if(imported.length&&!await loadSkills()){
                    resetSkillPackageInputState();
                    setSkillPackageStatus('部分 Skill 已导入，但列表刷新失败，请重新打开 Skill 库。','error');
                    return;
                }
                setSkillPackageImportButton(true);
                const names=conflicts.map(item=>item.id||'这个 Skill').join('、');
                if(window.confirm(`${names} 已经存在，是否覆盖？`)){
                    if(skillPackageUploadFiles.length){
                        skillPackageScan=null;
                        skillPackageSourceDir='';
                        if(!await inspectSkillPackage())return;
                    }
                    return importSkillPackage(true);
                }
                resetSkillPackageInputState();
                renderSkillPackagePreview(null);
                setSkillPackageStatus(imported.length?`已导入 ${imported.length} 个 Skill；原有 ${conflicts.length} 个 Skill 未覆盖。`:'已保留原来的 Skill，没有覆盖。');
                return;
            }
            const loaded=await loadSkills();
            if(!loaded){
                resetSkillPackageInputState();
                setSkillPackageStatus('文件已经导入，但 Skill 列表刷新失败，请重新打开 Skill 库。','error');
                return;
            }
            const missing=imported.filter(item=>!skills.some(skill=>skill.id===item.id));
            if(missing.length){
                resetSkillPackageInputState();
                setSkillPackageStatus('导入结果已返回，但列表没有找到新 Skill，请重新打开 Skill 库。','error');
                return;
            }
            if(imported.length){
                const importedId=imported[0]?.id||'';
                setSkillTab('library');
                requestAnimationFrame(()=>{
                    const item=Array.from(skillList?.querySelectorAll('[data-agent-skill-id]')||[]).find(button=>button.dataset.agentSkillId===importedId);
                    item?.scrollIntoView({block:'nearest'});
                });
                const currentName=skills.find(item=>item.id===skillEl.value)?.name||'通用助手';
                setSkillPackageStatus(`已导入 ${imported.length} 个 Skill，Skill 库已更新。当前对话仍使用 ${currentName}。`,'success');
                toast(`已导入 ${imported.length} 个 Skill，当前仍使用${currentName}`);
            }else if(skipped.length&&!errors.length){
                setSkillPackageStatus('这个 Skill 已经在列表中，没有重复导入。');
            }else{
                setSkillPackageStatus(errors.length?`导入失败：${errors.join('；')}`:'没有新增 Skill，请检查这个文件夹。','error');
            }
            resetSkillPackageInputState();
        }catch(error){setSkillPackageStatus(`导入失败：${error.message||error}`,'error');}
        finally{if(skillPackageScan)setSkillPackageImportButton(true);}
    }
    async function loadSkills(){
        const previousSkills=skills;
        try{
            const selected=rememberedSkill();
            const result=sharedSkillApi?.load?await sharedSkillApi.load(true):await fetch('/api/agent-skills',{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error(`Skill API ${response.status}`);return response.json();});
            skillCategories=Array.isArray(result?.categories)?result.categories:[];
            skills=Array.isArray(result)?result:(result?.skills||[]);
            if(skillEmpty){skillEmpty.dataset.loadMessage='';skillEmpty.textContent='暂无 Skill。点击右上角「添加」手动创建。';}
            skillEl.innerHTML='<option value="">通用助手</option>'+skills.map(skill=>`<option value="${esc(skill.id)}">${esc(skill.name)}</option>`).join('');
            if(skills.some(skill=>skill.id===selected&&skill.enabled!==false)){
                skillEl.value=selected;
                if(!hasSharedSkillPreference())savePreferences({skillChanged:true});
            }
            else if(selected){if(sharedSkillApi?.setSelected)sharedSkillApi.setSelected('');else{try{localStorage.setItem(skillSelectionKey,'');}catch(_){ }}}
            renderSkillList();
            renderQuickSkillList();
            return true;
        }catch(error){
            skills=previousSkills;
            if(skillEmpty&&skills.length===0){skillEmpty.dataset.loadMessage='Skill 列表暂时无法刷新，请稍后重试。';skillEmpty.textContent=skillEmpty.dataset.loadMessage;}
            renderSkillList();
            renderQuickSkillList();
            setSkillPackageStatus(`Skill 列表刷新失败，已保留原列表：${error.message||error}`,'error');
            console.warn('[Canvas Agent] Skill load failed:',error);
            return false;
        }
    }
    const PLAN_NODE_TYPES=new Set(['smart-upload','smart-prompt','smart-agent','smart-paint','smart-loop','smart-group','smart-image']);
    let agentTaskScopeIdentity='';
    const agentExcludedNodeIds=new Set();
    const agentExcludedReferenceKeys=new Set();
    let agentLockedTaskScopeSnapshot=null;
    function clearAgentTaskScopeFilters(resetIdentity=true){
        agentExcludedNodeIds.clear();
        agentExcludedReferenceKeys.clear();
        if(resetIdentity)agentTaskScopeIdentity='';
    }
    function agentTaskScopeIdentityFor(scope){
        return JSON.stringify([
            scope?.mode||'',scope?.targetNodeId||'',
            ...(Array.isArray(scope?.selectedNodeIds)?scope.selectedNodeIds:[]),
            '|',...(Array.isArray(scope?.sourceNodeIds)?scope.sourceNodeIds:[]),
            '|',...(Array.isArray(scope?.formalInputNodeIds)?scope.formalInputNodeIds:[]),
            '|selected-image',scope?.selectedImage?.nodeId||'',scope?.selectedImage?.imageIndex??''
        ]);
    }
    function syncAgentTaskScopeFilters(scope){
        if(!scope?.valid){clearAgentTaskScopeFilters();return;}
        const identity=agentTaskScopeIdentityFor(scope);
        if(agentTaskScopeIdentity&&agentTaskScopeIdentity!==identity)clearAgentTaskScopeFilters(false);
        agentTaskScopeIdentity=identity;
    }
    function agentReferenceKey(item){
        if(typeof inputRefKey==='function')return String(inputRefKey(item)||'');
        const url=String(item?.url||'').trim();
        if(!url)return '';
        const nodeId=String(item?.nodeId||'').trim();
        const imageIndex=Number.isFinite(Number(item?.imageIndex))?String(Number(item.imageIndex)):'';
        return nodeId&&imageIndex!==''?`${nodeId}|${imageIndex}`:`url|${url}`;
    }
    function agentScopeBranchNodeIds(nodeId){
        const ids=new Set([String(nodeId||'')].filter(Boolean));
        const node=nodes.find(item=>item.id===String(nodeId||''));
        if(node&&typeof canvasTaskScopeUpstreamIds==='function'){
            (canvasTaskScopeUpstreamIds([node])||[]).forEach(id=>ids.add(String(id||'')));
        }
        return ids;
    }
    function agentScopeBranchReferenceUrls(nodeIds){
        const urls=new Set();
        (nodeIds||[]).forEach(id=>{
            const node=nodes.find(item=>item.id===String(id||''));
            if(!node)return;
            const items=[];
            if(typeof outputImagesForNode==='function')items.push(...(outputImagesForNode(node)||[]));
            if(typeof manualReferenceImagesFor==='function')items.push(...(manualReferenceImagesFor(node)||[]));
            else if(Array.isArray(node.images))items.push(...node.images);
            items.forEach(item=>{if(item?.url)urls.add(String(item.url));});
        });
        return urls;
    }
    function agentReferenceBelongsToBranch(item,nodeIds,nodeUrls){
        const owners=[item?.nodeId,item?.groupNodeId].map(id=>String(id||'')).filter(Boolean);
        return owners.some(id=>nodeIds.has(id))||Boolean(item?.url&&nodeUrls.has(String(item.url)));
    }
    function cloneAgentTaskScope(value){
        try{return JSON.parse(JSON.stringify(value||{}));}
        catch(_){return {...(value||{})};}
    }
    function snapshotAgentTaskScope(scope){
        const snapshot=cloneAgentTaskScope(scope);
        snapshot.referenceImages=typeof snapshotReferenceImages==='function'
            ?snapshotReferenceImages(scope?.referenceImages||[])
            :(scope?.referenceImages||[]).filter(item=>item?.url).map(item=>({...item}));
        snapshot.excludedNodeIds=[...new Set((scope?.excludedNodeIds||[]).map(id=>String(id||'').trim()).filter(Boolean))];
        snapshot.excludedReferenceKeys=[...new Set((scope?.excludedReferenceKeys||[]).map(key=>String(key||'').trim()).filter(Boolean))];
        return snapshot;
    }
    function agentTaskScopeNodeIds(scope){
        const ids=[
            scope?.targetNodeId,
            ...(Array.isArray(scope?.selectedNodeIds)?scope.selectedNodeIds:[]),
            ...(Array.isArray(scope?.sourceNodeIds)?scope.sourceNodeIds:[]),
            ...(Array.isArray(scope?.formalInputNodeIds)?scope.formalInputNodeIds:[]),
            ...(Array.isArray(scope?.upstreamNodeIds)?scope.upstreamNodeIds:[])
        ];
        (scope?.referenceImages||[]).forEach(item=>ids.push(item?.nodeId,item?.groupNodeId));
        return [...new Set(ids.map(id=>String(id||'').trim()).filter(Boolean))];
    }
    function agentTaskScopeReferenceItems(nodeIds=[]){
        const items=[];
        (nodeIds||[]).forEach(id=>{
            const node=nodes.find(item=>item.id===String(id||''));
            if(!node)return;
            if(typeof outputImagesForNode==='function')items.push(...(outputImagesForNode(node)||[]));
            if(typeof manualReferenceImagesFor==='function')items.push(...(manualReferenceImagesFor(node)||[]));
            else if(Array.isArray(node.images))items.push(...node.images);
            if(typeof stableReferenceImagesFor==='function')items.push(...(stableReferenceImagesFor(node)||[]));
        });
        return items.filter(item=>item?.url);
    }
    function validateAgentLockedTaskScope(scope){
        if(!scope?.valid)return {valid:false,reason:'锁定的任务范围无效，已恢复当前画布选择。'};
        const nodeIds=agentTaskScopeNodeIds(scope);
        if(nodeIds.some(id=>!nodes.some(node=>node.id===id))){
            return {valid:false,reason:'锁定的任务节点已被删除，已恢复当前画布选择。'};
        }
        const currentItems=agentTaskScopeReferenceItems(nodeIds);
        const currentKeys=new Set(currentItems.map(item=>agentReferenceKey(item)).filter(Boolean));
        const currentUrls=new Set(currentItems.map(item=>String(item?.url||'')).filter(Boolean));
        const missingReference=(scope.referenceImages||[]).find(item=>{
            const url=String(item?.url||'').trim(),key=agentReferenceKey(item);
            return url&&!currentUrls.has(url)&&!(key&&currentKeys.has(key));
        });
        if(missingReference){
            return {valid:false,reason:'锁定的引用图片已被删除或清空，已恢复当前画布选择。'};
        }
        const selected=scope.selectedImage;
        if(selected?.nodeId){
            const selectedNodeId=String(selected.nodeId||'').trim();
            const selectedIndex=Number(selected.imageIndex);
            const selectedUrl=String(selected.url||'').trim();
            const selectedExists=currentItems.some(item=>{
                const itemNodeId=String(item?.nodeId||item?.groupNodeId||'').trim();
                const itemIndex=Number(item?.imageIndex);
                return (selectedUrl&&String(item?.url||'')===selectedUrl)
                    || (itemNodeId===selectedNodeId&&Number.isInteger(selectedIndex)&&itemIndex===selectedIndex);
            });
            if(!selectedExists)return {valid:false,reason:'锁定的单张引用图片已失效，已恢复当前画布选择。'};
        }
        return {valid:true};
    }
    function invalidateAgentTaskScopeLock(reason){
        if(!agentLockedTaskScopeSnapshot)return false;
        agentLockedTaskScopeSnapshot=null;
        clearAgentTaskScopeFilters();
        toast(reason||'锁定的任务范围已失效，已恢复当前画布选择。');
        return true;
    }
    function lockedAgentTaskScope(){
        if(!agentLockedTaskScopeSnapshot)return null;
        const validation=validateAgentLockedTaskScope(agentLockedTaskScopeSnapshot);
        if(!validation.valid){
            invalidateAgentTaskScopeLock(validation.reason);
            return null;
        }
        return cloneAgentTaskScope(agentLockedTaskScopeSnapshot);
    }
    function currentTaskScope(snapshot=null){
        let scope;
        try{
            if(snapshot&&typeof normalizeCanvasTaskScopeSnapshot==='function')scope=normalizeCanvasTaskScopeSnapshot(snapshot);
            else if(agentLockedTaskScopeSnapshot)scope=lockedAgentTaskScope()||((typeof resolveCanvasTaskScope==='function')?resolveCanvasTaskScope():null);
            else if(typeof resolveCanvasTaskScope==='function')scope=resolveCanvasTaskScope();
        }catch(error){console.warn('[Canvas Agent] Task scope unavailable:',error);}
        if(snapshot&&!scope?.valid&&typeof resolveCanvasTaskScope==='function'){
            // 旧计划消息可能只保存了空的 taskScope。此时面板显示的当前任务范围
            // 仍然是用户明确选中的来源，允许用它恢复计划；若快照带有已失效的
            // 节点 ID，则继续保留原错误，避免把历史计划静默指向另一批节点。
            const savedIds=[
                ...(Array.isArray(snapshot?.selectedNodeIds)?snapshot.selectedNodeIds:[]),
                ...(Array.isArray(snapshot?.selected_node_ids)?snapshot.selected_node_ids:[]),
                ...(Array.isArray(snapshot?.sourceNodeIds)?snapshot.sourceNodeIds:[]),
                ...(Array.isArray(snapshot?.source_node_ids)?snapshot.source_node_ids:[]),
                ...(Array.isArray(snapshot?.formalInputNodeIds)?snapshot.formalInputNodeIds:[]),
                ...(Array.isArray(snapshot?.formal_input_node_ids)?snapshot.formal_input_node_ids:[]),
                snapshot?.targetNodeId||snapshot?.target_node_id||''
            ].map(id=>String(id||'').trim()).filter(Boolean);
            if(!savedIds.length){
                try{
                    const liveScope=resolveCanvasTaskScope();
                    if(liveScope?.valid)scope=liveScope;
                }catch(error){console.warn('[Canvas Agent] Live task scope recovery failed:',error);}
            }
        }
        if(snapshot)return scope||{valid:false,reason:'原任务范围已不可用，请重新选择画布节点后再试。',selectedNodeIds:[],targetNodeId:'',sourceNodeIds:[],formalInputNodeIds:[],upstreamNodeIds:[],referenceImages:[],generationSettings:{}};
        if(!scope)return {valid:false,reason:'请先在画布上选择一个节点，再让 Agent 执行任务。',selectedNodeIds:[],targetNodeId:'',sourceNodeIds:[],formalInputNodeIds:[],upstreamNodeIds:[],referenceImages:[],generationSettings:{}};
        syncAgentTaskScopeFilters(scope);
        scope.excludedNodeIds=[...agentExcludedNodeIds];
        scope.excludedReferenceKeys=[...agentExcludedReferenceKeys];
        if(typeof canvasTaskScopeApplyExclusions==='function')return canvasTaskScopeApplyExclusions(scope,scope);
        scope.sourceNodeIds=(scope.sourceNodeIds||[]).filter(id=>!agentExcludedNodeIds.has(String(id||'')));
        scope.formalInputNodeIds=(scope.formalInputNodeIds||[]).filter(id=>!agentExcludedNodeIds.has(String(id||'')));
        scope.upstreamNodeIds=(scope.upstreamNodeIds||[]).filter(id=>!agentExcludedNodeIds.has(String(id||'')));
        scope.referenceImages=(scope.referenceImages||[]).filter(item=>{
            const key=agentReferenceKey(item),owners=[item?.nodeId,item?.groupNodeId].map(id=>String(id||''));
            return !agentExcludedReferenceKeys.has(key)&&!owners.some(id=>agentExcludedNodeIds.has(id));
        });
        return scope;
    }
    function serializedTaskScope(scope=currentTaskScope()){
        if(typeof canvasTaskScopeSnapshot==='function')return canvasTaskScopeSnapshot(scope);
        return {
            valid:Boolean(scope?.valid),mode:String(scope?.mode||''),selected_node_ids:(scope?.selectedNodeIds||[]).slice(),
            target_node_id:String(scope?.targetNodeId||''),source_node_ids:(scope?.sourceNodeIds||[]).slice(),
            formal_input_node_ids:(scope?.formalInputNodeIds||[]).slice(),upstream_node_ids:(scope?.upstreamNodeIds||[]).slice(),
            selected_image:scope?.selectedImage?.nodeId?{node_id:String(scope.selectedImage.nodeId),image_index:Number(scope.selectedImage.imageIndex)||0}:null,
            selected_reference_keys:(scope?.selectedReferenceKeys||[]).slice(),
            excluded_node_ids:(scope?.excludedNodeIds||[]).slice(),excluded_reference_keys:(scope?.excludedReferenceKeys||[]).slice()
        };
    }
    function updateAgentTaskScopeLockUi(scope){
        if(!scopeLockEl)return;
        const controls=[scopeLockEl];
        const locked=Boolean(agentLockedTaskScopeSnapshot),hasScope=Boolean(scope?.valid),state=locked?'locked':'unlocked';
        let iconChanged=false;
        controls.forEach(control=>{
            control.classList.toggle('is-locked',locked);
            control.disabled=!locked&&!hasScope;
            control.setAttribute('aria-pressed',locked?'true':'false');
            control.setAttribute('aria-label',locked?'已锁定当前任务，点击解锁':'锁定当前任务范围');
            control.title=locked?'解锁并跟随当前画布选择':(hasScope?'锁定当前任务范围':'请先选择画布节点');
            if(control.dataset.scopeLockState!==state){
                control.innerHTML=`<i data-lucide="${locked?'unlock':'lock'}"></i><span>${locked?'已锁定':'锁定任务'}</span>`;
                control.dataset.scopeLockState=state;
                iconChanged=true;
            }
        });
        if(iconChanged&&typeof refreshIcons==='function')refreshIcons();
    }
    function releaseAgentTaskScopeLock(){
        const wasLocked=Boolean(agentLockedTaskScopeSnapshot);
        agentLockedTaskScopeSnapshot=null;
        clearAgentTaskScopeFilters();
        return wasLocked;
    }
    function toggleAgentTaskScopeLock(){
        if(agentLockedTaskScopeSnapshot){
            releaseAgentTaskScopeLock();
            renderTaskScope();
            toast('已解锁当前任务，恢复跟随画布选择');
            return;
        }
        const scope=currentTaskScope();
        if(!scope?.valid){
            renderTaskScope();
            toast(scope?.reason||'请先选择画布节点');
            return;
        }
        agentLockedTaskScopeSnapshot=snapshotAgentTaskScope(scope);
        renderTaskScope();
        toast('已锁定当前任务范围，后续发送不会随画布选择变化');
    }
    function reconcileAgentTaskScopeLock(){
        if(!agentLockedTaskScopeSnapshot)return false;
        const validation=validateAgentLockedTaskScope(agentLockedTaskScopeSnapshot);
        if(!validation.valid){
            invalidateAgentTaskScopeLock(validation.reason);
            return false;
        }
        return true;
    }
    function scopeNodeLabel(id=''){
        const node=nodes.find(item=>item.id===id);
        return String(node?.title||node?.type||id||'未命名节点').slice(0,56);
    }
    function scopeNodeTypeLabel(node){
        const labels={
            'smart-upload':'素材',
            'smart-image':'图片',
            'smart-paint':'绘画',
            'smart-prompt':'提示词',
            'smart-agent':'Agent',
            'smart-loop':'循环',
            'smart-group':'分组'
        };
        return labels[String(node?.type||'')]||'节点';
    }
    function scopeNodeIcon(node){
        const icons={
            'smart-upload':'upload',
            'smart-image':'image',
            'smart-paint':'paintbrush',
            'smart-prompt':'file-text',
            'smart-agent':'bot',
            'smart-loop':'repeat',
            'smart-group':'layers-2'
        };
        return icons[String(node?.type||'')]||'box';
    }
    function scopeNodeImageCount(node){
        const items=[];
        if(typeof outputImagesForNode==='function')items.push(...(outputImagesForNode(node)||[]));
        else if(Array.isArray(node?.images))items.push(...node.images);
        if(typeof manualReferenceImagesFor==='function')items.push(...(manualReferenceImagesFor(node)||[]));
        else if(Array.isArray(node?.manualInputRefs))items.push(...node.manualInputRefs);
        return new Set(items.filter(item=>item?.url).map(item=>String(item.url))).size;
    }
    function removeAgentTaskScopeSource(nodeId){
        const id=String(nodeId||'').trim();
        if(!id)return;
        const scope=currentTaskScope();
        const sourceIds=scope?.targetNodeId?(scope.formalInputNodeIds||[]):(scope?.sourceNodeIds||[]);
        if(!sourceIds.includes(id))return;
        syncAgentTaskScopeFilters(scope);
        agentExcludedNodeIds.add(id);
        const branchIds=agentScopeBranchNodeIds(id),branchUrls=agentScopeBranchReferenceUrls(branchIds);
        (scope.referenceImages||[]).forEach(item=>{
            if(agentReferenceBelongsToBranch(item,branchIds,branchUrls)){
                const key=agentReferenceKey(item);
                if(key)agentExcludedReferenceKeys.add(key);
            }
        });
        renderTaskScope();
        toast('已从本次 Agent 任务移除该来源，画布节点和原图未删除');
    }
    function removeAgentTaskScopeReference(referenceKey){
        const key=String(referenceKey||'').trim();
        if(!key)return;
        const scope=currentTaskScope();
        if(!(scope.referenceImages||[]).some(item=>agentReferenceKey(item)===key))return;
        syncAgentTaskScopeFilters(scope);
        agentExcludedReferenceKeys.add(key);
        renderTaskScope();
        toast('已从本次 Agent 任务移除这张引用图，原图未删除');
    }
    function resetAgentTaskScopeFilters(){
        if(!agentExcludedNodeIds.size&&!agentExcludedReferenceKeys.size)return;
        clearAgentTaskScopeFilters(false);
        renderTaskScope();
        toast('已恢复本次 Agent 任务的全部来源和引用图');
    }
    function renderTaskScopeDetails(scope){
        const sourceIds=scope?.targetNodeId?(scope.formalInputNodeIds||[]):(scope?.sourceNodeIds||[]);
        const sourceNodes=sourceIds.map(id=>nodes.find(node=>node.id===id)).filter(Boolean);
        const references=typeof uniqueReferenceImages==='function'
            ?uniqueReferenceImages(scope?.referenceImages||[]).filter(item=>item?.url)
            :(scope?.referenceImages||[]).filter(item=>item?.url);
        const sourceHtml=sourceNodes.length
            ?sourceNodes.map((node,index)=>{
                const nodeTitle=scopeNodeLabel(node.id),title=`图${index+1}`,imageCount=scopeNodeImageCount(node);
                const hasText=['text','outputText','userPrompt','promptDraftText','runPrompt'].some(key=>String(node?.[key]||'').trim());
                const meta=[scopeNodeTypeLabel(node),imageCount?`${imageCount} 张图`:'',hasText?'含文字':''].filter(Boolean).join(' · ');
                return `<span class="canvas-agent-scope-source" title="${esc(`${title} · ${nodeTitle}`)}"><i data-lucide="${esc(scopeNodeIcon(node))}"></i><span><strong>${esc(title)}</strong><small>${esc(meta)}</small></span><button type="button" class="canvas-agent-scope-remove" data-agent-remove-source="${esc(node.id)}" title="仅移除本次 Agent 引用，不删除画布节点" aria-label="从本次任务移除来源 ${esc(title)}">×</button></span>`;
            }).join('')
            :'<span class="canvas-agent-scope-no-source">暂无明确来源节点</span>';
        const referenceHtml=references.length
            ?`<div class="canvas-agent-scope-reference-head"><span><i data-lucide="images"></i>已选素材图</span><b>${references.length} 张</b></div>`
            :'<div class="canvas-agent-scope-no-reference"><i data-lucide="file-text"></i><span>本次没有图片引用，Agent 只读取节点文字和参数。</span></div>';
        const canReset=Boolean((scope?.excludedNodeIds||[]).length||(scope?.excludedReferenceKeys||[]).length);
        return `<div class="canvas-agent-scope-details"><div class="canvas-agent-scope-detail-label"><span>引用来源 · ${sourceNodes.length} 个节点</span>${canReset?'<button type="button" data-agent-reset-scope title="恢复已移除的来源和引用图">恢复</button>':''}</div><div class="canvas-agent-scope-sources">${sourceHtml}</div><div class="canvas-agent-scope-references">${referenceHtml}</div></div>`;
    }
    function composerAttachmentReferences(scope){
        const seen=new Set();
        return [...(scope?.referenceImages||[]),...(Array.isArray(composerFileReferences)?composerFileReferences:[])]
            .filter(item=>{
                const url=String(item?.url||'').trim();
                if(!url||seen.has(url))return false;
                seen.add(url);
                return true;
            });
    }
    function renderComposerAttachments(scope){
        if(!composerAttachmentsEl)return;
        const references=composerAttachmentReferences(scope);
        if(!references.length){
            composerAttachmentsEl.hidden=true;
            composerAttachmentsEl.innerHTML='';
            resizeComposerInput();
            return;
        }
        composerAttachmentsEl.hidden=false;
        composerAttachmentsEl.innerHTML=references.map((item,index)=>{
            const label=item.name||`素材图 ${index+1}`;
            const owner=nodes.find(node=>node.id===String(item?.nodeId||item?.groupNodeId||''));
            const title=`${owner?scopeNodeLabel(owner.id):'已选素材图'} · ${label}`;
            return `<span class="canvas-agent-composer-attachment" role="option" aria-label="${esc(title)}" title="${esc(title)}">${agentPreviewImg(item,label,96)}<em>${index+1}</em><button type="button" class="canvas-agent-composer-attachment-remove" data-agent-composer-remove-reference="${index}" title="移除这张素材图" aria-label="移除${esc(label)}"><i data-lucide="x"></i></button></span>`;
        }).join('');
        composerAttachmentsEl.querySelectorAll('[data-agent-composer-remove-reference]').forEach(button=>button.addEventListener('click',event=>{
            event.preventDefault();
            event.stopPropagation();
            const item=references[Number(button.dataset.agentComposerRemoveReference)];
            if(!item)return;
            if(item.source==='composer-upload'){
                const key=agentReferenceKey(item),url=String(item.url||'');
                composerFileReferences=composerFileReferences.filter(reference=>agentReferenceKey(reference)!==key&&String(reference?.url||'')!==url);
                renderComposerAttachments(currentTaskScope());
                syncComposerFileUi();
                return;
            }
            removeAgentTaskScopeReference(agentReferenceKey(item));
        }));
        resizeComposerInput();
        if(typeof refreshIcons==='function')refreshIcons();
    }
    function syncComposerFileUi(){
        if(!composerMenuToggleEl)return;
        const uploading=Boolean(composerUploadBusy);
        const unavailable=uploading||busy;
        composerMenuToggleEl.disabled=unavailable;
        composerMenuToggleEl.classList.toggle('is-uploading',uploading);
        const label=uploading?'正在上传素材图':(busy?'任务处理中…':'添加素材或任务');
        composerMenuToggleEl.title=label;
        composerMenuToggleEl.setAttribute('aria-label',label);
        composerMenuEl?.querySelectorAll('button').forEach(button=>{button.disabled=unavailable;});
    }
    function closeComposerMenu(){
        if(!composerMenuEl)return;
        composerMenuEl.hidden=true;
        composerMenuToggleEl?.classList.remove('active');
        composerMenuToggleEl?.setAttribute('aria-expanded','false');
    }
    function toggleComposerMenu(){
        if(!composerMenuEl||composerMenuToggleEl?.disabled)return;
        const opening=composerMenuEl.hidden;
        closeAgentPopovers();
        composerMenuEl.hidden=!opening;
        composerMenuToggleEl?.classList.toggle('active',opening);
        composerMenuToggleEl?.setAttribute('aria-expanded',opening?'true':'false');
        if(opening)refreshIcons();
    }
    function isComposerImageFile(file){
        const type=String(file?.type||'').toLowerCase();
        return type.startsWith('image/')||/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(String(file?.name||''));
    }
    async function uploadComposerFiles(fileList){
        const files=Array.from(fileList||[]);
        if(!files.length||composerUploadBusy)return;
        const imageFiles=files.filter(isComposerImageFile);
        if(files.length!==imageFiles.length)toast('仅支持选择图片素材');
        const selected=imageFiles;
        if(!selected.length)return;
        composerUploadBusy=true;
        syncComposerFileUi();
        try{
            const formData=new FormData();
            selected.forEach(file=>formData.append('files',file,file.name));
            const response=await fetch('/api/ai/upload',{method:'POST',body:formData});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(String(data?.detail||data?.error||`HTTP ${response.status}`));
            const uploaded=(Array.isArray(data?.files)?data.files:[])
                .filter(item=>item?.url)
                .map(item=>({...item,source:'composer-upload',kind:'image'}));
            if(!uploaded.length)throw new Error('没有收到可用的图片地址');
            composerFileReferences=[...composerFileReferences,...uploaded];
            renderComposerAttachments(currentTaskScope());
            toast(`已添加 ${uploaded.length} 张素材图`);
        }catch(error){
            toast(`素材上传失败：${error.message||error}`);
        }finally{
            composerUploadBusy=false;
            if(composerFileInputEl)composerFileInputEl.value='';
            syncComposerFileUi();
        }
    }
    function clearComposerFileReferences(){
        if(!composerFileReferences.length)return;
        composerFileReferences=[];
        renderComposerAttachments(currentTaskScope());
        syncComposerFileUi();
    }
    function renderTaskScope(){
        const scope=currentTaskScope();
        updateAgentTaskScopeLockUi(scope);
        renderComposerAttachments(scope);
        if(!scopeEl)return;
        if(!scope.valid){
            scopeEl.innerHTML=`<div class="canvas-agent-scope-empty"><i data-lucide="mouse-pointer-2"></i><span>未选择画布节点。先选中素材、提示词或绘画节点，Agent 才会创建/修改正式任务。</span></div>`;
            if(typeof refreshIcons==='function')refreshIcons();
            return;
        }
        scopeEl.innerHTML=renderTaskScopeDetails(scope);
        scopeEl.querySelectorAll('[data-agent-remove-source]').forEach(button=>button.addEventListener('click',event=>{
            event.preventDefault();
            event.stopPropagation();
            removeAgentTaskScopeSource(button.dataset.agentRemoveSource||'');
        }));
        scopeEl.querySelectorAll('[data-agent-remove-reference]').forEach(button=>button.addEventListener('click',event=>{
            event.preventDefault();
            event.stopPropagation();
            removeAgentTaskScopeReference(button.dataset.agentRemoveReference||'');
        }));
        scopeEl.querySelector('[data-agent-reset-scope]')?.addEventListener('click',event=>{
            event.preventDefault();
            event.stopPropagation();
            resetAgentTaskScopeFilters();
        });
        if(typeof refreshIcons==='function')refreshIcons();
    }
    function planModeRequested(text){
        // 计划模式是显式高级开关：普通“分析一下”仍走当前节点的直接写入与运行，
        // 只有面板开关或明确说“开启/使用计划模式”才进入多节点编排。
        return generationPreferences().planMode||/(?:开启|使用|进入)\s*(?:计划|规划)\s*模式|\b(?:enable|use)\s+plan\s*mode\b/i.test(String(text||''));
    }
    function noGenerationRequested(text){
        return /(?:只|仅|单纯|单独)\s*(?:做|要)?\s*分析|(?:不要|别|不需要|无需|不用|不)\s*(?:生成|生图|出图|改图|修改|写入|运行|执行)|\bonly\s+analy[sz]e\b|\bdo\s+not\s+(?:generate|run|write)\b/i.test(String(text||''));
    }
    function clippedPlanText(value,max=260){
        const text=String(value||'').replace(/\s+/g,' ').trim();
        return text.length>max?`${text.slice(0,max)}…`:text;
    }
    function planSettingsSummary(node){
        const source=node?.runSettings||{};
        const keys=['engine','apiKind','provider_id','model','ratio','resolution','customRatio','count','videoProvider','videoModel','videoAspect'];
        return keys.reduce((out,key)=>{
            if(source[key]!==undefined&&source[key]!==null&&source[key]!=='')out[key]=source[key];
            return out;
        },{});
    }
    function applyRequestedGenerationToNode(node,generation={}){
        const requested=requestedPlanNodeSettings(generation);
        const type=String(node?.type||'');
        if(!node||!['smart-paint','smart-image'].includes(type)||node.isHistoryGroup||node.historyFor)return;
        const base=typeof smartSettingsForNode==='function'
            ?smartSettingsForNode(node)
            :{...(node.runSettings||settings||{})};
        const hasExplicitCount=Object.prototype.hasOwnProperty.call(generation||{},'count');
        const shouldDefaultImageCount=String(base.apiKind||'image').toLowerCase()!=='video'&&!hasExplicitCount;
        if(!requested&&!shouldDefaultImageCount)return;
        const next={...base,...(requested||{})};
        if(shouldDefaultImageCount)next.count=1;
        node.runSettings=typeof settingsForStorage==='function'?settingsForStorage(next):next;
    }
    function applyRequestedGenerationToSpec(spec,generation={}){
        const requested=requestedPlanNodeSettings(generation);
        if(!requested||!spec||normalizePlanNodeType(spec.type)!=='smart-paint')return spec;
        const incoming=spec.settings&&typeof spec.settings==='object'
            ?spec.settings
            :(spec.run_settings&&typeof spec.run_settings==='object'?spec.run_settings:{});
        return {...spec,settings:{...incoming,...requested}};
    }
    function planCanvasContext(scope=currentTaskScope()){
        const excluded=new Set((scope?.excludedNodeIds||[]).map(id=>String(id||'')));
        const selected=(Array.isArray(scope?.selectedNodeIds)?scope.selectedNodeIds:[]).filter(id=>!excluded.has(String(id||'')));
        const current=nodes.find(node=>node.id===(scope?.targetNodeId||''))||nodes.find(node=>node.id===selected[0])||null;
        const priority=[current?.id,...selected].filter(Boolean);
        const ordered=[...new Set([...priority,...nodes.map(node=>node.id)])].map(id=>nodes.find(node=>node.id===id)).filter(Boolean).slice(0,40);
        return {
            current_node_id:current?.id||'',
            selected_node_ids:selected,
            task_scope:serializedTaskScope(scope),
            nodes:ordered.map(node=>({
                id:String(node.id||''),type:String(node.type||'smart-image'),title:clippedPlanText(node.title||'',80),
                x:Number(node.x)||0,y:Number(node.y)||0,w:Number(node.w)||0,h:Number(node.h)||0,
                image_count:Array.isArray(node.images)?node.images.filter(item=>item?.url).length:0,
                input_node_ids:Array.isArray(node.inputNodeIds)?node.inputNodeIds.slice(0,20):[],
                prompt:clippedPlanText(node.promptDraftText||node.runPrompt||'',260),
                text:clippedPlanText(node.text||'',260),
                user_prompt:clippedPlanText(node.userPrompt||'',260),
                output_text:clippedPlanText(node.outputText||'',260),
                settings:planSettingsSummary(node)
            })),
            connections:(canvas?.connections||[]).filter(conn=>conn?.from&&conn?.to).slice(0,80).map(conn=>({from:String(conn.from),to:String(conn.to),kind:String(conn.kind||'flow')})),
            available_node_types:[...PLAN_NODE_TYPES]
        };
    }
    function planReferenceImages(scope=currentTaskScope()){
        return uniqueReferenceImages(scope?.referenceImages||[]).filter(item=>item?.url);
    }
    function scopeWithComposerReferences(scope,extraReferences=composerFileReferences){
        if(!scope)return scope;
        return {
            ...scope,
            referenceImages:snapshotReferenceImages([...(scope.referenceImages||[]),...(extraReferences||[])])
        };
    }
    function snapshotReferenceImages(items=[]){
        const seen=new Set();
        return (items||[]).map(item=>{
            const url=String(item?.url||'').trim();
            if(!url||seen.has(url))return null;
            seen.add(url);
            return {
                url,
                name:String(item?.name||item?.alias||'').slice(0,100),
                kind:String(item?.kind||'image'),
                nodeId:String(item?.nodeId||''),
                groupNodeId:String(item?.groupNodeId||''),
                imageIndex:Number.isFinite(Number(item?.imageIndex))?Number(item.imageIndex):0
            };
        }).filter(Boolean);
    }
    function messageReferenceImages(message){
        // 旧对话使用 refs 保存缩略图。它只用于回看，不会回流到当前任务范围或
        // 后续模型输入；新对话统一使用 referenceImages。
        const current=Array.isArray(message?.referenceImages)?message.referenceImages:[];
        const legacy=current.length?[]:(Array.isArray(message?.refs)?message.refs:[]);
        return snapshotReferenceImages(current.length?current:legacy);
    }
    function renderMessageReferences(message){
        if(message?.role!=='user')return '';
        const items=messageReferenceImages(message);
        if(!items.length)return '';
        return `<div class="agent-message-refs" aria-label="本次引用图片">${items.map((item,index)=>{
            const label=item.name||`引用图 ${index+1}`;
            return `<span>${agentPreviewImg(item,label,160)}<em>引用图${index+1}</em></span>`;
        }).join('')}</div>`;
    }
    function planTaskText(text){
        return String(text||'').replace(/^\s*(?:请|帮我)?\s*先\s*(?:规划|计划|分析)(?:一下)?[：:，,。\s]*/i,'').trim()||String(text||'').trim();
    }
    function planRequestText(message,index=-1){
        const direct=String(message?.requestText||'').trim();
        if(direct)return direct;
        if(Number.isInteger(index)&&index>=0){
            const previous=activeConversation().messages.slice(0,index).reverse().find(item=>item?.role==='user'&&String(item?.text||'').trim());
            if(previous)return String(previous.text).trim();
        }
        return String(message?.text||'').trim();
    }
    function planNeedsOutputRetry(message){
        return message?.planStatus==='done'&&/已创建\s*0\s*个节点/.test(String(message?.executionSummary||''));
    }
    function fallbackPlanForClient(text,requestedGeneration={}){
        const base=planTaskText(text)||'根据当前需求生成结果';
        const paint=(key,title,prompt)=>{
            const node={key,type:'smart-paint',title,prompt};
            const requested=requestedPlanNodeSettings(requestedGeneration);
            if(requested)node.settings=requested;
            return node;
        };
        return {
            analysis:'已读取当前任务，先把需求拆成可执行的画布流程。',
            approach:'提供快速落地、提示词增强和分阶段生成三种方向，选择后立即写入画布并运行。',
            options:[
                {id:'1',label:'快速落地',summary:'直接使用当前需求创建一个生成节点。',reason:'步骤最少，适合先验证方向。',steps:['整理当前需求','创建绘画节点','连接可用参考并运行'],workflow:{nodes:[paint('paint_1','快速生成',base)],connections:[{from:'current',to:'paint_1',kind:'input'}],run:['paint_1'],return_to:'current'}},
                {id:'2',label:'提示词增强',summary:'先建立提示词节点，再交给绘画节点执行。',reason:'便于后续复用、编辑和继续串联流程。',steps:['拆解视觉目标','生成提示词节点','连接绘画节点并运行'],workflow:{nodes:[{key:'prompt_1',type:'smart-prompt',title:'提示词策划',text:base},paint('paint_1','按策划生成','根据上游提示词执行生成')],connections:[{from:'current',to:'prompt_1',kind:'input'},{from:'prompt_1',to:'paint_1',kind:'input'}],run:['paint_1'],return_to:'current'}},
                {id:'3',label:'分阶段生成',summary:'先沉淀提示词，再经循环质检后输出最终绘画结果。',reason:'适合复杂任务，所有中间步骤都可继续编辑和复用。',steps:['沉淀可编辑提示词','循环检查输入','连接绘画节点并运行'],workflow:{nodes:[{key:'prompt_1',type:'smart-prompt',title:'需求拆解',text:base},{key:'loop_1',type:'smart-loop',title:'循环质检',count:2,mode:'serial',show_prompt:true,image_input:true},paint('paint_1','分阶段生成','根据上游提示词与参考图生成最终结果')],connections:[{from:'current',to:'prompt_1',kind:'input'},{from:'prompt_1',to:'loop_1',kind:'input'},{from:'loop_1',to:'paint_1',kind:'input'}],run:['paint_1'],return_to:'current'}}
            ]
        };
    }
    function normalizePlanNodeType(value){
        const raw=String(value||'').trim().toLowerCase();
        const aliases={upload:'smart-upload',image:'smart-paint',paint:'smart-paint',prompt:'smart-prompt',agent:'smart-agent',loop:'smart-loop',group:'smart-group',current:'current'};
        const type=aliases[raw]||raw;
        return PLAN_NODE_TYPES.has(type)||type==='current'?type:'smart-paint';
    }
    function planNeedsLoopNode(option){
        const text=[option?.label,option?.title,option?.summary,option?.description,option?.reason,...(Array.isArray(option?.steps)?option.steps:[])].filter(Boolean).join(' ');
        return /循环|迭代|质检|复检|多轮/.test(text);
    }
    function ensurePlanLoopNode(nodesSpec,connections,option){
        if(!planNeedsLoopNode(option)||nodesSpec.some(spec=>spec?.type==='smart-loop'))return connections;
        const outputIndex=[...nodesSpec.keys()].reverse().find(index=>nodesSpec[index]?.type==='smart-paint');
        // 没有绘画输出时由后续的兜底逻辑补输出节点，避免在这里制造悬空 Loop。
        if(outputIndex===undefined)return connections;
        const usedKeys=new Set(nodesSpec.map(spec=>String(spec?.key||'')));
        let suffix=1,loopKey='loop_1';
        while(usedKeys.has(loopKey)){suffix+=1;loopKey=`loop_${suffix}`;}
        nodesSpec.splice(outputIndex,0,{key:loopKey,type:'smart-loop',title:'循环质检',count:3,mode:'serial',show_prompt:false,image_input:true});
        const output=nodesSpec[outputIndex+1];
        const next=(connections||[]).map(item=>({...item}));
        const incomingIndex=next.findIndex(item=>String(item?.to||'')===String(output?.key||''));
        if(incomingIndex>=0)next[incomingIndex]={...next[incomingIndex],to:loopKey};
        else {
            const upstream=nodesSpec.slice(0,outputIndex).reverse().find(spec=>spec?.type!=='smart-loop')?.key||'current';
            next.push({from:upstream,to:loopKey,kind:'input'});
        }
        next.push({from:loopKey,to:output.key,kind:'input'});
        return next;
    }
    function ensurePlanAnalysisAgent(nodesSpec,connections,option,taskText=''){
        // 普通计划不再通过关键词偷偷补出 smart-agent。高级 Agent 节点需要用户
        // 从统一节点菜单显式创建；计划仍可用提示词、循环和分组表达多阶段过程。
        return (connections||[]).map(item=>({...item}));
    }
    function normalizePlanForClient(value,text,requestedGeneration={}){
        const fallback=fallbackPlanForClient(text,requestedGeneration);
        if(!value||typeof value!=='object')return fallback;
        const rawOptions=Array.isArray(value.options)?value.options:[];
        const options=rawOptions.slice(0,4).map((raw,index)=>{
            const option=raw&&typeof raw==='object'?raw:{};
            const optionMeta=Object.fromEntries(Object.entries(option).filter(([key])=>!['nodes','connections','run','return_to'].includes(key)));
            let workflow=option.workflow&&typeof option.workflow==='object'?option.workflow:{};
            if(!Array.isArray(workflow.nodes)&&Array.isArray(option.nodes))workflow={...workflow,nodes:option.nodes,connections:option.connections||[],run:option.run||[],return_to:option.return_to||'current'};
            const fallbackWorkflow=fallback.options[Math.min(index,fallback.options.length-1)].workflow;
            const rawNodes=Array.isArray(workflow.nodes)?workflow.nodes:[];
            const nodesSpec=rawNodes.slice(0,8).map((item,nodeIndex)=>{
                const spec=item&&typeof item==='object'?{...item}:{};
                spec.key=String(spec.key||spec.id||`node_${nodeIndex+1}`).slice(0,60);
                spec.type=normalizePlanNodeType(spec.type);
                if(spec.type==='smart-agent'){
                    // 兼容旧接口/旧计划返回，但普通计划不再落地持久 Agent 节点。
                    spec.type='smart-prompt';
                    spec.text=String(spec.text||spec.prompt||spec.user_prompt||'请根据上游输入整理可执行提示词。');
                    delete spec.user_prompt;delete spec.system_prompt;delete spec.auto_analysis;
                }
                return applyRequestedGenerationToSpec(spec,requestedGeneration);
            });
            if(!nodesSpec.length)nodesSpec.push(...fallbackWorkflow.nodes.map(item=>({...item})));
            let connections=ensurePlanAnalysisAgent(nodesSpec,Array.isArray(workflow.connections)?workflow.connections.slice(0,20):[],option,text);
            connections=ensurePlanLoopNode(nodesSpec,connections,option);
            return {
                ...optionMeta,
                id:String(option.id||String.fromCharCode(65+index)).slice(0,4),
                label:clippedPlanText(option.label||option.title||`方案 ${String.fromCharCode(65+index)}`,32),
                summary:clippedPlanText(option.summary||option.description||'按当前需求执行一条画布流程',180),
                reason:clippedPlanText(option.reason||'适合当前任务的执行方向',180),
                steps:(Array.isArray(option.steps)?option.steps:[]).map(item=>clippedPlanText(item,100)).filter(Boolean).slice(0,6),
                workflow:{...workflow,nodes:nodesSpec,connections,run:Array.isArray(workflow.run)?workflow.run.slice(0,8):[],return_to:workflow.return_to||'current'}
            };
        });
        for(const candidate of fallback.options){
            if(options.length>=3)break;
            if(!options.some(option=>option.id===candidate.id))options.push(candidate);
        }
        const normalizedOptions=(options.length?options:fallback.options).slice(0,4).map((option,index)=>({
            ...option,
            // 模型返回的 id 只用于内部匹配，不能直接暴露到 UI。某些模型会返回
            // direct/structure 之类的长字符串，旧版截断后就变成了 dire/stru。
            // 统一使用稳定的数字选项，用户点击后仍按当前数组位置执行。
            id:String(index+1)
        }));
        return {analysis:clippedPlanText(value.analysis||value.summary||fallback.analysis,1200),approach:clippedPlanText(value.approach||value.execution_plan||fallback.approach,1200),options:normalizedOptions};
    }
    function parsePlanJson(value){
        if(value&&typeof value==='object')return value;
        const raw=String(value||'').trim();
        if(!raw)return null;
        const blocks=[raw,...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1])];
        for(const block of blocks){
            const start=block.indexOf('{'),end=block.lastIndexOf('}');
            if(start<0||end<=start)continue;
            try{return JSON.parse(block.slice(start,end+1));}catch(_){ }
        }
        return null;
    }
    const ACTION_JSON_QUOTE_CHARS='"\'“”‘’';
    function actionJsonRegexEscape(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
    function actionJsonKeyPattern(key){
        const escaped=actionJsonRegexEscape(key);
        return `(?:[${ACTION_JSON_QUOTE_CHARS}]\\s*${escaped}\\s*[${ACTION_JSON_QUOTE_CHARS}]|\\b${escaped})\\s*:`;
    }
    function decodeLooseActionString(value){
        const mapped={'"':'"',"'":"'",'\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
        return String(value||'').replace(/\\(u[0-9a-fA-F]{4}|["'\\/bfnrt])/g,(_,token)=>{
            if(token[0]==='u')return String.fromCharCode(parseInt(token.slice(1),16));
            return mapped[token]??token;
        });
    }
    function looseActionStringField(value,key,followingKeys=[]){
        const source=String(value||''),match=new RegExp(actionJsonKeyPattern(key),'i').exec(source);
        if(!match)return '';
        let start=match.index+match[0].length;
        while(start<source.length&&/\s/.test(source[start]))start+=1;
        if(start>=source.length||!ACTION_JSON_QUOTE_CHARS.includes(source[start]))return '';
        const opening=source[start],closing=({"“":"”","‘":"’"})[opening]||opening,valueStart=start+1;
        let fallback='';
        for(let index=valueStart;index<source.length;index+=1){
            if(source[index]!==closing)continue;
            let backslashes=0,cursor=index-1;
            while(cursor>=valueStart&&source[cursor]==='\\'){backslashes+=1;cursor-=1;}
            if(backslashes%2)continue;
            const tail=source.slice(index+1);
            if(followingKeys.length&&followingKeys.some(next=>new RegExp(`^\\s*,\\s*${actionJsonKeyPattern(next)}`,'i').test(tail))){
                return decodeLooseActionString(source.slice(valueStart,index)).trim();
            }
            // 后续 settings 可能被模型省略；保留最后一个合法字段结尾，
            // 让 prompt 仍能触发画布节点创建。
            if(/^\s*(?:[,}]|$)/.test(tail))fallback=source.slice(valueStart,index);
        }
        return decodeLooseActionString(fallback).trim();
    }
    function looseActionObjectField(value,key){
        const source=String(value||''),match=new RegExp(actionJsonKeyPattern(key),'i').exec(source);
        if(!match)return {};
        const start=source.indexOf('{',match.index+match[0].length);
        if(start<0)return {};
        let depth=0,quote='',escaped=false,end=-1;
        for(let index=start;index<source.length;index+=1){
            const char=source[index];
            if(quote){
                if(escaped){escaped=false;continue;}
                if(char==='\\'){escaped=true;continue;}
                if(char===quote)quote='';
                continue;
            }
            if(char==='"'||char==="'"){quote=char;continue;}
            if(char==='{')depth+=1;
            else if(char==='}'&&--depth===0){end=index;break;}
        }
        if(end<0)return {};
        try{
            const parsed=JSON.parse(source.slice(start,end+1));
            return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
        }catch(_){return {};}
    }
    function parseCanvasAgentActionText(value){
        const raw=String(value||'').trim();
        if(!raw)return null;
        const blocks=[raw,...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match=>match[1])];
        for(const block of blocks){
            const parsed=parsePlanJson(block);
            if(parsed&&typeof parsed==='object'){
                const prompt=String(parsed.prompt||parsed.generation_prompt||parsed.final_prompt||'').trim();
                if(prompt)return {...parsed,prompt,can_apply:true};
            }
            const summary=looseActionStringField(block,'summary',['prompt','generation_prompt','final_prompt','settings','generation_settings'])
                ||looseActionStringField(block,'analysis',['approach','options','prompt','settings']);
            let prompt='';
            for(const key of ['prompt','generation_prompt','final_prompt']){
                prompt=looseActionStringField(block,key,['settings','generation_settings']);
                if(prompt)break;
            }
            if(!prompt)continue;
            let settings=looseActionObjectField(block,'settings');
            if(!Object.keys(settings).length)settings=looseActionObjectField(block,'generation_settings');
            return {summary:summary||'已整理可执行提示词。',prompt,settings,can_apply:true};
        }
        return null;
    }
    const CANVAS_AGENT_PLAIN_PROMPT_HINT_RE=/(?:参考图|图\s*[一二三四五六七八九十\d]|图片|图像|画面|场景|主体|构图|镜头|光线|色彩|背景|前景|材质|质感|细节|摄影|写实|渲染|风格|白底|透明底|相框|商品|产品|人像|海报|包装|字体|文字排版|生成|改图|编辑|重绘|添加|移除|替换|保持|还原|image|photo|render|background|foreground|composition|lighting|color|texture)/i;
    const CANVAS_AGENT_PLAIN_PROMPT_CONVERSATIONAL_RE=/^(?:好的|可以(?:的)?|当然(?:可以)?|没问题|收到|明白|了解|以下是|这里是|这是|我会|我将|我来|根据你的(?:要求|需求)|我已经|已为你|建议|分析如下|说明如下|抱歉|无法|不能|需要你|请先|请提供)/i;
    function plainCanvasAgentPromptCandidate(value){
        let text=String(value||'').trim();
        if(!text)return '';
        text=text.replace(/^```(?:text|markdown)?\s*/i,'').replace(/\s*```$/,'').trim();
        text=text.replace(/^(?:(?:以下是|这里是|这是)\s*)?(?:一份\s*)?(?:最终的?\s*)?(?:可直接(?:用于生图|执行)的?\s*)?(?:(?:生图|改图|生成)?提示词|image\s*prompt|prompt)\s*[:：]\s*/i,'').trim();
        if(text.length<12)return '';
        const firstLine=text.split(/\r?\n/).map(item=>item.trim()).find(Boolean)||'';
        if(CANVAS_AGENT_PLAIN_PROMPT_CONVERSATIONAL_RE.test(firstLine)||!CANVAS_AGENT_PLAIN_PROMPT_HINT_RE.test(text))return '';
        return text.slice(0,12000);
    }
    function normalizeCanvasAgentActionResponse(value){
        const data=value&&typeof value==='object'?value:{};
        if(data.no_generation)return data;
        if(String(data.prompt||'').trim())return {...data,can_apply:true};
        const parsed=parseCanvasAgentActionText(data.text||data.raw||'');
        if(parsed?.prompt)return {...data,...parsed,can_apply:true};
        const plainPrompt=plainCanvasAgentPromptCandidate(data.text||data.raw||data.summary||'')||plainCanvasAgentPromptCandidate(data.summary||'');
        return plainPrompt?{...data,prompt:plainPrompt,settings:data.settings||{},can_apply:true}:data;
    }
    function planSystemPrompt(requestedGeneration={}){
        const base='你是小美画布计划模式。只返回JSON对象，包含analysis、approach、options。options为2到4个不同方案，id按顺序使用1、2、3、4，每个包含label、summary、reason、steps和workflow；workflow包含nodes、connections、run、return_to。节点type默认只能是smart-upload、smart-prompt、smart-paint、smart-loop、smart-group，连接可引用current或临时key。节点最多8个，不删除现有节点。每个方案必须新建至少一个smart-paint作为最终输出，run必须指向该新节点；current仅用于输入引用，不能作为最终输出或运行目标。kind=input用于图片/素材输入，kind=flow用于提示词或分析结果；下游节点必须读取两类正式上游，不能只显示flow连线而丢掉其文字。绘画节点如需指定生成参数，可在settings中填写ratio、resolution、customRatio、quality、background等字段；count只有用户明确说生成几张时才填写，未说明时按1张处理。不要默认创建smart-agent持久节点。';
        const label=requestedGenerationLabel(requestedGeneration);
        return label?`${base}\n用户已明确指定${label}，所有最终smart-paint节点必须使用该比例，不得改成智能/适配输入；在workflow.nodes的绘画节点settings中写入对应ratio。`:base;
    }
    async function requestPlan(text,provider,model,history,skillId,scope=currentTaskScope(),requestedGeneration={},linkJobIds=[]){
        const context=planCanvasContext(scope),planRefs=snapshotReferenceImages(planReferenceImages(scope));
        const systemPrompt=planSystemPrompt(requestedGeneration);
        const body={message:text,messages:history,images:planRefs.map(item=>item.url),provider,model,skill_id:skillId||'',link_job_ids:linkJobIds||[],current_node_id:context.current_node_id,canvas_context:context,generation_preferences:requestedGeneration,allow_persistent_agent:false,system_prompt:systemPrompt};
        let response=await fetchWithTimeout('/api/canvas-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},CANVAS_AGENT_REQUEST_TIMEOUT_MS);
        let data=await response.json().catch(()=>({}));
        if(response.status===404){
            const fallbackMessage=`用户任务：${text}\n\n当前画布上下文：${JSON.stringify(context)}`;
            response=await fetchWithTimeout('/api/canvas-llm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:fallbackMessage,messages:history,images:planRefs.map(item=>item.url),provider,model,skill_id:skillId||'',link_job_ids:linkJobIds||[],generation_preferences:requestedGeneration,system_prompt:systemPrompt})},CANVAS_AGENT_REQUEST_TIMEOUT_MS);
            data=await response.json().catch(()=>({}));
        }
        if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
        return {plan:normalizePlanForClient(data.plan||parsePlanJson(data.text),text,requestedGeneration),linkContext:data.link_context||{},visionInput:data.vision_input||{},skill_id:data.skill_id||skillId||'',skill_name:data.skill_name||''};
    }

    function canvasReusableLinkInfo(conversation){
        const messages=conversation?.messages||[];
        for(let index=messages.length-1;index>=0;index--){
            const item=messages[index];
            const ids=Array.isArray(item?.linkJobIds)?item.linkJobIds:(Array.isArray(item?.link_job_ids)?item.link_job_ids:[]);
            if(item?.role!=='user'||!ids.length)continue;
            return {jobIds:ids.slice(0,3),urls:(Array.isArray(item.linkUrls)?item.linkUrls:(Array.isArray(item.link_urls)?item.link_urls:[])).slice(0,3)};
        }
        return {jobIds:[],urls:[]};
    }
    function sameCanvasLinkUrls(left,right){
        const a=(left||[]).map(item=>String(item||'').trim()).filter(Boolean),b=(right||[]).map(item=>String(item||'').trim()).filter(Boolean);
        return a.length===b.length&&a.every((item,index)=>item===b[index]);
    }
    async function prepareCanvasLinks(text,conversation,userMessage,options={}){
        const client=window.XiaomeiLinkAnalysis;
        if(!client?.prepare)return {jobIds:[],urls:[]};
        const urls=client.extractMarketplaceLinks(text),latest=canvasReusableLinkInfo(conversation);
        const currentIds=Array.isArray(userMessage?.linkJobIds)?userMessage.linkJobIds.slice(0,3):[];
        let existingIds=currentIds;
        if(!existingIds.length){
            if(!urls.length)existingIds=latest.jobIds;
            else if(sameCanvasLinkUrls(urls,latest.urls))existingIds=latest.jobIds;
        }
        if(!urls.length&&!existingIds.length)return {jobIds:[],urls:[]};
        let prepared;
        try{
            prepared=await client.prepare(text,{existingJobIds:existingIds,retryExisting:Boolean(options?.retryExisting),onProgress:event=>{
                const suffix=event?.total>1?`（${(event.index||0)+1}/${event.total}）`:'';
                setRunStatus('running',`正在读取链接${suffix}`,event?.label||'正在读取商品快照');
            }});
        }catch(error){
            const failedIds=error?.linkAnalysis?.jobIds||existingIds;
            if(userMessage){userMessage.linkJobIds=failedIds.slice(0,3);userMessage.linkUrls=(urls.length?urls:latest.urls).slice(0,3);}
            conversation.linkJobIds=failedIds.slice(0,3);
            conversation.linkUrls=(urls.length?urls:latest.urls).slice(0,3);
            throw error;
        }
        const jobIds=(prepared.jobIds||[]).slice(0,3),linkUrls=(prepared.urls?.length?prepared.urls:(urls.length?urls:latest.urls)).slice(0,3);
        if(userMessage){userMessage.linkJobIds=jobIds;userMessage.linkUrls=linkUrls;}
        conversation.linkJobIds=jobIds;
        conversation.linkUrls=linkUrls;
        return {jobIds,urls:linkUrls,partial:Boolean(prepared.partial)};
    }
    function visionInputDetail(info){
        const normalized=Math.max(0,Number(info?.normalized)||0),skipped=Math.max(0,Number(info?.skipped)||0),parts=[];
        if(normalized)parts.push(`已自动压缩 ${normalized} 张参考图`);
        if(skipped)parts.push(`跳过 ${skipped} 张无法读取的参考图`);
        return parts.join('；');
    }
    function renderPlanMessage(message,index){
        const requestedGeneration=message.requestedGeneration||requestedGenerationPreferences(planRequestText(message,index));
        const plan=normalizePlanForClient(message.plan||{},planRequestText(message,index),requestedGeneration);
        const status=message.planStatus||'pending';
        const retryableDone=planNeedsOutputRetry(message);
        const statusText=status==='executing'?'正在按所选方案编排并运行画布…':retryableDone?'上次没有创建可执行输出节点，请重新选择方案运行。':status==='done'?`已执行方案 ${message.selectedOptionId||''} · ${message.executionSummary||'结果已返回画布'}。可选择其他方案重新执行。`:status==='error'?`执行失败：${message.executionSummary||'请重新选择方案'}。可选择任意方案重试。`:'选择一个方案后将立即执行，不再额外确认。';
        const generationLabel=requestedGenerationLabel(requestedGeneration);
        const generationHint=generationLabel?`<div class="canvas-agent-plan-status">已识别并应用：${esc(generationLabel)}，点击任一方案后会锁定到最终绘画节点。</div>`:'';
        return `<section class="canvas-agent-plan-card">
            <div class="canvas-agent-plan-head"><strong>计划模式</strong><small>${retryableDone?'可重试':status==='done'?'已完成':status==='executing'?'执行中':'可直接执行'}</small></div>
            <div class="canvas-agent-plan-analysis">
                <p>${esc(plan.analysis)}</p>
                <p>${esc(plan.approach)}</p>
            </div>
            ${generationHint}
            <div class="canvas-agent-plan-options">
                ${plan.options.map(option=>{
                    const selected=message.selectedOptionId===option.id;
                    const disabled=status==='executing';
                    const steps=option.steps?.length?`<div class="canvas-agent-plan-option-steps">${option.steps.slice(0,3).map(step=>`<span>${esc(step)}</span>`).join('')}</div>`:'';
                    return `<button type="button" class="canvas-agent-plan-option ${selected?'selected':''}" data-plan-select="${index}" data-plan-option="${esc(option.id)}" ${disabled?'disabled':''}>
                        <span class="canvas-agent-plan-option-id">${esc(option.id)}</span>
                        <span class="canvas-agent-plan-option-body"><strong>${esc(option.label)}</strong><small>${esc(option.summary)}${option.reason?` · ${esc(option.reason)}`:''}</small>${steps}</span>
                        <span class="canvas-agent-plan-option-arrow">›</span>
                    </button>`;
                }).join('')}
            </div>
            <div class="canvas-agent-plan-status ${status==='done'?'done':status==='error'?'error':''}">${esc(statusText)}</div>
        </section>`;
    }
    function latestUserMessageIndex(messages=activeConversation().messages){
        for(let i=messages.length-1;i>=0;i--)if(messages[i]?.role==='user')return i;
        return -1;
    }
    function actionMessageForUser(userIndex){
        const messages=activeConversation().messages;
        if(!Number.isInteger(userIndex)||userIndex<0||messages[userIndex]?.role!=='user')return null;
        for(let i=userIndex+1;i<messages.length;i++){
            const item=messages[i];
            if(item?.role==='user')break;
            if(item?.role==='assistant'&&item?.kind==='action')return {message:item,index:i};
        }
        return null;
    }
    function userMessageIndexForAction(actionIndex){
        const messages=activeConversation().messages;
        for(let i=Number(actionIndex)-1;i>=0;i--)if(messages[i]?.role==='user')return i;
        return -1;
    }
    function canEditUserMessage(index){
        if(busy||index!==latestUserMessageIndex())return false;
        const related=actionMessageForUser(index),status=String(related?.message?.actionStatus||'history');
        return Boolean(related)&&['done','error','history','analysis-only','no-prompt','cancelled'].includes(status);
    }
    function syncMessageEditUi(){
        const editing=editingUserMessageIndex>=0;
        // 编辑历史提示词时切换到专注布局，让编辑器脱离窄消息气泡，
        // 同时隐藏底部重复的普通输入框，保留“发送修改”操作。
        panel?.classList.toggle('message-editing',editing);
        if(input){
            input.disabled=editing;
            input.placeholder=editing?'正在编辑上方提示词，完成后点击“发送修改”':agentInputPlaceholder;
        }
        if(sendLabelEl)sendLabelEl.textContent=editing?'发送修改':'发送';
    }
    function renderUserMessage(message,index){
        const editing=editingUserMessageIndex===index;
        const text=editing?editingUserMessageDraft:String(message?.text||'');
        const body=editing
            ?`<div class="agent-message-editing"><textarea data-agent-message-editor="${index}" rows="4" aria-label="编辑提示词">${esc(text)}</textarea><div class="agent-message-edit-footer"><span>修改后点击底部“发送修改”</span><button type="button" data-agent-cancel-message-edit="${index}">取消</button></div></div>`
            :`<div class="agent-message-text">${esc(text).replace(/\n/g,'<br>')}</div>`;
        const editButton=!editing&&canEditUserMessage(index)
            ?`<div class="agent-user-message-actions"><button type="button" data-agent-edit-message="${index}">编辑提示词</button></div>`:'';
        return `${body}${renderMessageReferences(message)}${editButton}`;
    }
    function beginUserMessageEdit(index){
        if(!canEditUserMessage(index)){toast('只能编辑当前任务最近一条已完成的提示词');return;}
        const message=activeConversation().messages[index];
        editingUserMessageIndex=index;
        editingUserMessageOriginal=String(message?.text||'');
        editingUserMessageDraft=editingUserMessageOriginal;
        editingInputDraft=String(input?.value||'');
        if(input){input.value='';resizeComposerInput();}
        syncMessageEditUi();
        renderMessages();
        const editor=messagesEl.querySelector(`[data-agent-message-editor="${index}"]`);
        editor?.focus();
        editor?.setSelectionRange(editor.value.length,editor.value.length);
    }
    function cancelUserMessageEdit(){
        if(editingUserMessageIndex<0)return;
        const index=editingUserMessageIndex;
        if(input){input.value=editingInputDraft;resizeComposerInput();}
        editingUserMessageIndex=-1;
        editingUserMessageDraft='';
        editingUserMessageOriginal='';
        editingInputDraft='';
        syncMessageEditUi();
        renderMessages();
        toast('已取消修改');
    }
    function formatComposerDuration(value){
        const total=Math.max(0,Math.floor(Number(value||0)/1000));
        const minutes=Math.floor(total/60),seconds=total%60;
        return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
    }
    function syncComposerRunUi(){
        const hasStatus=runState!=='idle';
        const elapsed=composerRunStartedAt?Math.max(0,Date.now()-composerRunStartedAt):0;
        panel?.classList.toggle('is-running',Boolean(busy));
        panel?.classList.toggle('has-run-status',hasStatus);
        panel?.setAttribute('aria-busy',busy?'true':'false');
        if(composerStatusEl){
            composerStatusEl.hidden=!hasStatus;
            composerStatusEl.className=`canvas-agent-composer-status ${runState||'idle'}${busy?' is-busy':''}`.trim();
            composerStatusEl.setAttribute('aria-busy',busy?'true':'false');
        }
        if(composerStatusTextEl)composerStatusTextEl.textContent=runStateText||'Agent 已就绪';
        if(composerStatusDetailEl){
            composerStatusDetailEl.textContent=runStateDetail||'';
            composerStatusDetailEl.hidden=!runStateDetail;
        }
        if(composerStatusTimeEl){
            composerStatusTimeEl.textContent=formatComposerDuration(elapsed);
            composerStatusTimeEl.setAttribute('datetime',`PT${Math.floor(elapsed/1000)}S`);
        }
        if(composerStopEl){
            composerStopEl.hidden=!busy;
            composerStopEl.disabled=Boolean(activeAgentStopRequested);
            composerStopEl.title=activeAgentStopRequested?'正在停止当前任务':'停止当前任务';
            composerStopEl.setAttribute('aria-label',activeAgentStopRequested?'正在停止当前任务':'停止当前任务');
        }
        const sendButton=$('canvasAgentSend');
        if(sendButton){
            sendButton.hidden=busy;
            sendButton.disabled=Boolean(busy);
        }
        if(sendLabelEl)sendLabelEl.textContent=editingUserMessageIndex>=0?'发送修改':'发送';
        if(composerHintEl)composerHintEl.textContent=busy
            ?(activeAgentStopRequested?'正在停止当前任务…':'Agent 正在处理，可点击右侧方块停止')
            :'命令支持 Ctrl + Enter 发送 · Enter 换行';
        if(busy&&!composerRunTimer){
            composerRunTimer=setInterval(()=>syncComposerRunUi(),1000);
        }else if(!busy&&composerRunTimer){
            clearInterval(composerRunTimer);
            composerRunTimer=0;
        }
        syncComposerFileUi();
        const folderActive=Boolean(folderBatch?.hasActive());
        panel?.classList.toggle('has-folder-task',folderActive);
        if(folderActive&&!busy){
            if(sendLabelEl)sendLabelEl.textContent='发送要求';
            if(composerHintEl)composerHintEl.textContent=folderBatch.composerHint();
        }
    }
    function stopAgentRun(){
        if(!busy||activeAgentStopRequested)return;
        activeAgentStopRequested=true;
        const runId=activeHarnessRunId;
        activeAgentAbortController?.abort();
        if(runId){
            fetch(`/api/canvas-agent/runs/${encodeURIComponent(runId)}/interrupt`,{method:'POST',headers:{'Content-Type':'application/json'}}).catch(()=>{});
        }
        setRunStatus('done','已停止','正在结束当前 Agent 请求；已经提交的画布任务会继续执行');
        syncComposerRunUi();
    }
    function renderMessages(){
        const messages=activeConversation().messages;
        refreshFolderBatch();
        const messageHtml=messages.length?messages.map((message,index)=>`
            <article class="${message.role}${message.role==='user'&&editingUserMessageIndex===index?' is-editing':''}"${message.role==='user'&&editingUserMessageIndex===index?' style="align-self:flex-end;width:100%;max-width:100%;box-sizing:border-box;"':''}>
                <small>${message.role==='user'?'你':'Agent'}</small>
                ${message.role==='user'?renderUserMessage(message,index):`<div class="agent-message-text">${esc(message.text).replace(/\n/g,'<br>')}</div>`}
                ${message.role==='assistant'&&message.kind==='plan'?renderPlanMessage(message,index):message.role==='assistant'&&message.kind==='orchestration'?renderHarnessStatus(message,index):message.role==='assistant'&&message.kind==='browser'?renderBrowserStatus(message,index):message.role==='assistant'?renderActionStatus(message,index):''}
            </article>`).join(''):'<div class="canvas-agent-empty">描述创意或需求，使用技能，@引用参考图。<br>Agent会分析画布并把结果返回节点。</div>';
        messagesEl.innerHTML=messageHtml;
        messagesEl.scrollTop=messagesEl.scrollHeight;
        syncMessageEditUi();
        syncComposerRunUi();
        messagesEl.querySelectorAll('[data-plan-select]').forEach(button=>button.onclick=()=>selectPlanOption(Number(button.dataset.planSelect),button.dataset.planOption));
        messagesEl.querySelectorAll('[data-agent-return]').forEach(btn=>btn.onclick=()=>returnToNode(Number(btn.dataset.agentReturn)));
        messagesEl.querySelectorAll('[data-agent-edit-message]').forEach(btn=>btn.onclick=()=>beginUserMessageEdit(Number(btn.dataset.agentEditMessage)));
        messagesEl.querySelectorAll('[data-agent-cancel-message-edit]').forEach(btn=>btn.onclick=cancelUserMessageEdit);
        messagesEl.querySelectorAll('[data-agent-message-editor]').forEach(editor=>{
            editor.oninput=()=>{if(Number(editor.dataset.agentMessageEditor)===editingUserMessageIndex)editingUserMessageDraft=editor.value;};
            editor.onkeydown=event=>{
                if(event.key==='Escape'){event.preventDefault();cancelUserMessageEdit();}
                else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();send();}
            };
        });
        messagesEl.querySelectorAll('[data-agent-rerun]').forEach(btn=>btn.onclick=()=>rerunAction(Number(btn.dataset.agentRerun)));
        messagesEl.querySelectorAll('[data-agent-retry]').forEach(btn=>btn.onclick=()=>retryAgentRequest(Number(btn.dataset.agentRetry)));
    }
    function actionRequestForMessage(message,index){
        const previousUser=activeConversation().messages.slice(0,index).reverse().find(item=>item?.role==='user'&&String(item?.text||'').trim());
        return [message?.requestText,previousUser?.text]
            .map(value=>String(value||'').trim()).find(Boolean)||'';
    }
    function actionPromptForMessage(message,index){
        const targetId=String(message?.targetNodeId||'');
        const target=targetId?nodes.find(node=>node.id===targetId):null;
        return [message?.actionPrompt,target?.promptDraftText,target?.runPrompt,actionRequestForMessage(message,index)]
            .map(value=>String(value||'').trim()).find(Boolean)||'';
    }
    function renderActionStatus(message,index){
        const status=String(message?.actionStatus||'history');
        const target=String(message?.targetNodeId||'');
        const created=message?.actionCreated?`新建目标，正式连接 ${Number(message?.actionConnected||0)} 条`:'已更新当前绘画节点';
        const label=status==='running'?'已写入，正在运行':status==='queued'?'已提交，画布正在生成':status==='done'?'已写入并运行':status==='analysis-only'?'仅完成分析，未改动画布':status==='no-prompt'?'未写入：没有有效生成提示词':status==='cancelled'?'已停止，未继续写入画布':status==='error'?'执行失败，已保留当前节点和连线':'历史对话记录';
        const detail=status==='analysis-only'||status==='no-prompt'||status==='cancelled'||status==='error'
            ?String(message?.actionDetail||'')
            :status==='queued'
                ?String(message?.actionDetail||'已提交到画布，图片完成后会自动更新状态')
            :(target?`${message?.rerunAt?'已使用当前提示词重新生成 · ':''}${created} · ${scopeNodeLabel(target)}`:'');
        const skillLabel=String(message?.skillName||message?.skill_name||'').trim();
        const detailText=[detail||'可在画布中查看任务关系',skillLabel?`Skill：${skillLabel}`:''].filter(Boolean).join(' · ');
        const prompt=actionPromptForMessage(message,index);
        const requestText=actionRequestForMessage(message,index);
        const retryButton=status==='error'&&requestText?`<button type="button" data-agent-retry="${index}">重试请求</button>`:'';
        const rerunButton=Boolean(prompt)&&target&&(status==='done'||status==='error'||status==='history'||status==='cancelled')?`<button type="button" data-agent-rerun="${index}">重新生成</button>`:'';
        return `<section class="agent-stage-card ${status==='error'?'error':''}"><b>${esc(label)}</b><div><span>${esc(detailText)}</span>${retryButton}${rerunButton}${target?`<button type="button" data-agent-return="${index}">查看节点</button>`:''}</div></section>`;
    }
    function renderBrowserStatus(message){
        const result=message?.browserResult||{};
        const status=String(result.status||'').trim();
        const failed=result.ok===false||status==='error';
        const labels={opened:'已打开网页',snapshot:'已读取页面',extracted:'已提取内容',screenshot:'已截图',clicked:'已点击目标',media_list:'已列出媒体',downloaded:'已下载媒体',confirmation_required:'等待确认',closed:'已关闭浏览器',ready:'浏览器已就绪'};
        const label=failed?'浏览器动作失败':(labels[status]||'浏览器 Skill');
        const detail=[result.title||'',result.url||'',result.message||result.error||''].filter(Boolean).join(' · ');
        const body=String(result.body||result.text||'').trim();
        const imageUrl=String(result.screenshot_url||result.file_url||'').trim();
        const media=Array.isArray(result.items)?result.items:[];
        return `<section class="agent-stage-card agent-browser-card ${failed?'error':''}">
            <b>${esc(label)}</b>
            <div class="agent-browser-meta"><span>${esc(detail||'已通过可见浏览器完成本次动作')}</span></div>
            ${body?`<pre class="agent-browser-preview">${esc(body.slice(0,6000))}</pre>`:''}
            ${imageUrl&&status==='screenshot'?`<img class="agent-browser-screenshot" src="${esc(imageUrl)}" alt="网页截图" loading="lazy">`:''}
            ${media.length?`<div class="agent-browser-media-list">${media.slice(0,20).map(item=>`<span><b>${esc(item.id||'')}</b>${esc(item.type||'媒体')} · ${esc(item.label||item.url||'')}</span>`).join('')}</div>`:''}
            ${result.file_url&&status==='downloaded'?`<a class="agent-browser-download" href="${esc(result.file_url)}" download>下载 ${esc(result.filename||'文件')}</a>`:''}
        </section>`;
    }
    function harnessComplexTaskRequested(text){
        const source=String(text||'').trim();
        if(!source||generationPreferences().harnessMode===false||noGenerationRequested(source))return false;
        return /codex\s*harness|全流程|一键|自动完成|批量|多个(?:节点|方案|商品|结果)|工作流|节点|连线|素材库|先[\s\S]{0,60}再|然后|接着|分析[\s\S]{0,60}(?:创建|生成|运行)|创建[\s\S]{0,60}(?:节点|画布)|检查[\s\S]{0,60}(?:重试|生成)/i.test(source);
    }
    function harnessPlanRisk(plan,text,requestedGeneration={}){
        const source=`${String(text||'')} ${JSON.stringify(plan||{})}`;
        const count=Math.max(Number(requestedGeneration?.count||1),...[...(plan?.options||[])].flatMap(option=>[...(option?.workflow?.nodes||[])].map(node=>Number(node?.settings?.count||1))));
        if(count>1||/批量|多张|几张|一组|一套/i.test(source))return `批量生图（${Math.max(2,count)} 张或多结果）`;
        if(/删除|移除节点|清空节点/i.test(source))return '删除画布节点';
        if(/提交|发布|下单|购买|支付|确认保存/i.test(source))return '网页提交/发布动作';
        return '';
    }
    function harnessStageLabel(stage){
        return ({queued:'排队中',analyzing:'canvas-llm 分析图片与商品',planned:'结构化计划已生成',harness:'Codex Harness 接管',executing:'Harness 正在调用工具',tool:'工具执行中',approval:'等待高风险确认',ready_to_apply:'等待画布执行器应用',applying:'正在写入并运行画布',completed:'已完成',error:'执行失败',cancelled:'已停止'}[String(stage||'')]||'处理中');
    }
    function renderHarnessStatus(message){
        const status=String(message?.harnessStatus||message?.status||'running');
        const failed=['error','cancelled'].includes(status)||status==='failed';
        const events=Array.isArray(message?.harnessEvents)?message.harnessEvents.slice(-6):[];
        const pending=message?.harnessApproval;
        const eventHtml=events.map(item=>`<span class="canvas-agent-harness-event"><i></i>${esc(item?.message||'步骤已更新')}</span>`).join('');
        const approvalHtml=pending?`<div class="canvas-agent-harness-approval"><strong>需要确认：${esc(pending.reason||'高风险动作')}</strong><small>确认窗口会在此步骤暂停，拒绝后不会执行该动作。</small></div>`:'';
        const plan=message?.plan;
        const planHtml=plan?.options?.length?`<div class="canvas-agent-harness-plan"><b>结构化计划</b><span>${esc(plan.analysis||'已完成任务拆解')}</span><small>${plan.options.slice(0,3).map(option=>`${esc(option.id||'')} · ${esc(option.label||'方案')}`).join('　')}</small></div>`:'';
        const detail=message?.harnessError||message?.harnessSummary||harnessStageLabel(message?.harnessStage||status);
        return `<section class="agent-stage-card canvas-agent-harness-card ${failed?'error':''}">
            <div class="canvas-agent-harness-head"><b>Codex Harness</b><small>${esc(harnessStageLabel(message?.harnessStage||status))}</small></div>
            <div class="canvas-agent-harness-detail">${esc(detail)}</div>
            ${planHtml}${approvalHtml}${eventHtml?`<div class="canvas-agent-harness-events">${eventHtml}</div>`:''}
            ${message?.harnessOperations?.length?`<div class="canvas-agent-harness-ops">已登记 ${message.harnessOperations.length} 个工具操作</div>`:''}
        </section>`;
    }
    async function fetchHarnessRun(runId){
        const response=await fetchWithTimeout(`/api/canvas-agent/runs/${encodeURIComponent(runId)}`,{cache:'no-store'},45000);
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
        return data.run||{};
    }
    async function approveHarnessRun(runId,approved){
        const response=await fetch(`/api/canvas-agent/runs/${encodeURIComponent(runId)}/approve`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved:Boolean(approved)})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
        return data;
    }
    async function applyHarnessRun(message,record,provider,model,scopeSnapshot,text,requestedGeneration,skillId,skillName){
        const plan=normalizePlanForClient(record?.plan||{},text,requestedGeneration);
        const operation=(record?.operations||[]).find(item=>item?.kind==='apply_workflow'&&item.workflow);
        const deleteOperations=(record?.operations||[]).filter(item=>item?.kind==='delete_nodes');
        const toolRiskApproved=Array.isArray(record?.events)&&record.events.some(item=>item?.type==='approval_resolved'&&item?.approved===true);
        if(!operation&&deleteOperations.length&&typeof deleteNode==='function'){
            const risk='删除画布节点';
            if(!message.harnessRiskApproved&&!toolRiskApproved){
                const approved=window.confirm(`Codex Harness 即将执行：${risk}\n\n是否继续？`);
                if(!approved){message.harnessStatus='error';message.harnessStage='error';message.harnessError=`已拒绝：${risk}，画布未改动`;return false;}
                message.harnessRiskApproved=true;
            }
            const ids=[...new Set(deleteOperations.flatMap(item=>Array.isArray(item.node_ids)?item.node_ids:[]).map(id=>String(id||'').trim()).filter(Boolean))];
            let deletedCount=0;
            ids.forEach(id=>{if(nodes.some(node=>node.id===id)){deleteNode(id);deletedCount+=1;}});
            message.harnessStatus='completed';message.harnessStage='completed';message.harnessSummary=`已按确认删除 ${deletedCount} 个节点。`;
            return true;
        }
        const optionBase=plan.options.find(option=>option.id===String(record?.selected_option_id||operation?.option_id||'1'))||plan.options[0];
        if(!optionBase)throw new Error('Harness 没有返回可执行的结构化方案');
        const option=operation?.workflow?{...optionBase,workflow:operation.workflow}:optionBase;
        const risk=harnessPlanRisk(plan,text,requestedGeneration);
        if(risk&&!message.harnessRiskApproved&&!toolRiskApproved){
            const approved=window.confirm(`Codex Harness 即将执行：${risk}\n\n是否继续？`);
            if(!approved){
                message.harnessStatus='error';
                message.harnessStage='error';
                message.harnessError=`已拒绝：${risk}，画布未改动`;
                return false;
            }
            message.harnessRiskApproved=true;
        }
        message.harnessStatus='applying';message.harnessStage='applying';message.plan=plan;renderMessages();
        const result=await executePlanOption(option,provider,model,scopeSnapshot,text,requestedGeneration,skillId,skillName);
        let deletedCount=0;
        if(deleteOperations.length&&typeof deleteNode==='function'){
            const ids=[...new Set(deleteOperations.flatMap(item=>Array.isArray(item.node_ids)?item.node_ids:[]).map(id=>String(id||'').trim()).filter(Boolean))];
            ids.forEach(id=>{if(nodes.some(node=>node.id===id)){deleteNode(id);deletedCount+=1;}});
        }
        message.harnessStatus='completed';message.harnessStage='completed';message.harnessSummary=`已创建 ${result.createdCount} 个节点，连接 ${result.connectedCount} 条，按 ${result.executedCount||1} 个阶段提交生成${deletedCount?`，并按确认删除 ${deletedCount} 个节点`:''}；结果已返回画布。`;
        message.targetNodeId=result.finalNode?.id||'';
        return true;
    }
    async function runCanvasHarness(message,{text,provider,model,history,selectedSkill,scope,scopeSnapshot,requestedGeneration,linkJobIds,messageRefs}){
        setRunStatus('running','正在启动 Codex Harness','先由 canvas-llm 分析图片和商品信息，再交给 Harness 调用画布工具');
        const response=await fetchWithTimeout('/api/canvas-agent/orchestrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            message:text,system_prompt:'',messages:history,images:messageRefs.map(item=>item.url),provider,model,
            skill_id:selectedSkill?.id||'',current_node_id:scope.targetNodeId||'',task_scope:scopeSnapshot,canvas_context:planCanvasContext(scope),
            generation_preferences:{...effectiveGenerationPreferences(),...requestedGeneration},link_job_ids:linkJobIds||[],harness_mode:'auto',approval_mode:'confirm'
        })},45000);
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
        if(data.status==='fallback')return {fallback:true,reason:data.reason||'Harness 当前不可用'};
        const runId=String(data.run_id||'').trim();
        if(!runId)throw new Error('Harness 没有返回任务 ID');
        activeHarnessRunId=runId;
        message.kind='orchestration';message.runId=runId;message.harnessStatus='queued';message.harnessStage='queued';message.harnessEvents=[];message.harnessOperations=[];message.plan=null;
        renderMessages();saveStore();
        const approvalPrompted=new Set();let deniedRisk=false;const deadline=Date.now()+Math.max(CANVAS_AGENT_REQUEST_TIMEOUT_MS,600000);
        while(Date.now()<deadline){
            const record=await fetchHarnessRun(runId);
            message.harnessStatus=record.status||'running';message.harnessStage=record.stage||record.status||'running';message.harnessEvents=record.events||[];message.harnessApproval=record.pending_approval||null;message.harnessOperations=record.operations||[];message.plan=record.plan||message.plan;message.harnessSummary=record.final_text||'';message.harnessError=record.error||'';
            renderMessages();saveStore();
            setRunStatus(record.status==='error'?'error':record.status==='completed'?'running':'running',harnessStageLabel(record.stage||record.status),record.pending_approval?.reason||record.final_text||'Harness 正在执行工具链');
            if(record.status==='awaiting_approval'&&record.pending_approval&&!approvalPrompted.has(record.pending_approval.id)){
                approvalPrompted.add(record.pending_approval.id);
                const approved=window.confirm(`Codex Harness 请求确认：${record.pending_approval.reason||'高风险动作'}\n\n确认后才会继续，取消则拒绝该动作。`);
                if(!approved)deniedRisk=true;
                await approveHarnessRun(runId,approved);
            }
            if(['completed','error','cancelled'].includes(String(record.status||''))){
                if(record.status==='completed'&&!deniedRisk){
                    const applied=await applyHarnessRun(message,record,provider,model,scopeSnapshot,text,requestedGeneration,selectedSkill?.id||'',selectedSkill?.name||'');
                    if(!applied)deniedRisk=true;
                }else if(record.status!=='completed'){
                    throw new Error(record.error||'Harness 执行未完成');
                }
                if(deniedRisk&&!message.harnessError){
                    message.harnessStatus='error';message.harnessStage='error';message.harnessError='高风险动作未获确认，画布未自动改动';
                }
                setRunStatus(message.harnessStatus==='error'?'error':'done',message.harnessStatus==='error'?'Harness 已停止':'Harness 已完成',message.harnessError||message.harnessSummary||'结果已返回画布');
                renderMessages();saveStore();
                return {fallback:false,record};
            }
            await new Promise(resolve=>setTimeout(resolve,700));
        }
        throw new Error('Harness 任务轮询超过时间上限');
    }
    function browserSearchTarget(text){
        const raw=String(text||'').trim();
        const platforms=[
            {pattern:/淘宝|taobao/i,url:'https://www.taobao.com'},
            {pattern:/天猫|tmall/i,url:'https://www.tmall.com'},
            {pattern:/京东|jd\.com/i,url:'https://www.jd.com'},
            {pattern:/1688/i,url:'https://s.1688.com'},
            {pattern:/亚马逊|amazon/i,url:'https://www.amazon.cn'},
            {pattern:/小红书|xiaohongshu/i,url:'https://www.xiaohongshu.com'},
            {pattern:/抖音|douyin/i,url:'https://www.douyin.com'},
            {pattern:/快手|kuaishou/i,url:'https://www.kuaishou.com'}
        ];
        const platform=platforms.find(item=>item.pattern.test(raw));
        if(!platform)return null;
        const query=raw
            .replace(/https?:\/\/[^\s<>'"）】]+/ig,' ')
            .replace(/(?:请)?(?:打开|访问|进入|搜索|搜一下|查找|浏览|看看|查询)/ig,' ')
            .replace(/淘宝|taobao|天猫|tmall|京东|jd\.com|1688|亚马逊|amazon|小红书|xiaohongshu|抖音|douyin|快手|kuaishou/ig,' ')
            .replace(/[：:，,。！？!?、]/g,' ')
            .replace(/\s+/g,' ').trim();
        if(!query)return {url:platform.url};
        const encoded=encodeURIComponent(query);
        if(/淘宝|taobao/i.test(raw))return {url:`https://s.taobao.com/search?q=${encoded}`};
        if(/天猫|tmall/i.test(raw))return {url:`https://list.tmall.com/search_product.htm?q=${encoded}`};
        if(/京东|jd\.com/i.test(raw))return {url:`https://search.jd.com/Search?keyword=${encoded}`};
        if(/1688/i.test(raw))return {url:`https://s.1688.com/selloffer/offer_search.htm?keywords=${encoded}`};
        if(/小红书|xiaohongshu/i.test(raw))return {url:`https://www.xiaohongshu.com/search_result?keyword=${encoded}`};
        return {url:platform.url};
    }
    function browserActionFromText(text){
        const raw=String(text||'').trim();
        const url=raw.match(/https?:\/\/[^\s<>'"）】]+/i)?.[0]?.replace(/[，。！？!?、）】]+$/g,'')||'';
        if(/关闭|关掉|退出浏览器|关闭网页/i.test(raw))return {action:'close'};
        const quoted=raw.match(/[“「【"]([^”」】"]+)[”」】"]/);
        if(/点击|点一下|按下|选择按钮|点击按钮|点击链接/i.test(raw)){
            let target=quoted?.[1]||raw.replace(/^(?:请)?(?:帮我)?(?:确认|确定)?\s*(?:点击|点一下|按下|选择按钮|点击按钮|点击链接)\s*/i,'').replace(/(?:按钮|链接)\s*$/i,'').trim();
            return target?{action:'click',text:target,confirm:/确认|确定|允许|同意/i.test(raw)}:null;
        }
        const mediaList=/列出|查看|读取|获取|采集|抓取/i.test(raw)&&/媒体|视频|音频|下载链接/i.test(raw);
        const download=raw.match(/下载(?:媒体|视频|音频|文件)?\s*(?:编号|第)?\s*(\d+)/i);
        if(download)return {action:'download-media',media_id:download[1]};
        if(/截图|截屏|页面截图/i.test(raw))return {action:'screenshot',openUrl:url};
        if(mediaList)return {action:'list-media',openUrl:url};
        const selector=raw.match(/(?:选择器|selector)\s*[:：]\s*([^\s，。]+)/i)?.[1]||'';
        if(selector||/提取|抽取|读取正文|读取页面|查看页面|查看正文|页面内容|采集网页|抓取页面/i.test(raw))return {action:'extract',selector,openUrl:url};
        if(url)return {action:'open',url};
        if(/打开|访问|进入|导航|浏览|搜索|搜一下|查找|查询/i.test(raw)){
            const target=browserSearchTarget(raw);
            if(target)return {action:'open',url:target.url};
        }
        return null;
    }
    async function browserAgentRequest(payload){
        const response=await fetchWithTimeout('/api/browser-agent/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},90000);
        const data=await response.json().catch(()=>({}));
        if(!response.ok&&data.status!=='confirmation_required')throw new Error(data.detail||data.error||`HTTP ${response.status}`);
        return data;
    }
    async function runBrowserSkillAction(text){
        const plan=browserActionFromText(text);
        if(!plan)throw new Error('请明确说出打开网址、读取页面、截图、列出媒体、下载媒体编号或点击精确按钮。');
        if(plan.openUrl){
            await browserAgentRequest({action:'open',url:plan.openUrl});
        }
        const payload={action:plan.action,url:plan.url||'',text:plan.text||'',selector:plan.selector||'',media_id:plan.media_id||'',confirm:Boolean(plan.confirm)};
        return browserAgentRequest(payload);
    }
    function setRunStatus(state,text,detail=''){
        runState=state;runStateText=text;runStateDetail=detail;renderMessages();
    }
    async function resolveSkillForMessage(text,provider,model,options={}){
        const mode=currentMode();
        const selected=skills.find(skill=>skill.id===skillEl.value&&skill.enabled!==false)||null;
        if(mode==='skill'){
            if(!selected)throw new Error('Skill 模式需要先从 Skill 库选择一个 Skill');
            return selected;
        }
        // Skill 库中的显式选择是当前任务的最高优先级，即使面板仍处于 Agent
        // 模式也不能再被自动路由模型覆盖；清除选择后才启用自动路由。
        if(selected)return selected;
        // 编辑已经完成过的 Agent 请求时，不为同一轮任务重新遍历整个 Skill
        // 目录并调用一次路由模型。
        if(options?.allowAutomatic===false)return null;
        const usableSkills=skills.filter(skill=>skill.enabled!==false);
        if(!usableSkills.length)return null;
        if(usableSkills.length===1)return usableSkills[0];
        const catalog=usableSkills.map(skill=>({id:skill.id,name:skill.name,description:skill.description||''}));
        try{
            const response=await fetchWithTimeout('/api/canvas-llm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
                message:`用户任务：${text}\n\n可用 Skill：\n${catalog.map(item=>`- ${item.id} | ${item.name} | ${item.description}`).join('\n')}`,
                messages:[],images:[],provider,model,
                system_prompt:'你是 Skill 路由器。根据用户任务，从可用 Skill 中选择最相关的一个。只返回 Skill 的 id；没有适合的就只返回 NONE。禁止解释。'
            })},CANVAS_AGENT_SKILL_ROUTING_TIMEOUT_MS);
            const data=await response.json().catch(()=>({}));
            if(response.ok){
                const answer=String(data.text||'').trim().replace(/^["'`]|["'`]$/g,'');
                const selected=usableSkills.find(skill=>answer===skill.id||answer===skill.name);
                if(selected)return selected;
            }
        }catch(error){console.warn('[Canvas Agent] Automatic Skill routing failed:',error);}
        return null;
    }
    function planSourceNodes(scope=currentTaskScope()){
        const ids=scope?.sourceNodeIds||[];
        return ids.map(id=>nodes.find(node=>node.id===id)).filter(Boolean);
    }
    function planExistingNode(ref,map,current){
        const key=String(ref||'').trim();
        if(!key)return null;
        if(['current','current_node','current-node'].includes(key))return current||null;
        if(map?.has(key))return map.get(key);
        return nodes.find(node=>node.id===key)||null;
    }
    function planPoint(anchor,index=0){
        return {x:(Number(anchor?.x)||0)+index*80,y:(Number(anchor?.y)||0)+index*34};
    }
    function applyPlanSettings(node,spec){
        if(!node||!spec||typeof spec!=='object')return;
        const incoming=spec.settings||spec.run_settings;
        if(!incoming||typeof incoming!=='object')return;
        const base=typeof cloneSmartSettings==='function'?cloneSmartSettings(node.runSettings||settings||{}):{...(node.runSettings||settings||{})};
        const allowed=['engine','apiKind','provider_id','model','ratio','resolution','customRatio','customRatioWidth','customRatioHeight','customSize','quality','background','count','videoProvider','videoModel','videoAspect','videoResolution','size'];
        allowed.forEach(key=>{if(incoming[key]!==undefined)base[key]=incoming[key];});
        node.runSettings=typeof settingsForStorage==='function'?settingsForStorage(base):base;
    }
    function applyPlanNodeSpec(node,spec,provider,model,fallbackPrompt=''){
        if(!node||!spec)return;
        const title=String(spec.title||'').trim();
        if(title)node.title=title.slice(0,80);
        applyPlanSettings(node,spec);
        if(node.type==='smart-prompt'){
            const text=String(spec.text||spec.prompt||spec.user_prompt||'').trim();
            if(text)node.text=text;
            if(spec.prompt_split_enabled!==undefined)node.promptSplitEnabled=Boolean(spec.prompt_split_enabled);
            if(spec.llm_enabled!==undefined || spec.llmEnabled!==undefined)node.llmEnabled=Boolean(spec.llm_enabled ?? spec.llmEnabled);
            if(spec.llm_instruction!==undefined)node.llmInstruction=String(spec.llm_instruction||'');
            if(spec.llm_system_prompt!==undefined)node.llmSystemPrompt=String(spec.llm_system_prompt||'');
            if(spec.llm_provider)node.llmProvider=String(spec.llm_provider);
            if(spec.llm_model)node.llmModel=String(spec.llm_model);
            return;
        }
        if(node.type==='smart-agent'){
            if(spec.user_prompt!==undefined)node.userPrompt=String(spec.user_prompt||'');
            if(spec.system_prompt!==undefined)node.systemPrompt=String(spec.system_prompt||'');
            if(spec.agent_provider||provider)node.agentProvider=String(spec.agent_provider||provider||node.agentProvider||'');
            if(spec.agent_model||model)node.agentModel=String(spec.agent_model||model||node.agentModel||'');
            if(Array.isArray(spec.installed_skills))node.installedSkills=spec.installed_skills.slice(0,8);
            return;
        }
        if(node.type==='smart-loop'){
            if(spec.count!==undefined)node.count=Math.max(1,Math.min(100,Number(spec.count)||1));
            if(spec.mode)node.mode=spec.mode==='parallel'?'parallel':'serial';
            if(spec.show_prompt!==undefined)node.showPrompt=Boolean(spec.show_prompt);
            if(spec.image_input!==undefined)node.imageInput=Boolean(spec.image_input);
            if(spec.variable_prompt!==undefined)node.variablePrompt=String(spec.variable_prompt||'');
            if(typeof fitSmartLoopNode==='function')fitSmartLoopNode(node);
            return;
        }
        // 有些模型只给出 text/user_prompt，不会给最终 smart-paint 写 prompt。
        // 计划仍应能直接运行，因此在没有上游文本可用时回退到本次任务。
        const prompt=String(spec.prompt||spec.execution_prompt||spec.promptDraftText||fallbackPrompt||'').trim();
        if(prompt&&isSmartRunnableNode(node))setPromptDraftForNode(node,prompt);
    }
    function createPlanNode(spec,point){
        const type=normalizePlanNodeType(spec?.type);
        if(type==='current')return null;
        if(type==='smart-prompt')return createPromptNode((point?.x||0)-158,(point?.y||0)-97,{select:false,skipUndo:true});
        if(type==='smart-agent')return createAgentNode((point?.x||0)-215,(point?.y||0)-180,{select:false,skipUndo:true});
        if(type==='smart-loop')return createLoopNode((point?.x||0)-170,(point?.y||0)-84,{select:false,skipUndo:true});
        if(type==='smart-group')return createSmartGroupNode((point?.x||0)-170,(point?.y||0)-143,{select:false,skipUndo:true});
        if(type==='smart-upload')return createImageNodeAt(point,[],{select:false,skipUndo:true,nodeType:SMART_UPLOAD_NODE_TYPE});
        return createPaintNodeAt(point,{select:false,skipUndo:true,title:spec?.title||'计划生成'});
    }
    function planWorkflowOrder(mapped,connections){
        const items=[...new Set([...mapped.values()].filter(Boolean))];
        const ids=new Set(items.map(node=>node.id)),indegree=new Map(items.map(node=>[node.id,0])),children=new Map(items.map(node=>[node.id,[]]));
        (connections||[]).forEach(conn=>{
            const from=conn?.fromNode,to=conn?.toNode;
            if(!from||!to||from.id===to.id||!ids.has(from.id)||!ids.has(to.id))return;
            children.get(from.id).push(to);indegree.set(to.id,(indegree.get(to.id)||0)+1);
        });
        const queue=items.filter(node=>(indegree.get(node.id)||0)===0),out=[];
        while(queue.length){
            const node=queue.shift();out.push(node);
            (children.get(node.id)||[]).forEach(next=>{indegree.set(next.id,(indegree.get(next.id)||0)-1);if(indegree.get(next.id)<=0)queue.push(next);});
        }
        return [...out,...items.filter(node=>!out.some(item=>item.id===node.id))];
    }
    function planConnectionExists(fromId,toId,kind='input'){
        return Boolean((canvas?.connections||[]).some(conn => conn?.from===fromId && conn?.to===toId && (conn.kind||'flow')===kind));
    }
    function planConnectionWouldCycle(fromId,toId){
        if(!fromId||!toId||fromId===toId)return true;
        const seen=new Set([toId]),queue=[toId];
        while(queue.length){
            const id=queue.shift();
            for(const conn of (canvas?.connections||[])){
                if(conn?.from!==id||!['input','flow'].includes(conn.kind||'flow'))continue;
                if(conn.to===fromId)return true;
                if(!seen.has(conn.to)){seen.add(conn.to);queue.push(conn.to);}
            }
        }
        return false;
    }
    function connectPlanWorkflow(connections,map,current,sourceNodes,createdNodes){
        let connected=0;
        const applied=[];
        const addApplied=(fromNode,toNode,kind)=>{
            if(!fromNode||!toNode||fromNode.id===toNode.id)return false;
            if(applied.some(item=>item.fromNode.id===fromNode.id&&item.toNode.id===toNode.id&&item.kind===kind))return true;
            applied.push({fromNode,toNode,kind});
            connected+=1;
            return true;
        };
        (connections||[]).forEach(raw=>{
            const fromRef=String(raw?.from||'').trim();
            const toNode=planExistingNode(raw?.to,map,current);
            // current 是任务范围占位符：多选来源时必须展开为所有正式来源，
            // 而非悄悄只取第一个节点或补出跨区域旧引用。
            const fromNodes=['current','current_node','current-node'].includes(fromRef)&&(sourceNodes||[]).length
                ? [...new Map((sourceNodes||[]).filter(node=>node?.id).map(node=>[node.id,node])).values()]
                : [planExistingNode(fromRef,map,current)].filter(Boolean);
            if(!fromNodes.length||!toNode)return;
            const kind=String(raw?.kind||'input')==='flow'?'flow':'input';
            fromNodes.forEach(fromNode=>{
                // 计划是一次性的有向流程。跳过模型误生成的回环，避免出现
                // “当前节点→循环→当前节点”这类交叉线和无法运行的链路。
                if(!fromNode||fromNode.id===toNode.id||planConnectionWouldCycle(fromNode.id,toNode.id))return;
                const existed=planConnectionExists(fromNode.id,toNode.id,kind);
                if(kind==='flow')addConnection(fromNode.id,toNode.id,'flow');
                else if(!connectInputNode(fromNode.id,toNode.id))return;
                if(existed||planConnectionExists(fromNode.id,toNode.id,kind))addApplied(fromNode,toNode,kind);
            });
        });
        const created=createdNodes||[];
        const first=created.find(node=>node.type!=='smart-group'&&node.type!=='smart-upload')||created[0];
        const orderedSources=[...(sourceNodes||[])].filter((node,index,list)=>node?.id&&list.findIndex(item=>item?.id===node.id)===index);
        if(first&&orderedSources.length){
            // 只在计划没有明确给首个节点安排输入时补线；旧版会把已声明的
            // current→节点再补成“所有参考图→节点”，从而导致顺序和线条重复。
            const hasDeclaredInput=applied.some(item=>item.toNode.id===first.id&&item.kind==='input');
            if(!hasDeclaredInput){
                orderedSources.forEach(source=>{
                    if(source.id===first.id||planConnectionWouldCycle(source.id,first.id))return;
                    const existed=planConnectionExists(source.id,first.id,'input');
                    if(connectInputNode(source.id,first.id)&&(existed||planConnectionExists(source.id,first.id,'input'))){
                        addApplied(source,first,'input');
                    }
                });
            }
        }
        if(!applied.length&&created.length>1){
            for(let index=1;index<created.length;index++){
                const from=created[index-1],to=created[index];
                if(!from||!to||planConnectionWouldCycle(from.id,to.id))continue;
                const existed=planConnectionExists(from.id,to.id,'input');
                if(connectInputNode(from.id,to.id)&&(existed||planConnectionExists(from.id,to.id,'input'))){
                    addApplied(from,to,'input');
                }
            }
        }
        return {connected,connections:applied};
    }
    function planRunTargets(workflow,map,current,createdNodes){
        const created=(createdNodes||[]).filter(node=>node&&isSmartImageNode(node)&&!isSmartUploadNode(node)&&!isHistoryGroupNode(node));
        const createdIds=new Set(created.map(node=>node.id));
        const listed=Array.isArray(workflow?.run)?workflow.run.map(ref=>planExistingNode(ref,map,current)).filter(Boolean):[];
        const listedCreated=[...new Set(listed)].filter(node=>createdIds.has(node.id));
        // 优先运行本次计划刚创建的最终绘画节点。即使模型误把 current
        // 放进 run，也不要静默重跑旧节点并制造一张历史分组。
        if(listedCreated.length)return listedCreated;
        if(created.length)return [created[created.length-1]];
        if(listed.length)return [...new Set(listed)];
        return current?[current]:[];
    }
    async function runPlanWorkflow(workflow,map,connectionItems,runTargets,createdNodes=[],requestedGeneration={}){
        const order=planWorkflowOrder(map,connectionItems);
        for(const node of order){
            if(node.type==='smart-agent'){
                const before=String(node.outputText||'').trim();
                await runAgentNode(node.id);
                if(!String(node.outputText||'').trim()&&!before)throw new Error(`Agent 节点「${node.title||node.id}」没有返回结果`);
            }else if(node.type==='smart-prompt'&&node.llmEnabled){
                const promptResult=await runPromptLLMNode(node.id);
                if(promptResult?.ok===false)throw new Error(promptResult.error||`提示词节点「${node.title||node.id}」运行失败`);
            }
        }
        // 只执行最终输出会跳过“阶段一 → 阶段二”里的中间绘画节点。
        // 从最终目标反向收集本次新增节点，再依照拓扑顺序执行，保证下一阶段能读取上一阶段的成图。
        const createdIds=new Set((createdNodes||[]).map(node=>node?.id).filter(Boolean));
        const requiredIds=new Set((runTargets||[]).map(node=>node?.id).filter(Boolean));
        let changed=true;
        while(changed){
            changed=false;
            (connectionItems||[]).forEach(connection=>{
                const fromId=connection?.fromNode?.id,toId=connection?.toNode?.id;
                if(toId&&requiredIds.has(toId)&&fromId&&createdIds.has(fromId)&&!requiredIds.has(fromId)){
                    requiredIds.add(fromId);
                    changed=true;
                }
            });
        }
        const stagedTargets=order.filter(node=>requiredIds.has(node.id)&&isSmartImageNode(node)&&!isSmartUploadNode(node)&&!isHistoryGroupNode(node));
        const executionTargets=stagedTargets.length?stagedTargets:(runTargets||[]);
        let finalNode=null;
        for(let stageIndex=0;stageIndex<executionTargets.length;stageIndex++){
            const target=executionTargets[stageIndex];
            if(!target)continue;
            finalNode=target;
            if(executionTargets.length>1)setRunStatus('running','正在分阶段生成',`第 ${stageIndex+1}/${executionTargets.length} 阶段：${target.title||'绘画节点'}`);
            selectedId=target.id;selectedIds=[];selectedImage={nodeId:'',index:-1};
            if(typeof applyGenerationPreferencesToCurrentNode==='function')applyGenerationPreferencesToCurrentNode({node:target,render:false});
            // 计划节点先接受模型建议，再接受右侧手动偏好；如果用户在本轮消息中
            // 明确指定了比例，最后再写回一次，避免被前两层参数覆盖。
            applyRequestedGenerationToNode(target,requestedGeneration);
            if(target.runSettings)settings=typeof cloneSmartSettings==='function'?cloneSmartSettings(target.runSettings):{...target.runSettings};
            render();updateComposer();
            if(isSmartImageNode(target)&&!isSmartUploadNode(target)){
                const beforeStarted=Number(target.runStartedAt||0),beforeRun=Number(target.runAt||0),beforeImages=Array.isArray(target.images)?target.images.length:0;
                // Agent 计划创建的目标节点已带有完整提示词和上游引用图。不能走画布级联：
                // 级联会从上传图（没有提示词）开始执行，最终只转移引用图而不提交生图请求。
                const previousUndoSuppressed=undoSuppressed;
                undoSuppressed=true;
                try{
                    await runGeneration();
                }finally{
                    undoSuppressed=previousUndoSuppressed;
                }
                const runError=String(target.runError||'').trim();
                if(runError)throw new Error(runError);
                const hasPending=Boolean(target.pending||target.running||target.queued||(Array.isArray(target.pendingTasks)&&target.pendingTasks.length));
                const started=Number(target.runStartedAt||0)>beforeStarted||Number(target.runAt||0)>beforeRun||hasPending;
                if(!started){
                    const detail=String(target.runError||'').trim();
                    throw new Error(detail||(!beforeImages?'生成节点没有启动，请检查提示词和生图模型设置':'生成节点没有启动，请重新选择方案'));
                }
            }
        }
        return {finalNode,executedCount:executionTargets.length};
    }
    async function executePlanOption(option,provider,model,scopeSnapshot,taskText='',requestedGeneration={},skillId='',skillName=''){
        const workflow=option?.workflow&&typeof option.workflow==='object'?option.workflow:{};
        const scope=currentTaskScope(scopeSnapshot);
        if(!scope.valid)throw new Error(scope.reason||'原任务范围已不可用，请重新选择画布节点后再试。');
        // 方案中的正式连线、节点创建、提示词写入和后续启动共用一份撤销快照。
        pushUndo();
        if(typeof ensureCanvasTaskScopeFormalConnections==='function')ensureCanvasTaskScopeFormalConnections(scope);
        const current=nodes.find(node=>node.id===(scope.targetNodeId||''))||nodes.find(node=>node.id===(scope.selectedNodeIds||[])[0])||null;
        // 计划消息保存的是发送当刻的正式任务范围，重新选择方案时不会把上一方案
        // 的结果或对话历史引用混入输入。
        const sourceNodes=planSourceNodes(scope);
        const anchor=typeof canvasTaskScopePlacement==='function'?canvasTaskScopePlacement(scope):viewportCenter();
        const fallbackPrompt=String(option?.execution_prompt||option?.prompt||taskText||'').trim();
        const outputPrompt=planTaskText(taskText)||fallbackPrompt;
        const map=new Map();
        if(current){map.set('current',current);map.set('current_node',current);map.set(current.id,current);}
        const createdNodes=[],createdIds=[];
        const specs=Array.isArray(workflow.nodes)?workflow.nodes.slice(0,8):[];
        specs.forEach((raw,index)=>{
            const spec=raw&&typeof raw==='object'?raw:{};
            const key=String(spec.key||spec.id||`node_${index+1}`).slice(0,60);
            const existing=spec.use_current===true||key==='current'||key==='current_node'
                ?current
                :nodes.find(node=>node.id===String(spec.node_id||spec.existing_node_id||key));
            const node=existing||createPlanNode(spec,planPoint(anchor,index));
            if(!node)return;
            map.set(key,node);map.set(node.id,node);
            if(!existing){createdNodes.push(node);createdIds.push(node.id);}
            applyPlanNodeSpec(node,spec,provider,model,fallbackPrompt);
            applyRequestedGenerationToNode(node,requestedGeneration);
            applyAgentSkillMetadataToNode(node,{skill_id:skillId,skill_name:skillName});
        });
        // 当前上传节点只是参考图来源，不能作为最终执行目标。若模型只复用 current、
        // 或只创建了提示词/Agent 节点，补一个可运行的绘画输出并带上原始用户需求。
        const hasCreatedPaint=createdNodes.some(node=>isSmartImageNode(node)&&!isSmartUploadNode(node)&&!isHistoryGroupNode(node));
        let ensuredOutput=null;
        if(!hasCreatedPaint){
            const key=map.has('paint_1')?'plan_output':'paint_1';
            const fallbackSpec={key,type:'smart-paint',title:'计划生成',prompt:outputPrompt||option.execution_prompt||option.summary||'根据当前需求生成结果'};
            const node=createPlanNode(fallbackSpec,planPoint(anchor,createdNodes.length));
            if(node){
                createdNodes.push(node);createdIds.push(node.id);map.set(key,node);map.set(node.id,node);
                applyPlanNodeSpec(node,fallbackSpec,provider,model,fallbackPrompt);
                applyRequestedGenerationToNode(node,requestedGeneration);
                applyAgentSkillMetadataToNode(node,{skill_id:skillId,skill_name:skillName});
                ensuredOutput={key,node};
            }
        }
        const connectionSpecs=Array.isArray(workflow.connections)?workflow.connections.slice(0,20):[];
        // 无论模型返回的中间编排如何，补出的输出节点都要直接收到用户引用的图片。
        if(ensuredOutput)sourceNodes.forEach(source=>connectionSpecs.push({from:source.id,to:ensuredOutput.key,kind:'input'}));
        const connectionResult=connectPlanWorkflow(connectionSpecs,map,current,sourceNodes,createdNodes);
        createdNodes.filter(node => isSmartImageNode(node) && !isSmartUploadNode(node) && !isHistoryGroupNode(node))
            .forEach(node => {
                if(typeof applyCanvasTaskScopeReferenceFilter==='function')applyCanvasTaskScopeReferenceFilter(node,scope);
            });
        if(createdIds.length>1&&typeof arrangeSmartIdsByConnections==='function')arrangeSmartIdsByConnections(createdIds);
        const runTargets=planRunTargets(workflow,map,current,createdNodes);
        if(!runTargets.length)throw new Error('计划没有可执行的目标节点');
        render();updateComposer();scheduleSave();
        const runResult=await runPlanWorkflow(workflow,map,connectionResult.connections,runTargets,createdNodes,requestedGeneration);
        const finalNode=runResult.finalNode;
        // 方案执行完成后把右侧 Agent 重新绑定到最终绘画节点。这样任务范围会
        // 立即展示该节点的正式 input/flow 上游，而不是停留在“未选择画布节点”。
        if(finalNode){
            selectedId=finalNode.id;
            selectedIds=[];
            selectedImage={nodeId:'',index:-1};
        }
        if(current&&finalNode){
            current.planResultNodeId=finalNode.id;
            current.planResultAt=Date.now();
            if(current.type==='smart-prompt'&&option.execution_prompt)current.text=String(option.execution_prompt);
            if(current.type==='smart-agent'&&option.execution_prompt)current.outputText=String(option.execution_prompt);
        }
        render();updateComposer();scheduleSave();
        return {finalNode,createdCount:createdNodes.length,connectedCount:connectionResult.connected,executedCount:runResult.executedCount};
    }
    async function selectPlanOption(index,optionId){
        if(busy)return;
        const conversation=activeConversation(),message=conversation.messages[index];
        if(!message||message.role!=='assistant'||message.kind!=='plan'||message.planStatus==='executing')return;
        const requestedGeneration=message.requestedGeneration||requestedGenerationPreferences(planRequestText(message,index));
        const plan=normalizePlanForClient(message.plan||{},planRequestText(message,index),requestedGeneration),option=plan.options.find(item=>item.id===optionId)||plan.options[0];
        if(!option)return;
        const provider=providerEl.value,model=modelEl.value;
        if(!provider||!model){toast('请先选择 Agent 模型');return;}
        message.selectedOptionId=option.id;message.planStatus='executing';saveStore();renderMessages();
        const runToken=beginAgentRun();
        $('canvasAgentSend').disabled=true;
        setRunStatus('running','正在执行方案',`正在创建并连接「${option.label}」的画布流程`);
        try{
            assertAgentRunActive(runToken);
            const result=await executePlanOption(option,provider,model,message.taskScope,planRequestText(message,index),requestedGeneration,message.skillId||message.skill_id||'',message.skillName||message.skill_name||'');
            assertAgentRunActive(runToken);
            message.planStatus='done';message.executionSummary=`已创建 ${result.createdCount} 个节点，连接 ${result.connectedCount} 条，已按顺序生成 ${result.executedCount||1} 个阶段，结果已返回画布`;
            setRunStatus('done','方案已执行',message.executionSummary);
        }catch(error){
            message.planStatus='error';
            message.executionSummary=isAgentCancelled(error)?'已停止本次方案执行，已完成的画布任务保持不变':(error.message||'执行未完成');
            setRunStatus(isAgentCancelled(error)?'done':'error',isAgentCancelled(error)?'已停止':'方案执行失败',message.executionSummary);
        }finally{finishAgentRun(runToken);$('canvasAgentSend').disabled=false;saveStore();renderMessages();renderTaskScope();}
    }
    function agentNodeBusy(node){
        return Boolean(node&&(node.running||node.pending||node.queued||node.jimengPending||(typeof smartPendingTasks==='function'&&smartPendingTasks(node).length)));
    }
    function agentNodeImageCount(node){
        if(!node)return 0;
        if(typeof imagesForNode==='function')return imagesForNode(node).filter(item=>item?.url&&!item.loopInputPreview).length;
        return Array.isArray(node.images)?node.images.filter(item=>item?.url&&!item.loopInputPreview).length:0;
    }
    function reconcileAgentActionStates(){
        const conversation=activeConversation();
        let changed=false;
        let recoveredError=false;
        const now=Date.now();
        (conversation.messages||[]).forEach(message=>{
            if(message?.role!=='assistant'||message.kind!=='action'||!['running','queued'].includes(String(message.actionStatus||'')))return;
            // 编辑重跑在写回 action.targetNodeId 之前就可能被页面刷新/重载；
            // 此时 taskScope 里仍保留正式目标节点，允许用它恢复卡片状态。
            const targetId=String(message.targetNodeId||message.taskScope?.targetNodeId||message.taskScope?.target_node_id||'');
            const target=targetId?nodes.find(node=>node.id===targetId):null;
            if(!target)return;
            const finishedAt=Number(target.runFinishedAt||0);
            const actionStartedAt=Number(message.agentRunStartedAt||0);
            const targetStartedAt=Number(target.runStartedAt||0);
            const sameRun=Boolean(actionStartedAt&&targetStartedAt>=actionStartedAt&&finishedAt>=actionStartedAt);
            const legacyEditedAction=!actionStartedAt
                && /正在根据修改后的提示词重新整理并运行/.test(String(message.text||''))
                && finishedAt>0
                && now-finishedAt<CANVAS_AGENT_LEGACY_ACTION_WINDOW_MS;
            const imageCount=agentNodeImageCount(target);
            const expectedCount=Math.max(1,Math.min(8,Number(target.runSettings?.count||1)));
            const hasResult=imageCount>0;
            const completed=Boolean(finishedAt&&!agentNodeBusy(target)&&(sameRun||legacyEditedAction));
            // 某个已生成结果的后台轮询卡住时，不再让 Agent 面板无限等待；
            // 画布节点仍保留自己的任务状态，后续轮询/恢复逻辑继续负责收尾。
            const resultReady=Boolean(hasResult&&imageCount>=expectedCount&&(sameRun||legacyEditedAction));
            if(!completed&&!resultReady)return;
            if(!message.targetNodeId)message.targetNodeId=targetId;
            if(target.runError){
                message.actionStatus='error';
                message.actionDetail=String(target.runError);
                recoveredError=true;
            }else{
                message.actionStatus='done';
                message.actionDetail=resultReady&&!completed
                    ?`已生成 ${imageCount} 张图片，画布正在完成后台收尾`
                    :'当前画布任务已完成';
                if(/^正在根据修改后的提示词重新整理并运行/.test(String(message.text||'')))message.text='已根据修改后的提示词完成并运行。';
            }
            changed=true;
        });
        if(!changed)return false;
        finishAgentRun();
        runState=recoveredError?'error':'done';
        runStateText=recoveredError?'运行失败':'已完成';
        runStateDetail=recoveredError?'画布节点已返回错误':'图片已生成，Agent 状态已自动收尾';
        saveStore();
        renderMessages();
        renderTaskScope();
        return true;
    }
    function ensureAgentActionWatcher(){
        if(agentActionWatchTimer)return;
        agentActionWatchTimer=setInterval(()=>{
            if(!panel?.classList.contains('open'))return;
            reconcileAgentActionStates();
        },CANVAS_AGENT_ACTION_WATCH_INTERVAL_MS);
    }
    function applyAgentSkillMetadataToNode(node,action){
        const skillId=String(action?.skill_id||action?.skillId||'').trim();
        if(!node||!skillId)return;
        const skillName=String(action?.skill_name||action?.skillName||'').trim();
        node.agentSkillId=skillId;
        node.agentSkillName=skillName;
        const base=typeof cloneSmartSettings==='function'
            ?cloneSmartSettings(node.runSettings||{})
            :{...(node.runSettings||{})};
        base.agentSkillId=skillId;
        base.agentSkillName=skillName;
        node.runSettings=typeof settingsForStorage==='function'?settingsForStorage(base):base;
    }
    async function runDirectCanvasAction(scope,action,requestedGeneration={},onPrepared=null){
        assertAgentRunActive();
        const prompt=String(action?.prompt||'').trim();
        if(!prompt)return {ok:false,reason:'Agent 没有返回可执行的生成提示词。'};
        const applied=typeof applyCanvasTaskScopeAction==='function'
            ?applyCanvasTaskScopeAction(scope,{prompt,title:'Agent 生成'})
            :{ok:false,reason:'当前画布未加载统一任务接口。'};
        if(!applied?.ok)throw new Error(applied?.reason||'无法写入当前画布任务。');
        const target=applied.target;
        if(typeof onPrepared==='function')onPrepared(applied);
        // Agent 可以补充它推断出的参数，但不能覆盖用户在右侧“生成偏好”中
        // 已手动锁定的模型、比例或清晰度；消息里明确写出的比例仍是最高优先级。
        if(action?.settings&&typeof applyCanvasGenerationSettings==='function'){
            const next=applyCanvasGenerationSettings(target,action.settings);
            if(next)settings=typeof cloneSmartSettings==='function'?cloneSmartSettings(next):{...next};
        }
        applyGenerationPreferencesToCurrentNode({node:target,render:false});
        applyRequestedGenerationToNode(target,requestedGeneration);
        applyAgentSkillMetadataToNode(target,action);
        if(target.runSettings)settings=typeof cloneSmartSettings==='function'?cloneSmartSettings(target.runSettings):{...target.runSettings};
        render();updateComposer();scheduleSave();
        // 创建目标、连线、写入提示词和启动生成共用前面的一次撤销快照；
        // 生成失败时目标与正式关系保留，用户可直接检查或重试。
        const beforeStarted=Number(target.runStartedAt||0),beforeRun=Number(target.runAt||0),beforeImages=Array.isArray(target.images)?target.images.length:0;
        const previousUndoSuppressed=undoSuppressed;
        const previousTransientBlockedInputRefs=globalThis.smartCanvasTransientBlockedInputRefs;
        const excludedReferenceKeys=Array.isArray(scope?.excludedReferenceKeys)?scope.excludedReferenceKeys.filter(Boolean):[];
        if(excludedReferenceKeys.length){
            globalThis.smartCanvasTransientBlockedInputRefs={nodeId:target.id,keys:excludedReferenceKeys};
        }
        undoSuppressed=true;
        try{
            assertAgentRunActive();
            // 任务已写入节点后，Agent 不应被画布保存或长轮询无限绑住。
            // runGeneration 会先写入新的 runStartedAt/pending，再提交远端
            // task；只等 pendingTasks 里的 task id 会把这段网络等待误判成
            // Agent 卡死。因此只要确认本轮节点已经进入忙碌态，就把控制权
            // 交回面板，节点自身继续提交/轮询，完成后由
            // reconcileAgentActionStates 更新卡片。
            const generationPromise=Promise.resolve().then(()=>runGeneration());
            const handoffPromise=new Promise(resolve=>{
                const check=()=>{
                    const live=nodes.find(node=>node.id===target.id)||target;
                    const started=Number(live.runStartedAt||0)>beforeStarted||Number(live.runAt||0)>beforeRun;
                    if(started&&agentNodeBusy(live)){
                        resolve({handoff:'queued',target:live});
                        return;
                    }
                    if(started&&Number(live.runFinishedAt||0)>Math.max(beforeRun,beforeStarted)&&!agentNodeBusy(live)){
                        resolve({handoff:'done',target:live});
                        return;
                    }
                    setTimeout(check,250);
                };
                check();
            });
            const generationOutcome=generationPromise.then(
                ()=>({handoff:'finished',target:nodes.find(node=>node.id===target.id)||target}),
                error=>({handoff:'failed',error}),
            );
            const outcome=await Promise.race([generationOutcome,handoffPromise]);
            if(outcome?.handoff==='queued'){
                // runGeneration 已经捕获自己的异常；这里再挂一个 catch 只是防止
                // 未来某条新增引擎链路抛出未处理 Promise 警告。
                generationPromise.catch(error=>console.warn('[Canvas Agent] 后台生图链路结束异常:',error));
                return {...applied,target:outcome.target,handoff:'queued'};
            }
            if(outcome?.handoff==='failed')throw outcome.error;
        }finally{
            undoSuppressed=previousUndoSuppressed;
            if(previousTransientBlockedInputRefs===undefined)delete globalThis.smartCanvasTransientBlockedInputRefs;
            else globalThis.smartCanvasTransientBlockedInputRefs=previousTransientBlockedInputRefs;
        }
        const runError=String(target.runError||'').trim();
        if(runError)throw new Error(runError);
        const hasPending=Boolean(target.pending||target.running||target.queued||(Array.isArray(target.pendingTasks)&&target.pendingTasks.length));
        const started=Number(target.runStartedAt||0)>beforeStarted||Number(target.runAt||0)>beforeRun||hasPending;
        if(!started){
            throw new Error(String(target.runError||'').trim()||(!beforeImages?'生成节点没有启动，请检查提示词和生图模型设置':'生成节点没有启动，请检查当前节点的模型设置'));
        }
        return {...applied,target:nodes.find(node=>node.id===target.id)||target};
    }
    function editedTaskScopeForUser(userIndex,actionMessage){
        const message=answerAt(userIndex),targetId=String(actionMessage?.targetNodeId||''),target=targetId?nodes.find(node=>node.id===targetId):null;
        let scope=null;
        if(target&&typeof resolveCanvasTaskScope==='function'){
            selectedId=target.id;
            selectedIds=[];
            selectedImage={nodeId:'',index:-1};
            scope=resolveCanvasTaskScope({selectedNodeIds:[target.id],targetNodeId:target.id});
        }else{
            scope=currentTaskScope(message?.taskScope||null);
        }
        const savedRefs=messageReferenceImages(message);
        if(scope&&savedRefs.length)scope.referenceImages=savedRefs;
        return scope;
    }
    function resetUserMessageEditState(clearInput=true){
        if(clearInput&&input){input.value='';resizeComposerInput();}
        editingUserMessageIndex=-1;
        editingUserMessageDraft='';
        editingUserMessageOriginal='';
        editingInputDraft='';
        syncMessageEditUi();
    }
    function editedMessageHistory(conversation,index){
        return conversation.messages.slice(Math.max(0,index-12),index).map(item=>({role:item.role,content:item.text}));
    }
    async function sendEditedUserMessage(index,options={}){
        if(busy){
            toast('Agent 正在处理上一条任务，请稍候');
            return;
        }
        const conversation=activeConversation(),message=conversation.messages[index],related=actionMessageForUser(index),action=related?.message;
        if(!message||message.role!=='user'||!canEditUserMessage(index)||!action){toast('当前提示词暂时不能编辑');return;}
        const text=String(editingUserMessageDraft||'').trim();
        if(!text){toast('提示词不能为空');return;}
        const provider=providerEl.value,model=modelEl.value;
        if(!provider||!model){toast('请先选择 Agent 模型');return;}
        let scope=editedTaskScopeForUser(index,action);
        if(!scope?.valid){toast(scope?.reason||'原任务范围已不可用，请重新选择画布节点后再试');return;}
        const composerRefs=composerFileReferences.slice();
        scope=scopeWithComposerReferences(scope,composerRefs);
        const savedRefs=messageReferenceImages(message),messageRefs=snapshotReferenceImages([...(savedRefs.length?savedRefs:planReferenceImages(scope)),...composerRefs]);
        scope.referenceImages=messageRefs;
        const scopeSnapshot=serializedTaskScope(scope),history=editedMessageHistory(conversation,index),requestedGeneration=requestedGenerationPreferences(text),hasLink=/https?:\/\//i.test(text);
        const generationError=generationPreferenceError(requestedGeneration,text);
        if(generationError){renderGenerationPreferences();toast(generationError);return;}
        let actionTargetId=String(action.targetNodeId||'');
        let linkJobIds=Array.isArray(message.linkJobIds)?message.linkJobIds.slice(0,3):[];
        const runToken=beginAgentRun();
        $('canvasAgentSend').disabled=true;
        message.text=text;
        message.taskScope=scopeSnapshot;
        message.referenceImages=messageRefs;
        action.actionStatus='running';
        action.agentRunStartedAt=Date.now();
        action.text='正在根据修改后的提示词重新整理并运行…';
        action.requestText=text;
        action.taskScope=scopeSnapshot;
        action.actionDetail='';
        resetUserMessageEditState(true);
        saveStore();
        renderMessages();
        setRunStatus('running','正在重新分析修改后的提示词','将更新同一个绘画节点，不会新增用户消息');
        try{
            assertAgentRunActive(runToken);
            if(window.XiaomeiLinkAnalysis){
                const prepared=await prepareCanvasLinks(text,conversation,message,{retryExisting:Boolean(options?.retryExisting)});
                assertAgentRunActive(runToken);
                linkJobIds=prepared.jobIds||[];
            }
            setRunStatus('running',hasLink?'正在读取链接':'正在生成可执行提示词',hasLink?'商品快照已读取，正在结合当前任务范围':'请求已发出，请稍候');
            const selectedSkill=await resolveSkillForMessage(text,provider,model,{allowAutomatic:false});
            assertAgentRunActive(runToken);
            if(selectedSkill)toast(`已${String(skillEl.value||'').trim()?'启用':'自动关联'} Skill：${selectedSkill.name}`);
            const rolePrompt='你是小美画布的电商视觉 Agent。你只能基于当前正式任务范围整理一条可直接运行的提示词。';
            const response=await fetchWithTimeout('/api/canvas-agent-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
                message:text,messages:history,images:messageRefs.map(item=>item.url),provider,model,
                skill_id:selectedSkill?.id||'',
                link_job_ids:linkJobIds,
                target_node_id:scope.targetNodeId||actionTargetId,task_scope:scopeSnapshot,canvas_context:planCanvasContext(scope),
                generation_preferences:{...effectiveGenerationPreferences(),...requestedGeneration},
                system_prompt:rolePrompt
            })},CANVAS_AGENT_REQUEST_TIMEOUT_MS),data=normalizeCanvasAgentActionResponse(await response.json().catch(()=>({})));
            assertAgentRunActive(runToken);
            if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
            const summary=String(data.summary||data.text||'Agent 已完成分析。').trim()||'Agent 已完成分析。';
            action.skillId=String(data.skill_id||selectedSkill?.id||'').trim();
            action.skillName=String(data.skill_name||selectedSkill?.name||'').trim();
            if(data.no_generation){
                action.text=summary;
                action.actionStatus='analysis-only';
                action.actionDetail='用户明确要求不生成，未改动画布。';
                setRunStatus('done','仅完成分析','已按你的要求保持画布不变');
                return;
            }
            if(!data.can_apply||!String(data.prompt||'').trim()){
                action.text=summary;
                action.actionStatus='no-prompt';
                action.actionDetail='未收到有效的可执行提示词，画布未改动。';
                setRunStatus('error','未写入画布','Agent 没有返回有效生成提示词');
                return;
            }
            setRunStatus('running','正在写入并运行','正在更新原绘画节点并通过正式连线运行');
            assertAgentRunActive(runToken);
            const applied=await runDirectCanvasAction(scope,data,requestedGeneration,result=>{actionTargetId=result.target?.id||actionTargetId;});
            assertAgentRunActive(runToken);
            const linkInfo=data.link_context||{},visionDetail=visionInputDetail(data.vision_input);
            const detail=[linkInfo.count?`已读取 ${linkInfo.success_count||0}/${linkInfo.count} 个链接`:'',visionDetail].filter(Boolean).join('；');
            action.text=summary;
            action.requestText=text;
            action.actionPrompt=String(data.prompt||'').trim();
            action.actionStatus=applied.handoff==='queued'?'queued':'done';
            action.targetNodeId=actionTargetId||applied.target?.id||'';
            action.taskScope=scopeSnapshot;
            delete action.rerunAt;
            if(applied.handoff==='queued')action.actionDetail='已提交到画布，图片完成后会自动更新状态';
            else delete action.actionDetail;
            setRunStatus('done',applied.handoff==='queued'?'已提交生成':'已更新并运行',detail||'已使用修改后的提示词更新当前画布任务');
        }catch(error){
            const cancelled=isAgentCancelled(error);
            action.text=cancelled?'本次 Agent 修改已停止。':`请求失败：${error.message}`;
            action.actionStatus=cancelled?'cancelled':'error';
            action.actionDetail=cancelled?'本次 Agent 请求已停止，画布未继续改动':(error.message||'请求未完成');
            action.requestText=text;
            action.taskScope=scopeSnapshot;
            setRunStatus(cancelled?'done':'error',cancelled?'已停止':'运行失败',action.actionDetail);
        }finally{
            finishAgentRun(runToken);
            $('canvasAgentSend').disabled=false;
            clearComposerFileReferences();
            saveStore();
            renderMessages();
            renderTaskScope();
        }
    }
    async function send(){
        if(sharedCanvasMode)return;
        // Folder requests must be handled before message edits or node scope checks.
        if(folderBatch?.hasActive()){
            const text=input.value.trim();
            if(!text||busy)return;
            const context=folderBatchContext();
            const accepted=await folderBatch.send(text,context);
            if(accepted&&store.activeId===context.conversationId&&String(canvas?.id||'')===context.canvasId&&input.value.trim()===text){input.value='';resizeComposerInput();}
            return;
        }
        if(editingUserMessageIndex>=0)return sendEditedUserMessage(editingUserMessageIndex);
        const composerRefs=composerFileReferences.slice();
        let text=input.value.trim();
        if((!text&&!composerRefs.length)||busy)return;
        if(!text)text='请分析我上传的素材图。';
        const browserSkillSelected=canonicalSkillId(skillEl.value)===BROWSER_SKILL_ID;
        const provider=providerEl.value,model=modelEl.value;if(!browserSkillSelected&&(!provider||!model)){toast('请先选择 Agent 模型');return;}
        let scope=currentTaskScope();
        if(!scope.valid&&!browserSkillSelected){renderTaskScope();toast(scope.reason||'请先选择画布节点');return;}
        if(browserSkillSelected&&!scope.valid){
            Object.assign(scope,{valid:true,mode:'browser',selectedNodeIds:[],targetNodeId:'',sourceNodeIds:[],formalInputNodeIds:[],upstreamNodeIds:[],referenceImages:[],generationSettings:{}});
        }
        scope=scopeWithComposerReferences(scope,composerRefs);
        const conversation=activeConversation();
        const planning=!noGenerationRequested(text)&&planModeRequested(text),harnessRequested=!planning&&!browserSkillSelected&&harnessComplexTaskRequested(text),requestedGeneration=requestedGenerationPreferences(text),messageRefs=snapshotReferenceImages(planReferenceImages(scope));
        const generationError=!browserSkillSelected?generationPreferenceError(requestedGeneration,text):'';
        if(generationError){renderGenerationPreferences();toast(generationError);return;}
        const scopeSnapshot=serializedTaskScope(scope);
        const runToken=beginAgentRun();
        $('canvasAgentSend').disabled=true;
        conversation.messages.push({role:'user',text,taskScope:scopeSnapshot,referenceImages:messageRefs,linkJobIds:[],linkUrls:[]});if(conversation.title==='新对话')conversation.title=text.slice(0,22);
        input.value='';resizeComposerInput();renderMessages();saveStore();
        setRunStatus('running','正在运行节点','Agent 已收到任务，请保持窗口开启');
        let actionTargetId='';
        const agentRunStartedAt=Date.now();
        let selectedSkillForMessage=null;
        try{
            assertAgentRunActive(runToken);
            setRunStatus('running','正在分析任务','正在匹配 Skill 并整理请求');
            const explicitSkillId=String(skillEl.value||'').trim();
            const selectedSkill=await resolveSkillForMessage(text,provider,model);
            assertAgentRunActive(runToken);
            selectedSkillForMessage=selectedSkill;
            if(selectedSkill)toast(`已${explicitSkillId?'启用':'自动关联'} Skill：${selectedSkill.name}`);
            const userMessage=conversation.messages[conversation.messages.length-1];
            if(userMessage&&selectedSkill){
                userMessage.skillId=selectedSkill.id||'';
                userMessage.skillName=selectedSkill.name||'';
            }
            if(browserSkillSelected&&selectedSkill?.id===BROWSER_SKILL_ID){
                setRunStatus('running','正在打开浏览器','已选择网页操作助手，正在执行可见网页动作');
                const browserResult=await runBrowserSkillAction(text);
                assertAgentRunActive(runToken);
                const browserText=browserResult.status==='confirmation_required'
                    ?String(browserResult.message||'这个动作需要再次确认')
                    :String(browserResult.title||browserResult.message||'浏览器动作已完成');
                conversation.messages.push({role:'assistant',kind:'browser',text:browserText,skillId:selectedSkill.id,skillName:selectedSkill.name||'网页操作助手',browserResult,taskScope:scopeSnapshot});
                setRunStatus(browserResult.ok===false?'error':'done',browserResult.ok===false?'等待确认':'浏览器动作完成',browserResult.url||browserResult.message||'结果已返回到对话');
                return;
            }
            const history=conversation.messages.slice(-12,-1).map(item=>({role:item.role,content:item.text}));
            const hasLink=/https?:\/\//i.test(text);
            let linkJobIds=[];
            if(window.XiaomeiLinkAnalysis){
                const prepared=await prepareCanvasLinks(text,conversation,userMessage);
                assertAgentRunActive(runToken);
                linkJobIds=prepared.jobIds||[];
            }
            let harnessFallback=false;
            if(harnessRequested){
                const harnessMessage={role:'assistant',kind:'orchestration',text:'正在启动 Codex Harness…',requestText:text,skillId:selectedSkill?.id||'',skillName:selectedSkill?.name||'',taskScope:scopeSnapshot,requestedGeneration};
                conversation.messages.push(harnessMessage);renderMessages();saveStore();
                const harnessResult=await runCanvasHarness(harnessMessage,{text,provider,model,history,selectedSkill,scope,scopeSnapshot,requestedGeneration,linkJobIds,messageRefs});
                assertAgentRunActive(runToken);
                if(!harnessResult?.fallback)return;
                conversation.messages=conversation.messages.filter(item=>item!==harnessMessage);
                harnessFallback=true;
                setRunStatus('running','切换为计划模式',harnessResult.reason||'Codex Harness 当前不可用，继续使用现有画布计划执行器');
            }
            if(planning||harnessFallback){
                setRunStatus('running',hasLink?'正在读取链接':'正在生成计划',hasLink?'商品快照已读取，正在结合画布上下文生成方案':'正在分析需求并整理 2–4 个可执行方向');
                const result=await requestPlan(text,provider,model,history,selectedSkill?.id||'',scope,requestedGeneration,linkJobIds);
                assertAgentRunActive(runToken);
                const plan=result.plan||fallbackPlanForClient(text,requestedGeneration),linkInfo=result.linkContext||{},visionDetail=visionInputDetail(result.visionInput);
                const generationDetail=requestedGenerationLabel(requestedGeneration);
                const linkPrefix=linkInfo.count?`已读取 ${linkInfo.success_count||0}/${linkInfo.count} 个链接${linkInfo.image_count?`，附带 ${linkInfo.image_count} 张参考图`:''}${generationDetail?`；${generationDetail}已锁定`:''}`:(generationDetail?`${generationDetail}已锁定`:'');
                const linkDetail=[linkPrefix,visionDetail,'请选择一个方案立即执行'].filter(Boolean).join('；');
                conversation.messages.push({role:'assistant',kind:'plan',text:[plan.analysis,plan.approach].filter(Boolean).join('\n\n'),requestText:text,plan,requestedGeneration,planStatus:'pending',skillId:result.skill_id||selectedSkill?.id||'',skillName:result.skill_name||selectedSkill?.name||'',taskScope:scopeSnapshot,linkJobIds});
                setRunStatus('done','计划已生成',linkDetail);
                return;
            }
            setRunStatus('running',hasLink?'正在读取链接':'正在生成可执行提示词',hasLink?'商品快照已读取，正在结合当前任务范围':'请求已发出，请稍候');
            const rolePrompt='你是小美画布的电商视觉 Agent。你只能基于当前正式任务范围整理一条可直接运行的提示词。';
            const response=await fetchWithTimeout('/api/canvas-agent-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
                message:text,messages:history,images:messageRefs.map(item=>item.url),provider,model,
                skill_id:selectedSkill?.id||'',
                link_job_ids:linkJobIds,
                target_node_id:scope.targetNodeId||'',task_scope:scopeSnapshot,canvas_context:planCanvasContext(scope),
                generation_preferences:{...effectiveGenerationPreferences(),...requestedGeneration},
                system_prompt:rolePrompt
            })},CANVAS_AGENT_REQUEST_TIMEOUT_MS),data=normalizeCanvasAgentActionResponse(await response.json().catch(()=>({})));
            assertAgentRunActive(runToken);
            if(!response.ok)throw new Error(data.detail||data.error||`HTTP ${response.status}`);
            const summary=String(data.summary||data.text||'Agent 已完成分析。').trim()||'Agent 已完成分析。';
            const responseSkillId=String(data.skill_id||selectedSkill?.id||'').trim();
            const responseSkillName=String(data.skill_name||selectedSkill?.name||'').trim();
            if(data.no_generation){
                conversation.messages.push({role:'assistant',kind:'action',text:summary,skillId:responseSkillId,skillName:responseSkillName,actionStatus:'analysis-only',actionDetail:'用户明确要求不生成，未改动画布。',taskScope:scopeSnapshot});
                setRunStatus('done','仅完成分析','已按你的要求保持画布不变');
                return;
            }
            if(!data.can_apply||!String(data.prompt||'').trim()){
                conversation.messages.push({role:'assistant',kind:'action',text:summary,skillId:responseSkillId,skillName:responseSkillName,actionStatus:'no-prompt',actionDetail:'未收到有效的可执行提示词，画布未改动。',taskScope:scopeSnapshot});
                setRunStatus('error','未写入画布','Agent 没有返回有效生成提示词');
                return;
            }
            setRunStatus('running','正在写入并运行','正在通过正式连线创建/更新目标节点');
            assertAgentRunActive(runToken);
            const applied=await runDirectCanvasAction(scope,data,requestedGeneration,result=>{actionTargetId=result.target?.id||'';});
            assertAgentRunActive(runToken);
            const linkInfo=data.link_context||{},visionDetail=visionInputDetail(data.vision_input);
            const detail=[linkInfo.count?`已读取 ${linkInfo.success_count||0}/${linkInfo.count} 个链接`:'',visionDetail].filter(Boolean).join('；');
                conversation.messages.push({role:'assistant',kind:'action',text:summary,skillId:responseSkillId,skillName:responseSkillName,requestText:text,actionPrompt:String(data.prompt||'').trim(),actionStatus:applied.handoff==='queued'?'queued':'done',actionDetail:applied.handoff==='queued'?'已提交到画布，图片完成后会自动更新状态':'',agentRunStartedAt,targetNodeId:actionTargetId,actionCreated:Boolean(applied.created),actionConnected:Number(applied.connected||0),taskScope:scopeSnapshot});
                setRunStatus('done',applied.handoff==='queued'?'已提交生成':'已写入并运行',detail||'当前画布任务已启动生成');
        }catch(error){
            const browserError=browserSkillSelected&&selectedSkillForMessage?.id===BROWSER_SKILL_ID;
            const cancelled=isAgentCancelled(error);
            conversation.messages.push(cancelled
                ? {role:'assistant',kind:'action',text:'本次 Agent 任务已停止。',skillId:selectedSkillForMessage?.id||'',skillName:selectedSkillForMessage?.name||'',actionStatus:'cancelled',targetNodeId:actionTargetId,actionDetail:'本次 Agent 请求已停止，画布未继续改动',taskScope:scopeSnapshot}
                : browserError
                    ? {role:'assistant',kind:'browser',text:`请求失败：${error.message}`,skillId:selectedSkillForMessage?.id||BROWSER_SKILL_ID,skillName:selectedSkillForMessage?.name||'网页操作助手',browserResult:{ok:false,status:'error',error:error.message||'请求未完成'},taskScope:scopeSnapshot}
                    : {role:'assistant',kind:'action',text:`请求失败：${error.message}`,skillId:selectedSkillForMessage?.id||'',skillName:selectedSkillForMessage?.name||'',actionStatus:'error',targetNodeId:actionTargetId,actionDetail:error.message||'请求未完成',taskScope:scopeSnapshot});
            setRunStatus(cancelled?'done':'error',cancelled?'已停止':'运行失败',cancelled?'本次 Agent 请求已停止，画布未继续改动':(error.message||'请求未完成'));
        }finally{finishAgentRun(runToken);$('canvasAgentSend').disabled=false;clearComposerFileReferences();saveStore();renderMessages();renderTaskScope();}
    }
    function retryAgentRequest(index){
        if(busy)return;
        const userIndex=userMessageIndexForAction(index),message=userIndex>=0?activeConversation().messages[userIndex]:null;
        if(!message||!canEditUserMessage(userIndex)){toast('当前请求暂时不能重试，请重新选择目标节点后再试');return;}
        // 复用原请求、任务范围和已保存的参考图，不新增一条用户消息，
        // 也不要求用户重新选择素材；sendEditedUserMessage 会把失败状态更新为运行中。
        editingUserMessageDraft=String(message.text||'');
        sendEditedUserMessage(userIndex,{retryExisting:true});
    }
    async function rerunAction(index){
        if(busy)return;
        const message=answerAt(index),targetId=String(message?.targetNodeId||''),target=nodes.find(node=>node.id===targetId),prompt=actionPromptForMessage(message,index);
        if(!target){toast('关联节点已不存在');return;}
        if(!prompt){toast('找不到可重新生成的提示词');return;}
        const scope=message?.taskScope||resolveCanvasTaskScope({selectedNodeIds:[target.id],targetNodeId:target.id});
        const requestedGeneration=requestedGenerationPreferences(message?.requestText||'');
        const generationError=generationPreferenceError(requestedGeneration,message?.requestText||'');
        if(generationError){renderGenerationPreferences();toast(generationError);return;}
        const runToken=beginAgentRun();
        $('canvasAgentSend').disabled=true;
        message.actionStatus='running';
        message.agentRunStartedAt=Date.now();
        message.actionPrompt=prompt;
        message.actionDetail='';
        saveStore();
        setRunStatus('running','正在重新生成','正在使用当前提示词重跑同一个绘画节点');
        try{
            assertAgentRunActive(runToken);
            const applied=await runDirectCanvasAction(scope,{prompt,title:target.title||'Agent 生成'},requestedGeneration);
            assertAgentRunActive(runToken);
            message.actionStatus=applied.handoff==='queued'?'queued':'done';
            message.targetNodeId=applied.target?.id||target.id;
            message.rerunAt=Date.now();
            message.actionDetail=applied.handoff==='queued'?'已提交到画布，图片完成后会自动更新状态':'';
            setRunStatus('done',applied.handoff==='queued'?'已提交生成':'已重新生成',applied.handoff==='queued'?'画布正在后台完成图片生成':'已使用当前提示词重跑当前绘画节点');
        }catch(error){
            message.actionStatus='error';
            message.actionDetail=isAgentCancelled(error)?'本次重新生成已停止，已经提交的画布任务保持不变':(error.message||'重新生成未完成');
            if(isAgentCancelled(error))message.actionStatus='cancelled';
            setRunStatus(isAgentCancelled(error)?'done':'error',isAgentCancelled(error)?'已停止':'重新生成失败',message.actionDetail);
        }finally{
            finishAgentRun(runToken);
            $('canvasAgentSend').disabled=false;
            saveStore();
            renderMessages();
            renderTaskScope();
        }
    }
    function answerAt(index){return activeConversation().messages[index]||{};}
    function returnToNode(index){
        // 旧对话的 sourceNodeId 仅允许“查看历史节点”，不会再作为后续任务输入。
        const message=answerAt(index),id=message.targetNodeId||message.sourceNodeId||'',node=nodes.find(item=>item.id===id);
        if(!node){toast('关联节点已不存在');return;}
        selectedId=node.id;selectedIds=[];selectedImage={nodeId:'',index:-1};render();updateComposer();renderTaskScope();toast('已返回关联节点');
    }
    function formatConversationDate(value){
        const timestamp=Number(value);
        if(!Number.isFinite(timestamp)||timestamp<=0)return '时间未知';
        try{
            return new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(timestamp));
        }catch(_){return '时间未知';}
    }
    function renderBatchHistoryPanel(){
        const list=historyEl?.querySelector('[data-history-panel="batches"]');
        if(!list)return;
        const batchApi=folderBatch||refreshFolderBatch();
        if(!batchApi?.renderHistory){
            list.innerHTML='<div class="canvas-agent-history-empty"><i data-lucide="folder-kanban"></i><strong>还没有批量任务</strong><span>从输入区的加号菜单选择文件夹后，任务会显示在这里</span></div>';
            return;
        }
        batchApi.renderHistory(list);
        const count=Number(list.dataset.batchCount||0);
        const countEl=historyEl.querySelector('[data-history-count]');
        if(countEl)countEl.textContent=`${count} 个`;
    }
    async function refreshBatchHistoryPanel(){
        const list=historyEl?.querySelector('[data-history-panel="batches"]');
        if(!list)return;
        const batchApi=folderBatch||refreshFolderBatch();
        if(!batchApi?.openHistory){renderBatchHistoryPanel();return;}
        await batchApi.openHistory(list);
        if(historyTab==='batches'&&historyEl?.classList.contains('open')){
            const count=Number(list.dataset.batchCount||0),countEl=historyEl.querySelector('[data-history-count]');
            if(countEl)countEl.textContent=`${count} 个`;
            refreshIcons();
        }
    }
    function renderHistory(){
        const conversations=Array.isArray(store.conversations)?store.conversations:[];
        const active=historyTab==='batches'?'batches':'conversations';
        const conversationList=conversations.length?conversations.map(item=>{
            const title=String(item.title||'未命名对话').trim()||'未命名对话';
            const messageCount=Array.isArray(item.messages)?item.messages.length:0;
            const createdAt=formatConversationDate(item.createdAt);
            return `<div class="canvas-agent-history-item ${item.id===store.activeId?'active':''}">
                <button type="button" data-chat-id="${esc(item.id)}" title="${esc(title)}" aria-current="${item.id===store.activeId?'true':'false'}">
                    <span class="canvas-agent-history-icon"><i data-lucide="message-square"></i></span>
                    <span class="canvas-agent-history-copy"><strong>${esc(title)}</strong><small><span>${messageCount} 条消息</span><i aria-hidden="true">·</i><span>${esc(createdAt)} 创建</span></small></span>
                    <span class="canvas-agent-history-count">${messageCount}</span>
                </button>
                <button type="button" class="canvas-agent-history-delete" data-delete-chat-id="${esc(item.id)}" title="删除对话" aria-label="删除对话"><i data-lucide="trash-2"></i></button>
            </div>`;
        }).join(''):'<div class="canvas-agent-history-empty"><i data-lucide="messages-square"></i><strong>还没有历史对话</strong><span>发送第一条 Agent 消息后会显示在这里</span></div>';
        historyEl.innerHTML=`
            <div class="canvas-agent-history-head">
                <div><strong>${active==='batches'?'批量任务':'历史对话'}</strong><span>${active==='batches'?'当前对话的文件夹批量改图任务':'旧引用仅用于回看，不会带入新任务'}</span></div>
                <b data-history-count>${active==='batches'?'读取中':`${conversations.length} 个`}</b>
            </div>
            <div class="canvas-agent-history-tabs" role="tablist" aria-label="历史分类">
                <button type="button" role="tab" data-history-tab="conversations" aria-selected="${active==='conversations'?'true':'false'}">历史对话</button>
                <button type="button" role="tab" data-history-tab="batches" aria-selected="${active==='batches'?'true':'false'}">批量任务</button>
            </div>
            <div class="canvas-agent-history-list ${active==='conversations'?'':'is-history-hidden'}" data-history-panel="conversations">
                ${conversationList}
            </div>
            <div class="canvas-agent-history-list ${active==='batches'?'':'is-history-hidden'}" data-history-panel="batches">
                <div class="canvas-agent-history-empty"><i data-lucide="loader-circle"></i><strong>正在读取批量任务</strong><span>请稍候…</span></div>
            </div>`;
        historyEl.querySelectorAll('[data-history-tab]').forEach(button=>button.onclick=()=>{
            historyTab=button.dataset.historyTab==='batches'?'batches':'conversations';
            renderHistory();
        });
        historyEl.querySelectorAll('[data-chat-id]').forEach(btn=>btn.onclick=()=>{store.activeId=btn.dataset.chatId;saveStore();renderMessages();historyEl.classList.remove('open');$('canvasAgentHistoryToggle')?.classList.remove('active');$('canvasAgentHistoryToggle')?.setAttribute('aria-expanded','false');historyEl.setAttribute('aria-hidden','true');});
        historyEl.querySelectorAll('[data-delete-chat-id]').forEach(btn=>btn.onclick=event=>{
            event.stopPropagation();
            const id=btn.dataset.deleteChatId,item=store.conversations.find(chat=>chat.id===id);
            if(!item)return;
            store.conversations=store.conversations.filter(chat=>chat.id!==id);
            if(store.activeId===id)store.activeId=store.conversations[0]?.id||'';
            activeConversation();saveStore();renderHistory();renderMessages();toast('对话已删除');
        });
        refreshIcons();
        if(active==='batches')void refreshBatchHistoryPanel();
    }
    function newConversation(){
        if(editingUserMessageIndex>=0)resetUserMessageEditState(true);
        releaseAgentTaskScopeLock();store.activeId='';activeConversation();saveStore();renderMessages();renderTaskScope();toast('已新建对话，已恢复实时任务范围');
    }
    function closeAgentPopovers(except=null){
        if(except!==skillPopover)toggleSkillCategoryManager(false);
        closeGenerationModelMenu();
        closeComposerMenu();
        [settingsEl,generationSettingsEl,skillQuickPopover,skillPopover,historyEl].forEach(item=>{if(item&&item!==except)item.classList.remove('open');});
        [[settingsEl,$('canvasAgentSettingsToggle')],[generationSettingsEl,generationToggle],[skillQuickPopover,skillQuickToggle],[skillPopover,$('canvasAgentSkillsToggle')],[historyEl,$('canvasAgentHistoryToggle')]].forEach(([item,button])=>{if(item!==except)button?.classList.remove('active');});
        if(except!==historyEl){
            $('canvasAgentHistoryToggle')?.setAttribute('aria-expanded','false');
            historyEl?.setAttribute('aria-hidden','true');
        }
        if(except!==skillQuickPopover){
            skillQuickPopover?.setAttribute('aria-hidden','true');
            skillQuickToggle?.setAttribute('aria-expanded','false');
        }
        panel?.classList.toggle('generation-preferences-open',generationSettingsEl?.classList.contains('open'));
        if(except!==generationSettingsEl)generationToggleControls().forEach(button=>{
            button.classList.remove('active');
            button.setAttribute('aria-expanded','false');
        });
    }
    window.closeCanvasAgentPanel=()=>{
        closeAgentPopovers();
        panel?.classList.remove('open');
        $('canvasAgentToggle')?.classList.remove('active');
    };
    function generationToggleControls(){
        return [generationToggle].filter(Boolean);
    }
    function togglePopover(target){
        const opening=!target.classList.contains('open');closeAgentPopovers(target);target.classList.toggle('open',opening);
        const map=new Map([[settingsEl,$('canvasAgentSettingsToggle')],[generationSettingsEl,generationToggle],[skillPopover,$('canvasAgentSkillsToggle')],[historyEl,$('canvasAgentHistoryToggle')]]);
        map.forEach((button,item)=>button?.classList.toggle('active',item===target&&opening));
        if(target===historyEl){
            $('canvasAgentHistoryToggle')?.setAttribute('aria-expanded',opening?'true':'false');
            historyEl?.setAttribute('aria-hidden',opening?'false':'true');
        }
        panel?.classList.toggle('generation-preferences-open',generationSettingsEl?.classList.contains('open'));
        generationToggleControls().forEach(button=>{
            const active=generationSettingsEl?.classList.contains('open');
            button.classList.toggle('active',active);
            button.setAttribute('aria-expanded',active?'true':'false');
        });
        refreshIcons();
    }
    function toggleQuickSkillPopover(){
        if(!skillQuickPopover)return;
        const opening=!skillQuickPopover.classList.contains('open');
        if(opening){
            [settingsEl,generationSettingsEl,skillPopover,historyEl].forEach(item=>item?.classList.remove('open'));
            [$('canvasAgentSettingsToggle'),...generationToggleControls(),$('canvasAgentSkillsToggle'),$('canvasAgentHistoryToggle')].forEach(button=>button?.classList.remove('active'));
            generationToggleControls().forEach(button=>button.setAttribute('aria-expanded','false'));
            renderQuickSkillList();
        }
        skillQuickPopover.classList.toggle('open',opening);
        skillQuickPopover.setAttribute('aria-hidden',opening?'false':'true');
        skillQuickToggle?.classList.toggle('active',opening);
        skillQuickToggle?.setAttribute('aria-expanded',opening?'true':'false');
        panel?.classList.toggle('generation-preferences-open',generationSettingsEl?.classList.contains('open'));
        if(opening)requestAnimationFrame(()=>skillQuickSearchEl?.focus());
        refreshIcons();
    }
    function addSkill(){
        setSkillTab('install');
        if(!skillPopover?.classList.contains('open'))togglePopover(skillPopover);
        requestAnimationFrame(()=>$('canvasAgentSkillName')?.focus());
    }
    async function createSkillFromForm(event){
        event.preventDefault();
        const name=String($('canvasAgentSkillName')?.value||'').trim();
        const description=String($('canvasAgentSkillDescription')?.value||'').trim();
        const instructions=String($('canvasAgentSkillInstructions')?.value||'').trim();
        if(!name||!instructions){toast('请先填写 Skill 名称和指令');return;}
        const submit=$('canvasAgentSkillCreate');
        if(submit)submit.disabled=true;
        try{
            const response=await fetch('/api/agent-skills/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description,instructions})});
            const data=await response.json().catch(()=>({}));
            if(!response.ok)throw new Error(data.detail||'创建失败');
            await loadSkills();
            if(data.skill?.id){skillEl.value=data.skill.id;savePreferences({skillChanged:true});renderSkillList();renderQuickSkillList();}
            event.target.reset();
            setSkillTab('library');
            toast('Skill 已创建并启用');
        }catch(error){toast(`创建 Skill 失败：${error.message||error}`);}
        finally{if(submit)submit.disabled=false;}
    }
    applyFontSize();
    if(!sharedCanvasMode)void loadCanvasAgentRuntimeConfig();
    ensureAgentActionWatcher();
    const agentToggleEl=$('canvasAgentToggle');
    // Agent 入口位于画布 shell 内。阻止按下/点击继续冒泡，避免 shell
    // 把“打开面板”误判成点击空白画布，从而清空当前节点选择。
    agentToggleEl?.addEventListener('pointerdown',event=>event.stopPropagation(),true);
    agentToggleEl?.addEventListener('mousedown',event=>event.stopPropagation(),true);
    agentToggleEl.onclick=(event)=>{
        event.stopPropagation();
        if(sharedCanvasMode)return;
        window.closeSmartCanvasFeaturePanels?.('agent');
        applyFontSize();
        void loadCanvasAgentRuntimeConfig();
        panel.classList.add('open');
        agentToggleEl.classList.add('active');
        syncProviders();loadSkills();loadStore();
        resizeComposerInput();
        ensureAgentActionWatcher();
        reconcileAgentActionStates();
        const savedGeneration=generationPreferences();
        $('canvasAgentAuto').checked=savedGeneration.auto;
        const mode=currentMode();
        document.querySelectorAll('[data-agent-mode]').forEach(button=>button.classList.toggle('active',button.dataset.agentMode===mode));
        if(composer?.classList?.contains('open'))syncGenerationPreferencesFromCanvas(settings);
        else renderGenerationPreferences();
        renderTaskScope();
        refreshIcons();
    };
    // loadConfig() runs asynchronously in smart-canvas.js. If the panel is
    // opened before that request completes, refresh it as soon as providers
    // arrive instead of leaving both selects permanently empty.
    window.addEventListener('smart-canvas-config-ready',()=>{syncProviders();renderGenerationPreferences();renderTaskScope();});
    window.addEventListener('smart-canvas-generation-settings-change',event=>syncGenerationPreferencesFromCanvas(event.detail?.settings));
    window.addEventListener('smart-canvas-task-scope-change',()=>{
        if(!panel?.classList.contains('open'))return;
        if(reconcileAgentTaskScopeLock())return;
        renderTaskScope();
    });
    $('canvasAgentClose').onclick=()=>window.closeCanvasAgentPanel?.();
    composerMenuToggleEl?.addEventListener('click',event=>{
        event.preventDefault();
        event.stopPropagation();
        toggleComposerMenu();
    });
    composerMenuEl?.addEventListener('click',event=>{
        const button=event.target.closest('[data-composer-menu-action]');
        if(!button||button.disabled)return;
        event.preventDefault();
        event.stopPropagation();
        const action=button.dataset.composerMenuAction;
        closeComposerMenu();
        if(action==='images')composerFileInputEl?.click();
        if(action==='folder'){
            const batchApi=folderBatch||refreshFolderBatch();
            if(batchApi?.startImport)void batchApi.startImport();
            else toast('当前画布暂不支持文件夹批量改图');
        }
    });
    composerFileInputEl?.addEventListener('change',event=>{closeComposerMenu();uploadComposerFiles(event.target.files);});
    document.addEventListener('click',event=>{
        if(composerMenuEl?.hidden)return;
        if(event.target===composerMenuToggleEl||composerMenuEl.contains(event.target))return;
        closeComposerMenu();
    });
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!composerMenuEl?.hidden)closeComposerMenu();});
    composerStopEl?.addEventListener('click',event=>{
        event.preventDefault();
        event.stopPropagation();
        stopAgentRun();
    });
    $('canvasAgentSettingsToggle').onclick=()=>togglePopover(settingsEl);
    generationToggle.onclick=()=>{closeGenerationModelMenu();renderGenerationPreferences();togglePopover(generationSettingsEl);};
    $('canvasAgentSkillsToggle').onclick=()=>{renderSkillList();togglePopover(skillPopover);};
    $('canvasAgentHistoryToggle').onclick=()=>{historyTab='conversations';renderHistory();togglePopover(historyEl);};
    $('canvasAgentNew').onclick=newConversation;
    $('canvasAgentSkillAdd').onclick=addSkill;
    $('canvasAgentSkillCategoryManage')?.addEventListener('click',()=>toggleSkillCategoryManager());
    $('canvasAgentSkillCategoryClose')?.addEventListener('click',()=>toggleSkillCategoryManager(false));
    skillCategoryFormEl?.addEventListener('submit',createSkillCategory);
    skillQuickToggle?.addEventListener('click',toggleQuickSkillPopover);
    skillQuickSearchEl?.addEventListener('input',renderQuickSkillList);
    skillSearchEl?.addEventListener('input',renderSkillList);
    skillCategoryEl?.addEventListener('change',renderSkillList);
    skillStatusEl?.addEventListener('change',renderSkillList);
    document.querySelectorAll('[data-canvas-skill-tab]').forEach(button=>button.onclick=()=>{
        setSkillTab(button.dataset.canvasSkillTab||'library');
        if(button.dataset.canvasSkillTab==='library')renderSkillList();
    });
    $('canvasAgentSkillClear')?.addEventListener('click',()=>{
        if(!skillEl.value)return;
        skillEl.value='';savePreferences({skillChanged:true});renderSkillList();renderQuickSkillList();toast('已切换为通用助手');
    });
    $('canvasAgentSkillBrowse')?.addEventListener('click',()=>skillPackageDirectoryEl?.click());
    skillPackageDirectoryEl?.addEventListener('change',handleSkillPackageDirectory);
    skillPackageSourceEl?.addEventListener('input',event=>{
        skillPackageUploadFiles=[];
        skillPackageSourceDir='';
        skillPackageScan=null;
        renderSkillPackagePreview(null);
        setSkillPackageImportButton(false);
        if(skillPackageDirectoryEl)skillPackageDirectoryEl.value='';
        if(skillPackageSelectionHintEl)skillPackageSelectionHintEl.textContent='';
    });
    skillPackageSourceEl?.addEventListener('keydown',event=>{
        if(event.key==='Enter'){
            event.preventDefault();
            void inspectSkillPackage();
        }
    });
    $('canvasAgentSkillImport')?.addEventListener('click',()=>importSkillPackage(false));
    $('canvasAgentSkillCreateForm')?.addEventListener('submit',createSkillFromForm);
    skillSearchEl?.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&skillSearchEl.value){
            skillSearchEl.value='';
            renderSkillList();
            event.stopPropagation();
        }
    });
    skillQuickSearchEl?.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&skillQuickSearchEl.value){
            skillQuickSearchEl.value='';
            renderQuickSkillList();
            event.stopPropagation();
        }else if(event.key==='Escape'){
            toggleQuickSkillPopover();
            event.stopPropagation();
        }
    });
    window.addEventListener('storage',event=>{
        if(event.key===fontSizePrefKey){
            applyFontSize();
            return;
        }
        if(event.key!==skillSelectionKey)return;
        const next=canonicalSkillId(event.newValue);
        if(next&&skills.some(skill=>skill.id===next&&skill.enabled!==false))skillEl.value=next;
        else if(!next)skillEl.value='';
        renderSkillList();
        renderQuickSkillList();
    });
    if(sharedSkillApi?.subscribe)sharedSkillApi.subscribe(next=>{
        next=canonicalSkillId(next);
        if(next&&skills.some(skill=>skill.id===next&&skill.enabled!==false))skillEl.value=next;
        else if(!next)skillEl.value='';
        renderSkillList();
        renderQuickSkillList();
    });
    document.querySelectorAll('[data-agent-popover-close]').forEach(button=>button.onclick=()=>{
        const popover=button.closest('.canvas-agent-popover');
        closeAgentPopovers();
        popover?.classList.remove('open');
    });
    document.querySelectorAll('[data-agent-mode]').forEach(button=>button.onclick=()=>{
        document.querySelectorAll('[data-agent-mode]').forEach(item=>item.classList.toggle('active',item===button));
        const mode=button.dataset.agentMode||'agent';
        localStorage.setItem('xiaomei_canvas_agent_mode',mode);
        saveGenerationPreferences({mode});
        loadSkills();
        renderGenerationPreferences();
        toast(`已切换为${button.textContent.trim()}模式`);
    });
    document.querySelectorAll('[data-agent-media]').forEach(button=>button.onclick=()=>{
        const media=button.dataset.agentMedia==='video'?'video':'image';
        setManualGenerationPreference({media});
        toast(media==='video'?'已切换视频任务':'已切换图片任务');
    });
    const updateCustomRatioPreference=()=>{
        const custom=normalizeGenerationCustomRatio({
            customRatioWidth:customRatioWidthEl?.value,
            customRatioHeight:customRatioHeightEl?.value
        });
        setManualGenerationPreference({
            media:'image',
            ratio:'custom',
            customRatio:custom.customRatio,
            customRatioWidth:custom.customRatioWidth,
            customRatioHeight:custom.customRatioHeight
        },{render:false});
        renderCustomRatioHint(custom);
    };
    [customRatioWidthEl,customRatioHeightEl].forEach(field=>{
        field?.addEventListener('input',updateCustomRatioPreference);
        field?.addEventListener('change',renderGenerationPreferences);
    });
    $('canvasAgentAuto').onchange=()=>{
        const auto=$('canvasAgentAuto').checked;
        const current=auto?{}:effectiveGenerationPreferences();
        localStorage.setItem('xiaomei_canvas_agent_auto',auto?'1':'0');
        saveGenerationPreferences({...current,auto});
        renderGenerationPreferences();
        toast(auto?'已开启自动跟随节点':'已固定当前模型参数');
    };
    generationModelTrigger?.addEventListener('click',event=>{
        event.preventDefault();
        event.stopPropagation();
        toggleGenerationModelMenu();
    });
    generationModelMenu?.addEventListener('click',event=>{
        const providerButton=event.target.closest?.('[data-agent-generation-provider]');
        if(providerButton){
            const provider=String(providerButton.dataset.agentGenerationProvider||'');
            const first=generationModelEntries(effectiveGenerationPreferences().media).find(item=>item.provider===provider);
            if(first&&generationModelEl){
                generationModelEl.value=generationModelToken(first.provider,first.model);
                generationModelEl.dispatchEvent(new Event('change',{bubbles:true}));
            }
            return;
        }
        const option=event.target.closest?.('[data-agent-generation-model]');
        if(!option)return;
        const value=String(option.dataset.agentGenerationModel||'');
        if(!value||!generationModelEl)return;
        generationModelEl.value=value;
        generationModelEl.dispatchEvent(new Event('change',{bubbles:true}));
        closeGenerationModelMenu();
    });
    document.addEventListener('pointerdown',event=>{
        if(!generationModelControl?.contains(event.target))closeGenerationModelMenu();
    });
    planModeEl?.addEventListener('change',()=>{
        const enabled=Boolean(planModeEl.checked);
        saveGenerationPreferences({planMode:enabled});
        renderGenerationPreferences();
        toast(enabled?'已开启计划模式：发送后先生成方案':'已关闭计划模式：恢复直接回答');
    });
    harnessModeEl?.addEventListener('change',()=>{
        const enabled=Boolean(harnessModeEl.checked);
        saveGenerationPreferences({harnessMode:enabled});
        renderGenerationPreferences();
        toast(enabled?'已开启 Codex Harness：复杂任务会自动编排':'已关闭 Codex Harness：恢复现有 Agent 链路');
    });
    generationModelEl?.addEventListener('change',()=>{
        const selected=parseGenerationModelToken(generationModelEl.value);
        const media=effectiveGenerationPreferences().media;
        setManualGenerationPreference(media==='video'
            ?{videoProvider:selected.provider,videoModel:selected.model}
            :{imageProvider:selected.provider,imageModel:selected.model});
    });
    fontSizeEl?.addEventListener('input',()=>saveFontSize(fontSizeEl.value));
    providerEl.onchange=syncModels;modelEl.onchange=savePreferences;skillEl.onchange=()=>{savePreferences({skillChanged:true});renderSkillList();};
    scopeLockEl?.addEventListener('click',toggleAgentTaskScopeLock);
    $('canvasAgentSend').onclick=send;
    input?.addEventListener('input',resizeComposerInput);
    input.onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();send();}};
    syncComposerRunUi();
    syncComposerFileUi();
})();
