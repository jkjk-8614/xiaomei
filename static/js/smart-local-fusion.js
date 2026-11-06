/* Local repair provenance travels with images; paid generation stays in paint nodes. */
const localFusionSessions = new Map();
const LOCAL_FUSION_NODE_HEIGHT = 512;
function localFusionNodeHeight(node){
    const height=Number(node.h);
    return !height||height===600||height===660?LOCAL_FUSION_NODE_HEIGHT:Math.max(440,height);
}
function localFusionDefaults(){return {colorMatch:true,feather:12,blend:'alpha',overlap:'reject',versions:{},excluded:[],patches:{},patchOpen:{}};}
function localFusionConfig(node){return node.fusionConfig ||= localFusionDefaults();}
function createLocalFusionNodeAt(point){
    const node=createNode(point.x-210,point.y-240,[],{nodeType:'smart-local-fusion',title:'智能局部融合',skipRender:true});
    if(node){node.w=420;node.h=LOCAL_FUSION_NODE_HEIGHT;localFusionConfig(node);render();scheduleSave();}
    return node;
}
function localRepairRegionFromRefs(refs){
    const regions=new Map();
    for(const ref of refs||[]){
        const stored=ref.localRepair || nodes.flatMap(n=>n.images||[]).find(img=>img.url===ref.url)?.localRepair;
        if(stored?.id)regions.set(stored.id,stored);
    }
    return regions.size===1?cloneSmartSettings([...regions.values()][0]):null;
}
function localRepairApplyMeta(images,region){
    return region?(images||[]).map(image=>({...image,localRepair:cloneSmartSettings(region)})):images;
}
function startLocalRepairCrop(nodeId,index=0){
    if(!collabCanMutateCanvas()||!collabCanEditNode(nodeId))return;
    openImageEditor(nodeId,index);
    setImageEditMode('crop',true);
    if(cropState)cropState.localRepair=true;
    const button=document.querySelector('#imageEditApplyBtn span');
    if(button)button.textContent='裁出局部副本';
}
function localFusionInputImages(node){
    const seen=new Set();
    return workflowInputNodesFor(node).flatMap(n=>outputImagesForNode(n).map(img=>({...img,nodeId:n.id})))
        .filter(img=>img.url&&mediaKindForItem(img)==='image'&&!seen.has(img.url)&&seen.add(img.url));
}
function localFusionState(node){
    const config=localFusionConfig(node),inputs=localFusionInputImages(node);
    config.versions||={};config.excluded||=[];config.patches||={};
    const regions=nodes.flatMap(n=>n.images||[]).map(img=>img.localRepair).filter(Boolean);
    const sourceUrl=config.sourceUrl||inputs.find(img=>img.localRepair)?.localRepair.sourceUrl||inputs[0]?.url||'';
    const source=inputs.find(img=>img.url===sourceUrl)||{url:sourceUrl,name:'裁剪原图'};
    const groups=new Map();
    for(const img of inputs.filter(img=>img.url!==sourceUrl)){
        const region=img.localRepair;
        const key=region?.id||img.url;
        if(!groups.has(key))groups.set(key,{key,region,images:[]});
        groups.get(key).images.push(img);
    }
    const patches=[...groups.values()].map(group=>{
        const selected=group.images.find(img=>img.url===config.versions[group.key])||group.images.at(-1);
        const options=config.patches[group.key]||{};
        const region=options.regionId?regions.find(r=>r.id===options.regionId):group.region;
        return {...group,selected,options,region:options.manualRegion||region,enabled:!config.excluded.includes(group.key)};
    });
    return {source,inputs,patches,regions};
}
function localFusionPayload(node){
    if(node.detailRepair?.enabled)return detailRepairFusionPayload(node);
    const c=localFusionConfig(node),state=localFusionState(node);
    return {sourceUrl:state.source.url,colorMatch:c.colorMatch,feather:c.feather,blend:c.blend,overlap:c.overlap,
        patches:state.patches.filter(p=>p.enabled).map(p=>({url:p.selected.url,region:p.region||null,...p.options,
            manualRegion:undefined,regionId:undefined}))};
}
function localFusionSignature(node){return node.detailRepair?.enabled?detailRepairSignature(node):JSON.stringify(localFusionPayload(node));}
function localFusionTone(message){
    const text=String(message||'');
    if(!text)return 'is-idle';
    if(/失败|错误|无效|无法|异常|超时|超出/.test(text))return 'is-error';
    if(/完成|已输出/.test(text))return 'is-ok';
    if(/更新|重新|已变化|请检查/.test(text))return 'is-warn';
    return 'is-idle';
}
function localFusionToneIcon(tone,busy){
    if(busy)return 'loader-circle';
    return tone==='is-error'?'circle-alert':tone==='is-ok'?'circle-check':tone==='is-warn'?'triangle-alert':'info';
}
function localFusionAssetHtml(image,label,selection=''){
    const url=image?.url;
    return '<figure class="lf-asset'+(url?'':' is-empty')+'"><figcaption><strong>'+escapeHtml(label)+'</strong>'
        +(selection?'<span class="lf-asset-state'+(selection==='已选区'?' is-selected':'')+'">'+escapeHtml(selection)+'</span>':'')
        +'</figcaption><div class="lf-asset-frame">'+(url
        ?'<img src="'+escapeAttr(url)+'" alt="'+escapeAttr(image.name||label)+'">'
        :'<span class="lf-asset-empty"><i data-lucide="image-plus" aria-hidden="true"></i>待连接</span>')+'</div></figure>';
}
function localFusionPatchHtml(node,p,i,busy,state){
    const c=localFusionConfig(node),open=Boolean(c.patchOpen&&c.patchOpen[p.key]);
    const thumb=p.selected&&p.selected.url?'<img src="'+escapeAttr(p.selected.url)+'" alt="">':'<i data-lucide="image"></i>';
    const versions=p.images.map((img,j)=>'<option value="'+escapeAttr(img.url)+'" '+(img.url===(p.selected&&p.selected.url)?'selected':'')+'>'+(j+1)+'. '+escapeHtml(img.name||'图片')+'</option>').join('');
    const regions=[...new Map(state.regions.map(r=>[r.id,r])).values()].filter(r=>r.sourceUrl===state.source.url);
    return '<article class="lf-patch'+(p.enabled?'':' is-off')+'">'
        +'<div class="lf-patch-row">'
        +'<label class="lf-check" title="勾选后参与融合"><input type="checkbox" data-lf-enable="'+i+'" '+(p.enabled?'checked':'')+(busy?' disabled':'')+'><span>区域 '+(i+1)+'</span></label>'
        +'<figure class="lf-patch-thumb'+(p.selected&&p.selected.url?'':' is-empty')+'">'+thumb+'</figure>'
        +'<select data-lf-version="'+i+'" aria-label="区域 '+(i+1)+' 使用的修改图" '+(busy?'disabled':'')+'>'+versions+'</select>'
        +'<button type="button" class="lf-patch-toggle'+(open?' is-open':'')+'" data-lf-patch-toggle="'+i+'" aria-expanded="'+(open?'true':'false')+'" title="位置与蒙版" aria-label="区域 '+(i+1)+' 的位置与蒙版"><i data-lucide="chevron-down"></i></button>'
        +'</div>'
        +'<div class="lf-patch-body" '+(open?'':'hidden')+'>'
        +'<p class="lf-patch-body-head">位置与蒙版<em class="lf-tag'+(p.region?' is-on':'')+'">'+(p.region?'已定位':'未定位')+'</em></p>'
        +'<label class="lf-field"><span>对齐方式<small>默认自动检查边界</small></span><select data-lf-patch="alignment" data-index="'+i+'">'+[['auto','自动对齐'],['coordinates','只用裁剪坐标'],['manual','手动坐标']].map(([v,l])=>'<option value="'+v+'" '+((p.options.alignment||'auto')===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>'
        +'<label class="lf-field"><span>对应裁剪区域</span><select data-lf-patch="regionId" data-index="'+i+'"><option value="">随修改图自动关联</option>'+regions.map((r,j)=>'<option value="'+escapeAttr(r.id)+'" '+(p.options.regionId===r.id?'selected':'')+'>区域 '+(j+1)+' · '+r.x+','+r.y+' · '+r.width+'×'+r.height+'</option>').join('')+'</select></label>'
        +'<div class="lf-numbers">'+[['offsetX','水平偏移',0],['offsetY','垂直偏移',0],['scale','缩放',1],['rotation','旋转角度',0]].map(([k,l,v])=>'<label>'+l+'<input type="number" step="'+(k==='scale'?'.01':'1')+'" data-lf-patch="'+k+'" data-index="'+i+'" value="'+escapeAttr(p.options[k]??v)+'"></label>').join('')+'</div>'
        +'<label class="lf-check lf-check-inline"><input type="checkbox" data-lf-patch="allowDistortion" data-index="'+i+'" '+(p.options.allowDistortion?'checked':'')+'><span>允许拉伸宽高比（可能变形）</span></label>'
        +'<label class="lf-field"><span>生效范围<small>“只改变化部分”需检查预览</small></span><select data-lf-patch="maskMode" data-index="'+i+'">'+[['rectangle','整个裁剪区域'],['changes','只改有变化的部分']].map(([v,l])=>'<option value="'+v+'" '+(p.options.maskMode===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>'
        +'<div class="lf-patch-actions"><button type="button" data-lf-position="'+i+'"><i data-lucide="move"></i>填写坐标</button><button type="button" data-lf-mask="'+i+'" '+(!p.region?'disabled':'')+'><i data-lucide="brush"></i>涂抹蒙版</button>'+(p.options.maskUrl?'<button type="button" data-lf-clear-mask="'+i+'"><i data-lucide="eraser"></i>清除蒙版</button>':'')+'</div>'
        +'</div></article>';
}
function localFusionNodeBodyHtml(node){
    if(node.detailRepair?.enabled)return detailRepairNodeBodyHtml(node);
    const c=localFusionConfig(node),state=localFusionState(node),session=localFusionSessions.get(node.id);
    const busy=Boolean(session)||Boolean(node.fusionJobId),fresh=node.fusionPreview&&node.fusionPreviewSignature===localFusionSignature(node);
    const patches=state.patches||[],enabled=patches.filter(p=>p.enabled),located=patches.filter(p=>p.region).length;
    const hasSource=Boolean(state.source&&state.source.url),sourceName=(state.source&&state.source.name)||'裁剪原图';
    const message=String(node.fusionMessage||'').trim(),tone=node.fusionStatus==='failed'?'is-error':localFusionTone(message);
    const canRun=hasSource&&enabled.length>0&&!busy;
    const originals=[...new Map([...state.inputs,...state.regions.map(r=>({url:r.sourceUrl,name:'裁剪原图'}))].filter(x=>x.url).map(x=>[x.url,x])).values()];
    const autoOption='<option value="" '+(c.sourceUrl?'':'selected')+'>'+(hasSource?'自动 · '+escapeHtml(sourceName):'自动选择裁剪原图')+'</option>';
    const sourceOptions=originals.map(img=>'<option value="'+escapeAttr(img.url)+'" '+(img.url===c.sourceUrl?'selected':'')+'>'+escapeHtml(img.name||'图片')+'</option>').join('');
    const patchPreview=(enabled[0]&&enabled[0].selected)||(patches[0]&&patches[0].selected)||null;
    const statusText=busy?(message||'正在融合…')
        :!hasSource?'将原图和局部修改图连到左侧输入口'
        :!patches.length?'将 AI 修改后的局部图连到左侧输入口'
        :!enabled.length?'勾选至少一个要融合的区域'
        :message||'可以开始融合';
    return '<div class="local-fusion-body" data-lf-root><div class="lf-scroll">'+detailRepairModeSwitch(node)
        +'<section class="lf-section" aria-label="素材"><div class="lf-assets">'
        +localFusionAssetHtml(state.source,'原图')+localFusionAssetHtml(patchPreview,'局部修改图')
        +'</div>'+(hasSource?'<label class="lf-source-row"><span>原图来源</span><select data-lf-source title="'+escapeAttr(sourceName)+'" '+(busy?'disabled':'')+'>'+autoOption+sourceOptions+'</select></label>'
            :'<p class="lf-note">在原图上用「局部修复」裁出副本，交给 AI 修改后再连回来。</p>')
        +'</section>'
        +(patches.length
            ?'<section class="lf-section"><header class="lf-section-head"><strong>融合区域</strong><span>已启用 '+enabled.length+' / '+patches.length+'</span></header>'
                +'<div class="lf-patches">'+patches.map((p,i)=>localFusionPatchHtml(node,p,i,busy,state)).join('')+'</div>'
                +((located<patches.length)?'<p class="lf-note">'+(patches.length-located)+' 个区域没有裁剪坐标，将按画面特征自动定位</p>':'')+'</section>'
            :'')
        +(hasSource?'<details class="lf-advanced lf-fusion-settings" '+(c.advancedOpen?'open':'')+'><summary><strong>融合设置</strong><span>'+escapeHtml(c.feather)+' px · '+(c.blend==='poisson'?'泊松':'羽化')+'</span></summary>'
            +'<label class="lf-switch" title="让局部图色调贴合原图"><input type="checkbox" data-lf-color '+(c.colorMatch?'checked':'')+(busy?' disabled':'')+'><span class="lf-switch-track" aria-hidden="true"></span><span class="lf-switch-text">颜色匹配</span></label>'
            +'<div class="lf-fields">'
            +'<label class="lf-field lf-field-stack" title="数值越大，接缝过渡越柔和"><span>边缘过渡</span><span class="lf-field-ctl"><input type="number" min="0" max="128" data-lf-config="feather" value="'+escapeAttr(c.feather)+'"><em>px</em></span></label>'
            +'<label class="lf-field lf-field-stack"><span>融合方式</span><select data-lf-config="blend">'+[['alpha','羽化 · 保留细节'],['poisson','泊松 · 融合背景纹理']].map(([v,l])=>'<option value="'+v+'" '+(c.blend===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>'
            +'</div>'
            +(patches.length?'<label class="lf-field"><span>区域重叠时</span><select data-lf-config="overlap">'+[['reject','停止并提示'],['ordered','按列表顺序叠加']].map(([v,l])=>'<option value="'+v+'" '+(c.overlap===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>':'')
            +'<p class="lf-note">泊松融合可能改变文字和 Logo 的颜色。手动填写坐标后请先看预览。</p></details>':'')
        +(node.fusionPreview?'<section class="lf-result">'
            +'<button type="button" class="lf-result-thumb" data-lf-preview aria-label="放大检查融合结果"><img src="'+escapeAttr(node.fusionPreview.url)+'" alt="融合结果预览"><span><i data-lucide="maximize-2"></i></span></button>'
            +'<div class="lf-result-info"><strong>融合预览</strong><small>'+(fresh?'请检查接缝、文字与产品结构':'输入已变化，请重新融合')+'</small><button type="button" data-lf-output '+(!fresh||busy?'disabled':'')+'>查看完整图片</button></div></section>':'')
        +'</div><div class="lf-footer"><p class="lf-state '+(statusText===message?tone:'is-idle')+'" role="status"><i data-lucide="'+localFusionToneIcon(statusText===message?tone:'is-idle',busy)+'" aria-hidden="true"></i><span>'+escapeHtml(statusText)+'</span></p>'
        +'<div class="dr-actions"><button type="button" class="lf-run-btn" data-lf-run '+(canRun?'':'disabled')+'>'+(busy?'正在融合…':'开始融合')+'</button>'
        +(busy?'<button type="button" data-lf-cancel>取消融合</button>':'')+'</div></div>'
        +'</div>';
}
function bindLocalFusionNode(el,node){
    if(node.detailRepair?.enabled){bindDetailRepairNode(el,node);return;}
    const root=el.querySelector('[data-lf-root]');if(!root)return;
    // Keep controls from starting node drag / canvas shortcuts.
    root.addEventListener('pointerdown',e=>e.stopPropagation());root.addEventListener('mousedown',e=>e.stopPropagation());
    root.addEventListener('wheel',e=>e.stopPropagation(),{passive:true});
    // 每次改参数都会整体重绘 body，记下滚动位置，避免「调一个值就跳回顶部」。
    const mutate=fn=>{if(localFusionSessions.has(node.id)||!collabCanMutateCanvas()||!collabCanEditNode(node.id))return;const top=(root.querySelector('.lf-scroll')||root).scrollTop;pushUndo();fn();delete node.fusionStatus;node.fusionMessage='设置已更新，重新融合后生效';render();scheduleSave();const next=document.querySelector('[data-id="'+CSS.escape(node.id)+'"] .lf-scroll');if(next)next.scrollTop=top;};
    const state=()=>localFusionState(node),c=localFusionConfig(node);
    root.querySelector('[data-dr-mode]')?.addEventListener('click',()=>setDetailRepairMode(node,true));
    // 区域「位置与蒙版」展开状态跟着节点存，重绘后不收起。
    root.querySelectorAll('[data-lf-patch-toggle]').forEach(button=>button.onclick=()=>{
        const index=Number(button.dataset.lfPatchToggle),body=button.closest('.lf-patch').querySelector('.lf-patch-body');
        const open=body.hasAttribute('hidden');
        body.toggleAttribute('hidden',!open);
        button.setAttribute('aria-expanded',String(open));button.classList.toggle('is-open',open);
        const patch=state().patches[index];if(patch){c.patchOpen||={};c.patchOpen[patch.key]=open;}scheduleSave();
    });
    if(localFusionSessions.has(node.id)||node.fusionJobId)root.querySelectorAll('input,select,[data-lf-position],[data-lf-mask],[data-lf-clear-mask]').forEach(input=>input.disabled=true);
    root.querySelector('[data-lf-source]')?.addEventListener('change',e=>mutate(()=>{c.sourceUrl=e.target.value;}));
    root.querySelector('[data-lf-color]')?.addEventListener('change',e=>mutate(()=>{c.colorMatch=e.target.checked;}));
    root.querySelectorAll('[data-lf-config]').forEach(input=>input.onchange=()=>mutate(()=>{c[input.dataset.lfConfig]=input.type==='number'?Number(input.value):input.value;}));
    root.querySelectorAll('[data-lf-enable]').forEach(input=>input.onchange=()=>mutate(()=>{const key=state().patches[Number(input.dataset.lfEnable)].key;c.excluded=c.excluded.filter(k=>k!==key);if(!input.checked)c.excluded.push(key);}));
    root.querySelectorAll('[data-lf-version]').forEach(input=>input.onchange=()=>mutate(()=>{c.versions[state().patches[Number(input.dataset.lfVersion)].key]=input.value;}));
    root.querySelectorAll('[data-lf-patch]').forEach(input=>input.onchange=()=>mutate(()=>{const p=state().patches[Number(input.dataset.index)],options=c.patches[p.key]||={};options[input.dataset.lfPatch]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;if(input.dataset.lfPatch==='regionId')delete options.manualRegion;}));
    root.querySelector('.lf-advanced')?.addEventListener('toggle',e=>{c.advancedOpen=e.target.open;});
    root.querySelectorAll('[data-lf-position]').forEach(button=>button.onclick=()=>localFusionPositionDialog(node,Number(button.dataset.lfPosition)));
    root.querySelectorAll('[data-lf-mask]').forEach(button=>button.onclick=()=>localFusionMaskDialog(node,Number(button.dataset.lfMask)));
    root.querySelectorAll('[data-lf-clear-mask]').forEach(button=>button.onclick=()=>mutate(()=>{const p=state().patches[Number(button.dataset.lfClearMask)];delete c.patches[p.key].maskUrl;}));
    root.querySelector('[data-lf-run]').onclick=()=>void runLocalFusionNode(node);
    root.querySelector('[data-lf-cancel]')?.addEventListener('click',()=>void cancelLocalFusionNode(node));
    root.querySelector('[data-lf-preview]')?.addEventListener('click',()=>localFusionPreviewDialog(node));
    root.querySelector('[data-lf-output]')?.addEventListener('click',()=>localFusionOutput(node));
    if(node.fusionJobId&&!localFusionSessions.has(node.id))void pollLocalFusionNode(node,node.fusionJobId,node.fusionJobSignature);
}
async function localFusionFetch(url,options){
    const r=await fetch(url,options),data=await r.json();
    if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:'融合请求无效，请检查区域与参数');return data;
}
async function runLocalFusionNode(node){
    if(!collabCanMutateCanvas()||!collabCanEditNode(node.id)||localFusionSessions.has(node.id))return;
    const signature=localFusionSignature(node),canvasToken=canvas.id;
    localFusionSessions.set(node.id,{starting:true,canvasToken});
    node.fusionStatus='queued';node.fusionMessage='正在提交本地融合';render();
    try{
        const job=await localFusionFetch('/api/local-fusion/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(localFusionPayload(node))});
        if(canvas.id!==canvasToken||!nodes.includes(node)||localFusionSessions.get(node.id)?.cancelled){await fetch('/api/local-fusion/jobs/'+job.id,{method:'DELETE'});return;}
        node.fusionJobId=job.id;node.fusionJobSignature=signature;localFusionSessions.delete(node.id);scheduleSave();
        await pollLocalFusionNode(node,job.id,signature);
    }catch(error){node.fusionStatus='failed';node.fusionMessage='融合未完成：'+error.message;toast(node.fusionMessage);}
    finally{localFusionSessions.delete(node.id);if(canvas.id===canvasToken){render();scheduleSave();}}
}
async function pollLocalFusionNode(node,id,signature){
    if(localFusionSessions.has(node.id))return;
    const session={canvasToken:canvas.id};localFusionSessions.set(node.id,session);
    try{
        while(true){
            if(canvas.id!==session.canvasToken||!nodes.includes(node)){await fetch('/api/local-fusion/jobs/'+id,{method:'DELETE'});return;}
            const job=await localFusionFetch('/api/local-fusion/jobs/'+id);
            if(canvas.id!==session.canvasToken||!nodes.includes(node))return;
            node.fusionStatus=job.status;node.fusionMessage=job.message;
            if(job.status==='completed'){
                if(node.detailRepair?.enabled&&node.detailRepair.run)node.detailRepair.run.terminal=true;
                pushUndo();node.fusionPreview=job.result;node.fusionPreviewSignature=signature;
                node.fusionPreviewSource=JSON.parse(signature).sourceUrl;
                node.fusionMessage=job.result.report.warnings.join('；')||'融合预览完成 · 原图尺寸不变，修改范围外像素一致';
                if(!session.cancelled&&signature===localFusionSignature(node))localFusionOutput(node);
                break;
            }
            if(['failed','cancelled'].includes(job.status)){
                if(job.status==='failed'){node.fusionMessage='融合未完成：'+job.message;toast(node.fusionMessage);}
                break;
            }
            const text=document.querySelector('[data-id="'+CSS.escape(node.id)+'"] .lf-state > span');if(text)text.textContent=job.message;
            await new Promise(resolve=>setTimeout(resolve,450));
        }
    }catch(error){node.fusionStatus='failed';node.fusionMessage='融合未完成：'+error.message;toast(node.fusionMessage);}
    finally{localFusionSessions.delete(node.id);delete node.fusionJobId;if(canvas.id===session.canvasToken){render();scheduleSave();}}
}
async function cancelLocalFusionNode(node){
    const session=localFusionSessions.get(node.id);if(session)session.cancelled=true;
    if(node.fusionJobId)await localFusionFetch('/api/local-fusion/jobs/'+node.fusionJobId,{method:'DELETE'}).catch(error=>toast(error.message));
}
function localFusionOutput(node){
    if(!collabCanMutateCanvas()||!collabCanEditNode(node.id)||node.fusionPreviewSignature!==localFusionSignature(node))return;
    const result=node.fusionPreview;if(!result)return;
    let output=nodes.find(n=>(node.fusionOutputs||[]).some(record=>record.nodeId===n.id&&record.url===result.url)&&n.images?.some(img=>img.url===result.url));
    if(!output){
        pushUndo();
        output=createNode(node.x+nodeRect(node).width+64,node.y,[{url:result.url,name:result.name,kind:'image',natural_w:result.width,natural_h:result.height,width:result.width,height:result.height,
            fusionRecord:{sourceUrl:node.fusionPreviewSource,request:JSON.parse(node.fusionPreviewSignature),report:result.report,maskUrl:result.maskUrl}}],{skipUndo:true,skipRender:true,skipSave:true});
        if(!output)return;output.title=node.detailRepair?.enabled?'细节修复结果':'局部修复结果';
        if(node.detailRepair?.enabled){
            const region=detailRepairInputs(node).scene?.localRepair;
            if(region)output.images[0].localRepair=cloneSmartSettings(region);
        }
        addConnection(node.id,output.id,'flow');
        node.fusionOutputs||=[];node.fusionOutputs.push({nodeId:output.id,url:result.url,createdAt:Date.now()});
    }
    node.images=[{...output.images[0]}];
    node.fusionMessage='融合完成，完整图片已输出到右侧'+(result.report.warnings.length?'；'+result.report.warnings.join('；'):'');render();
    const a=nodeRect(node),b=nodeRect(output),left=Math.min(a.x,b.x),top=Math.min(a.y,b.y),right=Math.max(a.x+a.width,b.x+b.width),bottom=Math.max(a.y+a.height,b.y+b.height);
    viewport.scale=Math.min(viewport.scale,(shell.clientWidth-100)/Math.max(1,right-left),(shell.clientHeight-160)/Math.max(1,bottom-top));
    centerViewportOnWorldPoint({x:(left+right)/2,y:(top+bottom)/2});
    scheduleSave();toast('已输出完整图片，可继续局部修复');
}
function localFusionDialog(title){
    const dialog=document.createElement('dialog');dialog.className='lf-dialog';
    dialog.innerHTML='<header><h2>'+escapeHtml(title)+'</h2><button type="button" aria-label="关闭">×</button></header><div class="lf-dialog-content"></div>';
    const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('header button').onclick=close;
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.oncancel=e=>{e.preventDefault();close();};dialog.addEventListener('click',e=>{if(e.target===dialog)close();});
    document.body.append(dialog);dialog.showModal();return dialog;
}
function localFusionPreviewDialog(node){
    const d=localFusionDialog('融合结果预览'),r=node.fusionPreview;
    d.querySelector('.lf-dialog-content').innerHTML='<div class="lf-preview-controls"><button data-lf-view="result">融合结果</button><button data-lf-view="source">原图</button><button data-lf-view="mask">修改范围</button><button data-lf-pixels>适应窗口</button><label>缩放 <input data-lf-zoom type="range" min="10" max="400" step="10" value="100"></label><output data-lf-zoom-label>100%</output><span>'+r.width+'×'+r.height+'</span></div><div class="lf-preview-stage actual-pixels"><div class="lf-preview-image"><img class="lf-large-preview" src="'+escapeAttr(r.url)+'" alt="融合结果"><img class="lf-preview-mask" src="'+escapeAttr(r.maskUrl)+'" alt="修改范围叠加" hidden></div></div><p data-lf-preview-note>'+escapeHtml(r.report.warnings.join('；')||'滚轮或缩放滑块可放大检查文字、Logo、产品结构与接缝。')+'</p>';
    const stage=d.querySelector('.lf-preview-stage'),img=d.querySelector('.lf-large-preview'),zoom=d.querySelector('[data-lf-zoom]'),label=d.querySelector('[data-lf-zoom-label]'),pixels=d.querySelector('[data-lf-pixels]');
    const setZoom=value=>{const percent=Math.max(10,Math.min(400,Math.round(value/10)*10));stage.classList.add('actual-pixels');img.style.width=Math.round(r.width*percent/100)+'px';zoom.value=percent;label.textContent=percent+'%';pixels.textContent='适应窗口';};
    zoom.oninput=()=>setZoom(Number(zoom.value));
    stage.addEventListener('wheel',e=>{e.preventDefault();setZoom(Number(zoom.value)+(e.deltaY<0?10:-10));},{passive:false});
    d.querySelectorAll('[data-lf-view]').forEach(b=>b.onclick=()=>{
        const mask=b.dataset.lfView==='mask';img.src=b.dataset.lfView==='result'?r.url:node.fusionPreviewSource;
        d.querySelector('.lf-preview-mask').hidden=!mask;
        d.querySelector('[data-lf-preview-note]').textContent=mask?'绿色高亮是实际修改范围，请检查边缘是否经过文字或重要结构。':r.report.warnings.join('；')||'滚轮或缩放滑块可放大检查文字、Logo、产品结构与接缝。';
    });
    pixels.onclick=()=>{const actual=stage.classList.contains('actual-pixels');if(actual){stage.classList.remove('actual-pixels');img.style.width='';pixels.textContent='实际像素';label.textContent='适应窗口';}else setZoom(100);};
}
async function localFusionPositionDialog(node,index){
    const state=localFusionState(node),p=state.patches[index],d=localFusionDialog('局部图在原图中的位置');
    const img=new Image();img.src=state.source.url;
    try{await img.decode();}catch{d.close();d.remove();toast('原图无法读取');return;}
    if(!d.isConnected)return;
    const r=p.region||{x:0,y:0,width:Math.min(img.naturalWidth,512),height:Math.min(img.naturalHeight,512)};
    const content=d.querySelector('.lf-dialog-content');
    content.innerHTML='<p>坐标以原图左上角为起点，单位为像素。保存后使用手动定位，请检查融合预览。</p><div class="lf-numbers">'+[['x','左',r.x],['y','上',r.y],['width','宽',r.width],['height','高',r.height]].map(([k,l,v])=>'<label>'+l+'<input name="'+k+'" type="number" min="0" value="'+v+'"></label>').join('')+'</div><p role="status"></p><button data-save>保存位置</button>';
    content.querySelector('[data-save]').onclick=()=>{
        if(!collabCanMutateCanvas()||!collabCanEditNode(node.id))return;
        const box=Object.fromEntries([...content.querySelectorAll('input')].map(i=>[i.name,Number(i.value)]));
        if(Object.values(box).some(v=>!Number.isInteger(v)||v<0)||box.width<4||box.height<4||box.x+box.width>img.naturalWidth||box.y+box.height>img.naturalHeight){content.querySelector('[role=status]').textContent='位置超出原图或尺寸小于 4 像素';return;}
        pushUndo();const opts=localFusionConfig(node).patches[p.key]||={};opts.alignment='manual';opts.manualRegion={...box,id:'manual-'+p.key,sourceUrl:state.source.url,sourceWidth:img.naturalWidth,sourceHeight:img.naturalHeight};
        d.close();d.remove();render();scheduleSave();
    };
}
async function localFusionMaskDialog(node,index){
    const state=localFusionState(node),p=state.patches[index],r=p.region;if(!r)return;
    const d=localFusionDialog('绘制需要修改的区域'),content=d.querySelector('.lf-dialog-content');
    content.innerHTML='<p>涂抹区域会使用局部修改图，其余保留原图。文字和 Logo 请完整涂入区域。</p><div class="lf-preview-controls"><label>画笔 <input type="range" min="2" max="120" value="32" data-size></label><label><input type="checkbox" data-erase>擦除</label><button data-clear>清空</button></div><canvas class="lf-mask-canvas"></canvas><p role="status"></p><button data-save>保存蒙版</button>';
    const image=new Image();image.src=state.source.url;
    try{await image.decode();}catch{content.querySelector('[role=status]').textContent='原图无法读取';return;}
    if(!d.isConnected)return;
    const canvasEl=content.querySelector('canvas'),s=Math.min(1,1000/Math.max(r.width,r.height));
    canvasEl.width=Math.max(1,Math.round(r.width*s));canvasEl.height=Math.max(1,Math.round(r.height*s));
    const mask=document.createElement('canvas');mask.width=r.width;mask.height=r.height;
    const m=mask.getContext('2d');m.fillStyle='#000';m.fillRect(0,0,r.width,r.height);
    if(p.options.maskUrl){const old=new Image();old.src=p.options.maskUrl;try{await old.decode();m.drawImage(old,0,0,r.width,r.height);}catch{}}
    const draw=()=>{const ctx=canvasEl.getContext('2d');ctx.clearRect(0,0,canvasEl.width,canvasEl.height);ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,canvasEl.width,canvasEl.height);ctx.globalAlpha=.42;ctx.drawImage(mask,0,0,canvasEl.width,canvasEl.height);ctx.globalAlpha=1;};
    draw();let last=null;
    const point=e=>{const b=canvasEl.getBoundingClientRect();return [(e.clientX-b.left)/b.width*r.width,(e.clientY-b.top)/b.height*r.height];};
    const paint=e=>{const next=point(e),size=Number(content.querySelector('[data-size]').value)/s;m.strokeStyle=m.fillStyle=content.querySelector('[data-erase]').checked?'#000':'#fff';m.lineWidth=size;m.lineCap='round';m.beginPath();m.moveTo(...(last||next));m.lineTo(...next);m.stroke();m.beginPath();m.arc(...next,size/2,0,Math.PI*2);m.fill();last=next;draw();};
    canvasEl.onpointerdown=e=>{canvasEl.setPointerCapture(e.pointerId);last=point(e);paint(e);};canvasEl.onpointermove=e=>{if(last)paint(e);};canvasEl.onpointerup=()=>{last=null;};canvasEl.onpointercancel=()=>{last=null;};
    content.querySelector('[data-clear]').onclick=()=>{m.fillStyle='#000';m.fillRect(0,0,r.width,r.height);draw();};
    content.querySelector('[data-save]').onclick=async e=>{
        if(!collabCanMutateCanvas()||!collabCanEditNode(node.id)||localFusionSessions.has(node.id))return;
        e.target.disabled=true;
        try{const blob=await new Promise(resolve=>mask.toBlob(resolve,'image/png')),file=await uploadCroppedBlob(blob,'local-repair-mask.png');
            if(!nodes.includes(node)||localFusionState(node).source.url!==state.source.url)throw new Error('原图已改变，请重新绘制');
            pushUndo();(localFusionConfig(node).patches[p.key]||={}).maskUrl=file.url;d.close();d.remove();render();scheduleSave();
        }catch(error){content.querySelector('[role=status]').textContent=error.message;e.target.disabled=false;}
    };
}
