/* Dual selections extend the existing local-fusion node and its output pipeline. */
const detailRepairSessions = new Map();
const detailRepairModelLoads = new WeakSet();
const detailRepairLoadedModels = new WeakSet();
const detailRepairModelErrors = new WeakMap();
const detailRepairRecoveries = new WeakSet();

function detailRepairConfig(node){return node.detailRepair ||= {enabled:false,selections:{},feather:6,modelKey:''};}
function detailRepairInputs(node){
    const items=localFusionInputImages(node),c=detailRepairConfig(node);
    return {items,scene:items.find(i=>i.url===c.sceneUrl)||(!c.sceneUrl?items[0]:null),
        product:items.find(i=>i.url===c.productUrl)||(!c.productUrl?items.find(i=>i.url!==(c.sceneUrl||items[0]?.url)):null)};
}
function detailRepairSelection(node,role){
    const input=detailRepairInputs(node)[role];
    return input?detailRepairConfig(node).selections?.[role]?.url===input.url?node.detailRepair.selections[role]:null:null;
}
function detailRepairSignature(node){
    const c=detailRepairConfig(node),i=detailRepairInputs(node);
    return JSON.stringify({sourceUrl:i.scene?.url||'',productUrl:i.product?.url||'',
        scene:detailRepairSelection(node,'scene'),product:detailRepairSelection(node,'product'),modelKey:c.modelKey,feather:c.feather});
}
function detailRepairBusy(node){return detailRepairSessions.has(node.id)||Boolean(node.fusionJobId)||localFusionSessions.has(node.id);}
function detailRepairModeSwitch(node){
    const repair=Boolean(node.detailRepair?.enabled),busy=detailRepairBusy(node);
    return '<div class="dr-mode" role="group" aria-label="处理模式">'+[true,false].map(mode=>{
        const active=mode===repair;
        return '<button type="button" aria-pressed="'+active+'" '+(active?'aria-disabled="true"':'data-dr-mode '+(busy?'disabled':''))+'>'
            +(mode?'双图细节修复':'局部图融合')+'</button>';
    }).join('')+'</div>';
}
function setDetailRepairMode(node,enabled){
    if(detailRepairBusy(node)||!collabCanMutateCanvas()||!collabCanEditNode(node.id))return;
    pushUndo();
    detailRepairConfig(node).enabled=enabled;
    delete node.runError;
    delete node.fusionStatus;
    delete node.fusionMessage;
    render();scheduleSave();
    world.querySelector('[data-id="'+CSS.escape(node.id)+'"] .dr-mode [aria-pressed="true"]')?.focus({preventScroll:true});
}
function openDetailRepair(nodeId,index=0){
    const source=nodes.find(n=>n.id===nodeId),image=source?.images?.[index];
    if(!source||!image?.url||sharedCanvasMode||!collabCanMutateCanvas()||!collabCanEditNode(nodeId))return;
    const rect=nodeRect(source),node=createLocalFusionNodeAt({x:source.x+rect.width+274,y:source.y+240});
    if(!node)return;
    node.detailRepair={enabled:true,sceneUrl:image.url,selections:{},feather:6,modelKey:''};
    connectInputNode(source.id,node.id);selectedId=node.id;render();scheduleSave();return node;
}
function detailRepairNodeBodyHtml(node){
    const c=detailRepairConfig(node),inputs=detailRepairInputs(node),busy=detailRepairBusy(node);
    const selected=role=>Boolean(detailRepairSelection(node,role)?.ops?.length);
    const hasBoth=Boolean(inputs.scene&&inputs.product);
    const ready=hasBoth&&selected('scene')&&selected('product');
    const models=c.models||[],current=detailRepairLoadedModels.has(node)&&models.find(m=>`${m.provider_id}:${m.model}`===c.modelKey);
    const pending=c.run&&!c.run.terminal;
    const resumable=pending&&c.run.signature===detailRepairSignature(node);
    const canRun=ready&&!busy&&(pending?resumable:current);
    const message=node.fusionMessage||'';
    const modelError=detailRepairModelErrors.get(node);
    const modelPrompt=modelError?'模型读取失败，请重新读取'
        :!detailRepairLoadedModels.has(node)?'正在读取图片模型…'
        :models.length?'选择支持参考图的模型':'未找到支持参考图的模型';
    const status=busy?(message||'正在修复…')
        :!inputs.scene&&!inputs.product?'将场景图和产品参考图连到左侧输入口'
        :!inputs.scene?'将场景图连到左侧输入口'
        :!inputs.product?'将产品参考图连到左侧输入口'
        :!ready?'选择场景中的修复位置和产品上的正确细节'
        :pending&&!resumable?'素材或选区已变化，请先结束本次任务'
        :!current&&!resumable?(modelError?'模型读取失败，请重新读取。'+modelError:modelPrompt)
        :message||(resumable?'上次修复待继续，可查询结果并回贴':'两侧选区已就绪');
    const tone=status===message&&node.fusionStatus==='failed'?'is-error':localFusionTone(status);
    const options=(role,label)=>'<option value="">自动 · '+escapeHtml(inputs[role]?.name||label)+'</option>'
        +inputs.items.map(i=>'<option value="'+escapeAttr(i.url)+'" '+(c[role+'Url']===i.url?'selected':'')+'>'+escapeHtml(i.name||'图片')+'</option>').join('');
    const fresh=node.fusionPreview&&node.fusionPreviewSignature===detailRepairSignature(node);
    return '<div class="local-fusion-body dr-body" data-dr-root><div class="lf-scroll">'+detailRepairModeSwitch(node)
        +'<section class="lf-section" aria-label="素材与选区"><div class="lf-assets">'+['scene','product'].map(role=>{
            const image=inputs[role],label=role==='scene'?'场景图':'产品参考图';
            return '<div class="dr-input">'+localFusionAssetHtml(image,label,image?(selected(role)?'已选区':'待选区'):'')
                +'<select data-dr-input="'+role+'" aria-label="'+label+'来源" title="'+escapeAttr(image?.name||label)+'" '+(busy||!inputs.items.length?'disabled':'')+'>'+options(role,label)+'</select></div>';
        }).join('')+'</div><div class="dr-actions"><button type="button" data-dr-edit '+(!hasBoth||busy?'disabled':'')+'><i data-lucide="scan-line" aria-hidden="true"></i>'+(ready?'编辑两侧选区':'选择两侧区域')+'</button>'
        +'<button type="button" data-dr-clear '+(busy||!selected('scene')&&!selected('product')?'disabled':'')+'>清除选区</button></div></section>'
        +'<div class="lf-field lf-field-stack dr-model"><label for="dr-model-'+escapeAttr(node.id)+'">图片模型</label><div class="dr-actions">'
        +'<select id="dr-model-'+escapeAttr(node.id)+'" title="'+escapeAttr(current?`${current.provider_name} · ${current.model}`:modelPrompt)+'" data-dr-model '+(busy?'disabled':'')+'><option value="">'+modelPrompt+'</option>'+models.map(m=>'<option value="'+escapeAttr(`${m.provider_id}:${m.model}`)+'" '+(c.modelKey===`${m.provider_id}:${m.model}`?'selected':'')+'>'+escapeHtml(`${m.provider_name} · ${m.model}`)+'</option>').join('')+'</select>'
        +'<button type="button" data-dr-model-refresh title="重新读取模型" aria-label="重新读取模型" '+(busy?'disabled':'')+'><i data-lucide="refresh-cw" aria-hidden="true"></i></button></div></div>'
        +'<details class="lf-advanced dr-more" '+(c.advancedOpen?'open':'')+'><summary>高级设置</summary><label class="lf-field"><span>边缘过渡</span><span class="lf-field-ctl"><input data-dr-feather type="number" min="0" max="64" value="'+escapeAttr(c.feather??6)+'" '+(busy?'disabled':'')+'><em>px</em></span></label>'
        +'<p class="lf-note">模型只接收两侧选区。回贴后保留选区外的原图，请核对选区内的文字、Logo 和结构。</p>'
        +'<button type="button" data-dr-crop '+(!inputs.scene||busy?'disabled':'')+'>裁出局部副本</button></details>'
        +(node.fusionPreview?'<section class="lf-result"><button class="lf-result-thumb" data-lf-preview aria-label="查看修复结果"><img src="'+escapeAttr(node.fusionPreview.url)+'" alt="修复结果"></button><div class="lf-result-info"><strong>修复结果</strong><small>'+(fresh?'请核对产品细节':'输入已变化，请重新修复')+'</small><button data-lf-output '+(!fresh||busy?'disabled':'')+'>查看完整图片</button></div></section>':'')
        +'</div><div class="lf-footer"><p class="lf-state '+tone+'" role="status"><i data-lucide="'+localFusionToneIcon(tone,busy)+'" aria-hidden="true"></i><span>'+escapeHtml(status)+'</span></p><div class="dr-actions">'
        +'<button class="lf-run-btn" type="button" data-dr-run '+(canRun?'':'disabled')+'>'+(busy?'正在修复…':resumable?'继续查询与回贴':'开始修复')+'</button>'
        +(busy||pending?'<button type="button" data-dr-cancel>'+(busy?'停止等待':'结束本次任务')+'</button>':'')+'</div></div></div>';
}
async function detailRepairLoadModels(node,refresh=false){
    if(detailRepairModelLoads.has(node)&&!refresh)return;
    detailRepairModelLoads.add(node);
    try{
        if(refresh)productRetouchOptionsRequest=null;
        const response=await productRetouchOptions();
        if(!nodes.includes(node))return;
        const c=detailRepairConfig(node);c.models=response.models||[];
        detailRepairLoadedModels.add(node);
        detailRepairModelErrors.delete(node);
        if(node.fusionMessage?.startsWith('模型读取失败'))delete node.fusionMessage;
        if(!c.modelKey&&c.models.length){const m=c.models.find(m=>m.provider_id===settings.provider_id&&m.model===settings.model)||c.models[0];c.modelKey=`${m.provider_id}:${m.model}`;scheduleSave();}
    }catch(error){detailRepairModelErrors.set(node,error.message||'图片模型暂时无法读取');detailRepairLoadedModels.delete(node);}
    if(nodes.includes(node))render();
}
window.addEventListener('smart-canvas-config-ready',()=>{
    for(const node of nodes.filter(n=>n.detailRepair?.enabled))void detailRepairLoadModels(node,true);
});
function bindDetailRepairNode(el,node){
    const root=el.querySelector('[data-dr-root]');if(!root)return;
    for(const type of ['pointerdown','mousedown','wheel'])root.addEventListener(type,e=>e.stopPropagation());
    const mutate=fn=>{
        if(detailRepairBusy(node)||!collabCanMutateCanvas()||!collabCanEditNode(node.id))return;
        const top=root.querySelector('.lf-scroll').scrollTop;
        pushUndo();fn();
        delete node.fusionMessage;delete node.fusionStatus;delete node.runError;
        render();scheduleSave();
        const scroller=world.querySelector('[data-id="'+CSS.escape(node.id)+'"] .lf-scroll');
        if(scroller)scroller.scrollTop=top;
    };
    root.querySelector('[data-dr-mode]').onclick=()=>setDetailRepairMode(node,false);
    root.querySelectorAll('[data-dr-input]').forEach(input=>input.onchange=()=>mutate(()=>{node.detailRepair[input.dataset.drInput+'Url']=input.value;}));
    root.querySelector('[data-dr-model]').onchange=e=>mutate(()=>{node.detailRepair.modelKey=e.target.value;});
    root.querySelector('[data-dr-feather]').onchange=e=>mutate(()=>{node.detailRepair.feather=Math.max(0,Math.min(64,Number(e.target.value)||0));});
    root.querySelector('.dr-more').addEventListener('toggle',e=>{node.detailRepair.advancedOpen=e.target.open;});
    root.querySelector('[data-dr-clear]').onclick=()=>mutate(()=>{node.detailRepair.selections={};});
    root.querySelector('[data-dr-edit]').onclick=()=>void detailRepairEditor(node);
    root.querySelector('[data-dr-crop]').onclick=()=>{const i=detailRepairInputs(node).scene;const source=nodes.find(n=>n.id===i.nodeId);if(source)startLocalRepairCrop(source.id,source.images.findIndex(img=>img.url===i.url));};
    root.querySelector('[data-dr-model-refresh]').onclick=()=>void detailRepairLoadModels(node,true);
    root.querySelector('[data-dr-run]').onclick=()=>void runDetailRepairNode(node);
    root.querySelector('[data-dr-cancel]')?.addEventListener('click',()=>void cancelDetailRepairNode(node));
    root.querySelector('[data-lf-preview]')?.addEventListener('click',()=>localFusionPreviewDialog(node));
    root.querySelector('[data-lf-output]')?.addEventListener('click',()=>localFusionOutput(node));
    void detailRepairLoadModels(node);
    if(node.fusionJobId&&!localFusionSessions.has(node.id))void pollLocalFusionNode(node,node.fusionJobId,node.fusionJobSignature);
    else if(node.detailRepair.run&&!node.detailRepair.run.terminal&&!detailRepairRecoveries.has(node.detailRepair.run)&&!detailRepairSessions.has(node.id))void runDetailRepairNode(node,{resume:true});
}

