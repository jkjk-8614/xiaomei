(function(){
    'use strict';

    const state = {
        modal:null, stage:null, graph:null, sidebar:null, status:null, history:null,
        nodeId:'', selectedId:'', selectedRun:null, runs:[], skills:[], providers:[],
        drag:null, link:null, pointer:null, pointerClient:null, pan:null, zoom:1,
        edited:new Map(), watching:new Set()
    };
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[char]);
    const is = node => Boolean(node?.type === 'smart-agent' && node.agentMode === 'expert-workflow');
    const isBusy = node => Boolean(node?.running || ['queued','running'].includes(node?.expertRunStatus)
        || (node?.id && smartDependencyRuns.get(node.id)?.waiting));
    const canEdit = (node, quiet=false) => Boolean(node && !isBusy(node) && collabCanMutateCanvas(quiet));
    const newWorkflow = () => ({version:1, name:'专家协作', experts:[], edges:[]});
    const executionSignature = workflow => ({
        experts:(workflow?.experts || []).map(item => ({
            id:item.id, name:item.name, skill_id:item.skill_id, provider:item.provider,
            model:item.model, instruction:item.instruction, output_format:item.output_format,
            pause_after:Boolean(item.pause_after)
        })),
        edges:(workflow?.edges || []).map(item => ({from:item.from, to:item.to}))
    });
    const currentNode = () => nodes.find(node => node.id === state.nodeId && is(node));
    const workflowFor = node => {
        if(!node.expertWorkflow || !Array.isArray(node.expertWorkflow.experts) || !Array.isArray(node.expertWorkflow.edges)){
            node.expertWorkflow = newWorkflow();
        }
        return node.expertWorkflow;
    };
    const statusLabel = value => ({
        queued:'等待运行', running:'运行中', completed:'已完成', failed:'运行失败',
        paused:'待审阅', cancelled:'已停止', interrupted:'已中断', reused:'已沿用',
        waiting:'等待上游', outdated:'配置已修改', idle:'未运行'
    })[value] || '未运行';
    const short = (value, count=140) => {
        const text = String(value || '').trim();
        return text.length > count ? text.slice(0, count) + '…' : text;
    };
    function inputText(node){
        const seen = new Set();
        return workflowInputNodesFor(node).map(source => {
            const value = String(textForNode(source) || '').trim();
            if(!value || seen.has(value)) return '';
            seen.add(value);
            return '来自「' + (source.title || source.id) + '」：\n' + value;
        }).filter(Boolean).join('\n\n');
    }

    function nodeBodyHtml(node){
        const flow = workflowFor(node);
        const count = flow.experts.length;
        const status = node.expertRunStatus || 'idle';
        const busy = isBusy(node);
        // 输出预览必须保留完整结果。`short()` 只适合输入卡片和职责摘要，
        // 不能用于这里，否则长提示词会在节点里被省略号截断。
        const preview = node.outputText
            ? (status === 'completed' ? '' : '上次结果：') + String(node.outputText).trim()
            : (count ? '打开编排，查看专家和连线。' : '添加专家并连接流程。');
        return [
            '<div class="expert-workflow-node">',
            '<div class="expert-workflow-node-head"><span class="expert-workflow-node-mark"><i data-lucide="network"></i></span>',
            '<div><strong>', esc(flow.name || '专家协作'), '</strong><small>', count, ' 位专家 · ', esc(statusLabel(status)), '</small></div></div>',
            '<label class="expert-workflow-node-brief"><span>任务要求</span><textarea class="agent-node-control expert-workflow-node-input" placeholder="填写任务，或连接上游文字、图片和文件"',
            busy ? ' disabled' : '', '>',
            esc(node.userPrompt || ''), '</textarea></label>',
            '<div class="expert-workflow-node-preview">', esc(preview), '</div>',
            '<div class="expert-workflow-node-actions">',
            '<button type="button" class="agent-node-control expert-workflow-open"><i data-lucide="workflow"></i>打开编排</button>',
            '<button type="button" class="agent-node-control expert-workflow-run">',
            '<i data-lucide="', busy ? 'square' : status === 'paused' ? 'eye' : 'play', '"></i>',
            busy ? '停止' : status === 'paused' ? '审阅' : '运行', '</button>',
            '</div></div>'
        ].join('');
    }

    function bindNode(el, node){
        el.querySelector('.expert-workflow-open')?.addEventListener('click', event => {
            event.stopPropagation();
            void open(node);
        });
        el.querySelector('.expert-workflow-run')?.addEventListener('click', event => {
            event.stopPropagation();
            if(isBusy(node)) void stop(node);
            else if(node.expertRunStatus === 'paused') void open(node);
            else runAgentNode(node.id);
        });
        el.querySelector('.expert-workflow-node-input')?.addEventListener('input', event => {
            if(isBusy(node)) return;
            node.userPrompt = event.target.value;
            node.expertRunStatus = node.outputText ? 'outdated' : 'idle';
            scheduleSave();
        });
    }

    function ensureModal(){
        if(state.modal) return state.modal;
        const root = document.createElement('div');
        root.className = 'expert-workflow-overlay';
        root.hidden = true;
        root.innerHTML = [
            '<div class="expert-workflow-dialog" role="dialog" aria-modal="true" aria-label="专家协作编排" tabindex="-1">',
            '<header class="expert-workflow-header"><div class="expert-workflow-header-name">',
            '<span class="expert-workflow-header-icon"><i data-lucide="network"></i></span>',
            '<label><span>专家协作流程</span><input class="expert-workflow-name" maxlength="80" aria-label="流程名称"></label></div>',
            '<div class="expert-workflow-header-actions"><span class="expert-workflow-status" role="status"></span>',
            '<button type="button" class="expert-workflow-add"><i data-lucide="plus"></i>添加专家</button>',
            '<button type="button" class="expert-workflow-start"><i data-lucide="play"></i>运行流程</button>',
            '<button type="button" class="expert-workflow-close" aria-label="关闭"><i data-lucide="x"></i></button></div></header>',
            '<div class="expert-workflow-subhead"><span>拖动卡片排版 · 从右侧端点拖线连接，松开空白处添加专家 · 拖动空白处平移</span>',
            '<div class="expert-workflow-view-tools"><button type="button" data-ew-zoom="out" aria-label="缩小">−</button>',
            '<output class="expert-workflow-zoom-label">100%</output>',
            '<button type="button" data-ew-zoom="in" aria-label="放大">+</button>',
            '<button type="button" data-ew-zoom="reset" aria-label="恢复 100%">100%</button></div>',
            '<label>运行记录 <select class="expert-workflow-history" aria-label="运行记录"></select></label></div>',
            '<div class="expert-workflow-main"><div class="expert-workflow-viewport"><div class="expert-workflow-stage"></div></div>',
            '<aside class="expert-workflow-sidebar"></aside></div>',
            '</div>'
        ].join('');
        document.body.appendChild(root);
        state.modal = root;
        state.stage = root.querySelector('.expert-workflow-stage');
        state.sidebar = root.querySelector('.expert-workflow-sidebar');
        state.status = root.querySelector('.expert-workflow-status');
        state.history = root.querySelector('.expert-workflow-history');
        root.querySelector('.expert-workflow-close').addEventListener('click', close);
        root.querySelector('.expert-workflow-add').addEventListener('click', addExpert);
        root.querySelector('.expert-workflow-start').addEventListener('click', () => {
            const node = currentNode();
            if(!node) return;
            if(isBusy(node)) void stop(node);
            else {
                if(node.expertRunStatus === 'paused'){
                    node.expertRunStatus = 'idle';
                    scheduleSave();
                }
                runAgentNode(node.id);
            }
        });
        root.querySelector('.expert-workflow-name').addEventListener('input', event => {
            const node = currentNode();
            if(!canEdit(node, true)) return;
            workflowFor(node).name = event.target.value;
            scheduleSave();
            render({nodeIds:[node.id]});
        });
        state.history.addEventListener('change', () => void selectHistory(state.history.value));
        root.querySelectorAll('[data-ew-zoom]').forEach(button => button.addEventListener('click', () => {
            const direction = button.dataset.ewZoom;
            setZoom(direction === 'reset' ? 1 : state.zoom + (direction === 'in' ? 0.15 : -0.15));
        }));
        state.stage.addEventListener('click', stageClick);
        state.stage.addEventListener('pointerdown', stagePointerDown);
        const viewport = root.querySelector('.expert-workflow-viewport');
        viewport.addEventListener('wheel', event => {
            if(event.shiftKey) return;
            event.preventDefault();
            setZoom(state.zoom + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX, event.clientY);
        }, {passive:false});
        viewport.addEventListener('scroll', () => {
            if(state.link && state.pointerClient){
                state.pointer = pointerInStage(state.pointerClient);
                drawEdges();
            }
        });
        state.sidebar.addEventListener('input', sidebarInput);
        state.sidebar.addEventListener('change', sidebarChange);
        state.sidebar.addEventListener('click', sidebarClick);
        document.addEventListener('pointermove', pointerMove);
        document.addEventListener('pointerup', pointerUp);
        document.addEventListener('pointercancel', cancelPointer);
        root.addEventListener('pointerdown', event => event.stopPropagation());
        root.addEventListener('wheel', event => event.stopPropagation());
        root.addEventListener('dblclick', event => event.stopPropagation());
        root.addEventListener('keydown', event => {
            if(event.key === 'Escape') close();
            event.stopPropagation();
        });
        root.addEventListener('click', event => {
            if(event.target === root) close();
            event.stopPropagation();
        });
        return root;
    }

    function close(){
        if(!state.modal) return;
        state.modal.hidden = true;
        state.drag = null;
        state.link = null;
        state.pointer = null;
        state.pointerClient = null;
        state.pan = null;
    }

    async function open(node){
        if(!is(node)) return;
        ensureModal();
        state.nodeId = node.id;
        state.selectedId = workflowFor(node).experts[0]?.id || 'input';
        state.selectedRun = null;
        state.edited.clear();
        state.modal.hidden = false;
        state.stage.style.zoom = String(state.zoom);
        updateZoomLabel();
        state.modal.querySelector('.expert-workflow-dialog').focus();
        state.modal.querySelector('.expert-workflow-name').value = workflowFor(node).name || '专家协作';
        renderAll();
        void loadCatalogs();
        void loadHistory(node);
        if(node.expertRunId){
            try {
                const run = await getRun(node.expertRunId);
                if(state.nodeId === node.id){
                    state.selectedRun = run;
                    syncNodeRun(node, run);
                    renderAll();
                }
            } catch(error){
                setStatus('运行记录读取失败：' + (error.message || error), 'failed');
            }
        }
        if(window.lucide) lucide.createIcons({nodes:[state.modal]});
    }

    async function loadCatalogs(){
        const results = await Promise.allSettled([
            fetch('/api/agent-skills', {cache:'no-store'}).then(readJson),
            fetch('/api/providers', {cache:'no-store'}).then(readJson)
        ]);
        if(results[0].status === 'fulfilled'){
            state.skills = (results[0].value.skills || []).filter(item => item && item.id);
        } else setStatus('Skill 列表读取失败，请检查本地服务后重试', 'failed');
        if(results[1].status === 'fulfilled'){
            state.providers = (results[1].value.providers || []).filter(item => item && item.enabled !== false
                && !isModelScopeProvider(item) && Array.isArray(item.chat_models) && item.chat_models.length);
        } else setStatus('模型列表读取失败，请检查 API 设置', 'failed');
        renderGraph();
        renderSidebar();
    }

    function setStatus(message, phase='idle'){
        if(!state.status) return;
        state.status.textContent = message;
        state.status.dataset.phase = phase;
    }

    function markChanged(node){
        if(!node) return;
        node.expertRunStatus = node.outputText ? 'outdated' : 'idle';
        scheduleSave();
        render({nodeIds:[node.id]});
    }

    function cardHtml(id, title, subtitle, position, kind, phase, description=''){
        return [
            '<div class="expert-workflow-card ', kind, ' ', id === state.selectedId ? 'selected' : '',
            '" data-ew-card="', esc(id), '" data-ew-drag="', esc(id), '" data-phase="', esc(phase || 'idle'),
            '" style="left:', Math.round(position.x), 'px;top:', Math.round(position.y), 'px">',
            kind === 'input' ? '' : '<span class="expert-workflow-port in" data-ew-in="' + esc(id) + '" title="连接输入"></span>',
            '<div class="expert-workflow-card-head"><span class="expert-workflow-card-icon"><i data-lucide="',
            kind === 'input' ? 'arrow-right' : kind === 'output' ? 'flag' : 'bot', '"></i></span>',
            '<strong>', esc(title), '</strong></div>',
            '<div class="expert-workflow-card-sub">', esc(subtitle), '</div>',
            description ? '<div class="expert-workflow-card-description"><span>职责</span>' + esc(description) + '</div>' : '',
            kind === 'output' ? '' : '<span class="expert-workflow-port out" data-ew-out="' + esc(id) + '" title="拖动连接下一步"></span>',
            '</div>'
        ].join('');
    }

    function graphPositions(flow){
        const result = {input:flow.positions?.input || {x:50,y:300}};
        flow.experts.forEach((item, index) => {
            result[item.id] = {
                x:Number.isFinite(Number(item.x)) ? Number(item.x) : 330 + index * 300,
                y:Number.isFinite(Number(item.y)) ? Number(item.y) : 275
            };
        });
        const right = flow.experts.reduce((value, item) => Math.max(value, result[item.id].x), 330);
        result.output = flow.positions?.output || {x:Math.max(740, right + 310), y:300};
        return result;
    }

    function renderGraph(){
        const node = currentNode();
        if(!node || !state.stage) return;
        const flow = workflowFor(node);
        const pos = graphPositions(flow);
        const width = Math.max(1150, ...Object.values(pos).map(item => item.x + 270));
        const height = Math.max(800, ...Object.values(pos).map(item => item.y + 240));
        state.stage.style.width = width + 'px';
        state.stage.style.height = height + 'px';
        const runSteps = new Map((state.selectedRun?.steps || []).map(step => [step.id, step]));
        const upstream = inputText(node);
        const refs = promptNodeInputMediaForLLM(node);
        const cards = [
            cardHtml('input', '输入', short([upstream, node.userPrompt].filter(Boolean).join(' · '), 90) || (refs.length ? refs.length + ' 项素材' : '填写任务或连接上游'), pos.input, 'input', 'idle')
        ];
        flow.experts.forEach(item => {
            const skill = state.skills.find(row => row.id === item.skill_id);
            const step = runSteps.get(item.id);
            const subtitle = [skill?.name || item.skill_id || '未选择 Skill', item.model || '未选择模型',
                step?.status ? statusLabel(step.status) : ''].filter(Boolean).join(' · ');
            cards.push(cardHtml(item.id, item.name || '未命名专家', subtitle, pos[item.id], 'expert',
                step?.status || 'idle', short(item.instruction || '未填写职责', 150)));
        });
        cards.push(cardHtml('output', '输出', short(state.selectedRun?.output || node.outputText || '最终结果交给下游节点', 90),
            pos.output, 'output', state.selectedRun?.status || 'idle'));
        state.stage.innerHTML = '<svg class="expert-workflow-lines" aria-hidden="true"></svg>' + cards.join('');
        drawEdges();
        if(window.lucide) lucide.createIcons({nodes:[state.stage]});
    }

    function cardCenter(id, side){
        const card = [...state.stage.querySelectorAll('[data-ew-card]')].find(item => item.dataset.ewCard === id);
        if(!card) return null;
        return {
            x:card.offsetLeft + (side === 'out' ? card.offsetWidth : 0),
            y:card.offsetTop + card.offsetHeight / 2
        };
    }
    function pathBetween(from, to){
        const dx = Math.max(70, Math.abs(to.x - from.x) * 0.45);
        return 'M ' + from.x + ' ' + from.y + ' C ' + (from.x + dx) + ' ' + from.y
            + ', ' + (to.x - dx) + ' ' + to.y + ', ' + to.x + ' ' + to.y;
    }
    function drawEdges(){
        const node = currentNode();
        const svg = state.stage?.querySelector('.expert-workflow-lines');
        if(!node || !svg) return;
        svg.setAttribute('width', state.stage.style.width);
        svg.setAttribute('height', state.stage.style.height);
        const paths = workflowFor(node).edges.map((edge, index) => {
            const from = cardCenter(edge.from, 'out');
            const to = cardCenter(edge.to, 'in');
            if(!from || !to) return '';
            const path = esc(pathBetween(from, to));
            return '<path class="expert-workflow-line" d="' + path + '"></path>'
                + '<path class="expert-workflow-line-hit" d="' + path + '" data-ew-edge="' + index + '"></path>';
        });
        if(state.link && state.pointer){
            const from = cardCenter(state.link.from, 'out');
            if(from) paths.push('<path class="expert-workflow-line preview" d="' + esc(pathBetween(from, state.pointer)) + '"></path>');
        }
        svg.innerHTML = paths.join('');
    }

    function renderSidebar(){
        const node = currentNode();
        if(!node || !state.sidebar) return;
        const flow = workflowFor(node);
        const expert = flow.experts.find(item => item.id === state.selectedId);
        if(!expert){
            const output = state.selectedId === 'output';
            state.sidebar.innerHTML = '<h3>' + (output ? '最终输出' : '流程输入') + '</h3><p>'
                + (output ? '最后一位专家的文字结果会从外层节点的输出端交给下游。'
                    : '外层节点的任务要求与上游文字、图片、文件会进入这条流程。')
                + '</p>' + (output && state.selectedRun?.output
                    ? '<div class="expert-workflow-result">' + esc(state.selectedRun.output) + '</div>' : '');
            return;
        }
        const skillOptions = state.skills.filter(item => item.enabled !== false).map(item =>
            '<option value="' + esc(item.id) + '"' + (expert.skill_id === item.id ? ' selected' : '') + '>' + esc(item.name || item.id) + '</option>');
        if(expert.skill_id && !state.skills.some(item => item.id === expert.skill_id && item.enabled !== false)){
            skillOptions.unshift('<option value="' + esc(expert.skill_id) + '" selected>Skill 不可用：' + esc(expert.skill_id) + '</option>');
        }
        const providerOptions = state.providers.map(item =>
            '<option value="' + esc(item.id) + '"' + (expert.provider === item.id ? ' selected' : '') + '>' + esc(item.name || item.id) + '</option>');
        if(expert.provider && !state.providers.some(item => item.id === expert.provider)){
            providerOptions.unshift('<option value="' + esc(expert.provider) + '" selected>平台不可用：' + esc(expert.provider) + '</option>');
        }
        const provider = state.providers.find(item => item.id === expert.provider);
        const models = Array.isArray(provider?.chat_models) ? provider.chat_models : [];
        const modelOptions = models.map(model =>
            '<option value="' + esc(model) + '"' + (expert.model === model ? ' selected' : '') + '>' + esc(model) + '</option>');
        if(expert.model && !models.includes(expert.model)){
            modelOptions.unshift('<option value="' + esc(expert.model) + '" selected>模型不可用：' + esc(expert.model) + '</option>');
        }
        const step = state.selectedRun?.steps?.find(item => item.id === expert.id);
        const edited = state.edited.has(expert.id) ? state.edited.get(expert.id) : step?.output || '';
        const index = state.selectedRun?.steps?.findIndex(item => item.id === expert.id) ?? -1;
        const locked = isBusy(node) ? ' disabled' : '';
        const runStopped = state.selectedRun && !['queued','running'].includes(state.selectedRun.status) && !isBusy(node);
        const priorComplete = state.selectedRun?.steps?.slice(0, index).every(item => ['completed','reused'].includes(item.status));
        const canContinue = runStopped && step && ['completed','reused'].includes(step.status)
            && index < state.selectedRun.steps.length - 1;
        const canRetry = runStopped && step && priorComplete
            && ['failed','cancelled','running','waiting'].includes(step.status)
            && ['failed','cancelled','interrupted'].includes(state.selectedRun.status);
        state.sidebar.innerHTML = [
            '<div class="expert-workflow-sidebar-head"><h3>专家设置</h3><button type="button" data-ew-delete', locked, '>删除专家</button></div>',
            '<label>名称<input data-ew-field="name" maxlength="80" value="', esc(expert.name || ''), '"', locked, '></label>',
            '<label>Skill<select data-ew-field="skill_id"', locked, '><option value="">选择 Skill</option>', skillOptions.join(''), '</select></label>',
            '<label>API 平台<select data-ew-field="provider"', locked, '><option value="">选择平台</option>', providerOptions.join(''), '</select></label>',
            '<label>聊天模型<select data-ew-field="model"', locked, '><option value="">选择模型</option>', modelOptions.join(''), '</select></label>',
            '<label>职责<textarea data-ew-field="instruction" rows="4" maxlength="3000" placeholder="这一位专家具体负责什么"', locked, '>', esc(expert.instruction || ''), '</textarea></label>',
            '<label>交付要求<textarea data-ew-field="output_format" rows="3" maxlength="1500" placeholder="例如：输出问题清单和修改建议"', locked, '>', esc(expert.output_format || ''), '</textarea></label>',
            '<label class="expert-workflow-checkbox"><input type="checkbox" data-ew-field="pause_after"',
            expert.pause_after ? ' checked' : '', locked, '> 完成后暂停，等待我审阅</label>',
            step ? '<div class="expert-workflow-step-result"><h4>本次结果 · ' + esc(statusLabel(step.status)) + '</h4>'
                + (step.error ? '<p class="expert-workflow-error">' + esc(step.error) + '</p>' : '')
                + '<details><summary>查看交给这位专家的文字</summary><pre>' + esc(step.input || '') + '</pre></details>'
                + '<textarea data-ew-edited rows="8" aria-label="修改专家结果" placeholder="完成后可在这里修改结果">' + esc(edited) + '</textarea>'
                + (canContinue ? '<button type="button" class="expert-workflow-continue" data-ew-continue="' + index + '">从这里继续</button>' : '')
                + (canRetry ? '<button type="button" class="expert-workflow-continue" data-ew-retry="' + (index - 1) + '">从这里重试</button>' : '')
                + '</div>' : '',
        ].join('');
    }

    function renderHistory(){
        if(!state.history) return;
        const options = ['<option value="">最近运行</option>'];
        state.runs.forEach(item => {
            const date = item.created_at ? new Date(item.created_at * 1000).toLocaleString('zh-CN') : '';
            options.push('<option value="' + esc(item.id) + '"' + (state.selectedRun?.id === item.id ? ' selected' : '')
                + '>' + esc(date + ' · ' + statusLabel(item.status)) + '</option>');
        });
        state.history.innerHTML = options.join('');
    }
    function renderAll(){
        const node = currentNode();
        if(!node) return;
        state.modal.querySelector('.expert-workflow-name').value = workflowFor(node).name || '专家协作';
        setStatus(state.selectedRun ? statusLabel(state.selectedRun.status) : statusLabel(node.expertRunStatus), state.selectedRun?.status || node.expertRunStatus || 'idle');
        renderRunControls(node);
        renderGraph();
        renderSidebar();
        renderHistory();
        if(window.lucide) lucide.createIcons({nodes:[state.modal]});
    }
    function renderRunControls(node){
        const start = state.modal.querySelector('.expert-workflow-start');
        const busy = isBusy(node);
        state.modal.classList.toggle('is-busy', busy);
        start.innerHTML = '<i data-lucide="' + (busy ? 'square' : 'play') + '"></i>'
            + (busy ? '停止运行' : node.expertRunStatus === 'paused' ? '从头运行' : '运行流程');
        state.modal.querySelector('.expert-workflow-name').disabled = busy;
        state.modal.querySelector('.expert-workflow-add').disabled = busy;
        if(window.lucide) lucide.createIcons({nodes:[start]});
    }

    function createExpert(flow, position){
        const last = flow.experts[flow.experts.length - 1];
        const id = 'expert_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        const provider = state.providers[0];
        const expert = {
            id, name:'专家 ' + (flow.experts.length + 1), skill_id:'',
            provider:provider?.id || '', model:provider?.chat_models?.[0] || '',
            instruction:'', output_format:'', pause_after:false,
            x:position?.x ?? (last ? Math.round(Number(last.x || 330) + 300) : 330),
            y:position?.y ?? (last ? Math.round(Number(last.y || 275)) : 275)
        };
        flow.experts.push(expert);
        state.selectedId = id;
        return expert;
    }

    function addExpert(){
        const node = currentNode();
        if(!canEdit(node)) return;
        const flow = workflowFor(node);
        if(flow.experts.length >= 12){ toast('一个流程最多添加 12 位专家'); return; }
        pushUndo();
        const last = flow.experts[flow.experts.length - 1];
        const predecessor = flow.edges.find(edge => edge.to === 'output')?.from || (last?.id || 'input');
        flow.edges = flow.edges.filter(edge => edge.to !== 'output');
        const expert = createExpert(flow);
        flow.edges.push({from:predecessor, to:expert.id}, {from:expert.id, to:'output'});
        markChanged(node);
        renderAll();
    }

    function addExpertFromLink(node, sourceId, point){
        const flow = workflowFor(node);
        if(flow.experts.length >= 12){ toast('一个流程最多添加 12 位专家'); return; }
        pushUndo();
        const next = flow.edges.find(edge => edge.from === sourceId)?.to;
        flow.edges = flow.edges.filter(edge => edge.from !== sourceId);
        const expert = createExpert(flow, {
            x:Math.max(20, Math.round(point.x - 120)),
            y:Math.max(20, Math.round(point.y - 71))
        });
        flow.edges.push({from:sourceId, to:expert.id});
        if(next) flow.edges.push({from:expert.id, to:next});
        else if(!flow.edges.some(edge => edge.to === 'output')) flow.edges.push({from:expert.id, to:'output'});
        markChanged(node);
        renderAll();
    }

    function deleteExpert(){
        const node = currentNode();
        if(!canEdit(node)) return;
        const flow = workflowFor(node);
        const id = state.selectedId;
        if(!flow.experts.some(item => item.id === id)) return;
        pushUndo();
        const preceding = flow.edges.find(edge => edge.to === id)?.from;
        const following = flow.edges.find(edge => edge.from === id)?.to;
        flow.experts = flow.experts.filter(item => item.id !== id);
        flow.edges = flow.edges.filter(edge => edge.from !== id && edge.to !== id);
        if(preceding && following) flow.edges.push({from:preceding, to:following});
        state.selectedId = following && following !== 'output' ? following : (flow.experts[0]?.id || 'input');
        markChanged(node);
        renderAll();
    }

    function stageClick(event){
        const node = currentNode();
        if(!node) return;
        const edge = event.target.closest('[data-ew-edge]');
        if(edge){
            if(!canEdit(node)) return;
            pushUndo();
            workflowFor(node).edges.splice(Number(edge.dataset.ewEdge), 1);
            markChanged(node);
            renderGraph();
            return;
        }
        if(event.target.closest('.expert-workflow-port')) return;
        const card = event.target.closest('[data-ew-card]');
        if(!card) return;
        state.selectedId = card.dataset.ewCard;
        renderGraph();
        renderSidebar();
    }

    function stagePointerDown(event){
        if(event.button !== 0) return;
        const node = currentNode();
        if(!node) return;
        const outputPort = event.target.closest('[data-ew-out]');
        const handle = event.target.closest('[data-ew-drag]');
        if(!outputPort && !handle && !event.target.closest('[data-ew-edge],.expert-workflow-port')){
            const viewport = state.stage.parentElement;
            state.pan = {
                pointerId:event.pointerId, startX:event.clientX, startY:event.clientY,
                left:viewport.scrollLeft, top:viewport.scrollTop
            };
            event.preventDefault();
            return;
        }
        if(!canEdit(node, true)) return;
        if(outputPort){
            event.preventDefault();
            state.link = {from:outputPort.dataset.ewOut, pointerId:event.pointerId};
            state.pointerClient = {clientX:event.clientX, clientY:event.clientY};
            state.pointer = pointerInStage(event);
            drawEdges();
            return;
        }
        if(event.target.closest('.expert-workflow-port')) return;
        if(!handle) return;
        const start = graphPositions(workflowFor(node))[handle.dataset.ewDrag];
        if(!start) return;
        event.preventDefault();
        state.drag = {
            id:handle.dataset.ewDrag, pointerId:event.pointerId,
            startX:event.clientX, startY:event.clientY,
            x:Number(start.x), y:Number(start.y), moved:false
        };
        state.selectedId = handle.dataset.ewDrag;
        renderSidebar();
    }

    function pointerInStage(event){
        const rect = state.stage.getBoundingClientRect();
        return {x:(event.clientX - rect.left) / state.zoom,
            y:(event.clientY - rect.top) / state.zoom};
    }

    function updateZoomLabel(){
        const label = state.modal?.querySelector('.expert-workflow-zoom-label');
        if(label) label.textContent = Math.round(state.zoom * 100) + '%';
    }

    function setZoom(value, clientX, clientY){
        if(!state.stage) return;
        const next = Math.round(Math.max(0.5, Math.min(2, value)) * 100) / 100;
        if(next === state.zoom) return;
        const viewport = state.stage.parentElement;
        const rect = viewport.getBoundingClientRect();
        const anchorX = (clientX ?? (rect.left + rect.width / 2)) - rect.left;
        const anchorY = (clientY ?? (rect.top + rect.height / 2)) - rect.top;
        const ratio = next / state.zoom;
        const left = (viewport.scrollLeft + anchorX) * ratio - anchorX;
        const top = (viewport.scrollTop + anchorY) * ratio - anchorY;
        state.zoom = next;
        state.stage.style.zoom = String(next);
        viewport.scrollLeft = left;
        viewport.scrollTop = top;
        updateZoomLabel();
        if(state.link && state.pointerClient){
            state.pointer = pointerInStage(state.pointerClient);
            drawEdges();
        }
    }

    function pointerMove(event){
        if(!state.modal || state.modal.hidden) return;
        if(state.link){
            if(event.pointerId !== state.link.pointerId) return;
            state.pointerClient = {clientX:event.clientX, clientY:event.clientY};
            state.pointer = pointerInStage(event);
            drawEdges();
            return;
        }
        if(state.pan){
            if(event.pointerId !== state.pan.pointerId) return;
            const viewport = state.stage.parentElement;
            viewport.scrollLeft = state.pan.left - (event.clientX - state.pan.startX);
            viewport.scrollTop = state.pan.top - (event.clientY - state.pan.startY);
            return;
        }
        if(!state.drag || event.pointerId !== state.drag.pointerId) return;
        const node = currentNode();
        if(!node) return;
        const flow = workflowFor(node);
        const position = state.drag.id === 'input' || state.drag.id === 'output'
            ? ((flow.positions ||= {})[state.drag.id] ||= {...graphPositions(flow)[state.drag.id]})
            : flow.experts.find(item => item.id === state.drag.id);
        if(!position) return;
        const x = Math.max(20, Math.round(state.drag.x + (event.clientX - state.drag.startX) / state.zoom));
        const y = Math.max(20, Math.round(state.drag.y + (event.clientY - state.drag.startY) / state.zoom));
        if((x !== position.x || y !== position.y) && !state.drag.moved){
            pushUndo();
            state.drag.moved = true;
        }
        position.x = x;
        position.y = y;
        const card = [...state.stage.querySelectorAll('[data-ew-card]')].find(item => item.dataset.ewCard === state.drag.id);
        if(card){ card.style.left = x + 'px'; card.style.top = y + 'px'; }
        state.stage.style.width = Math.max(state.stage.offsetWidth, x + 270) + 'px';
        state.stage.style.height = Math.max(state.stage.offsetHeight, y + 240) + 'px';
        drawEdges();
    }

    function pointerUp(event){
        if(!state.modal || state.modal.hidden) return;
        const node = currentNode();
        if(state.link){
            if(event.pointerId !== state.link.pointerId) return;
            const hit = document.elementFromPoint(event.clientX, event.clientY);
            const target = hit?.closest('[data-ew-in]');
            const sourceId = state.link.from;
            state.link = null;
            state.pointer = null;
            state.pointerClient = null;
            if(target && node && target.dataset.ewIn !== sourceId && canEdit(node, true)){
                const targetId = target.dataset.ewIn;
                const flow = workflowFor(node);
                pushUndo();
                flow.edges = flow.edges.filter(edge => edge.from !== sourceId && edge.to !== targetId);
                flow.edges.push({from:sourceId, to:targetId});
                markChanged(node);
                renderGraph();
            } else if(node && canEdit(node, true) && state.stage.contains(hit)
                && !hit.closest('[data-ew-card]')){
                addExpertFromLink(node, sourceId, pointerInStage(event));
            } else drawEdges();
            return;
        }
        if(state.pan){
            if(event.pointerId === state.pan.pointerId) state.pan = null;
            return;
        }
        if(!state.drag || event.pointerId !== state.drag.pointerId) return;
        const moved = state.drag.moved;
        state.drag = null;
        if(moved && node) scheduleSave();
        renderGraph();
    }

    function cancelPointer(event){
        if(state.pan?.pointerId === event.pointerId) state.pan = null;
        if(state.link?.pointerId === event.pointerId){
            state.link = null;
            state.pointer = null;
            state.pointerClient = null;
            drawEdges();
        }
        if(state.drag?.pointerId === event.pointerId){
            const moved = state.drag.moved;
            state.drag = null;
            if(moved) scheduleSave();
            renderGraph();
        }
    }

    function sidebarInput(event){
        const node = currentNode();
        if(!node) return;
        if(event.target.matches('[data-ew-edited]')){
            state.edited.set(state.selectedId, event.target.value);
            return;
        }
        const field = event.target.dataset.ewField;
        if(field === 'provider' || field === 'model'){
            sidebarChange(event);
            return;
        }
        if(!['name','instruction','output_format'].includes(field) || !canEdit(node, true)) return;
        const expert = workflowFor(node).experts.find(item => item.id === state.selectedId);
        if(!expert) return;
        expert[field] = event.target.value;
        markChanged(node);
        if(field === 'name') renderGraph();
    }

    function sidebarChange(event){
        const node = currentNode();
        const field = event.target.dataset.ewField;
        if(!node || !['skill_id','provider','model','pause_after'].includes(field) || !canEdit(node, true)) return;
        const expert = workflowFor(node).experts.find(item => item.id === state.selectedId);
        if(!expert) return;
        const value = field === 'pause_after' ? event.target.checked : event.target.value;
        if(expert[field] === value) return;
        expert[field] = value;
        if(field === 'provider'){
            const provider = state.providers.find(item => item.id === expert.provider);
            expert.model = provider?.chat_models?.[0] || '';
        }
        markChanged(node);
        renderGraph();
        renderSidebar();
    }

    function sidebarClick(event){
        if(event.target.closest('[data-ew-delete]')){ deleteExpert(); return; }
        const continueButton = event.target.closest('[data-ew-continue]');
        const retryButton = event.target.closest('[data-ew-retry]');
        if(!continueButton && !retryButton) return;
        const last = Number(continueButton?.dataset.ewContinue ?? retryButton?.dataset.ewRetry);
        void continueFrom(last, Boolean(continueButton));
    }

    async function readJson(response){
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || 'HTTP ' + response.status);
        return data;
    }
    async function getRun(runId){
        const response = await fetch('/api/expert-workflows/runs/' + encodeURIComponent(runId), {cache:'no-store'});
        return readJson(response);
    }
    async function loadHistory(node){
        try {
            const params = new URLSearchParams({canvas_id:String(canvas?.id || canvasId || ''), node_id:node.id});
            const response = await fetch('/api/expert-workflows/runs?' + params, {cache:'no-store'});
            const data = await readJson(response);
            if(state.nodeId !== node.id) return;
            state.runs = data.runs || [];
            renderHistory();
        } catch(error){
            if(state.nodeId === node.id) setStatus('运行记录读取失败：' + (error.message || error), 'failed');
        }
    }
    async function selectHistory(runId){
        if(!runId) return;
        try {
            const run = await getRun(runId);
            if(state.nodeId !== run.node_id) return;
            state.selectedRun = run;
            state.edited.clear();
            renderAll();
        } catch(error){
            setStatus('运行记录读取失败：' + (error.message || error), 'failed');
        }
    }

    function requestBody(node, resume={}){
        const refs = promptNodeInputMediaForLLM(node);
        return {
            canvas_id:String(canvas?.id || canvasId || ''),
            node_id:node.id,
            workflow:workflowFor(node),
            message:[inputText(node), String(node.userPrompt || '').trim()].filter(Boolean).join('\n\n'),
            images:imageRefsOnly(refs).map(item => item.url).filter(Boolean),
            videos:videoRefsOnly(refs).map(item => item.url).filter(Boolean),
            attachments:documentRefsOnly(refs).map(item => ({url:item.url, name:item.name || ''})),
            ...resume
        };
    }
    async function beginRun(node, resume={}, signal=null){
        if(signal?.aborted) throw new Error('Agent 运行已取消');
        const response = await fetch('/api/expert-workflows/runs', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify(requestBody(node, resume))
        });
        const run = await readJson(response);
        node.expertRunId = run.id;
        node.expertRunSignature = smartDependencySignature(node);
        if(signal?.aborted){
            await cancelServerRun(run.id);
            node.expertRunStatus = 'cancelled';
            throw new Error('Agent 运行已取消');
        }
        node.expertRunStatus = run.status;
        node.outputText = '';
        delete node.dependencyRunSignature;
        node.runError = '';
        scheduleSave();
        render({nodeIds:[node.id]});
        if(state.nodeId === node.id){
            state.selectedRun = run;
            state.edited.clear();
            void loadHistory(node);
            renderAll();
        }
        return run;
    }

    function syncNodeRun(node, run){
        if(node.expertRunId !== run.id) return;
        const oldStatus = node.expertRunStatus;
        const currentSignature = smartDependencySignature(node);
        const outdated = run.status === 'completed' && node.expertRunSignature && node.expertRunSignature !== currentSignature;
        node.expertRunStatus = outdated ? 'outdated' : run.status;
        if(run.status === 'completed'){
            if(!outdated){
                node.outputText = String(run.output || '').trim();
                node.dependencyRunSignature = currentSignature;
            }
            node.runError = '';
            node.runFinishedAt = Date.now();
            node.running = false;
        } else if(['failed','cancelled','interrupted'].includes(run.status)){
            node.runError = run.error || statusLabel(run.status);
            node.runFinishedAt = Date.now();
            node.running = false;
        } else if(run.status === 'paused'){
            node.runError = '';
            node.running = false;
        } else node.running = true;
        if(oldStatus !== node.expertRunStatus || ['completed','failed','cancelled','interrupted'].includes(run.status)){
            scheduleSave();
            render({nodeIds:[node.id]});
        }
        if(state.nodeId === node.id && (!state.selectedRun || state.selectedRun.id === run.id)){
            const oldSteps = JSON.stringify((state.selectedRun?.steps || []).map(item => [item.status, item.output, item.error]));
            const newSteps = JSON.stringify((run.steps || []).map(item => [item.status, item.output, item.error]));
            state.selectedRun = run;
            if(oldStatus !== run.status || oldSteps !== newSteps){
                renderRunControls(node);
                renderGraph();
                if(!state.sidebar?.querySelector('[data-ew-edited]:focus')) renderSidebar();
                setStatus(statusLabel(run.status), run.status);
                renderHistory();
            }
        }
    }

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function monitor(node, signal=null){
        while(true){
            if(signal?.aborted){
                await cancelServerRun(node.expertRunId);
                throw new Error('Agent 运行已取消');
            }
            const run = await getRun(node.expertRunId);
            syncNodeRun(node, run);
            if(!['queued','running'].includes(run.status)) return run;
            await delay(850);
        }
    }

    async function runNode(node, signal=null){
        if(!is(node)) return {ok:false, error:'专家协作节点不存在'};
        if(node.expertRunStatus === 'paused'){
            void open(node);
            return {ok:false, paused:true, error:'流程待审阅；请打开编排后继续'};
        }
        if(node.running) return {ok:false, error:'专家协作正在运行'};
        node.running = true;
        node.runStartedAt = Date.now();
        node.runFinishedAt = 0;
        node.runError = '';
        render({nodeIds:[node.id]});
        if(state.nodeId === node.id && state.modal?.hidden === false) renderRunControls(node);
        try {
            await beginRun(node, {}, signal);
            const run = await monitor(node, signal);
            if(run.status === 'completed') return {ok:true, text:node.outputText};
            if(run.status === 'paused'){
                if(state.modal?.hidden !== false) void open(node);
                return {ok:false, paused:true, error:'流程待审阅；请打开编排后继续'};
            }
            return {ok:false, error:run.error || statusLabel(run.status)};
        } catch(error){
            const message = error.message || String(error);
            node.runError = message;
            node.expertRunStatus = signal?.aborted ? 'cancelled' : node.expertRunStatus === 'paused' ? 'paused' : 'failed';
            return {ok:false, error:message};
        } finally {
            node.running = false;
            node.runFinishedAt = Date.now();
            scheduleSave();
            render({nodeIds:[node.id]});
            if(state.nodeId === node.id && state.modal?.hidden === false) renderRunControls(node);
        }
    }

    async function cancelServerRun(runId){
        if(!runId) return;
        try {
            await fetch('/api/expert-workflows/runs/' + encodeURIComponent(runId) + '/cancel', {method:'POST'});
        } catch(_error){}
    }
    async function stop(node){
        if(!node) return;
        const dependencyActive = smartDependencyRuns.has(node.id);
        const activeRunId = ['queued','running'].includes(node.expertRunStatus) ? node.expertRunId : '';
        if(dependencyActive) cancelAgentNode(node.id);
        if(activeRunId) await cancelServerRun(activeRunId);
        if((!dependencyActive && activeRunId) || (dependencyActive && !activeRunId)){
            node.running = false;
            node.expertRunStatus = 'cancelled';
            node.runError = '已停止专家协作运行';
            scheduleSave();
            render({nodeIds:[node.id]});
            if(state.nodeId === node.id && state.modal?.hidden === false) renderAll();
        }
        if(state.nodeId === node.id && activeRunId) void selectHistory(activeRunId);
    }

    async function continueFrom(last, useEdited){
        const node = currentNode();
        const previous = state.selectedRun;
        if(!node || !previous || isBusy(node)) return;
        const step = previous.steps[last];
        const edited = useEdited ? (state.edited.has(step?.id) ? state.edited.get(step.id) : step?.output || '') : '';
        if(useEdited && !String(edited).trim()){ setStatus('请先填写这位专家的结果', 'failed'); return; }
        node.running = true;
        node.runStartedAt = Date.now();
        node.runFinishedAt = 0;
        node.runError = '';
        render({nodeIds:[node.id]});
        renderRunControls(node);
        try {
            await beginRun(node, {
                resume_from:previous.id,
                resume_after_step:last,
                edited_output:useEdited ? String(edited).trim() : ''
            });
            void observe(node);
        } catch(error){
            node.running = false;
            setStatus('继续运行失败：' + (error.message || error), 'failed');
            render({nodeIds:[node.id]});
            renderRunControls(node);
        }
    }

    async function observe(node){
        if(state.watching.has(node.id)) return;
        state.watching.add(node.id);
        try {
            await monitor(node);
        } catch(error){
            node.running = false;
            node.expertRunStatus = 'interrupted';
            node.runError = error.message || String(error);
            scheduleSave();
            render({nodeIds:[node.id]});
        } finally {
            state.watching.delete(node.id);
        }
    }
    async function restore(loadedNodes){
        await Promise.allSettled((loadedNodes || []).filter(node => is(node) && node.expertRunId).map(async node => {
            try {
                const run = await getRun(node.expertRunId);
                syncNodeRun(node, run);
                if(['queued','running'].includes(run.status)) void observe(node);
            } catch(error){
                node.running = false;
                node.expertRunStatus = 'interrupted';
                node.runError = '运行记录读取失败：' + (error.message || error);
                scheduleSave();
                render({nodeIds:[node.id]});
            }
        }));
    }

    window.SmartExpertWorkflow = {is, newWorkflow, executionSignature, inputText, nodeBodyHtml, bindNode, open, runNode, restore};
})();
