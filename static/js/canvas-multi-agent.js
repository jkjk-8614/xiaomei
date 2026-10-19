(function(){
    'use strict';
    if(new URLSearchParams(location.search).get('shared')==='1')return;
    const bridge=window.CanvasMultiAgentBridge,panel=document.getElementById('canvasAgentPanel');
    if(!bridge||!panel)return;
    const prefix='/api/canvas-agent/multi';
    const terminal=new Set(['completed','failed','cancelled']);
    const labels={queued:'等待开始',running:'正在处理',waiting_dependency:'等待前一步',awaiting_approval:'需要确认',waiting_result:'等待结果',completed:'已完成',failed:'未完成',cancelled:'已停止'};
    let scopeKey='',scope=null,runId='',snapshot=null,mode=false,loading=false,executing=false,polling=false,epoch=0,config=null;
    const requestId=()=>globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const clientId=`agent-browser-${requestId()}`;
    const entry=document.createElement('button');entry.type='button';entry.id='canvasMultiAgentOpen';entry.className='multi-agent-entry';entry.textContent='智能分工';entry.setAttribute('aria-controls','canvasMultiAgentDrawer');entry.setAttribute('aria-expanded','false');
    panel.querySelector('header nav')?.prepend(entry);
    const drawer=document.createElement('section');drawer.id='canvasMultiAgentDrawer';drawer.className='multi-agent-drawer';drawer.hidden=true;drawer.setAttribute('aria-label','智能分工');
    drawer.innerHTML=`<header><strong>智能分工</strong><button type="button" data-ma-close aria-label="收起智能分工">×</button></header>
        <div class="multi-agent-body">
            <label class="multi-agent-mode"><input type="checkbox" data-ma-mode>使用智能分工处理输入框中的任务</label>
            <p class="multi-agent-hint">按任务需要分配助手；简单问题可直接完成。生成前会按授权请求确认。</p>
            <div class="multi-agent-toolbar"><select data-ma-history aria-label="本画布的分工记录"><option value="">本画布的分工记录</option></select><button type="button" data-ma-refresh>刷新</button></div>
            <p data-ma-notice role="status" class="multi-agent-notice"></p>
            <div data-ma-summary class="multi-agent-summary"></div><div data-ma-actions class="multi-agent-actions"></div><div data-ma-tasks class="multi-agent-tasks"></div>
            <details class="multi-agent-advanced"><summary>高级设置</summary><form data-ma-settings>
                <label>最大层级<input name="max_depth" type="number" min="0" max="2" value="2"></label>
                <label>每位助手最多派遣<input name="max_children" type="number" min="0" max="6" value="6"></label>
                <label>同时处理<input name="concurrency" type="number" min="1" max="3" value="3"></label>
                <label>总执行步数<input name="max_steps" type="number" min="1" max="240" value="120"></label>
                <label>每位助手步数<input name="task_steps" type="number" min="1" max="60" value="24"></label>
                <label>上下文用量上限<input name="max_tokens" type="number" min="500" max="1000000" value="750000"></label>
                <label>每次回复长度上限<input name="max_output_tokens" type="number" min="1024" max="16384" value="4096"></label>
                <label>模型超时（秒）<input name="model_timeout" type="number" min="5" max="600" value="300"></label>
                <label>预计费用预算<input name="max_cost" type="number" min="0" max="10000" step="0.01" value="0"></label>
                <label>每次模型调用费用上限<input name="model_call_cost" type="number" min="0" max="1000" step="0.001" value="0"></label>
                <label>每次生成费用上限<input name="generation_unit_cost" type="number" min="0" max="1000" step="0.001" value="0"></label>
                <label>预先授权生成次数<input name="authorized_generations" type="number" min="0" max="40" value="0"></label>
                <label class="multi-agent-check"><input name="allow_canvas_writes" type="checkbox" checked>允许创建和修改画布节点</label>
                <label class="multi-agent-check"><input name="allow_local_gpu" type="checkbox">允许串行运行已有本地工作流</label>
                <p>费用与预算使用你填写的同一货币单位。单次费用是你提供的预留上限，并非平台报价；未填写生成费用时，每次请求确认。平台实际账单可能不同。修改设置用于下一次新任务。</p>
            </form></details>
        </div>`;
    panel.append(drawer);
    const find=selector=>drawer.querySelector(selector);
    const notice=text=>{find('[data-ma-notice]').textContent=text||'';};
    const key=suffix=>`xiaomei_multi_agent:${scopeKey}:${suffix}`;
    function button(label,callback){const element=document.createElement('button');element.type='button';element.textContent=label;element.addEventListener('click',()=>Promise.resolve(callback()).catch(error=>notice(error.message)));return element;}
    async function api(path,body,method=body?'POST':'GET'){
        const response=await fetch(prefix+path,{method,cache:'no-store',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok){const error=new Error(data.detail?.message||data.detail||'任务状态暂时无法读取，请重试');error.code=data.detail?.code;throw error;}
        return data;
    }
    const scoped=()=>({project_id:scope.project_id,canvas_id:scope.canvas_id});
    const params=()=>new URLSearchParams(scoped()).toString();
    function show(){drawer.hidden=false;entry.setAttribute('aria-expanded','true');resize();}
    function resize(){const footer=panel.querySelector(':scope > footer');drawer.style.bottom=`${Math.max(0,footer?.offsetHeight||0)}px`;drawer.style.top=`${panel.querySelector(':scope > header')?.offsetHeight||50}px`;}
    new ResizeObserver(resize).observe(panel);
    entry.onclick=()=>{syncScope();if(drawer.hidden){mode=true;find('[data-ma-mode]').checked=true;entry.classList.add('is-enabled');show();void history();}else{drawer.hidden=true;entry.setAttribute('aria-expanded','false');}};
    find('[data-ma-close]').onclick=()=>{drawer.hidden=true;entry.setAttribute('aria-expanded','false');};
    find('[data-ma-mode]').onchange=event=>{mode=event.target.checked;entry.classList.toggle('is-enabled',mode);};
    function settings(){
        const values={};for(const field of find('[data-ma-settings]').elements)if(field.name)values[field.name]=field.type==='checkbox'?field.checked:Number(field.value);
        const policy={authorized_generations:values.authorized_generations,allow_canvas_writes:values.allow_canvas_writes,allow_local_gpu:values.allow_local_gpu};
        for(const name of Object.keys(policy))delete values[name];
        return {limits:values,policy};
    }
    find('[data-ma-settings]').onchange=()=>localStorage.setItem(key('settings'),JSON.stringify(settings()));
    function restoreSettings(){
        let saved;try{saved=JSON.parse(localStorage.getItem(key('settings'))||'null');}catch(_){return;}
        for(const field of find('[data-ma-settings]').elements){
            if(!field.name)continue;const value=saved?.policy?.[field.name]??saved?.limits?.[field.name]??config?.policy?.[field.name]??config?.limits?.[field.name];
            if(value===undefined)continue;if(field.type==='checkbox')field.checked=Boolean(value);else field.value=value;
        }
    }
    async function history(){
        if(!scope?.canvas_id)return;
        const token=epoch;
        try{
            const result=await api('/runs?'+params());if(token!==epoch)return;
            const select=find('[data-ma-history]');select.replaceChildren(new Option('本画布的分工记录',''));
            result.runs.forEach(run=>select.add(new Option(`${labels[run.status]||'处理中'} · ${run.goal.slice(0,32)}`,run.run_id)));
            if(!runId){runId=localStorage.getItem(key('run'))||result.runs.find(run=>!terminal.has(run.status))?.run_id||'';}
            if(!result.runs.some(run=>run.run_id===runId)){runId='';snapshot=null;}
            select.value=runId;
            if(runId)await refresh();else render();
        }catch(error){if(token===epoch)notice(error.message);}
    }
    find('[data-ma-history]').onchange=event=>{runId=event.target.value;snapshot=null;localStorage.setItem(key('run'),runId);void refresh();};
    find('[data-ma-refresh]').onclick=()=>void history();
    async function refresh(){
        if(!runId||!scope?.canvas_id||polling)return;
        const token=epoch,id=runId;polling=true;
        try{
            const result=await api(`/runs/${encodeURIComponent(id)}?${params()}`);
            if(token!==epoch||id!==runId)return;
            snapshot=result;render();
            if(!terminal.has(result.run.status)&&!executing){
                for(const action of result.actions.filter(a=>a.operation.tool==='canvas.run_node'&&(['executing','waiting_result'].includes(a.status)||a.status==='registered'&&a.resume_unsubmitted))){
                    await bridge.restore(action);
                    if(token!==epoch||id!==runId)return;
                }
            }
            if(!result.run.recovery_required&&!terminal.has(result.run.status))void pump();
        }catch(error){if(token===epoch)notice(error.message);}
        finally{polling=false;}
    }
    async function approve(action,approved){await api(`/runs/${runId}/actions/${action.action_id}/approve`,{...scoped(),approved});notice(approved?'已确认此操作':'已拒绝此操作');await refresh();}
    function render(){
        const summary=find('[data-ma-summary]'),tasksBox=find('[data-ma-tasks]'),actionsBox=find('[data-ma-actions]');
        const open=new Set([...tasksBox.querySelectorAll('details[open]')].map(el=>el.dataset.taskId));
        const scroll=find('.multi-agent-body').scrollTop;
        summary.replaceChildren();tasksBox.replaceChildren();actionsBox.replaceChildren();
        if(!snapshot){summary.textContent='选择画布中的产品图，在下方输入需求后发送。';return;}
        const run=snapshot.run;
        const selected=find('[data-ma-history]').selectedOptions[0];
        if(selected?.value===run.run_id)selected.textContent=`${labels[run.status]||'处理中'} · ${run.goal.slice(0,32)}`;
        const title=document.createElement('strong');title.textContent=run.goal;
        const status=document.createElement('p');status.textContent=`${labels[run.status]||'处理中'} · ${snapshot.tasks.filter(t=>t.status==='completed').length}/${snapshot.tasks.length} 项完成`;
        summary.append(title,status);
        if(run.error){const p=document.createElement('p');p.textContent=run.error;summary.append(p);}
        if(!terminal.has(run.status))summary.append(button('停止全部',async()=>{
            await api(`/runs/${runId}/interrupt`,scoped());notice('已停止。平台已受理的生成可能继续运行或计费。');await refresh();
        }));
        if(run.recovery_required)summary.append(button('核对后继续',async()=>{await api(`/runs/${runId}/resume`,scoped());notice('已核对已有任务编号，继续未提交步骤');await refresh();}));
        for(const action of snapshot.actions.filter(a=>a.status==='awaiting_approval')){
            const card=document.createElement('div');card.className='multi-agent-approval';
            const text=document.createElement('p');text.textContent=action.error||`需要确认：${action.operation.tool==='canvas.run_node'?'运行生成节点':action.operation.tool==='canvas.delete_node'?'删除节点':action.operation.tool}`;
            const description=document.createElement('details'),heading=document.createElement('summary'),pre=document.createElement('pre');heading.textContent='查看操作';pre.textContent=JSON.stringify(action.operation,null,2);description.append(heading,pre);
            card.append(text,description,button('确认',()=>approve(action,true)),button('拒绝',()=>approve(action,false)));actionsBox.append(card);
        }
        for(const action of snapshot.actions.filter(a=>a.status==='waiting_result'&&a.error)){
            const card=document.createElement('p');card.className='multi-agent-error';
            card.textContent=`${action.error}。可查看对应节点和平台原任务；状态未核对前不会再次生成。停止此项可结束等待。`;actionsBox.append(card);
        }
        for(const action of snapshot.actions.filter(a=>a.operation.tool==='canvas.run_node'&&['claimed','waiting_result'].includes(a.status)&&!a.submission_started&&!a.generation_task_ids?.length&&!a.server_result)){
            const card=document.createElement('div');card.className='multi-agent-approval';
            const text=document.createElement('p');text.textContent='生成命令已领取，尚未记录提交。如果执行页面已经关闭，可继续这一步。';
            card.append(text,button('继续未提交的生成',async()=>{await api(`/runs/${runId}/actions/${action.action_id}/resume-unsubmitted`,scoped());await refresh();}));actionsBox.append(card);
        }
        for(const task of snapshot.tasks){
            const card=document.createElement('article');card.className='multi-agent-task';card.dataset.status=task.status;card.style.setProperty('--agent-depth',Math.min(task.depth,2));
            const header=document.createElement('div');header.className='multi-agent-task-head';
            const who=document.createElement('strong');who.textContent=task.depth?task.agent_role:'主助手';
            const state=document.createElement('small');state.textContent=labels[task.status]||task.status;header.append(who,state);
            const goal=document.createElement('p');goal.textContent=task.goal;card.append(header,goal);
            if(task.summary){const result=document.createElement('p');result.className='multi-agent-result';result.textContent=task.summary;card.append(result);}
            if(task.error){const error=document.createElement('p');error.className='multi-agent-error';error.textContent=task.error;card.append(error);}
            const links=document.createElement('div');links.className='multi-agent-result-links';
            for(const ref of task.result_refs||[]){
                if(ref.kind==='node')links.append(button('查看画布结果',()=>bridge.focus(ref.id)));
                if((ref.kind==='image'||ref.kind==='video')&&/^\/(assets\/|output\/|api\/storage-file)/.test(ref.id)){
                    const link=document.createElement('a');link.href=ref.id;link.target='_blank';link.rel='noopener';link.textContent=ref.kind==='video'?'查看视频':'查看图片';links.append(link);
                }
            }
            if(task.status==='failed')links.append(button('重试分析',async()=>{await api(`/runs/${runId}/tasks/${task.task_id}/retry`,{...scoped(),instructions:''});await refresh();}));
            if(task.depth&&!terminal.has(task.status))links.append(button('停止此项',async()=>{await api(`/runs/${runId}/tasks/${task.task_id}/cancel`,scoped());await refresh();}));
            card.append(links);
            const details=document.createElement('details');details.dataset.taskId=task.task_id;details.open=open.has(task.task_id);
            const label=document.createElement('summary');label.textContent='对话与操作记录';details.append(label);
            const model=document.createElement('small');model.textContent=`${task.provider_id} · ${task.model}`;details.append(model);
            for(const message of task.messages||[]){const pre=document.createElement('pre');pre.textContent=message.content;details.append(pre);}
            const events=snapshot.events.filter(event=>event.task_id===task.task_id&&event.type==='tool_call');
            for(const event of events){const pre=document.createElement('pre');pre.textContent=`${event.tool}\n${JSON.stringify(event.args,null,2)}`;details.append(pre);}
            card.append(details);tasksBox.append(card);
        }
        find('.multi-agent-body').scrollTop=scroll;
    }
    async function pump(){
        if(executing||bridge.isBusy()||!snapshot||snapshot.run.recovery_required||terminal.has(snapshot.run.status))return;
        const action=snapshot.actions.find(a=>a.status==='registered');
        if(!action)return;
        const token=epoch,id=runId,requestScope=scoped();executing=true;
        let claimed=null;
        try{
            await bridge.flush(requestScope.canvas_id);
            if(token!==epoch||id!==runId)return;
            const result=await api(`/runs/${id}/actions/${action.action_id}/claim`,{...requestScope,client_id:clientId});
            claimed=result.action;
            if(token!==epoch||id!==runId)return;
            const receipt=await bridge.execute(claimed);
            if(token!==epoch||id!==runId)return;
            await api(`/runs/${id}/actions/${action.action_id}/receipt`,{...requestScope,...receipt,lease_token:claimed.lease_token,status:'applied'});
        }catch(error){
            if(token===epoch&&!['canvas_busy','gpu_busy','generation_busy','already_claimed'].includes(error.code))notice(error.message);
            if(claimed&&token===epoch){
                try{await api(`/runs/${id}/actions/${action.action_id}/receipt`,{...requestScope,lease_token:claimed.lease_token,status:'failed',error:String(error.message).slice(0,1000),node_ids:[]});}catch(_){/* Keep the durable action waiting for recovery. */}
            }
        }finally{executing=false;if(token===epoch)setTimeout(()=>void refresh(),250);}
    }
    window.CanvasMultiAgent={
        enabled:()=>mode,
        async start(goal){
            if(loading)throw new Error('任务正在提交，请稍候');
            if(snapshot&&!terminal.has(snapshot.run.status))throw new Error('本画布已有分工任务，请先查看或停止');
            loading=true;const token=epoch;
            try{
                const context=await bridge.prepare();
                if(token!==epoch)throw new Error('画布已切换，请重新发送');
                if(!context.provider_id||!context.model)throw new Error('请先在 Agent 设置中选择对话模型');
                const draft={...context,...settings(),goal};
                let previous;try{previous=JSON.parse(localStorage.getItem(key('pending'))||'null');}catch(_){}
                const idempotencyKey=previous?.signature===JSON.stringify(draft)?previous.idempotency_key:`request-${requestId()}`;
                localStorage.setItem(key('pending'),JSON.stringify({signature:JSON.stringify(draft),idempotency_key:idempotencyKey}));
                const data=await api('/runs',{...draft,idempotency_key:idempotencyKey});
                if(token!==epoch)return;
                runId=data.run_id;snapshot=data;localStorage.setItem(key('run'),runId);localStorage.removeItem(key('pending'));
                show();notice('任务已开始，生成和删除操作会按授权确认');render();void history();
            }finally{loading=false;}
        }
    };
    function syncScope(){
        const next=bridge.current(),nextKey=`${next.project_id}:${next.canvas_id}`;
        if(nextKey===scopeKey)return;
        scope=next;scopeKey=nextKey;epoch++;runId='';snapshot=null;mode=false;entry.classList.remove('is-enabled');find('[data-ma-mode]').checked=false;
        find('[data-ma-history]').replaceChildren(new Option('本画布的分工记录',''));notice('');render();restoreSettings();
        if(next.canvas_id)void history();
    }
    setInterval(()=>{syncScope();if(runId)void refresh();},1200);
    void api('/config').then(value=>{config=value;restoreSettings();}).catch(error=>notice(error.message));
    syncScope();
})();