function detailRepairPaint(ctx,ops){
    ctx.fillStyle=ctx.strokeStyle='#fff';ctx.lineCap=ctx.lineJoin='round';
    for(const op of ops){
        if(op.tool==='rect'){ctx.fillRect(op.x,op.y,op.w,op.h);continue;}
        if(!op.points?.length)continue;
        ctx.lineWidth=op.size;ctx.beginPath();ctx.moveTo(...op.points[0]);
        for(const p of op.points.slice(1))ctx.lineTo(...p);
        ctx.stroke();for(const p of [op.points[0],op.points.at(-1)]){ctx.beginPath();ctx.arc(...p,op.size/2,0,Math.PI*2);ctx.fill();}
    }
}
function detailRepairBounds(selection,padding=0){
    if(!selection?.ops?.length)throw new Error('请先选择两侧区域');
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(const op of selection.ops){
        const points=op.tool==='rect'?[[op.x,op.y],[op.x+op.w,op.y+op.h]]:op.points;
        const radius=op.tool==='brush'?op.size/2:0;
        for(const [x,y] of points){left=Math.min(left,x-radius);top=Math.min(top,y-radius);right=Math.max(right,x+radius);bottom=Math.max(bottom,y+radius);}
    }
    const margin=padding?Math.max(16,Math.max(right-left,bottom-top)*padding):0;
    const x=Math.max(0,Math.floor(left-margin)),y=Math.max(0,Math.floor(top-margin));
    const w=Math.min(selection.width,Math.ceil(right+margin))-x,h=Math.min(selection.height,Math.ceil(bottom+margin))-y;
    if(w<4||h<4)throw new Error('选区小于 4 像素，请重新选择');
    if(w*h>16_000_000)throw new Error('选区超过 1600 万像素，请缩小修复范围');
    return {x,y,width:w,height:h};
}
async function detailRepairImage(url){
    const img=new Image();img.src=displayMediaUrl({url});
    try{await img.decode();}catch{throw new Error('图片读取失败，请检查场景图和产品图');}
    if(img.naturalWidth*img.naturalHeight>40_000_000)throw new Error('图片超过 4000 万像素，请先缩小副本');
    return img;
}
function detailRepairCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
function detailRepairMask(selection,box){
    const c=detailRepairCanvas(box.width,box.height),ctx=c.getContext('2d');ctx.translate(-box.x,-box.y);detailRepairPaint(ctx,selection.ops);return c;
}
async function detailRepairUpload(c,name){
    const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('选区导出失败，请缩小图片后重试');
    const file=await uploadCroppedBlob(blob,name);if(!file?.url)throw new Error('选区上传失败，请重试');return file;
}

