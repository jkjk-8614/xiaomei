(function(global){
    'use strict';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const labels = {'smart-upload':'参考素材','smart-paint':'图像生成','smart-prompt':'提示词','smart-text':'文本','image':'图片','text':'文本','generate':'生成'};
    const tones = [['#4778d8','#eaf1ff'],['#0e8a83','#e8f8f5'],['#b56b26','#fff2df'],['#8b5fc4','#f3ebff'],['#bf5967','#fff0f1'],['#4f8b64','#eaf7ee']];
    function graphOf(value={}){
        const source = value.preview_graph || value.workflow || value;
        const nodes = (Array.isArray(source.nodes) ? source.nodes : []).filter(node => node && typeof node === 'object');
        const connections = Array.isArray(source.connections) ? source.connections : (Array.isArray(source.links) ? source.links : []);
        return {nodes, connections};
    }
    function nodeType(node){
        const raw = String(node?.type || node?.class_type || '').trim();
        return labels[raw] || raw.replace(/^smart-/, '').replace(/[-_]+/g, ' ') || '节点';
    }
    function nodeTitle(node){
        return String(node?.title || node?.name || labels[node?.type] || node?.type || '节点').trim() || '节点';
    }
    function layout(value){
        const graph=graphOf(value), ids=new Set(graph.nodes.map((node,index)=>String(node.id ?? index)));
        const hasPosition=graph.nodes.some(node=>node.x!=null || Array.isArray(node.pos)), layers=new Map(), rows=new Map();
        graph.nodes.forEach((node,index)=>layers.set(String(node.id ?? index),0));
        if(!hasPosition){
            for(let pass=0;pass<Math.min(graph.nodes.length,12);pass++){
                let changed=false;
                graph.connections.forEach(link=>{
                    const from=String(link.from ?? link[0] ?? ''),to=String(link.to ?? link[1] ?? '');
                    if(!ids.has(from)||!ids.has(to)||from===to) return;
                    const next=Math.min(8,(layers.get(from)||0)+1);
                    if(next>(layers.get(to)||0)){layers.set(to,next);changed=true;}
                });
                if(!changed) break;
            }
        }
        const nodes=graph.nodes.map((node,index)=>{
            const id=String(node.id ?? index),layer=layers.get(id)||0,row=rows.get(layer)||0; rows.set(layer,row+1);
            const pos=Array.isArray(node.pos)?node.pos:[], rawX=node.x ?? pos[0], rawY=node.y ?? pos[1];
            return {id,title:nodeTitle(node),type:nodeType(node),x:rawX!=null&&Number.isFinite(Number(rawX))?Number(rawX):layer*260,y:rawY!=null&&Number.isFinite(Number(rawY))?Number(rawY):row*130,media:Array.isArray(node.media)?node.media.filter(Boolean).slice(0,2):[],inputs:Number(node.input_count||0),outputs:Number(node.output_count||0)};
        });
        if(!nodes.length) return {nodes:[],connections:[],width:420,height:220};
        const nodeWidth=220,nodeHeight=92,minX=Math.min(...nodes.map(node=>node.x)),minY=Math.min(...nodes.map(node=>node.y));
        nodes.forEach(node=>{node.x=node.x-minX+28;node.y=node.y-minY+28;node.width=nodeWidth;node.height=nodeHeight;});
        return {nodes,connections:graph.connections,width:Math.max(...nodes.map(node=>node.x+nodeWidth))+28,height:Math.max(...nodes.map(node=>node.y+nodeHeight))+28};
    }
    function shorten(value,max){const text=String(value||'');return text.length>max?`${text.slice(0,max-1)}…`:text;}
    function markup(value,options={}){
        const graph=layout(value),map=new Map(graph.nodes.map(node=>[node.id,node]));
        if(!graph.nodes.length) return `<div class="workflow-preview-empty">${esc(value?.preview_error || '没有可预览的节点')}</div>`;
        const links=graph.connections.map(link=>{
            const from=map.get(String(link.from ?? link[0] ?? '')),to=map.get(String(link.to ?? link[1] ?? ''));
            if(!from||!to) return '';
            const x1=from.x+from.width,y1=from.y+46,x2=to.x,y2=to.y+46,curve=Math.max(42,Math.abs(x2-x1)/2);
            return `<path class="workflow-preview-link" data-preview-from="${esc(link.from ?? link[0] ?? '')}" data-preview-to="${esc(link.to ?? link[1] ?? '')}" d="M${x1} ${y1} C${x1+curve} ${y1},${x2-curve} ${y2},${x2} ${y2}"/>`;
        }).join('');
        const nodes=graph.nodes.map((node,index)=>{
            const tone=tones[index%tones.length],header=esc(tone[0]),body=esc(tone[1]);
            const media=node.media.map((url,mediaIndex)=>`<image href="${esc(url)}" x="${12+mediaIndex*43}" y="35" width="38" height="38" preserveAspectRatio="xMidYMid slice" class="workflow-preview-media"><title>${esc(url)}</title></image>`).join('');
            const detail=media?'':`<text x="12" y="61" class="workflow-preview-body">${esc(shorten(node.type,24))}</text>`;
            const inputs=Math.max(1,Math.min(4,node.inputs||1)),outputs=Math.max(1,Math.min(4,node.outputs||1));
            const inPorts=Array.from({length:inputs},(_,i)=>`<circle cx="0" cy="${28+i*16}" r="3.2" class="workflow-preview-port workflow-preview-port-in"/>`).join('');
            const outPorts=Array.from({length:outputs},(_,i)=>`<circle cx="220" cy="${28+i*16}" r="3.2" class="workflow-preview-port workflow-preview-port-out"/>`).join('');
            return `<g data-preview-node="${esc(node.id)}" transform="translate(${node.x},${node.y})"><title>${esc(node.title)} · ${esc(node.type)}</title><rect width="220" height="92" rx="9" fill="${body}" class="workflow-preview-node"/><rect width="220" height="24" rx="9" fill="${header}" class="workflow-preview-header"/><rect y="16" width="220" height="8" fill="${header}"/><text x="12" y="17" class="workflow-preview-title">${esc(shorten(node.title,24))}</text>${media}${detail}<text x="12" y="82" class="workflow-preview-type">${esc(shorten(node.type,30))}</text>${inPorts}${outPorts}</g>`;
        }).join('');
        return `<div class="workflow-preview ${options.large?'is-large':''}"><svg viewBox="0 0 ${graph.width} ${graph.height}" role="img" aria-label="${esc(options.name||'工作流')}：${graph.nodes.length} 个节点，${graph.connections.length} 条连线" preserveAspectRatio="xMidYMid meet">${links}${nodes}</svg></div>`;
    }
    function resourceCount(value){
        const urls=new Set();
        function visit(item){
            if(typeof item==='string' && /^(?:\/assets\/|\/output\/|\/api\/storage-files\/|https?:\/\/)/i.test(item) && /\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav)(?:[?#]|$)/i.test(item)) urls.add(item);
            else if(Array.isArray(item)) item.forEach(visit); else if(item&&typeof item==='object') Object.values(item).forEach(visit);
        }
        visit(graphOf(value).nodes); return urls.size;
    }
    global.XiaomeiWorkflowPreview={markup,graphOf,resourceCount};
})(window);
