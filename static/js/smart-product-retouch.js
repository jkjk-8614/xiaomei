/* Product retouch is a persistent processing node on the canvas. */
const productRetouchSessions = new Map();
const productRetouchRecoveries = new Set();
const PRODUCT_RETOUCH_DEFAULT_WIDTH = 520;
const PRODUCT_RETOUCH_DEFAULT_RESOLUTION = '4k';
let productRetouchOptionsRequest = null;

function productRetouchOptions(){
    if(!productRetouchOptionsRequest)productRetouchOptionsRequest=XiaomeiImageTaskClient.requestJson('/api/product-retouch/options').catch(error=>{productRetouchOptionsRequest=null;throw error;});
    return productRetouchOptionsRequest;
}
function productRetouchStateCurrent(state){return canvasId===state.canvasId && productRetouchSessions.get(state.nodeId)===state && state.panel?.isConnected;}
function productRetouchItems(node,index=0,batch=false){
    return (batch?nodes.filter(n=>isNodeSelected(n.id)):[node]).flatMap(n=>(n.images||[]).map((image,i)=>({...image,nodeId:n.id,imageIndex:i})))
        .filter(image=>image.url&&mediaKindForItem(image)==='image'&&(batch||node.images.length>1||image.imageIndex===index));
}
function productRetouchInputItems(node){
    const connected=workflowInputNodesFor(node).flatMap(n=>outputImagesForNode(n).map(image=>({...image,nodeId:n.id})));
    const seen=new Set(),excluded=new Set(node.retouchExcludedInputs||[]);
    return [...connected,...(node.retouchLocalInputs||[]).map(image=>({...image,nodeId:node.id}))]
        .filter(image=>image.url&&mediaKindForItem(image)==='image'&&!excluded.has(image.url)&&!seen.has(image.url)&&seen.add(image.url))
        .map(image=>({...image,region:node.retouchRegions?.[image.url]}));
}
function createProductRetouchNodeAt(point,sourceItems=[]){
    if(!collabCanMutateCanvas()||sharedCanvasMode)return null;
    const node=createNode(point.x-PRODUCT_RETOUCH_DEFAULT_WIDTH/2,point.y-260,[],{nodeType:'smart-product-retouch',title:'产品精修',skipRender:true});
    if(!node)return null;
    node.w=PRODUCT_RETOUCH_DEFAULT_WIDTH;node.h=520;
    node.retouchConfig={category:'general',background:'original',protect_structure:true,protect_logo:true};
    node.retouchSelection={modelKey:'',resolution:PRODUCT_RETOUCH_DEFAULT_RESOLUTION};
    node.retouchOutputIds=[];
    for(const id of new Set(sourceItems.map(item=>item.nodeId)))if(id!==node.id)connectInputNode(id,node.id);
    selectedId=node.id;selectedIds=[];selectedImage={nodeId:'',index:-1};render();scheduleSave();return node;
}
function openProductRetouch(nodeId,index=0,batch=false){
    const source=nodes.find(n=>n.id===nodeId);
    if(!source||sharedCanvasMode||sharedCanvasReadOnly||!collabCanEditNode(nodeId))return;
    closeSmartNodeSettingsPanel();
    const owner=source.retouchOwnerId&&nodes.find(n=>n.id===source.retouchOwnerId&&isProductRetouchNode(n));
    if(owner||isProductRetouchNode(source)){selectedId=(owner||source).id;selectedIds=[];render();return owner||source;}
    const items=productRetouchItems(source,index,batch),rect=nodeRect(source);
    return createProductRetouchNodeAt({x:source.x+rect.width+60+PRODUCT_RETOUCH_DEFAULT_WIDTH/2,y:source.y+260},items);
}
function productRetouchWarning(records){
    const warnings=records.map(r=>r.validation).filter(v=>v?.status==='warning');
    const ratio=warnings.find(v=>v.aspect_ratio_changed||v.reason?.startsWith('输出画幅比例发生变化'));
    if(ratio)return {label:'画幅比例变化',message:ratio.reason||'画幅比例变化，请对照检查'};
    if(warnings.length)return {label:'主体轮廓或位置变化',message:warnings[0].reason||'主体轮廓或位置变化，请对照检查'};
    return null;
}
function acceptProductRetouchResult(node,records){
    node.productRetouchResults=cloneSmartSettings(records);
    toast(productRetouchWarning(records)?.message||'产品精修完成，请对照检查文字、Logo 和关键结构');
}
function productRetouchReviewHtml(node){
    if(!node.productRetouchResults?.length||isProductRetouchNode(node))return '';
    const warning=productRetouchWarning(node.productRetouchResults);
    return `<button type="button" class="product-retouch-review ${warning?'has-difference':''}" data-smart-node-action="product-retouch" data-node-id="${escapeAttr(node.id)}" title="${escapeAttr(warning?.message||'查看产品精修节点')}">${warning?.label||'产品精修'}</button>`;
}
function productRetouchMessage(state,message,error=false){
    if(!productRetouchStateCurrent(state))return;
    const el=state.panel.querySelector('[data-pr-message]');
    if(el.textContent!==message)el.textContent=message;
    el.classList.toggle('is-error',error);
}
function productRetouchPendingOutputs(state){
    return nodes.filter(node=>node.retouchOwnerId===state.nodeId
        && (node.productRetouchSubmission||smartPendingTasks(node).length||node.pending||node.running));
}
function productRetouchBusy(state){
    return state.submitting||productRetouchPendingOutputs(state).length>0;
}
function persistProductRetouchInputs(state){
    const live=nodes.find(n=>n.id===state.nodeId);if(!live||canvasId!==state.canvasId)return;
    live.retouchConfig=state.config;
    live.retouchSelection={modelKey:state.models[Number(state.modelKey)]?`${state.models[Number(state.modelKey)].provider_id}:${state.models[Number(state.modelKey)].model}`:state.modelKey,resolution:state.resolution};
    live.retouchActiveIndex=state.active;
    const urls=new Set(state.items.map(i=>i.url));
    live.retouchLocalInputs=state.items.filter(i=>i.replacement||i.nodeId===live.id).map(({nodeId,imageIndex,region,replacement,...image})=>image);
    live.retouchExcludedInputs=workflowInputNodesFor(live).flatMap(n=>outputImagesForNode(n)).filter(i=>i.url&&!urls.has(i.url)).map(i=>i.url);
    scheduleSave();
}
function productRetouchPlanMessage(state,message,error=false){
    if(!productRetouchStateCurrent(state))return;
    const el=state.panel.querySelector('[data-pr-plan-message]');el.textContent=message;el.classList.toggle('is-error',error);
}
function productRetouchPlanKey(state){
    if(!state.config.plan)return state.config.category||'general';
    const signature=plan=>JSON.stringify(['name','subject','improve','preserve','skill_id','skill_version'].map(key=>plan?.[key]||''));
    const match=(state.plans||[]).find(p=>signature(p.plan)===signature(state.config.plan));
    return match?.key||'snapshot';
}
function productRetouchSyncPlans(state){
    const select=state.panel.querySelector('[data-pr-plan]'),plans=state.plans||[];
    const key=productRetouchPlanKey(state);
    const groups=[['内置方案',plans.filter(p=>!p.key.startsWith('skill:'))],['我的方案',plans.filter(p=>p.key.startsWith('skill:'))]];
    select.innerHTML=groups.filter(([,list])=>list.length).map(([label,list])=>`<optgroup label="${label}">${list.map(p=>`<option value="${escapeAttr(p.key)}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>`).join('');
    if(key==='snapshot')select.insertAdjacentHTML('afterbegin',`<option value="snapshot">${escapeHtml(state.config.plan.name)}</option>`);
    if(key==='clothing_bags'&&!plans.some(plan=>plan.key===key)){
        select.insertAdjacentHTML('afterbegin','<option value="clothing_bags">服饰箱包 · 保留纹理</option>');
    }
    if(!select.options.length)select.innerHTML=`<option value="${escapeAttr(key)}">${escapeHtml(state.config.plan?.name||'通用 · 自然提质')}</option>`;
    select.value=key;
    select.title=state.config.plan?.name||select.selectedOptions[0]?.textContent||'';
}
async function initializeProductRetouchPlans(state){
    const panel=state.panel;state.plansLoading=true;productRetouchRefresh(state);
    try{
        const result=await XiaomeiImageTaskClient.requestJson('/api/product-retouch/plans',{requestInit:{cache:'no-store'}});
        if(!productRetouchStateCurrent(state)||state.panel!==panel)return;
        state.plans=result.plans||[];state.plansError=false;if(!state.planEditorOpen)productRetouchPlanMessage(state,'');productRetouchSyncPlans(state);
    }catch(error){if(productRetouchStateCurrent(state)&&state.panel===panel){state.plansError=true;productRetouchPlanMessage(state,`方案读取失败：${error.message}`,true);}}
    finally{if(productRetouchStateCurrent(state)&&state.panel===panel){state.plansLoading=false;productRetouchRefresh(state);}}
}
function productRetouchDraft(state){
    return Object.fromEntries(['name','subject','improve','preserve'].map(key=>[key,state.panel.querySelector(`[data-pr-plan-${key}]`).value.trim()]));
}
function openProductRetouchPlanEditor(state){
    if(state.submitting||state.planSaving||sharedCanvasReadOnly||!collabCanEditNode(state.nodeId))return;
    const selected=(state.plans||[]).find(p=>p.key===productRetouchPlanKey(state));
    const draft=state.node.retouchPlanDraft||state.config.plan||selected?.plan||{};
    for(const key of ['name','subject','improve','preserve'])state.panel.querySelector(`[data-pr-plan-${key}]`).value=draft[key]||'';
    state.planEditorOpen=true;state.panel.querySelector('[data-pr-plan-editor]').hidden=false;productRetouchPlanMessage(state,'');productRetouchRefresh(state);
    state.panel.querySelector('.pr-plan-fields').scrollTop=0;
    state.panel.querySelector('[data-pr-plan-name]').focus({preventScroll:true});
}
function applyProductRetouchPlan(state,plan){
    state.config.plan=cloneSmartSettings({skill_id:'',skill_version:'',...plan});state.config.category='general';
    state.planEditorOpen=false;delete state.node.retouchPlanDraft;
    state.panel.querySelector('[data-pr-plan-editor]').hidden=true;
    productRetouchSyncPlans(state);productRetouchSyncOptions(state);persistProductRetouchInputs(state);productRetouchRefresh(state);
}
async function saveProductRetouchPlan(state,shared=false){
    if(!productRetouchStateCurrent(state)||state.submitting||state.planSaving||sharedCanvasReadOnly||!collabCanEditNode(state.nodeId))return;
    const draft=productRetouchDraft(state);
    if(!draft.name||!draft.improve){productRetouchPlanMessage(state,'请填写方案名称和改善要求',true);return;}
    if(!shared){
        applyProductRetouchPlan(state,draft);productRetouchPlanMessage(state,'');
        state.panel.querySelector('[data-pr-plan-edit]').focus({preventScroll:true});
        return;
    }
    state.planSaving=true;productRetouchPlanMessage(state,'正在保存…');productRetouchRefresh(state);
    try{
        const result=await XiaomeiImageTaskClient.requestJson('/api/product-retouch/plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:draft})});
        if(!productRetouchStateCurrent(state))return;
        if(!result.plan?.plan?.skill_id)throw new Error('方案保存结果不完整，请重试');
        state.plans=[...(state.plans||[]).filter(p=>p.key!==result.plan.key),result.plan];
        applyProductRetouchPlan(state,result.plan.plan);productRetouchPlanMessage(state,'');
        window.dispatchEvent(new CustomEvent('product-retouch-plans-changed',{detail:{nodeId:state.nodeId}}));
        window.parent?.postMessage({type:'skills-changed',updated_at:Date.now()},location.origin);
        toast('方案已保存到 Skill 库');
    }catch(error){productRetouchPlanMessage(state,`保存失败：${error.message}`,true);}
    finally{
        state.planSaving=false;productRetouchRefresh(state);
        if(productRetouchStateCurrent(state)&&!state.planEditorOpen)state.panel.querySelector('[data-pr-plan-edit]').focus({preventScroll:true});
    }
}
function productRetouchNodeBodyHtml(node){return `<div class="product-retouch-panel" data-pr-node-root data-pr-state="${escapeAttr(JSON.stringify({inputs:productRetouchInputItems(node).map(i=>i.url),config:node.retouchConfig,selection:node.retouchSelection}))}">
        <div class="pr-scroll">
        <div class="pr-source">
            <div class="pr-source-head"><span>商品原图 <small data-pr-count hidden></small></span><div class="pr-preview-actions" data-pr-preview-actions><button type="button" data-pr-replace>替换</button><button type="button" data-pr-remove>移除</button></div></div>
            <div class="pr-preview"><img data-pr-source alt="待精修的商品原图" hidden><div class="pr-empty" data-pr-empty hidden><button type="button" data-pr-add>添加图片</button><p class="pr-note">也可连接画布上的图片节点</p></div></div>
            <input type="file" accept="image/*" multiple data-pr-files hidden><div class="pr-inputs" data-pr-inputs></div>
        </div>
        <div class="pr-settings"><div class="pr-setting-row"><label for="pr-plan-${escapeAttr(node.id)}">精修方案</label><div class="pr-plan-choice"><select id="pr-plan-${escapeAttr(node.id)}" data-pr-plan aria-label="精修方案"><option value="general">通用 · 自然提质</option></select><button type="button" class="pr-text-button" data-pr-plan-edit>自定义</button></div></div>
        <div class="pr-plan-editor" data-pr-plan-editor hidden>
            <div class="pr-plan-fields">
                <label class="pr-field">方案名称<input data-pr-plan-name maxlength="120" aria-label="方案名称"></label>
                <label class="pr-field">产品与材质<input data-pr-plan-subject maxlength="500" aria-label="产品与材质"></label>
                <label class="pr-field">想改善什么<textarea data-pr-plan-improve maxlength="3000" rows="4" aria-label="想改善什么"></textarea></label>
                <label class="pr-field">必须保留什么<textarea data-pr-plan-preserve maxlength="3000" rows="3" aria-label="必须保留什么"></textarea></label>
            </div>
        </div><p class="pr-note pr-plan-message" data-pr-plan-message role="status" aria-live="polite"></p><button type="button" class="pr-text-button" data-pr-plan-reload hidden>重新读取方案</button>
        <div class="pr-plan-actions"><button type="button" data-pr-plan-close>取消</button><button type="button" data-pr-plan-apply>修改方案</button><button type="button" data-pr-plan-save>保存方案</button></div>
        <div class="pr-setting-row"><span>背景</span><div class="pr-backgrounds" data-pr-backgrounds role="group" aria-label="背景处理"><button type="button" data-value="original">保留背景</button><button type="button" data-value="white">白底</button></div></div></div>
        </div><footer><div class="pr-generation">
        <label class="pr-field">API 平台<select data-pr-provider aria-label="精修 API 平台"><option value="">正在读取平台…</option></select></label>
        <label class="pr-field">图像编辑模型<select data-pr-model aria-label="图像编辑模型"><option value="">正在读取已配置模型…</option></select></label>
        <label class="pr-field">输出清晰度<select data-pr-resolution></select></label>
        </div><p data-pr-message role="status" aria-live="polite">正在读取兼容模型…</p><button type="button" class="pr-text-button" data-pr-model-retry hidden>重新读取模型</button>
        <div class="pr-run-bar"><button type="button" data-pr-recover hidden>续查任务</button><button type="button" class="pr-start" data-pr-start disabled>开始精修</button></div></footer></div>`;}
function bindProductRetouchNode(el,node){
    const panel=el.querySelector('[data-pr-node-root]');if(!panel)return;
    if(panel.dataset.bound){
        const current=productRetouchSessions.get(node.id);
        if(current){current.node=node;current.config=node.retouchConfig;current.outputs=node.retouchOutputIds||[];
            if(!current.submitting){current.items=productRetouchInputItems(node);current.active=Math.max(0,Math.min(current.active,current.items.length-1));productRetouchSyncInputs(current);}}
        return;
    }
    panel.dataset.bound='1';
    let state=productRetouchSessions.get(node.id);
    if(!state||state.canvasId!==canvasId){
        node.retouchConfig||={category:'general',background:'original',protect_structure:true,protect_logo:true};
        const selection=node.retouchSelection||{};
        state={node,nodeId:node.id,canvasId,config:node.retouchConfig,modelKey:selection.modelKey||'',resolution:selection.resolution||PRODUCT_RETOUCH_DEFAULT_RESOLUTION,models:[],items:[],outputs:node.retouchOutputIds||[],active:Number(node.retouchActiveIndex)||0,submitting:false,stop:false};
        productRetouchSessions.set(node.id,state);
    }
    state.node=node;state.panel=panel;state.config=node.retouchConfig;
    if(!state.submitting)state.items=productRetouchInputItems(node);
    state.outputs=node.retouchOutputIds||[];state.active=Math.max(0,Math.min(state.active,state.items.length-1));
    const scroll=panel.querySelector('.pr-scroll');scroll.scrollTop=state.scrollTop||0;scroll.onscroll=()=>{state.scrollTop=scroll.scrollTop;};
    panel.querySelector('[data-pr-plan-editor]').hidden=!state.planEditorOpen;
    if(state.planEditorOpen){for(const key of ['name','subject','improve','preserve'])panel.querySelector(`[data-pr-plan-${key}]`).value=node.retouchPlanDraft?.[key]||'';}
    panel.querySelector('[data-pr-plan-edit]').onclick=()=>openProductRetouchPlanEditor(state);
    panel.querySelector('[data-pr-plan-close]').onclick=()=>{
        state.planEditorOpen=false;delete state.node.retouchPlanDraft;scheduleSave();
        panel.querySelector('[data-pr-plan-editor]').hidden=true;
        productRetouchPlanMessage(state,'');productRetouchRefresh(state);
        panel.querySelector('[data-pr-plan-edit]').focus({preventScroll:true});
    };
    panel.querySelector('[data-pr-plan-apply]').onclick=()=>void saveProductRetouchPlan(state);
    panel.querySelector('[data-pr-plan-save]').onclick=()=>void saveProductRetouchPlan(state,true);
    panel.querySelector('[data-pr-plan-reload]').onclick=()=>void initializeProductRetouchPlans(state);
    panel.querySelector('[data-pr-plan]').onchange=e=>{
        if(state.submitting)return;
        const plan=(state.plans||[]).find(p=>p.key===e.target.value);if(!plan)return;
        state.config.category=plan.category;state.config.plan=cloneSmartSettings(plan.plan);productRetouchSyncPlans(state);
    };
    panel.querySelector('[data-pr-plan-editor]').addEventListener('input',()=>{node.retouchPlanDraft=productRetouchDraft(state);scheduleSave();});
    ['pointerdown','mousedown','dblclick','click','wheel','keydown','keyup'].forEach(type => panel.addEventListener(type,e=>e.stopPropagation()));
    panel.querySelector('[data-pr-backgrounds]').onclick = e => {
        const button = e.target.closest('[data-value]');
        if(button && !state.submitting){state.config.background=button.dataset.value;productRetouchSyncOptions(state);persistProductRetouchInputs(state);}
    };
    panel.querySelector('[data-pr-provider]').onchange=e=>{
        const index=state.models.findIndex(m=>m.provider_id===e.target.value);
        state.modelKey=index<0?'':String(index);productRetouchSyncModels(state);productRetouchSyncResolutions(state);productRetouchRefresh(state);
    };
    panel.querySelector('[data-pr-model]').onchange=e=>{state.modelKey=e.target.value;productRetouchSyncResolutions(state);productRetouchRefresh(state);};
    panel.querySelector('[data-pr-resolution]').onchange=e=>state.resolution=e.target.value;
    panel.querySelector('[data-pr-model-retry]').onclick=()=>{productRetouchOptionsRequest=null;void initializeProductRetouchNodeModels(state);};
    panel.querySelector('[data-pr-start]').onclick=()=>void runProductRetouchNode(node);
    panel.querySelector('[data-pr-recover]').onclick=()=>void recoverProductRetouchSubmissions(false,productRetouchPendingOutputs(state).map(output=>output.id));
    panel.querySelectorAll('[data-pr-add],[data-pr-replace]').forEach(button=>{
        button.onclick=()=>panel.querySelector('[data-pr-files]').click();
    });
    panel.querySelector('[data-pr-remove]').onclick=()=>{if(state.submitting)return;state.items.splice(state.active,1);persistProductRetouchInputs(state);state.active=Math.max(0,Math.min(state.active,state.items.length-1));productRetouchSyncInputs(state);};
    panel.querySelector('[data-pr-files]').onchange=async e=>{
        const files=Array.from(e.target.files||[]);e.target.value='';
        if(!files.length||state.submitting)return;
        state.uploading=true;productRetouchRefresh(state);productRetouchMessage(state,'正在导入图片…');
        try{
            const uploaded=[];
            for(const file of files){
                if(!file.type.startsWith('image/'))throw new Error('请选择图片文件');
                const result=await uploadCroppedBlob(file,file.name);
                if(!result?.url)throw new Error('图片导入失败，请重试');
                uploaded.push({...result,nodeId:state.nodeId,kind:'image',replacement:true});
            }
            if(!productRetouchStateCurrent(state))return;
            state.items.splice(state.active,state.items.length?1:0,...uploaded);persistProductRetouchInputs(state);productRetouchSyncInputs(state);
            productRetouchMessage(state,'图片已导入，原图节点保留');
        }catch(error){productRetouchMessage(state,error.message,true);}
        finally{state.uploading=false;productRetouchRefresh(state);}
    };
    panel.addEventListener('change',()=>persistProductRetouchInputs(state));
    productRetouchSyncInputs(state);
    productRetouchSyncPlans(state);
    void initializeProductRetouchPlans(state);
    void initializeProductRetouchNodeModels(state);
}
async function initializeProductRetouchNodeModels(state){
    const panel=state.panel;
    state.modelsLoading=true;state.modelsError=false;productRetouchRefresh(state);
    try{
        const response=await productRetouchOptions();
        if(!productRetouchStateCurrent(state)||state.panel!==panel)return;
        state.models=response.models||[];
        const selectedKey=state.node.retouchSelection?.modelKey||state.modelKey;
        const preferred=state.models.findIndex(m=>`${m.provider_id}:${m.model}`===selectedKey || (!selectedKey&&m.provider_id===settings.provider_id&&m.model===settings.model));
        state.modelKey=state.models.length?String(Math.max(0,preferred)):selectedKey;
        const providers=[...new Map(state.models.map(m=>[m.provider_id,m.provider_name||m.provider_id])).entries()];
        panel.querySelector('[data-pr-provider]').innerHTML=providers.map(([id,name])=>`<option value="${escapeAttr(id)}">${escapeHtml(name)}</option>`).join('')||'<option value="">暂无可用平台</option>';
        productRetouchSyncModels(state);
        productRetouchSyncOptions(state);productRetouchSyncResolutions(state);
        if(state.models.length&&!state.submitting)persistProductRetouchInputs(state);
        productRetouchMessage(state,state.models.length?'':'请先在 API 设置中配置支持参考图编辑的图片模型',!state.models.length);
    }catch(error){if(productRetouchStateCurrent(state)&&state.panel===panel){state.modelsError=true;productRetouchMessage(state,`无法读取模型：${error.message}，请重新读取`,true);}}
    finally{if(productRetouchStateCurrent(state)&&state.panel===panel){state.modelsLoading=false;productRetouchRefresh(state);}}
}
function productRetouchSyncModels(state){
    const model=state.models[Number(state.modelKey)],d=state.panel;
    const provider=d.querySelector('[data-pr-provider]');
    provider.value=model?.provider_id||'';
    provider.title=model?.provider_name||model?.provider_id||'';
    const select=d.querySelector('[data-pr-model]');
    const options=state.models.map((m,i)=>m.provider_id===model?.provider_id?`<option value="${i}">${escapeHtml(m.model)}</option>`:'').join('');
    select.innerHTML='<button type="button"><selectedcontent></selectedcontent></button>'+(options||'<option value="">暂无兼容模型</option>');
    select.value=state.modelKey;select.title=model?.model||'';
}
function syncProductRetouchNodeResults(node){
    if(!node||!isProductRetouchNode(node))return;
    const images=(node.retouchOutputIds||[]).flatMap(id=>nodes.find(n=>n.id===id)?.images||[]).filter(i=>i.product_retouch);
    if(images.length && JSON.stringify(images.map(i=>i.url))!==JSON.stringify((node.images||[]).map(i=>i.url))){node.images=images.map(i=>({...i}));scheduleSave();}
    const outputs=(node.retouchOutputIds||[]).map(id=>nodes.find(n=>n.id===id)).filter(Boolean);
    if(images.length&&outputs.length&&outputs.every(n=>!n.productRetouchSubmission&&!smartPendingTasks(n).length&&!n.pending&&!n.running)&&node.retouchRunSignature===smartDependencySignature(node))node.dependencyRunSignature=node.retouchRunSignature;
}
async function runProductRetouchNodeDirect(node,signal=null,submitOnly=false){
    const state=productRetouchSessions.get(node.id);
    if(!state||!productRetouchStateCurrent(state))return {ok:false,error:'产品精修节点尚未就绪，请重新打开画布'};
    if(!submitOnly&&state.runPromise)return state.runPromise;
    let outputIds=state.outputs;
    const onAbort=()=>void cancelProductRetouch(state,outputIds);signal?.addEventListener('abort',onAbort,{once:true});
    const run=(async()=>{
        const latestPending=productRetouchPendingOutputs(state).filter(output=>outputIds.includes(output.id));
        if(!submitOnly&&latestPending.length){
            await recoverProductRetouchSubmissions(false,latestPending.map(output=>output.id));
            await Promise.allSettled(outputIds.map(id=>nodes.find(n=>n.id===id)).filter(n=>n&&smartPendingTasks(n).length).map(n=>resumeSmartPendingNode(n)));
        }else{
            delete node.runError;
            state.items=productRetouchInputItems(node);
            if(!state.items.length)return {ok:false,error:'请先连接或添加商品图片'};
            persistProductRetouchInputs(state);
            const submitting=submitProductRetouch(state);
            outputIds=state.outputs;
            const jobs=await submitting;
            if(submitOnly&&(jobs.length||outputIds.some(id=>nodes.find(n=>n.id===id)?.productRetouchSubmission)))return {ok:true};
            await Promise.allSettled(jobs);
        }
        if(canvasId!==state.canvasId||!nodes.some(n=>n.id===node.id))return {ok:false,error:'画布已切换'};
        syncProductRetouchNodeResults(node);
        return node.images?.length?{ok:true}:{ok:false,error:'精修尚未完成，请查看节点中的任务状态'};
    })();
    if(!submitOnly)state.runPromise=run;
    try{return await run;}finally{if(!submitOnly)state.runPromise=null;signal?.removeEventListener('abort',onAbort);}
}
function runProductRetouchNode(node){
    const state=productRetouchSessions.get(node.id);
    if(!state||state.submitting)return;
    return runSmartNodeWithDependencies(node,(current,signal)=>runProductRetouchNodeDirect(current,signal,true),
        {concurrentTarget:productRetouchBusy(state)});
}
setInterval(()=>{
    for(const [id,state] of productRetouchSessions){
        if(!productRetouchStateCurrent(state)){productRetouchSessions.delete(id);continue;}
        const node=nodes.find(n=>n.id===id);if(!node){productRetouchSessions.delete(id);continue;}
        syncProductRetouchNodeResults(node);productRetouchRefresh(state);
    }
},500);
window.addEventListener('smart-canvas-config-ready',()=>{productRetouchOptionsRequest=null;for(const state of productRetouchSessions.values())void initializeProductRetouchNodeModels(state);});
window.addEventListener('product-retouch-plans-changed',event=>{for(const state of productRetouchSessions.values())if(state.nodeId!==event.detail?.nodeId)void initializeProductRetouchPlans(state);});
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.data?.type==='skills-changed')for(const state of productRetouchSessions.values())void initializeProductRetouchPlans(state);});
function productRetouchSyncOptions(state){
    const d=state.panel;
    for(const [selector,key] of [['[data-pr-backgrounds]','background']])
        d.querySelectorAll(`${selector} [data-value]`).forEach(b=>{const active=b.dataset.value===state.config[key];b.classList.toggle('is-selected',active);b.setAttribute('aria-pressed',String(active));});
}
function productRetouchSyncResolutions(state){
    const model=state.models[Number(state.modelKey)],values=model?.resolutions||[];
    state.resolution=values.includes(state.resolution)?state.resolution:values[0]||'';
    state.panel.querySelector('[data-pr-resolution]').innerHTML=values.map(r=>`<option value="${r}" ${r===state.resolution?'selected':''}>${r.toUpperCase()}</option>`).join('');
    const modelSelect=state.panel.querySelector('[data-pr-model]');modelSelect.title=model?.model||'';
}
function productRetouchSyncInputs(state){
    const d=state.panel,item=state.items[state.active],image=d.querySelector('[data-pr-source]');
    if(item)image.src=displayMediaUrl(imageForDisplay(item));else image.removeAttribute('src');
    image.hidden=!item;d.querySelector('[data-pr-empty]').hidden=Boolean(item);
    d.querySelector('[data-pr-preview-actions]').hidden=!item;
    const count=d.querySelector('[data-pr-count]');
    count.textContent=`${state.active+1} / ${state.items.length}`;
    count.hidden=state.items.length<=1;
    const inputs=d.querySelector('[data-pr-inputs]');
    inputs.innerHTML=state.items.length>1?state.items.map((item,i)=>`<button type="button" data-index="${i}" aria-pressed="${i===state.active}" title="${escapeAttr(item.name||'商品图片')}"><img src="${escapeAttr(displayMediaUrl(imageForDisplay(item)))}" alt="商品 ${i+1}"><span aria-hidden="true">${i+1}</span></button>`).join(''):'';
    inputs.onclick=e=>{
        const button=e.target.closest('[data-index]');
        if(!button)return;
        state.active=Number(button.dataset.index);state.node.retouchActiveIndex=state.active;scheduleSave();
        productRetouchSyncInputs(state);
        inputs.querySelector(`[data-index="${state.active}"]`)?.focus({preventScroll:true});
    };
    productRetouchRefresh(state);
}
function productRetouchRefresh(state){
    if(!productRetouchStateCurrent(state))return;
    const d=state.panel,pendingOutputs=productRetouchPendingOutputs(state),busy=state.submitting||pendingOutputs.length>0;
    const locked=state.submitting||state.uploading||state.planSaving||sharedCanvasMode||sharedCanvasReadOnly||!collabCanEditNode(state.nodeId);
    d.querySelectorAll('[data-pr-plan-edit],[data-pr-plan-close],[data-pr-plan-apply],[data-pr-plan-save],[data-pr-plan-editor] input,[data-pr-plan-editor] textarea,[data-pr-backgrounds] button,[data-pr-add],[data-pr-replace],[data-pr-remove]').forEach(e=>e.disabled=locked);
    d.querySelector('[data-pr-plan]').disabled=locked||state.plansLoading||state.planEditorOpen;
    d.querySelector('[data-pr-plan-reload]').hidden=!state.plansError||state.plansLoading;
    d.querySelector('[data-pr-plan-reload]').disabled=locked;
    d.querySelector('[data-pr-plan-save]').textContent=state.planSaving?'保存中…':'保存方案';
    d.querySelectorAll('[data-pr-provider],[data-pr-model],[data-pr-resolution]').forEach(e=>e.disabled=locked||state.modelsLoading||state.modelsError||!state.models.length);
    d.querySelector('[data-pr-model-retry]').hidden=!(state.modelsError||!state.models.length)||state.modelsLoading;
    d.querySelector('[data-pr-model-retry]').disabled=locked;
    d.querySelector('[data-pr-remove]').disabled=locked||!state.items.length;
    d.querySelector('[data-pr-start]').disabled=locked||state.planEditorOpen||state.modelsLoading||state.modelsError||!state.models.length||!state.resolution||!state.items.length;
    d.querySelector('[data-pr-start]').textContent=state.submitting?'正在提交…':state.items.length>1?`批量精修 ${state.items.length} 张`:busy?'再精修一张':'开始精修';
    const uncertain=pendingOutputs.find(n=>n.productRetouchSubmission);
    d.querySelector('[data-pr-recover]').hidden=!uncertain||state.submitting;
    if((busy||state.stop||state.outputs.length)&&!state.modelsError&&state.models.length&&!state.modelsLoading&&!state.uploading){
        const outputNodes=state.outputs.map(id=>nodes.find(n=>n.id===id)).filter(Boolean),failed=outputNodes.filter(n=>n.runError&&!/取消/.test(n.runError)).length;
        const cancelled=outputNodes.filter(n=>n.runError&&/取消/.test(n.runError)).length;
        const done=outputNodes.filter(n=>n.images?.length).length;
        const tasks=pendingOutputs.flatMap(n=>smartPendingTasks(n));
        const queued=tasks.filter(t=>t.status==='queued').length;
        const message=uncertain&&!state.submitting?`提交状态待确认：${uncertain.runError||'请续查任务，系统不会自动重发请求'}`:state.stop?(busy?'正在取消任务…':'已取消未完成任务，已完成结果保留'):state.submitting?'正在提交精修任务…':busy?`精修中 · ${pendingOutputs.length} 张待完成${queued?` · 排队 ${queued}`:''}`:failed?`完成 ${done} 张，${failed} 张失败：${outputNodes.find(n=>n.runError&&!/取消/.test(n.runError)).runError}`:cancelled?`完成 ${done} 张，已取消 ${cancelled} 张`:done?`已精修 ${done} 张，请对照检查结构和文字`:'';
        productRetouchMessage(state,message,failed>0&&!busy);
    }
}
async function submitProductRetouch(state){
    if(state.submitting||state.uploading||state.planSaving||state.planEditorOpen||state.modelsLoading||state.modelsError||canvasId!==state.canvasId||sharedCanvasReadOnly)return [];
    const model=state.models[Number(state.modelKey)],resolution=state.resolution;if(!model||!resolution)return [];
    state.submitting=true;state.stop=false;state.outputs=[];state.node.retouchOutputIds=state.outputs;state.node.images=[];
    state.node.retouchRunSignature=smartDependencySignature(state.node);
    const config={...cloneSmartSettings(state.config),protect_structure:true,protect_logo:true};
    delete config.region;
    delete config.requirements;
    const pendingJobs=[];
    productRetouchRefresh(state);
    try{
        for(const item of state.items){
            if(state.stop||canvasId!==state.canvasId||sharedCanvasReadOnly)break;
            let source=nodes.find(n=>n.id===state.nodeId);
            if(!source||!collabCanEditNode(source.id))continue;
            pushUndo();
            const runSettings={...cloneSmartSettings(initialSmartSettings),engine:'api',apiKind:'image',provider_id:model.provider_id,model:model.model,resolution,count:1,productRetouch:config};
            delete runSettings.productFidelity;
            const refs=[{url:smartOriginalMediaUrl(item)||item.url,name:item.name||'商品原图',kind:'image',nodeId:item.nodeId||source.id,imageIndex:item.imageIndex}];
            const meta={prompt:'产品精修',promptText:'产品精修',displayPrompt:'产品精修',promptRefs:refs,inputRefs:refs,sourceNodeId:source.id,settings:runSettings,createdAt:Date.now()};
            const output=createPendingOutputFromSource(source,1,meta,{refs,connectSource:false});
            output.productRetouchSource=refs[0].url;output.retouchOwnerId=source.id;
            const requestId=`retouch-${globalThis.crypto?.randomUUID?.() || uid('request')}`;
            output.productRetouchSubmission={client_request_id:requestId};
            state.outputs.push(output.id);
            render();scheduleSave();
            const saved=await saveCanvas();
            if(canvasId!==state.canvasId)break;
            if(!saved){delete output.productRetouchSubmission;markSmartNodeFailed(output,'画布保存失败，尚未提交精修，请重试');throw new Error('画布保存失败，尚未提交精修');}
            if(state.stop){delete output.productRetouchSubmission;markSmartNodeFailed(output,'精修已取消');break;}
            try{
                const sourceImage=new Image();sourceImage.src=displayMediaUrl(refs[0]);await sourceImage.decode();
                if(state.stop){delete output.productRetouchSubmission;markSmartNodeFailed(output,'精修已取消');break;}
                const edge={ '1k':1024,'2k':2048,'4k':4096 }[resolution];
                const w=sourceImage.naturalWidth||sourceImage.width,h=sourceImage.naturalHeight||sourceImage.height;
                const factor=edge/Math.max(w,h),size=`${Math.max(16,Math.round(w*factor/16)*16)}x${Math.max(16,Math.round(h*factor/16)*16)}`;
                runSettings.ratio='custom';runSettings.customRatio=`${w}:${h}`;
                output.runSettings=cloneSmartSettings(runSettings);
                const payload={prompt:'产品精修',provider_id:model.provider_id,model:model.model,n:1,size,resolution,aspect_ratio:'source',reference_images:refs,product_retouch:config,history_source:'canvas',project_id:currentSmartProjectId(),client_request_id:requestId};
                const task=await XiaomeiImageTaskClient.createImageTask(payload);
                if(canvasId!==state.canvasId)break;
                const live=nodes.find(n=>n.id===output.id);
                if(!live){await XiaomeiImageTaskClient.requestJson(`/api/canvas-image-tasks/${encodeURIComponent(task.task_id)}/cancel`,{method:'POST'});continue;}
                delete live.productRetouchSubmission;
                live.pendingTasks=[{taskId:task.task_id,kind:'image',providerId:model.provider_id,model:model.model,status:'queued'}];
                live.pending=1;live.running=false;render();scheduleSave();await saveCanvas();
                if(state.stop)await XiaomeiImageTaskClient.requestJson(`/api/canvas-image-tasks/${encodeURIComponent(task.task_id)}/cancel`,{method:'POST'});
                pendingJobs.push(resumeSmartPendingNode(live).catch(()=>{}));
            }catch(error){
                if(canvasId!==state.canvasId)break;
                const live=nodes.find(n=>n.id===output.id);if(!live)continue;
                if(error.code!=='NETWORK_ERROR')delete live.productRetouchSubmission;
                markSmartNodeFailed(live,error.message||'精修提交失败，请重试');render();scheduleSave();
            }
        }
        syncProductRetouchNodeResults(state.node);
    }catch(error){productRetouchMessage(state,error.message,true);}
    finally{state.submitting=false;if(canvasId===state.canvasId){render();scheduleSave();productRetouchRefresh(state);}}
    return pendingJobs;
}
async function cancelProductRetouch(state,outputIds=null){
    const currentOutputs=state.outputs;
    const cancelCurrent=!outputIds||outputIds===currentOutputs;
    if(cancelCurrent){state.stop=true;productRetouchRefresh(state);}
    const outputs=productRetouchPendingOutputs(state).filter(node=>!outputIds||outputIds.includes(node.id));
    for(const node of outputs){if(node.productRetouchSubmission)node.productRetouchSubmission.cancel_requested=true;}
    scheduleSave();
    if(!state.submitting)await recoverProductRetouchSubmissions(true,outputs.map(node=>node.id));
    if(canvasId!==state.canvasId)return;
    const ids=outputs.flatMap(node=>smartPendingTasks(nodes.find(n=>n.id===node.id))).map(t=>t.taskId);
    const results=await Promise.allSettled(ids.map(id=>XiaomeiImageTaskClient.requestJson(`/api/canvas-image-tasks/${encodeURIComponent(id)}/cancel`,{method:'POST'})));
    if(results.some(r=>r.status==='rejected')){
        if(cancelCurrent&&state.outputs===currentOutputs)state.stop=false;
        productRetouchMessage(state,'部分任务取消失败，请重试',true);
    }
}
async function recoverProductRetouchSubmissions(abandonMissing=false,outputIds=null){
    const token=canvasId;
    for(let node of nodes.filter(n=>n.productRetouchSubmission&&(!outputIds||outputIds.includes(n.id)))){
        const requestId=node.productRetouchSubmission.client_request_id;
        const key=`${token}:${node.id}:${requestId}`;
        const current=()=>canvasId===token && nodes.find(n=>n.id===node.id)?.productRetouchSubmission?.client_request_id===requestId;
        if(productRetouchRecoveries.has(key))continue;
        productRetouchRecoveries.add(key);
        try{
            const task=await XiaomeiImageTaskClient.requestJson(`/api/canvas-image-tasks/recover?client_request_id=${encodeURIComponent(requestId)}`);
            if(!current())continue;
            node=nodes.find(n=>n.id===node.id);
            if(node.productRetouchSubmission?.cancel_requested)await XiaomeiImageTaskClient.requestJson(`/api/canvas-image-tasks/${encodeURIComponent(task.task_id)}/cancel`,{method:'POST'});
            if(!current())continue;
            delete node.productRetouchSubmission;
            node.pendingTasks=[{taskId:task.task_id,kind:'image',providerId:node.runSettings?.provider_id,model:node.runSettings?.model,status:task.status}];
            node.pending=1;delete node.runError;
            void resumeSmartPendingNode(node).catch(()=>{});
        }catch(error){if(current()){
            node=nodes.find(n=>n.id===node.id);node.pending=0;node.running=false;
            if(error.status===404 && abandonMissing && node.productRetouchSubmission.cancel_requested){
                delete node.productRetouchSubmission;node.productRetouchAbandonedRequestId=requestId;
                markSmartNodeFailed(node,'已取消本地等待；平台已受理的请求可能继续执行或计费');
            }else node.runError=error.status===404?'未找到精修任务，可续查或取消本地等待':'精修任务暂时无法读取，请续查任务';
        }}
        finally{productRetouchRecoveries.delete(key);if(canvasId===token){render();scheduleSave();}}
    }
}
window.addEventListener('smart-canvas-config-ready',()=>void recoverProductRetouchSubmissions());