async function detailRepairEditor(node){
    if(detailRepairBusy(node)||!collabCanMutateCanvas()||!collabCanEditNode(node.id))return;
    const inputs=detailRepairInputs(node);if(!inputs.scene||!inputs.product)return;
    const signature=detailRepairSignature(node),canvasToken=canvas.id,d=localFusionDialog('编辑修复区域');
    d.classList.add('dr-dialog');
    const content=d.querySelector('.lf-dialog-content');
    content.innerHTML='<p class="dr-help">左侧选择修复位置，右侧选择正确细节。滚轮缩放，空格拖动或使用平移工具。</p><div class="dr-panes">'+['scene','product'].map(role=>'<section class="dr-pane" data-dr-pane="'+role+'"><h3>'+(role==='scene'?'场景图 · 修复位置':'产品图 · 参考细节')+'</h3><canvas tabindex="0" aria-label="'+(role==='scene'?'场景图选区':'产品图选区')+'"></canvas><div class="dr-tools"><div role="group" aria-label="选区工具"><button data-tool="brush">画笔</button><button data-tool="rect">框选</button><button data-tool="pan">平移</button></div><button data-undo>撤销</button><button data-clear>清除</button><button data-fit>适应</button><output>100%</output></div><label class="dr-brush">画笔大小 <input data-size type="range" min="2" max="120" value="28"><output data-size-label>28 px</output></label></section>').join('')+'</div><footer class="dr-editor-footer"><p role="status">正在读取两张图片…</p><button type="button" class="image-edit-btn secondary" data-preview>预览选区</button><button type="button" class="image-edit-btn primary" data-save disabled>保存选区</button></footer>';
    const panes=[];let space=false,preview=false;
    const status=content.querySelector('[role=status]'),save=content.querySelector('[data-save]');
    const valid=()=>canvas.id===canvasToken&&nodes.includes(node)&&detailRepairSignature(node)===signature&&collabCanEditNode(node.id)&&!detailRepairBusy(node);
    const update=()=>{const ready=panes.length===2&&panes.every(p=>p.ops.length);save.disabled=!ready;status.textContent=ready?'两侧选区已就绪':'请在两张图片上分别选择区域';};
    try{
        const images=await Promise.all(['scene','product'].map(role=>detailRepairImage(inputs[role].url)));
        if(!d.isConnected)return;
        ['scene','product'].forEach((role,index)=>{
            const section=content.querySelector('[data-dr-pane="'+role+'"]'),view=section.querySelector('canvas'),img=images[index];
            const previous=detailRepairSelection(node,role);
            const p={role,section,view,img,ops:previous?.width===img.naturalWidth&&previous?.height===img.naturalHeight?cloneSmartSettings(previous.ops):[],tool:'rect',zoom:1,panX:0,panY:0,drag:null};
            const factor=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
            const overlay=detailRepairCanvas(Math.ceil(img.naturalWidth*factor),Math.ceil(img.naturalHeight*factor));
            panes.push(p);
            const transform=()=>{const b=view.getBoundingClientRect(),fit=Math.min(b.width/img.naturalWidth,b.height/img.naturalHeight),scale=fit*p.zoom;return {b,scale,x:(b.width-img.naturalWidth*scale)/2+p.panX,y:(b.height-img.naturalHeight*scale)/2+p.panY};};
            const draw=()=>{
                const t=transform(),ratio=window.devicePixelRatio||1;
                view.width=Math.max(1,Math.round(t.b.width*ratio));view.height=Math.max(1,Math.round(t.b.height*ratio));
                const ctx=view.getContext('2d');ctx.scale(ratio,ratio);ctx.translate(t.x,t.y);ctx.scale(t.scale,t.scale);
                ctx.drawImage(img,0,0);ctx.save();ctx.beginPath();ctx.rect(0,0,img.naturalWidth,img.naturalHeight);ctx.clip();
                const ops=p.drag?.op?[...p.ops,p.drag.op]:p.ops;
                // Tint the union once, so overlapping brush strokes keep the same opacity.
                const o=overlay.getContext('2d');o.setTransform(1,0,0,1,0,0);o.clearRect(0,0,overlay.width,overlay.height);o.globalCompositeOperation='source-over';o.scale(factor,factor);detailRepairPaint(o,ops);
                o.setTransform(1,0,0,1,0,0);o.globalCompositeOperation='source-in';o.fillStyle=getComputedStyle(section).getPropertyValue('--dr-accent').trim()||getComputedStyle(section).color;o.fillRect(0,0,overlay.width,overlay.height);
                if(preview){ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillRect(0,0,img.naturalWidth,img.naturalHeight);}
                ctx.globalAlpha=preview?.75:.38;ctx.drawImage(overlay,0,0,img.naturalWidth,img.naturalHeight);ctx.restore();
                section.querySelector('.dr-tools output').textContent=Math.round(p.zoom*100)+'%';
                section.querySelector('[data-undo]').disabled=!p.ops.length&&!p.cleared;section.querySelector('[data-clear]').disabled=!p.ops.length;
            };
            const point=e=>{const t=transform();return [Math.max(0,Math.min(img.naturalWidth,(e.clientX-t.b.left-t.x)/t.scale)),Math.max(0,Math.min(img.naturalHeight,(e.clientY-t.b.top-t.y)/t.scale))];};
            section.querySelectorAll('[data-tool]').forEach(button=>{button.classList.toggle('active',button.dataset.tool===p.tool);button.setAttribute('aria-pressed',String(button.dataset.tool===p.tool));button.onclick=()=>{p.tool=button.dataset.tool;section.querySelectorAll('[data-tool]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});};});
            view.onpointerdown=e=>{
                if(e.button!==0&&e.button!==1)return;e.preventDefault();view.focus();view.setPointerCapture(e.pointerId);
                const t=transform(),x=e.clientX-t.b.left,y=e.clientY-t.b.top;
                if(p.tool==='pan'||space||e.button===1)p.drag={pan:true,x:e.clientX,y:e.clientY,panX:p.panX,panY:p.panY};
                else if(x>=t.x&&y>=t.y&&x<=t.x+img.naturalWidth*t.scale&&y<=t.y+img.naturalHeight*t.scale){
                    const start=point(e),size=Number(section.querySelector('[data-size]').value)/t.scale;
                    p.drag={start,op:p.tool==='rect'?{tool:'rect',x:start[0],y:start[1],w:0,h:0}:{tool:'brush',size,points:[start]}};
                }
                draw();
            };
            view.onpointermove=e=>{
                if(!p.drag)return;
                if(p.drag.pan){p.panX=p.drag.panX+e.clientX-p.drag.x;p.panY=p.drag.panY+e.clientY-p.drag.y;}
                else{const next=point(e),op=p.drag.op;if(op.tool==='rect'){op.x=Math.min(p.drag.start[0],next[0]);op.y=Math.min(p.drag.start[1],next[1]);op.w=Math.abs(next[0]-p.drag.start[0]);op.h=Math.abs(next[1]-p.drag.start[1]);}else if(op.points.length<12000)op.points.push(next);}
                draw();
            };
            view.onpointerup=()=>{const op=p.drag?.op;if(op&&(op.tool==='brush'||op.w>=1&&op.h>=1))p.ops.push(op);p.drag=null;draw();update();};
            view.onpointercancel=()=>{p.drag=null;draw();};view.onlostpointercapture=()=>{if(p.drag){p.drag=null;draw();}};
            view.addEventListener('wheel',e=>{e.preventDefault();if(p.drag)return;const before=transform(),x=e.clientX-before.b.left,y=e.clientY-before.b.top;const ix=(x-before.x)/before.scale,iy=(y-before.y)/before.scale;p.zoom=Math.max(.25,Math.min(16,p.zoom*Math.exp(-e.deltaY*.0015)));const after=transform();p.panX+=x-(after.x+ix*after.scale);p.panY+=y-(after.y+iy*after.scale);draw();},{passive:false});
            section.querySelector('[data-fit]').onclick=()=>{p.zoom=1;p.panX=p.panY=0;draw();};
            // Clearing is undoable as one action, alongside individual strokes.
            const undo=section.querySelector('[data-undo]');undo.onclick=()=>{if(!p.ops.length&&p.cleared){p.ops=p.cleared;p.cleared=null;}else p.ops.pop();draw();undo.disabled=!p.ops.length&&!p.cleared;update();};
            section.querySelector('[data-clear]').onclick=()=>{p.cleared=cloneSmartSettings(p.ops);p.ops=[];draw();undo.disabled=false;update();};
            section.querySelector('[data-size]').oninput=e=>{section.querySelector('[data-size-label]').textContent=e.target.value+' px';};
            p.draw=draw;const observer=new ResizeObserver(draw);observer.observe(view);p.observer=observer;draw();
        });
        update();
    }catch(error){status.textContent=error.message;}
    content.querySelector('[data-preview]').onclick=e=>{preview=!preview;e.target.textContent=preview?'返回编辑':'预览选区';panes.forEach(p=>p.draw());};
    d.addEventListener('keydown',e=>{
        if(e.code==='Space'&&e.target.tagName==='CANVAS'){space=true;e.preventDefault();}
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();const p=panes.find(p=>p.view===document.activeElement);p?.section.querySelector('[data-undo]').click();}
    });
    d.addEventListener('keyup',e=>{if(e.code==='Space')space=false;});d.addEventListener('focusout',()=>{space=false;});
    d.addEventListener('close',()=>panes.forEach(p=>p.observer.disconnect()),{once:true});
    save.onclick=async()=>{
        if(!valid()){status.textContent='输入、连线或设置已变化，请关闭后重新选择';return;}
        const previous=node.detailRepair.selections;
        try{
            const selections=Object.fromEntries(panes.map(p=>[p.role,{url:inputs[p.role].url,width:p.img.naturalWidth,height:p.img.naturalHeight,ops:cloneSmartSettings(p.ops)}]));
            Object.values(selections).forEach(s=>detailRepairBounds(s));
            save.disabled=true;status.textContent='正在保存选区…';node.detailRepair.selections=selections;
            if(!await saveCanvas())throw new Error('选区保存失败，请重试；当前选区已保留');
            if(canvas.id!==canvasToken||!nodes.includes(node))throw new Error('画布已切换，请重新打开编辑器');
            node.detailRepair.selections=previous;pushUndo();node.detailRepair.selections=selections;
            node.fusionMessage='两侧选区已保存';d.close();d.remove();render();scheduleSave();
        }catch(error){node.detailRepair.selections=previous;status.textContent=error.message;save.disabled=false;}
    };
}

async function detailRepairPrepare(node){
    const inputs=detailRepairInputs(node),scene=detailRepairSelection(node,'scene'),product=detailRepairSelection(node,'product');
    const [a,b]=await Promise.all([detailRepairImage(inputs.scene.url),detailRepairImage(inputs.product.url)]);
    if(a.naturalWidth!==scene.width||a.naturalHeight!==scene.height||b.naturalWidth!==product.width||b.naturalHeight!==product.height)throw new Error('图片尺寸已变化，请重新选择区域');
    const box=detailRepairBounds(scene,.16),referenceBox=detailRepairBounds(product);
    const crop=detailRepairCanvas(box.width,box.height);crop.getContext('2d').drawImage(a,box.x,box.y,box.width,box.height,0,0,box.width,box.height);
    const reference=detailRepairCanvas(referenceBox.width,referenceBox.height),r=reference.getContext('2d');
    r.drawImage(b,referenceBox.x,referenceBox.y,referenceBox.width,referenceBox.height,0,0,referenceBox.width,referenceBox.height);r.globalCompositeOperation='destination-in';r.drawImage(detailRepairMask(product,referenceBox),0,0);
    const mask=detailRepairMask(scene,box),m=mask.getContext('2d');m.globalCompositeOperation='destination-over';m.fillStyle='#000';m.fillRect(0,0,mask.width,mask.height);
    const files=await Promise.all([detailRepairUpload(crop,'repair-scene-crop.png'),detailRepairUpload(reference,'repair-product-detail.png'),detailRepairUpload(mask,'repair-region-mask.png')]);
    return {sourceUrl:inputs.scene.url,region:{...box,sourceUrl:inputs.scene.url,sourceWidth:a.naturalWidth,sourceHeight:a.naturalHeight},scene:files[0],product:files[1],mask:files[2]};
}
function detailRepairFusionPayload(node){
    const run=node.detailRepair?.run;if(!run?.prepared||!run.generatedUrl)throw new Error('局部修复结果尚未生成，请先完成模型任务');
    return {sourceUrl:run.prepared.sourceUrl,patches:[{url:run.generatedUrl,region:run.prepared.region,maskUrl:run.prepared.mask.url,alignment:'coordinates'}],colorMatch:false,feather:node.detailRepair.feather??6,blend:'alpha',overlap:'reject'};
}
async function cancelDetailRepairNode(node){
    const c=detailRepairConfig(node),session=detailRepairSessions.get(node.id);if(session)session.cancelled=true;
    if(c.run)c.run.cancelRequested=true;
    if(c.run&&!session&&!node.fusionJobId&&!localFusionSessions.has(node.id))c.run.terminal=true;
    if(node.fusionJobId||localFusionSessions.has(node.id))await cancelLocalFusionNode(node);
    if(c.run?.taskId)await XiaomeiImageTaskClient.requestJson('/api/canvas-image-tasks/'+encodeURIComponent(c.run.taskId)+'/cancel',{method:'POST'}).catch(error=>toast(error.message));
    node.fusionMessage='已停止等待；已提交的平台任务可能继续执行或计费';scheduleSave();render();
}
async function runDetailRepairNode(node,{resume=false,signal=null}={}){
    if(detailRepairSessions.has(node.id))return detailRepairSessions.get(node.id).promise;
    if(!collabCanMutateCanvas()||!collabCanEditNode(node.id))return {ok:false,error:'当前画布不可编辑'};
    const signature=detailRepairSignature(node),token=canvas.id,c=detailRepairConfig(node),session={cancelled:false};
    if(c.run?.terminal)delete c.run.cancelRequested;
    if(c.run)detailRepairRecoveries.add(c.run);
    const current=()=>canvas.id===token&&nodes.includes(node);
    const check=()=>{if(!current()||session.cancelled||signal?.aborted||c.run?.cancelRequested)throw new Error('细节修复已停止');if(signature!==detailRepairSignature(node))throw new Error('输入或选区已变化，请重新修复');};
    const onAbort=()=>void cancelDetailRepairNode(node);signal?.addEventListener('abort',onAbort,{once:true});
    detailRepairSessions.set(node.id,session);
    session.promise=(async()=>{
        try{
            delete node.runError;
            if(c.run&&!c.run.terminal&&c.run.signature!==signature)throw new Error('输入已变化，请先停止原任务，再开始新的修复');
            let run=c.run;
            if(!run||run.terminal){
                if(resume)return {ok:false,error:'没有待恢复任务'};
                if(!detailRepairLoadedModels.has(node))await detailRepairLoadModels(node,true);
                const model=detailRepairLoadedModels.has(node)&&c.models?.find(m=>`${m.provider_id}:${m.model}`===c.modelKey);if(!model)throw new Error('请先选择支持参考图编辑的图片模型');
                node.fusionMessage='正在提取两侧选区';render();
                const prepared=await detailRepairPrepare(node);check();
                const {width,height}=prepared.region,edge=1024,factor=edge/Math.max(width,height),size=`${Math.max(16,Math.round(width*factor/16)*16)}x${Math.max(16,Math.round(height*factor/16)*16)}`;
                run=c.run={signature,prepared,requestId:'detail-repair-'+(crypto.randomUUID?.()||uid('request')),stage:'submitting'};
                detailRepairRecoveries.add(run);
                run.payload={prompt:'图1是场景的局部裁剪，图2是产品选区中的正确细节。只将图2对应细节还原到图1中的同一位置。保留图1构图、视角、结构比例、光影和材质，文字与 Logo 严格参考图2，不添加或编造内容。返回完整图1裁剪画面，尺寸比例和边界位置不变，不输出对比图、标记或参考图。',provider_id:model.provider_id,model:model.model,n:1,size,aspect_ratio:'source',reference_images:[{url:prepared.scene.url,name:'场景局部',kind:'image'},{url:prepared.product.url,name:'产品正确细节',kind:'image'}],history_source:'canvas',project_id:currentSmartProjectId(),client_request_id:run.requestId};
                if(!await saveCanvas()){c.run=null;throw new Error('画布保存失败，尚未提交模型，请重试');}check();
            }
            check();
            if(!run.taskId){
                node.fusionMessage='正在提交局部修复';render();
                // The persisted correlation ID makes a lost POST response safe to retry.
                const task=await XiaomeiImageTaskClient.createImageTask(run.payload);run.taskId=task.task_id;
                if(!run.taskId)throw new Error('服务未返回任务编号，请保留选区后重试');
                run.stage='generating';scheduleSave();await saveCanvas();
                if(session.cancelled||run.cancelRequested||!current()){await XiaomeiImageTaskClient.requestJson('/api/canvas-image-tasks/'+encodeURIComponent(run.taskId)+'/cancel',{method:'POST'});check();}
            }
            if(!run.generatedUrl){
                node.fusionMessage='模型正在修复局部，完成后自动回贴';render();
                const task=await XiaomeiImageTaskClient.pollImageTask(run.taskId,{intervalMs:1200,initialDelayMs:0,maxNetworkFailures:3,
                    beforePoll:()=>{try{check();return null;}catch(error){return {action:'reject',error};}},
                    onTaskUpdate:task=>{if(['failed','cancelled','canceled'].includes(task.status))run.terminal=true;}});
                check();const result=task.result||task;run.generatedUrl=(result.image_items||[]).find(i=>i.url)?.url||(result.images||[])[0];
                if(typeof run.generatedUrl!=='string')throw new Error('模型未返回图片，请检查平台是否支持双图编辑');
                run.stage='compositing';scheduleSave();if(!await saveCanvas())throw new Error('修复结果已生成，但画布保存失败；请重试继续回贴');
            }
            check();node.fusionMessage='正在按蒙版回贴，校验选区外像素';
            await runLocalFusionNode(node);check();
            if(node.fusionStatus!=='completed')throw new Error(node.fusionMessage||'局部回贴失败');
            run.terminal=true;node.dependencyRunSignature=smartDependencySignature(node);return {ok:true};
        }catch(error){
            if(c.run?.stage==='submitting'&&Number(error.status)>=400&&Number(error.status)<500)c.run.terminal=true;
            if(current()){node.fusionStatus='failed';node.fusionMessage=error.message;node.runError=error.message;if(session.cancelled||c.run?.cancelRequested){if(c.run)c.run.terminal=true;}toast(error.message);}
            return {ok:false,error:error.message};
        }finally{
            signal?.removeEventListener('abort',onAbort);detailRepairSessions.delete(node.id);
            if(current()){render();scheduleSave();}
        }
    })();render();return session.promise;
}
