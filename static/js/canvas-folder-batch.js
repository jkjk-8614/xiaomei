(function(){
    'use strict';
    const API='/api/canvas-folder-batches';
    const PLAN_STATUSES=new Set(['imported','ready','plan_failed']);
    const IN_FLIGHT=new Set(['running','waiting_upstream']);
    const BATCH_LABELS={imported:'待生成计划',analyzing:'正在识别与规划',ready:'待确认计划',plan_failed:'规划失败',running:'批量改图中',paused:'已暂停派发',completed:'本批已结束',interrupted:'任务中断'};
    const ITEM_LABELS={pending:'待处理',unreadable:'无法读取',skipped:'已跳过',queued:'排队中',running:'改图中',succeeded:'已完成',failed:'改图失败',waiting_upstream:'等待上游结果'};
    const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const keyFor=context=>JSON.stringify([context?.canvasId||'',context?.conversationId||'']);
    const batchPath=id=>`${API}/${encodeURIComponent(id)}`;
    const wasConfirmed=batch=>Boolean(batch.output_directory||batch.items.some(item=>item.attempt||item.task_id||item.result_url||item.status==='queued'));
    const canPlan=batch=>!wasConfirmed(batch)&&(PLAN_STATUSES.has(batch.status)||['paused','interrupted'].includes(batch.status));
    const canRetryBatch=batch=>['completed','paused','interrupted'].includes(batch.status)&&!batch.items.some(item=>item.status==='running');
    function createdLabel(value){
        if(!value)return '';
        const date=new Date(typeof value==='number'?value*1000:value);
        return Number.isNaN(date.getTime())?'':date.toLocaleString();
    }
    function safeUrl(value){
        if(!value)return '';
        try{const url=new URL(value,location.href);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch(_){return '';}
    }
    async function request(url,method='GET',body){
        const response=await fetch(url,{method,cache:'no-store',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
        const data=await response.json().catch(()=>null);
        if(!response.ok){
            const detail=data?.detail||data?.error||data?.message;
            const message=typeof detail==='string'?detail:detail?.message|| (Array.isArray(detail)?detail.map(item=>item.msg||'请求字段无效').join('；'):'');
            const error=new Error(message||`请求失败（${response.status}）`);
            error.status=response.status;
            throw error;
        }
        if(!data)throw new Error('服务未返回任务数据，请刷新任务状态。');
        return data;
    }
    function create({root,getContext,getMessage=()=>'',previewUrl=item=>item.url,onChange=()=>{},onHistorySelect=()=>{}}){
        const disabled=new URLSearchParams(location.search).get('shared')==='1';
        if(!root||disabled){if(root)root.hidden=true;return {refresh:async()=>{},hasActive:()=>false,send:async()=>false,composerHint:()=>'',startImport:async()=>false,openHistory:async()=>{},renderHistory:()=>{},selectTask:async()=>false};}
        const states=new Map();
        let current=null,pollTimer=0,viewKey='',cards=new Map(),disposed=false;
        root.hidden=true;
        root.innerHTML=`
            <div class="cfb-toolbar">
                <strong>文件夹批量任务</strong>
                <div class="cfb-toolbar-actions">
                    <button type="button" data-cfb-action="reload" hidden>重试读取任务</button>
                    <button type="button" data-cfb-action="exit" hidden>回到普通 Agent</button>
                </div>
            </div>
            <div class="cfb-notice" role="status" aria-live="polite" hidden></div>
            <div class="cfb-content" hidden>
                <div class="cfb-heading"><strong data-cfb-name></strong><span class="cfb-badge" data-cfb-status></span></div>
                <p class="cfb-copy" data-cfb-message hidden></p>
                <p class="cfb-copy" data-cfb-summary hidden></p>
                <p class="cfb-error" data-cfb-error hidden></p>
                <div class="cfb-progress" hidden><label data-cfb-progress-label></label><progress aria-label="整批图片识别进度"></progress></div>
                <p class="cfb-copy" data-cfb-hint></p>
                <p class="cfb-copy" data-cfb-generation hidden></p>
                <div class="cfb-actions">
                    <button type="button" data-cfb-action="plan">生成计划</button>
                    <button type="button" data-cfb-action="save" hidden>保存计划修改</button>
                    <button type="button" data-cfb-action="execute" class="cfb-primary" hidden>确认开始批量改图</button>
                    <button type="button" data-cfb-action="pause" hidden>暂停后续图片</button>
                    <button type="button" data-cfb-action="resume" hidden>继续未开始的图片</button>
                    <button type="button" data-cfb-action="refresh">刷新状态</button>
                </div>
                <p class="cfb-copy cfb-draft-note" data-cfb-draft hidden></p>
                <details class="cfb-gallery"><summary data-cfb-gallery-label>查看原图</summary><div class="cfb-grid"></div></details>
                <div class="cfb-selection" hidden><label><input type="checkbox" data-cfb-select-all>选择全部可读图片</label><span data-cfb-count></span></div>
                <div class="cfb-items"></div>
                <div class="cfb-downloads"><a data-cfb-zip hidden>下载成功结果 ZIP</a><a data-cfb-report>下载任务报告</a></div>
                <details class="cfb-output-details" hidden><summary>输出位置</summary><p class="cfb-output" data-cfb-output></p></details>
            </div>`;
        const $=selector=>root.querySelector(selector);
        const action=name=>$(`[data-cfb-action="${name}"]`);
        function text(element,value){const next=String(value??'');if(element.textContent!==next)element.textContent=next;}
        function copy(selector,value){const element=$(selector);text(element,value);element.hidden=!value;}
        function stateFor(context){
            const key=keyFor(context);
            if(!states.has(key)){
                let binding;
                try{const stored=localStorage.getItem(`xiaomei_canvas_folder_binding_v1_${key}`);binding=stored===null?undefined:JSON.parse(stored);}catch(_){ }
                states.set(key,{key,context:{canvasId:context.canvasId,conversationId:context.conversationId},activeId:typeof binding==='string'?binding:binding===null?null:undefined,records:new Map(),order:[],loaded:false,loading:false,loadSeq:0,busy:'',error:'',pollError:'',notice:''});
            }
            return states.get(key);
        }
        function persistBinding(state){try{localStorage.setItem(`xiaomei_canvas_folder_binding_v1_${state.key}`,JSON.stringify(state.activeId??null));}catch(_){ }}
        function recordFor(state,id=state.activeId){return state?.records.get(id);}
        function isCurrent(state,id=state.activeId){return !disposed&&current===state&&keyFor(getContext())===state.key&&state.activeId===id;}
        function hasActive(){return Boolean(!disposed&&current&&keyFor(getContext())===current.key&&current.activeId);}
        function batchHistoryStatus(batch){return BATCH_LABELS[batch?.status]||batch?.status||'未知状态';}
        function renderHistoryList(target){
            if(!target)return;
            const state=current;
            const entries=state?.order.map(id=>state.records.get(id)?.batch).filter(Boolean)||[];
            target.dataset.batchCount=String(entries.length);
            if(!state){
                target.innerHTML='<div class="canvas-agent-history-empty"><i data-lucide="folder-kanban"></i><strong>还没有批量任务</strong><span>从输入区的加号菜单选择文件夹后，任务会显示在这里</span></div>';
            }else if(state.loading&&!entries.length){
                target.innerHTML='<div class="canvas-agent-history-empty"><i data-lucide="loader-circle"></i><strong>正在读取批量任务</strong><span>请稍候…</span></div>';
            }else if(state.error&&!entries.length){
                target.innerHTML=`<div class="canvas-agent-history-empty"><i data-lucide="triangle-alert"></i><strong>批量任务读取失败</strong><span>${esc(state.error)}</span></div>`;
            }else if(!entries.length){
                target.innerHTML='<div class="canvas-agent-history-empty"><i data-lucide="folder-kanban"></i><strong>还没有批量任务</strong><span>从输入区的加号菜单选择文件夹后，任务会显示在这里</span></div>';
            }else{
                target.innerHTML=entries.map(batch=>{
                    const itemCount=Array.isArray(batch.items)?batch.items.length:0;
                    const created=createdLabel(batch.created_at);
                    const meta=[batchHistoryStatus(batch),`${itemCount} 张图片`,created].filter(Boolean).join(' · ');
                    return `<div class="canvas-agent-history-item ${batch.id===state.activeId?'active':''} cfb-history-item">
                        <button type="button" data-cfb-history-id="${esc(batch.id)}" title="打开 ${esc(batch.name||'文件夹任务')}" aria-current="${batch.id===state.activeId?'true':'false'}">
                            <span class="canvas-agent-history-icon"><i data-lucide="folder-kanban"></i></span>
                            <span class="canvas-agent-history-copy"><strong>${esc(batch.name||'未命名文件夹')}</strong><small>${esc(meta)}</small></span>
                            <span class="canvas-agent-history-count">${itemCount}</span>
                        </button>
                    </div>`;
                }).join('');
            }
            target.querySelectorAll('[data-cfb-history-id]').forEach(button=>button.onclick=()=>{void selectTask(button.dataset.cfbHistoryId);});
            if(typeof window.refreshIcons==='function')window.refreshIcons();
        }
        async function openHistory(target){
            renderHistoryList(target);
            const context=getContext();
            if(!context?.canvasId||!context?.conversationId)return;
            await refresh(true);
            if(!disposed)renderHistoryList(target);
        }
        async function selectTask(id){
            const state=current;
            if(!state||!id||!state.records.has(id))return false;
            state.activeId=id;state.error='';state.notice='';persistBinding(state);render();onHistorySelect();
            await refreshBatch(state);
            return true;
        }
        function composerHint(){
            const record=recordFor(current);
            if(!record)return '正在读取文件夹任务，请稍候';
            if(record.batch.status==='analyzing')return '正在识别整批图片，完成后可继续补充要求';
            return canPlan(record.batch)?'输入整批修改要求；确认计划后才会开始改图':'请在图片卡片填写修改意见并点击重试；普通对话请先退出任务';
        }
        function accept(state,batch){
            if(!batch?.id||!Array.isArray(batch.items))throw new Error('任务数据不完整，请刷新状态。');
            const old=recordFor(state,batch.id);
            if(old&&Number(batch.revision)<Number(old.batch.revision))return old;
            const record=old||{draft:null,feedback:new Map(),epoch:0};
            if(record.draft&&Number(batch.revision)>Number(record.draft.revision)){
                record.draft.revision=batch.revision;record.draft.conflict=true;
            }
            record.batch=batch;
            state.records.set(batch.id,record);
            if(!state.order.includes(batch.id))state.order.unshift(batch.id);
            return record;
        }
        function draftFor(record){
            if(!record.draft)record.draft={revision:record.batch.revision,items:new Map(),conflict:false};
            return record.draft;
        }
        function planItem(record,item){return record.draft?.items.get(item.id)||{id:item.id,selected:item.selected!==false&&item.status!=='unreadable',prompt:item.prompt||''};}
        function selectedItems(record){return record.batch.items.filter(item=>item.status!=='unreadable'&&planItem(record,item).selected);}
        function changePlan(record,item,patch){
            const draft=draftFor(record);
            draft.items.set(item.id,{...planItem(record,item),...patch});
            render();
        }
        function rememberError(state,error,prefix){
            state.error=`${prefix}：${error.message||error}。${error.status===409?'计划已变化，已保留你的草稿；请刷新并核对后重新保存。':'请刷新状态后重试。'}`;
        }
        async function load(state){
            const seq=++state.loadSeq;
            state.loading=true;
            render();
            try{
                const params=new URLSearchParams({canvas_id:state.context.canvasId,conversation_id:state.context.conversationId});
                const data=await request(`${API}?${params}`);
                if(seq!==state.loadSeq)return;
                if(!Array.isArray(data.batches))throw new Error('服务未返回文件夹任务列表');
                const batches=data.batches;
                // A list can arrive after a mutation; existing detail records remain authoritative.
                batches.forEach(batch=>{if(!state.records.has(batch.id))accept(state,batch);});
                state.order=batches.map(batch=>batch.id);
                if(state.activeId===undefined)state.activeId=state.order[0]||null;
                if(state.activeId&&!state.order.includes(state.activeId)){state.activeId=null;persistBinding(state);}
                state.loaded=true;
                state.error='';
            }catch(error){if(seq===state.loadSeq)rememberError(state,error,'读取文件夹任务失败');}
            finally{
                if(seq===state.loadSeq){state.loading=false;if(current===state){render();schedulePoll();}}
            }
        }
        async function refresh(force=false){
            if(disposed)return;
            const context=getContext();
            if(!context.canvasId||!context.conversationId)return;
            const next=stateFor(context),changed=current!==next;
            if(changed){clearTimeout(pollTimer);current=next;viewKey='';render();}
            if(next.loading)return;
            if(!next.loaded||force||changed){await load(next);if(isCurrent(next)&&recordFor(next))await refreshBatch(next);}
            else if(changed)schedulePoll();
        }
        async function refreshBatch(state=current){
            const record=recordFor(state),id=state?.activeId;
            if(!record||state.busy)return;
            const epoch=++record.epoch;
            try{
                const batch=await request(batchPath(id));
                if(epoch!==record.epoch)return;
                if(batch.id!==id)throw new Error('返回了其他文件夹任务');
                accept(state,batch);
                state.pollError='';
            }catch(error){if(epoch===record.epoch)state.pollError=`更新任务状态失败：${error.message||error}。正在重连，可手动刷新。`;}
            finally{if(isCurrent(state,id)){render();schedulePoll();}}
        }
        function schedulePoll(){
            clearTimeout(pollTimer);
            const state=current,record=recordFor(state);
            if(!record||disposed)return;
            const batch=record.batch;
            if(state.pollError||['analyzing','running'].includes(batch.status)||batch.items.some(item=>IN_FLIGHT.has(item.status))){
                pollTimer=setTimeout(()=>{if(isCurrent(state,batch.id))void refreshBatch(state);},2000);
            }
        }
        async function mutate(state,id,label,operation){
            if(state.busy||!isCurrent(state,id))return false;
            state.busy=label;state.error='';state.notice='';
            state.loadSeq++;state.loading=false;
            const record=recordFor(state,id);
            if(record)record.epoch++;
            clearTimeout(pollTimer);render();
            let succeeded=false;
            try{await operation();succeeded=true;}
            catch(error){
                rememberError(state,error,label);
                // A disconnected response may still have committed a paid request. Reconcile, never resubmit.
                if(record){
                    try{
                        const batch=await request(batchPath(id));
                        if(batch.id===id)accept(state,batch);
                        if(error.status===409&&record.draft){record.draft.revision=record.batch.revision;record.draft.conflict=true;}
                    }catch(_){ }
                }
            }finally{state.busy='';if(current===state){render();schedulePoll();}}
            return succeeded;
        }
        async function importFolder(){
            const state=current;
            if(!state||state.loading||state.busy)return false;
            const previousId=state.activeId;
            return mutate(state,previousId,'导入文件夹失败',async()=>{
                const chosen=await request('/api/select-folder','POST',{title:'选择要批量改图的文件夹'});
                if(!chosen.selected||!chosen.path||!isCurrent(state,previousId))return;
                const batch=await request(API,'POST',{path:chosen.path,canvas_id:state.context.canvasId,conversation_id:state.context.conversationId});
                accept(state,batch);state.loaded=true;
                if(state.activeId===previousId){state.activeId=batch.id;persistBinding(state);}
            });
        }
        async function startImport(){
            if(disposed)return false;
            if(!current)await refresh();
            const state=current;
            if(!state)return false;
            if(state.loading){
                await new Promise(resolve=>{
                    const wait=()=>state.loading?setTimeout(wait,50):resolve();
                    wait();
                });
            }
            if(!state.loaded)await load(state);
            return importFolder();
        }
        async function send(message,context=getContext()){
            if(!hasActive()||keyFor(context)!==current.key)return false;
            const state=current,record=recordFor(state);
            if(!record||state.busy)return false;
            if(!canPlan(record.batch)){
                state.notice=composerHint();render();return false;
            }
            try{context=getContext(message);}catch(error){state.error=error.message;render();return false;}
            if(!context.provider||!context.model){state.error='请在 Agent 设置中选择对话模型，再生成计划。';render();return false;}
            if(!context.generation?.provider_id||!context.generation?.model){state.error='请在生成偏好中选择图片模型，再生成计划。';render();return false;}
            if(record.draft?.items.size){state.error='有未保存的计划修改。请先保存，再发送新的整批要求。';render();return false;}
            if(!message.trim())return false;
            return mutate(state,record.batch.id,'生成计划失败',async()=>{
                const batch=await request(`${batchPath(record.batch.id)}/plan`,'POST',{message:message.trim(),provider:context.provider,model:context.model,skill_id:context.skillId||'',generation:context.generation});
                accept(state,batch);
            });
        }
        async function saveDraft(state,record){
            const draft=record.draft;
            if(!draft?.items.size)return;
            const changes=[...draft.items.values()].map(item=>({...item}));
            const batch=await request(`${batchPath(record.batch.id)}/plan`,'PATCH',{revision:draft.revision,items:changes});
            accept(state,batch);
            record.draft=null;
        }
        async function runAction(name,itemId){
            const state=current,record=recordFor(state);
            if(!record)return;
            const id=record.batch.id;
            if(name==='refresh'){state.error='';state.notice='';await refreshBatch();return;}
            if(name==='plan'){
                await send(getMessage()||record.batch.requirements?.at(-1)||'请逐张识别这批图片，给出保持主体与产品细节的统一改图计划。',getContext());
                return;
            }
            if(name==='save'&&record.batch.status==='ready'){
                await mutate(state,id,'保存计划失败',()=>saveDraft(state,record));return;
            }
            if(name==='execute'){
                if(record.batch.status!=='ready'||!selectedItems(record).length)return;
                if(selectedItems(record).some(item=>!planItem(record,item).prompt.trim())){state.error='已选图片缺少改图提示词，请补全后确认。';render();return;}
                if(record.draft&&(record.draft.conflict||record.draft.revision!==record.batch.revision)){
                    state.error='计划版本已变化，请核对并保存草稿，再确认开始改图。';render();return;
                }
                await mutate(state,id,'开始批量改图失败',async()=>{
                    await saveDraft(state,record);
                    if(!isCurrent(state,id))return;
                    const batch=await request(`${batchPath(id)}/execute`,'POST',{revision:record.batch.revision});
                    accept(state,batch);
                });
                return;
            }
            if(name==='pause'&&['running','analyzing'].includes(record.batch.status)||name==='resume'&&wasConfirmed(record.batch)&&['paused','interrupted'].includes(record.batch.status)){
                await mutate(state,id,name==='pause'?'暂停任务失败':'继续任务失败',async()=>accept(state,await request(`${batchPath(id)}/${name}`,'POST',{})));
                return;
            }
            const item=record.batch.items.find(value=>value.id===itemId);
            if(name==='retry'&&canRetryBatch(record.batch)&&item&&['failed','succeeded'].includes(item.status)){
                const feedback=record.feedback.get(item.id)||'';
                await mutate(state,id,'单图重试失败',async()=>{
                    accept(state,await request(`${batchPath(id)}/items/${encodeURIComponent(item.id)}/retry`,'POST',{revision:record.batch.revision,feedback}));
                });
            }
        }
        function makeCard(item){
            const element=document.createElement('div');
            element.className='cfb-item';element.dataset.itemId=item.id;
            element.innerHTML=`<div class="cfb-item-heading"><strong data-item-name></strong><span class="cfb-badge" data-item-status></span></div>
                <div class="cfb-compare"><a data-item-original target="_blank" rel="noopener"><img loading="lazy" decoding="async" alt="原图"><span>原图</span></a><a data-item-result target="_blank" rel="noopener" hidden><img loading="lazy" decoding="async" alt="改图结果"><span>结果</span></a></div>
                <p class="cfb-error" data-item-error hidden></p>
                <p class="cfb-copy" data-item-duplicate hidden></p>
                <details class="cfb-item-details"><summary>识别与改图计划</summary><p class="cfb-path" data-item-path></p><p class="cfb-copy" data-item-description></p><p class="cfb-copy" data-item-prompt></p></details>
                <div data-item-plan hidden><label class="cfb-check"><input type="checkbox" data-item-selected>参与本次改图</label><label class="cfb-field">改图提示词<textarea data-item-editor rows="4"></textarea></label></div>
                <div data-item-feedback-box hidden><label class="cfb-field">这张图的修改意见<textarea data-item-feedback rows="2" placeholder="例如：背景再浅一点；也可留空重试"></textarea></label><button type="button" data-cfb-action="retry">重试这张图</button></div>
                <a class="cfb-item-download" data-item-download hidden>下载这张结果</a>
                <details class="cfb-versions" hidden><summary>查看改图版本</summary><div data-item-versions></div></details>`;
            const refs={element};
            element.querySelectorAll('[data-item-name],[data-item-status],[data-item-original],[data-item-result],[data-item-error],[data-item-duplicate],[data-item-path],[data-item-description],[data-item-prompt],[data-item-plan],[data-item-selected],[data-item-editor],[data-item-feedback-box],[data-item-feedback],[data-item-download],[data-item-versions]').forEach(node=>{refs[Object.keys(node.dataset).find(key=>key.startsWith('item'))]=node;});
            return refs;
        }
        function updateImage(link,url,preview){
            const href=safeUrl(url),src=safeUrl(preview||url);
            link.hidden=!href;
            if(href){
                if(link.getAttribute('href')!==href)link.setAttribute('href',href);
                const img=link.querySelector('img');
                if(img.getAttribute('src')!==src)img.src=src;
            }
        }
        function renderCard(record,item,editable){
            let refs=cards.get(item.id);
            if(!refs){refs=makeCard(item);cards.set(item.id,refs);$('.cfb-items').append(refs.element);}
            const value=planItem(record,item),canEdit=editable&&item.status!=='unreadable';
            text(refs.itemName,`${item.number}. ${item.name}`);
            text(refs.itemStatus,`${ITEM_LABELS[item.status]||item.status}${item.attempt?` · 第 ${item.attempt} 次`:''}`);
            refs.itemStatus.dataset.status=item.status;
            updateImage(refs.itemOriginal,item.url,previewUrl(item,320));
            updateImage(refs.itemResult,item.result_url,previewUrl({url:item.result_url},320));
            text(refs.itemResult.querySelector('span'),item.status==='succeeded'?'结果':'上一版结果');
            text(refs.itemError,item.error||'');refs.itemError.hidden=!item.error;
            const duplicate=record.batch.items.find(value=>value.id===item.duplicate_of);
            text(refs.itemDuplicate,duplicate?`与第 ${duplicate.number} 张图片内容相同`:'');refs.itemDuplicate.hidden=!duplicate;
            text(refs.itemPath,`${item.relative_path||item.name}${item.width&&item.height?` · ${item.width} × ${item.height}`:''}`);
            text(refs.itemDescription,item.description||'尚未返回图片识别结果。');
            text(refs.itemPrompt,item.prompt||'');refs.itemPrompt.hidden=canEdit||!item.prompt;
            refs.itemPlan.hidden=!canEdit;
            refs.itemSelected.checked=Boolean(value.selected);refs.itemSelected.disabled=Boolean(current.busy);
            refs.itemSelected.setAttribute('aria-label',`选择图片 ${item.number} ${item.name}`);
            const editor=refs.itemEditor;
            if(document.activeElement!==editor&&editor.value!==value.prompt)editor.value=value.prompt;
            editor.disabled=Boolean(current.busy);editor.setAttribute('aria-label',`图片 ${item.number} 的改图提示词`);
            const feedback=refs.itemFeedback;
            const retryable=['failed','succeeded'].includes(item.status),canRetry=retryable&&canRetryBatch(record.batch);
            refs.itemFeedbackBox.hidden=!retryable&&!record.feedback.has(item.id);
            if(document.activeElement!==feedback&&feedback.value!==(record.feedback.get(item.id)||''))feedback.value=record.feedback.get(item.id)||'';
            feedback.disabled=Boolean(current.busy)||!canRetry;feedback.setAttribute('aria-label',`图片 ${item.number} 的修改意见`);
            const retry=refs.element.querySelector('[data-cfb-action="retry"]');
            retry.disabled=Boolean(current.busy)||!canRetry;
            retry.title=canRetry?'': '请等待本批完成或暂停并收齐已提交结果后重试';
            text(retry,item.status==='succeeded'?'按意见重新改图':'重试这张图');
            refs.itemDownload.hidden=!item.result_url;
            refs.itemDownload.href=`${batchPath(record.batch.id)}/items/${encodeURIComponent(item.id)}/download`;
            refs.itemDownload.setAttribute('download','');
            const versions=(item.versions||[]).map(version=>`<div class="cfb-version"><a href="${esc(safeUrl(version.url))}" target="_blank" rel="noopener">第 ${esc(version.attempt)} 次结果</a><p class="cfb-copy">${esc(version.prompt||'')}</p></div>`).join('');
            if(refs.itemVersions.innerHTML!==versions)refs.itemVersions.innerHTML=versions;
            refs.itemVersions.parentElement.hidden=!versions;
        }
        function render(){
            if(disposed||!current)return;
            const state=current,record=recordFor(state),batch=record?.batch;
            root.hidden=!state.activeId;
            root.classList.toggle('is-active',Boolean(state.activeId));
            action('exit').hidden=!state.activeId;
            action('reload').hidden=Boolean(batch)||!state.error;action('reload').disabled=Boolean(state.loading||state.busy);
            const notice=state.error||state.pollError||state.notice||(state.loading?'正在读取文件夹任务…':state.busy?'正在提交，请稍候…':'');
            copy('.cfb-notice',notice);$('.cfb-notice').classList.toggle('cfb-error',Boolean(state.error||state.pollError));
            $('.cfb-content').hidden=!batch;
            const nextView=`${state.key}:${state.activeId||''}`;
            if(viewKey!==nextView){viewKey=nextView;cards=new Map();$('.cfb-items').replaceChildren();$('.cfb-grid').replaceChildren();$('.cfb-gallery').open=batch?.status==='imported';$('.cfb-output-details').open=false;$('.cfb-content').scrollTop=0;}
            if(!batch){onChange();return;}
            const editable=batch.status==='ready',planning=canPlan(batch),selected=selectedItems(record);
            copy('[data-cfb-name]',batch.name);
            copy('[data-cfb-status]',BATCH_LABELS[batch.status]||batch.status);
            copy('[data-cfb-message]',batch.requirements?.length?`整批要求：${batch.requirements.at(-1)}`:'');
            copy('[data-cfb-summary]',batch.summary||'');copy('[data-cfb-error]',batch.error||'');
            const total=Math.max(0,Number(batch.analysis_total)||0),done=Math.max(0,Number(batch.analysis_done)||0);
            $('.cfb-progress').hidden=batch.status!=='analyzing'&&!total;
            text($('[data-cfb-progress-label]'),`已识别 ${done} / ${total} 张`);
            const progress=$('progress');progress.max=Math.max(1,total);progress.value=done;
            const succeeded=batch.items.filter(item=>item.status==='succeeded').length,failed=batch.items.filter(item=>item.status==='failed').length;
            const hints={imported:'在下方输入整批修改要求，或点击生成计划。',analyzing:'Agent 正在逐张看图并整理计划，完成后可勾选和修改。',ready:'核对逐图提示词，确认后将调用图片模型。',plan_failed:'识别或规划未完成。可以修改下方要求后重试生成计划。',running:`已完成 ${succeeded} 张，失败 ${failed} 张；结果会逐张更新。`,paused:'后续图片已暂停；已提交的图片继续等待结果。',completed:`已完成 ${succeeded} 张，失败 ${failed} 张。可逐图反馈重试或下载。`,interrupted:'任务已中断；刷新可回收结果，继续只派发未开始的图片。'};
            copy('[data-cfb-hint]',planning&&['paused','interrupted'].includes(batch.status)?'图片分析已暂停或中断。可补充要求后重新生成计划。':hints[batch.status]||batch.message||'');
            const generation=batch.generation||{};
            const sizeLabel=generation.aspect_ratio==='source'?(generation.size==='auto'?'尺寸自动适配':`目标长边 ${Math.max(...String(generation.size).split('x').map(Number))} 像素`):generation.size;
            const qualityLabel=({auto:'自动质量',standard:'标准质量',hd:'高清',low:'低质量',medium:'中等质量',high:'高质量',xhigh:'超高质量',max:'最高质量'})[generation.quality]||generation.quality;
            const backgroundLabel=({auto:'自动背景',opaque:'不透明背景',transparent:'透明背景'})[generation.background]||generation.background;
            copy('[data-cfb-generation]',generation.model?`图片模型：${generation.model} · ${generation.provider_id||''}\n${[sizeLabel,generation.aspect_ratio==='source'?'跟随每张原图比例':generation.aspect_ratio,qualityLabel,backgroundLabel].filter(Boolean).join(' · ')}`:'');
            action('plan').hidden=!planning;action('plan').disabled=Boolean(state.busy)||!batch.items.some(item=>item.status!=='unreadable');
            text(action('plan'),batch.status==='imported'?'生成计划':batch.status==='plan_failed'?'重试生成计划':'重新生成计划');
            action('save').hidden=!editable;action('save').disabled=Boolean(state.busy)||!record.draft?.items.size;
            action('execute').hidden=!editable;action('execute').disabled=Boolean(state.busy)||!selected.length;
            text(action('execute'),`确认开始批量改图（${selected.length} 张）`);
            action('pause').hidden=!['running','analyzing'].includes(batch.status);text(action('pause'),batch.status==='analyzing'?'暂停分析':'暂停后续图片');
            action('resume').hidden=!wasConfirmed(batch)||!['paused','interrupted'].includes(batch.status);
            ['pause','resume','refresh'].forEach(name=>action(name).disabled=Boolean(state.busy));
            const draft=record.draft;
            copy('[data-cfb-draft]',draft?.items.size?(draft.conflict||draft.revision!==batch.revision?'计划版本已变化，草稿已保留。请核对后保存，再确认开始。':'有未保存修改；点击确认时会先保存当前计划。'):'');
            $('.cfb-selection').hidden=!editable;text($('[data-cfb-count]'),`已选择 ${selected.length} 张`);
            const all=$('[data-cfb-select-all]'),readable=batch.items.filter(item=>item.status!=='unreadable');
            all.checked=Boolean(readable.length)&&selected.length===readable.length;all.indeterminate=selected.length>0&&selected.length<readable.length;all.disabled=Boolean(state.busy)||!readable.length;
            text($('[data-cfb-gallery-label]'),`原图缩略图 · ${batch.items.length} 张`);
            const grid=$('.cfb-grid');
            if(grid.children.length!==batch.items.length){
                grid.innerHTML=batch.items.map(item=>`<a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener"><img src="${esc(safeUrl(previewUrl(item,160)))}" alt="${esc(item.name)}" loading="lazy" decoding="async"><span>${esc(item.number)}. ${esc(item.name)}</span></a>`).join('');
            }
            $('.cfb-items').hidden=['imported','analyzing'].includes(batch.status);
            batch.items.forEach(item=>renderCard(record,item,editable));
            const ids=new Set(batch.items.map(item=>item.id));cards.forEach((refs,id)=>{if(!ids.has(id)){refs.element.remove();cards.delete(id);}});
            const zip=$('[data-cfb-zip]');zip.hidden=!batch.items.some(item=>item.result_url);zip.href=`${batchPath(batch.id)}/download`;zip.setAttribute('download','');
            $('[data-cfb-report]').href=`${batchPath(batch.id)}/report.json`;$('[data-cfb-report]').setAttribute('download','');
            copy('[data-cfb-output]',batch.output_directory?`输出文件夹：${batch.output_directory}`:'');
            $('.cfb-output-details').hidden=!batch.output_directory;
            onChange();
        }
        root.addEventListener('click',event=>{
            const button=event.target.closest('[data-cfb-action]');
            if(!button||button.disabled)return;
            const name=button.dataset.cfbAction;
            if(name==='exit'){
                current.activeId=null;current.notice='';persistBinding(current);clearTimeout(pollTimer);render();
            }else if(name==='reload')void refresh(true);
            else void runAction(name,button.closest('[data-item-id]')?.dataset.itemId);
        });
        root.addEventListener('input',event=>{
            const record=recordFor(current),card=event.target.closest('[data-item-id]');
            if(!record||!card||current.busy)return;
            const item=record.batch.items.find(value=>value.id===card.dataset.itemId);
            if(!item)return;
            if(event.target.matches('[data-item-editor]')&&record.batch.status==='ready')changePlan(record,item,{prompt:event.target.value});
            if(event.target.matches('[data-item-feedback]'))record.feedback.set(item.id,event.target.value);
        });
        root.addEventListener('change',event=>{
            const record=recordFor(current);
            if(!record||current.busy||record.batch.status!=='ready')return;
            if(event.target.matches('[data-cfb-select-all]')){
                record.batch.items.filter(item=>item.status!=='unreadable').forEach(item=>{draftFor(record).items.set(item.id,{...planItem(record,item),selected:event.target.checked});});render();
            }else if(event.target.matches('[data-item-selected]')){
                const item=record.batch.items.find(value=>value.id===event.target.closest('[data-item-id]').dataset.itemId);
                if(item)changePlan(record,item,{selected:event.target.checked});
            }
        });
        window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(pollTimer);},{once:true});
        return {refresh,hasActive,send,composerHint,startImport,openHistory,renderHistory:renderHistoryList,selectTask};
    }
    window.CanvasFolderBatch={create};
})();
