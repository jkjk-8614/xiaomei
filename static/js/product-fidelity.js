/* Product fidelity is a local processing node. Models and paid generation belong to downstream paint nodes. */
const productFidelitySessions = new Map();
function productFidelityDefaults(){
    return {version:1,enabled:false,mode:'strict',category:'auto',geometry:'auto',referenceIds:{},rois:[],maskStrokes:[],
        structure:{lockRatio:true,lockOutline:true,lockLines:true,lockSymmetry:false,lockLayout:true},
        detail:{enabled:true,inputMode:'combined',highPassRadiusPx:2,highPassGain:2,autoCrops:false,cropCount:2,restoreMode:'off',restoreStrength:.3},
        dimensions:{width:0,height:0,depth:0,unit:'cm'},view:{mode:'keep',yaw:0,pitch:0,roll:0,proxyEnabled:false},
        generation:{allowedEdits:'background'},validation:{enabled:true,ratioTolerancePct:5},retries:{enabled:false,maxRetries:0},
        maskFeatherPx:0,alignmentThreshold:.85};
}
function fidelityConfig(raw){
    const base=productFidelityDefaults(), old=cloneSmartSettings(raw||{});
    const config={...base,...old};
    for(const key of ['structure','detail','dimensions','view','generation','validation','retries']) config[key]={...base[key],...old[key]};
    config.referenceIds={...config.referenceIds};config.rois=config.rois||[];config.maskStrokes=config.maskStrokes||[];
    return config;
}
function normalizeProductFidelityNode(node){
    node.type=SMART_PRODUCT_FIDELITY_NODE_TYPE;
    if(!node.fidelityConfig) node.fidelityConfig=fidelityConfig(node.runSettings?.productFidelity||{enabled:true});
    node.w=Math.max(760,Number(node.w)||980);node.h=Math.max(650,Number(node.h)||820);
    node.title='产品保真';
    return node;
}
function createProductFidelityNodeAt(point){
    const node=createNode((point?.x||0)-490,(point?.y||0)-410,[],{nodeType:SMART_PRODUCT_FIDELITY_NODE_TYPE,title:'产品保真',skipSave:true});
    if(!node)return null;
    normalizeProductFidelityNode(node);
    node.fidelityConfig.detail.autoCrops=true;
    render();updateComposer();scheduleSave();
    return node;
}
function fidelityGetValue(config,key){return key.split('.').reduce((value,part)=>value?.[part],config);}
function fidelitySetValue(config,key,value){
    const parts=key.split('.');let target=config;
    for(const part of parts.slice(0,-1)) target=target[part]||={};
    target[parts.at(-1)]=value;
}
function fidelityChangeMode(config,mode){
    config.mode=mode;config.generation.allowedEdits=mode==='strict'?'background':mode==='view'?'view':'lighting';
    if(mode!=='view')config.view={mode:'keep',yaw:0,pitch:0,roll:0,proxyEnabled:false};
    if(mode==='view'){config.view.mode='target';config.detail.restoreMode='off';}
}
function productFidelityInputImages(node,ctx=smartLoopContext,visited=new Set()){
    if(!node||visited.has(node.id))return [];
    visited.add(node.id);
    const source=workflowInputNodesFor(node).flatMap(input=>isProductFidelityNode(input)?productFidelityInputImages(input,ctx,visited):outputImagesForNode(input,false,ctx));
    const own=(node.images||[]).map((image,index)=>({...image,nodeId:node.id,imageIndex:index}));
    const seen=new Set(), maskUrl=node.fidelityConfig?.maskUrl;
    return orderedSmartInputReferences(node,[...source,...manualReferenceImagesFor(node),...own])
        .filter(ref=>ref?.url&&mediaKindForItem(ref)==='image'&&ref.url!==maskUrl&&!isInputRefBlocked(node,ref))
        .filter(ref=>{if(seen.has(ref.url))return false;seen.add(ref.url);return true;})
        .map((ref,index)=>({...ref,nodeId:node.id,imageIndex:index}));
}
function fidelityEnsureReferences(node){
    normalizeProductFidelityNode(node);
    const refs=productFidelityInputImages(node),config=node.fidelityConfig;
    refs.forEach(ref=>config.referenceIds[ref.url]||=(crypto.randomUUID?.()||uid('fidelity-ref')));
    if(!config.productReferenceId&&refs[0])config.productReferenceId=config.referenceIds[refs[0].url];
    return refs;
}
function productFidelitySourcesFor(node){
    const found=new Map(),seen=new Set();
    function walk(item){
        if(!item||seen.has(item.id))return;seen.add(item.id);
        if(isProductFidelityNode(item)){normalizeProductFidelityNode(item);if(item.fidelityConfig.enabled)found.set(item.id,item);return;}
        if(isSmartPaintNode(item)||isSmartUploadNode(item))return;
        workflowInputNodesFor(item).forEach(walk);
    }
    workflowInputNodesFor(node).forEach(walk);
    return [...found.values()];
}
function productFidelitySettingsForNode(node,base){
    if(!node||isProductFidelityNode(node))return base;
    const next=cloneSmartSettings(base);
    if(next.productFidelity?.sourceNodeId)delete next.productFidelity;
    const sources=productFidelitySourcesFor(node);
    if(sources.length===1){
        fidelityEnsureReferences(sources[0]);
        next.productFidelity={...cloneSmartSettings(sources[0].fidelityConfig),sourceNodeId:sources[0].id};
    }
    return next;
}
function productFidelityReferences(refs,config){
    config.referenceIds||={};
    const source=nodes.find(node=>node.id===config.sourceNodeId&&isProductFidelityNode(node));
    return imageRefsOnly(refs).map(ref=>{
        config.referenceIds[ref.url]||=source?.fidelityConfig?.referenceIds?.[ref.url]||ref.reference_id||(crypto.randomUUID?.()||uid('fidelity-ref'));
        if(source)source.fidelityConfig.referenceIds[ref.url]=config.referenceIds[ref.url];
        return {...ref,reference_id:config.referenceIds[ref.url]};
    });
}
function validateProductFidelityRun(node,runSettings){
    const sources=productFidelitySourcesFor(node);
    if(sources.length>1)throw new Error('当前绘画连接了多个启用的产品保真节点，请只保留一个保护来源');
    const effective=productFidelitySettingsForNode(node,runSettings);
    if(effective.productFidelity)runSettings.productFidelity=effective.productFidelity;
    else if(runSettings.productFidelity?.sourceNodeId)delete runSettings.productFidelity;
    if(!runSettings.productFidelity?.enabled)return;
    if(runSettings.engine!=='api'||runSettings.apiKind==='video'||runSettings.imageOperation==='upscale')
        throw new Error('产品保真需要普通 API 图片模型；请选择图片模型或关闭上游产品保真');
    if(node?.outpaintSize||runSettings.outpaintMode)throw new Error('产品保真不能与扩图同时运行，请分别处理');
    if(runSettings.productFidelity.mode==='strict'&&upstreamCameraNodesFor(node).length)
        throw new Error('保留原产品像素需要保持原角度，请关闭视角控制或改用视角保真');
}
function validateProductFidelityConnection(from,to){
    if(!isProductFidelityNode(from)&&!isProductFidelityNode(to))return true;
    if(isProductFidelityNode(from)&&isProductFidelityNode(to)){toast('产品保真节点不串联，请将它连接到绘画节点');return false;}
    const seen=new Set();
    function ancestor(item){
        if(!item||seen.has(item.id))return false;seen.add(item.id);
        return item.id===to.id||workflowInputNodesFor(item).some(ancestor);
    }
    if(ancestor(from)){toast('这条连接会形成循环，请连接到下游节点');return false;}
    return true;
}
function fidelityDownstream(node){
    return nodes.filter(item=>isSmartPaintNode(item)&&productFidelitySourcesFor(item).some(source=>source.id===node.id));
}
function fidelitySignature(node){
    return JSON.stringify({config:node.fidelityConfig,refs:productFidelityInputImages(node).map(ref=>ref.url)});
}
function fidelityAssetHtml(asset,label){
    return '<figure><a href="'+escapeAttr(asset.url)+'" target="_blank" rel="noopener"><img src="'+escapeAttr(asset.url)+'" alt="'+escapeAttr(label||asset.name||'处理图片')+'"></a><figcaption>'+escapeHtml(label||asset.name||'处理图片')+'</figcaption></figure>';
}
function productFidelityNodeBodyHtml(node){
    const refs=fidelityEnsureReferences(node),config=node.fidelityConfig;
    const check=(key,label)=>'<label class="pf-check"><input type="checkbox" data-pf-field="'+key+'" '+(fidelityGetValue(config,key)?'checked':'')+'><span>'+label+'</span></label>';
    const select=(key,label,choices)=>'<label class="pf-field"><span>'+label+'</span><select data-pf-field="'+key+'">'+choices.map(([v,t])=>'<option value="'+escapeAttr(v)+'" '+(fidelityGetValue(config,key)===v?'selected':'')+'>'+escapeHtml(t)+'</option>').join('')+'</select></label>';
    const number=(key,label,min,max,step,unit='')=>'<label class="pf-field"><span>'+label+'</span><span class="pf-number"><input type="number" min="'+min+'" max="'+max+'" step="'+step+'" data-pf-field="'+key+'" value="'+Number(fidelityGetValue(config,key)||0)+'">'+unit+'</span></label>';
    const section=(title,content)=>'<section class="pf-section" data-pf-section="'+title.slice(0,2)+'"><h3>'+title+'</h3>'+content+'</section>';
    const previous=node.fidelityPreview, fresh=previous?.signature===fidelitySignature(node);
    const current=refs.find(ref=>config.referenceIds[ref.url]===config.productReferenceId);
    const assets=fresh?previous.generatedAssets||[]:[];
    return '<div class="pf-workbench" data-pf-root><header class="pf-heading"><div><strong>产品保真</strong><span>处理产品图片，将保护规则传给下游绘画</span></div>'+check('enabled','启用')+'</header>'+
        '<div class="pf-layout"><div class="pf-image-column"><div class="pf-image-heading"><strong>产品图片</strong><span data-pf-source-info>'+refs.length+' 张输入</span></div>'+
        '<div class="pf-tools"><button type="button" data-pf-tool="mask">画保护区</button><button type="button" data-pf-tool="erase">擦除保护区</button><button type="button" data-pf-tool="roi">框选细节</button></div>'+
        '<label class="pf-brush">画笔大小<input type="range" min="1" max="20" value="4" data-pf-brush></label>'+
        '<div class="pf-canvas-stage"><canvas data-pf-canvas aria-label="产品图片与保护区域"></canvas><p data-pf-empty '+(current?'hidden':'')+'>将左侧产品图片连接到此节点<br>随后在图上标出需要保护的区域</p></div>'+
        '<p class="pf-image-note" data-pf-roi-info>绿色：保护区域 · 橙色：手动细节 · 蓝色：自动候选</p>'+
        '<div class="pf-secondary-actions"><button type="button" data-pf-action="clear-mask">重置保护区域</button><button type="button" data-pf-action="clear-rois">清空细节选区</button></div>'+
        '<div class="pf-roi-list" data-pf-rois></div><h4>辅助参考图</h4><div class="pf-assets" data-pf-assets>'+assets.filter(a=>a.role!=='product-mask').map(a=>fidelityAssetHtml(a,a.role==='highpass'?'纹理细节图':a.role==='perspective-proxy'?'目标角度示意':'局部细节图')).join('')+'</div>'+
        '<p class="pf-help">本地处理不调用生图模型。原始图片保持不变。</p></div>'+
        '<div class="pf-settings-column"><nav class="pf-section-nav" aria-label="产品保真设置区块">'+['产品识别','结构约束','视角控制','生成强度','校验规则','失败重试','高级模式'].map((title,index)=>'<button type="button" data-pf-jump="'+String(index+1).padStart(2,'0')+'">'+title+'</button>').join('')+'</nav>'+
        section('01 产品识别',
            select('productReferenceId','保护哪张产品图',[...(!current?[[config.productReferenceId||'','请重新选择产品主图']]:[]),...refs.map((r,i)=>[config.referenceIds[r.url],(i+1)+' · '+(r.name||'产品图片')])])+
            select('category','产品类型',[['auto','尚未选择'],['frame','相框'],['box','包装盒'],['cylinder','瓶罐／杯具'],['electronics','电子设备'],['other','其他']])+
            select('geometry','产品形状',[['auto','尚未确认'],['plane','平面矩形'],['box','包装盒可见平面'],['cylinder','圆柱'],['other','不规则']])+
            '<label class="pf-field"><span>已有保护蒙版</span><input type="file" accept="image/png" data-pf-mask-upload></label>'+
            '<p class="pf-help">透明产品图沿用透明区域。黑白蒙版中，白色保留、黑色改变；也可以直接在左图涂抹。自动抠图请先使用已有抠图工具。</p>'+
            number('dimensions.width','实际宽度',0,1000000,.1)+number('dimensions.height','实际高度',0,1000000,.1)+number('dimensions.depth','实际厚度',0,1000000,.1)+
            select('dimensions.unit','尺寸单位',[['mm','毫米'],['cm','厘米'],['m','米']])+'<p class="pf-help">尺寸可不填，0 表示未知，不会从图片推测实际尺寸。</p>')+
        section('02 结构约束',
            select('mode','如何保护产品',[['strict','保留原产品像素 · 换背景'],['structure','保持结构 · 可改光照'],['view','保持身份 · 可换角度']])+
            '<div class="pf-checks">'+check('structure.lockRatio','保持产品比例')+check('structure.lockOutline','保持产品外形')+check('structure.lockLines','保持直线与边框')+check('structure.lockSymmetry','保持对称')+check('structure.lockLayout','保持按钮与接口位置')+'</div>'+
            '<p class="pf-help">保留原像素时采用本地合成。允许产品重绘时，结构要求通过参考图和提示词表达，不能保证完全不变。</p>'+
            '<div class="pf-detail"><h4>细节保护</h4>'+check('detail.enabled','增加细节保护')+
            select('detail.inputMode','给绘画补充什么',[['original','只使用原产品图'],['highpass','增加纹理细节图'],['crops','增加局部细节图'],['combined','纹理图＋局部细节图']])+
            check('detail.autoCrops','自动寻找细节区域')+number('detail.cropCount','最多局部参考图',0,3,1,'张')+
            '<button type="button" data-pf-action="auto-crops">寻找细节并预览</button>'+
            select('detail.restoreMode','生成后恢复纹理',[['off','不回填'],['auto','对齐可靠后恢复原纹理']])+
            '<label class="pf-field"><span>纹理恢复量</span><span class="pf-range"><small>少量</small><input type="range" min="0" max="1" step=".05" data-pf-field="detail.restoreStrength" value="'+config.detail.restoreStrength+'"><small>较多</small></span></label>'+
            '<p class="pf-help" data-pf-restore-note></p></div>')+
        section('03 视角控制',
            select('view.mode','观察角度',[['keep','保持原角度'],['minor','轻微调整'],['target','指定新角度']])+
            '<div class="pf-angle-presets"><button type="button" data-pf-angle="-30">向左 30°</button><button type="button" data-pf-angle="0">正面</button><button type="button" data-pf-angle="30">向右 30°</button></div>'+
            number('view.yaw','左右转动',-90,90,15,'°')+number('view.pitch','俯仰角度',-90,90,15,'°')+number('view.roll','画面旋转',-90,90,15,'°')+
            check('view.proxyEnabled','增加平面角度示意图')+
            '<p class="pf-help">换角度请先选择“保持身份 · 可换角度”。其他真实视角图接入同一输入口；在下游提示词注明前／侧／背。角度示意只适用于平面矩形，不重建隐藏面。</p>')+
        section('04 生成强度',
            select('generation.allowedEdits','允许改变什么',[['background','只改变背景'],['lighting','背景与产品光照'],['material','局部材质'],['view','产品观察角度']])+
            '<p class="pf-strategy" data-pf-strategy></p>')+
        section('05 校验规则',check('validation.enabled','检查生成结果')+
            number('validation.ratioTolerancePct','平面边长允许偏差',1,20,1,'%')+
            '<p class="pf-help">原像素模式核对产品核心像素；结构模式检查可靠匹配的平面边框。遮挡、透明材质或匹配不足时显示“无法判断”。文字与接口数量仍需人工复核。</p>'+
            '<div class="pf-results" data-pf-results></div>')+
        section('06 失败重试','<label class="pf-check"><input type="checkbox" disabled><span>自动重新生成 · 暂不可用</span></label>'+
            '<p class="pf-help">额外费用目前无法可靠估算。失败原因显示在结果检查中；请在下游绘画节点手动重新生成，每次重新生成都会调用模型。</p>')+
        section('07 高级模式',
            number('detail.highPassRadiusPx','纹理提取半径',.5,8,.5,'px')+number('detail.highPassGain','纹理图对比强度',.5,4,.25)+
            number('maskFeatherPx','保护边缘过渡',0,8,.5,'px')+number('alignmentThreshold','纹理回填对齐要求',.7,1,.05)+
            '<p class="pf-help">对齐要求越高，越不容易回填；对不上时跳过恢复。以上参数只控制本地图像处理，不是模型的原生控制参数。纹理灰图不代表真实颜色。</p>'+
            '<details class="pf-debug"><summary>查看下游模型与实际参考图</summary><pre data-pf-debug></pre></details>')+
        '</div></div><footer class="pf-footer"><div><p data-pf-status role="status">'+(fresh?'本地处理结果已更新':refs.length?'处理结果待更新；下游运行时会自动准备最新参考图':'等待产品图片')+'</p><span data-pf-route>连接右侧绘画节点，设置提示词与模型</span></div><button type="button" class="pf-update" data-pf-action="preview">更新处理结果</button></footer></div>';
}
function fidelityCanEdit(node){
    return collabCanMutateCanvas()&&(typeof collabCanEditNode!=='function'||collabCanEditNode(node.id,true));
}
function fidelityStatus(session,message){const el=session.root.querySelector('[data-pf-status]');if(el)el.textContent=message;}
function fidelityCommit(session,withRender=false){
    session.controller?.abort();session.detectedRois=[];delete session.node.fidelityPreview;
    fidelityStatus(session,'处理结果待更新；下游运行时会自动准备最新参考图');
    session.root.querySelector('[data-pf-assets]')?.replaceChildren();scheduleSave();
    if(withRender)render({nodeIds:[session.node.id]});
    else {fidelitySyncAvailability(session);session.draw?.();fidelityRenderRois(session);}
}
function fidelitySyncFields(session){
    session.root.querySelectorAll('[data-pf-field]').forEach(el=>{
        const value=fidelityGetValue(session.node.fidelityConfig,el.dataset.pfField);
        if(el.type==='checkbox')el.checked=Boolean(value);else el.value=value??'';
    });
}
function fidelitySyncAvailability(session){
    const config=session.node.fidelityConfig,field=key=>session.root.querySelector('[data-pf-field="'+key+'"]');
    const enabled=config.detail.enabled,usesHigh=enabled&&['highpass','combined'].includes(config.detail.inputMode),usesCrops=enabled&&['crops','combined'].includes(config.detail.inputMode);
    for(const key of ['detail.highPassRadiusPx','detail.highPassGain'])field(key).disabled=!usesHigh;
    for(const key of ['detail.autoCrops','detail.cropCount'])field(key).disabled=!usesCrops;
    field('detail.inputMode').disabled=!enabled;
    const restore=config.mode==='structure'&&enabled;
    field('detail.restoreMode').disabled=!restore;
    field('detail.restoreStrength').disabled=!restore||config.detail.restoreMode!=='auto';
    session.root.querySelector('[data-pf-restore-note]').textContent=config.mode==='strict'?'原产品像素直接合成，纹理随原图保留。':config.mode==='view'?'换角度时不回填旧视角纹理，避免重影。':'需要保护蒙版和可靠同视角对齐；形状异常或匹配不足时自动跳过。';
    for(const key of ['view.mode','view.yaw','view.pitch','view.roll','view.proxyEnabled'])field(key).disabled=config.mode!=='view';
    session.root.querySelectorAll('[data-pf-angle]').forEach(el=>el.disabled=config.mode!=='view');
    for(const option of field('generation.allowedEdits').options)option.disabled=config.mode==='strict'?option.value!=='background':config.mode==='structure'&&option.value==='view';
    session.root.querySelector('[data-pf-strategy]').textContent=config.mode==='strict'?'生成后保留原产品位置、比例和核心像素；只改变背景。':config.mode==='view'?'使用产品和视角参考生成；未拍摄的隐藏面由 AI 推测。':'使用原图与辅助细节参考；可靠对齐后才执行已开启的纹理恢复。';
    session.root.querySelectorAll('[data-pf-action="preview"],[data-pf-action="auto-crops"]').forEach(el=>el.disabled=!config.enabled||!session.refs.length||Boolean(session.busy));
    if(sharedCanvasReadOnly)session.root.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
}
function fidelityRenderRois(session){
    const list=session.root.querySelector('[data-pf-rois]');list.replaceChildren();
    const config=session.node.fidelityConfig;
    [...config.rois.map((roi,index)=>({roi,index,auto:false})),...(session.detectedRois||[]).map((roi,index)=>({roi,index,auto:true}))].forEach(({roi,index,auto})=>{
        const item=document.createElement('div'),button=document.createElement('button');
        item.className='pf-roi-item';item.append(document.createTextNode((auto?'自动候选 ':'手动细节 ')+(index+1)));
        button.type='button';button.textContent='删除';
        button.onclick=()=>{
            if(!fidelityCanEdit(session.node))return;pushUndo();
            if(auto){
                const others=session.detectedRois.filter((_,i)=>i!==index);
                config.rois.push(...others.slice(0,Math.max(0,3-config.rois.length)).map(r=>({x:r.x,y:r.y,w:r.w,h:r.h})));
                config.detail.autoCrops=false;
            }else config.rois.splice(index,1);
            fidelitySyncFields(session);fidelityCommit(session);
        };
        item.append(button);list.append(item);
    });
}
async function fidelityLoadEditor(session){
    const node=session.node,config=node.fidelityConfig,root=session.root;
    const ref=session.refs.find(r=>config.referenceIds[r.url]===config.productReferenceId);
    const canvasEl=root.querySelector('[data-pf-canvas]'),empty=root.querySelector('[data-pf-empty]');
    empty.hidden=Boolean(ref);canvasEl.hidden=!ref;
    if(!ref){session.draw=null;empty.textContent=session.refs.length?'原产品图已移除，请在右侧重新选择要保护的图片':'将左侧产品图片连接到此节点，随后在图上标出需要保护的区域';fidelityStatus(session,empty.textContent);return;}
    const seq=session.editorSeq=(session.editorSeq||0)+1;
    const image=new Image();image.src=ref.url;
    try{await image.decode();}catch{fidelityStatus(session,'产品图片无法读取，请重新导入');return;}
    if(!root.isConnected||seq!==session.editorSeq)return;
    canvasEl.width=Math.min(900,image.naturalWidth);canvasEl.height=Math.round(canvasEl.width*image.naturalHeight/image.naturalWidth);
    const context=canvasEl.getContext('2d'),maskImage=config.maskUrl?new Image():null;
    if(maskImage){maskImage.src=config.maskUrl;try{await maskImage.decode();}catch{fidelityStatus(session,'蒙版图片无法读取，请重新上传');}}
    if(!root.isConnected||seq!==session.editorSeq)return;
    let tool='mask',start=null,stroke=null;
    session.draw=()=>{
        context.clearRect(0,0,canvasEl.width,canvasEl.height);context.drawImage(image,0,0,canvasEl.width,canvasEl.height);
        const layer=document.createElement('canvas');layer.width=canvasEl.width;layer.height=canvasEl.height;const overlay=layer.getContext('2d');
        if(maskImage?.naturalWidth){
            overlay.drawImage(maskImage,0,0,layer.width,layer.height);
            const pixels=overlay.getImageData(0,0,layer.width,layer.height);
            for(let i=0;i<pixels.data.length;i+=4){const alpha=pixels.data[i];pixels.data[i]=24;pixels.data[i+1]=150;pixels.data[i+2]=124;pixels.data[i+3]=alpha*.7;}
            overlay.putImageData(pixels,0,0);
        }else if(!config.maskStrokes.length){
            overlay.drawImage(image,0,0,layer.width,layer.height);
            const pixels=overlay.getImageData(0,0,layer.width,layer.height);
            let transparent=false;for(let i=3;i<pixels.data.length;i+=4)if(pixels.data[i]<255){transparent=true;break;}
            if(transparent){
                for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=24;pixels.data[i+1]=150;pixels.data[i+2]=124;}
                overlay.putImageData(pixels,0,0);
            }else overlay.clearRect(0,0,layer.width,layer.height);
        }
        for(const s of config.maskStrokes){
            overlay.globalCompositeOperation=s.erase?'destination-out':'source-over';overlay.strokeStyle='#18967c';overlay.fillStyle='#18967c';overlay.lineWidth=s.width*Math.min(layer.width,layer.height);overlay.lineCap='round';overlay.lineJoin='round';
            overlay.beginPath();s.points.forEach((p,i)=>i?overlay.lineTo(p[0]*layer.width,p[1]*layer.height):overlay.moveTo(p[0]*layer.width,p[1]*layer.height));overlay.stroke();
            if(s.points[0]){overlay.beginPath();overlay.arc(s.points[0][0]*layer.width,s.points[0][1]*layer.height,overlay.lineWidth/2,0,Math.PI*2);overlay.fill();}
        }
        context.globalAlpha=.32;context.drawImage(layer,0,0);context.globalAlpha=1;
        context.strokeStyle='#d98212';context.lineWidth=2;config.rois.forEach(r=>context.strokeRect(r.x*canvasEl.width,r.y*canvasEl.height,r.w*canvasEl.width,r.h*canvasEl.height));
        context.strokeStyle='#167baf';context.setLineDash([6,4]);(session.detectedRois||[]).forEach(r=>context.strokeRect(r.x*canvasEl.width,r.y*canvasEl.height,r.w*canvasEl.width,r.h*canvasEl.height));context.setLineDash([]);
        root.querySelector('[data-pf-source-info]').textContent=image.naturalWidth+' × '+image.naturalHeight+' · 原图';
        root.querySelector('[data-pf-roi-info]').textContent='手动 '+config.rois.length+' 区 · 自动候选 '+(session.detectedRois?.length||0)+' 区；绿色为保护区';
    };
    const point=event=>{const r=canvasEl.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
    root.querySelectorAll('[data-pf-tool]').forEach(b=>b.onclick=()=>{tool=b.dataset.pfTool;root.querySelectorAll('[data-pf-tool]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
    root.querySelector('[data-pf-tool="mask"]').setAttribute('aria-pressed','true');
    canvasEl.onpointerdown=event=>{
        if(!fidelityCanEdit(node))return;event.preventDefault();event.stopPropagation();
        if(tool!=='roi'&&config.maskUrl){fidelityStatus(session,'修改已有蒙版请先重置保护区域，再重新涂抹');return;}
        if(tool==='roi'&&config.rois.length>=3){fidelityStatus(session,'最多保留 3 个手动细节区域，请先删除不需要的区域');return;}
        pushUndo();
        canvasEl.setPointerCapture(event.pointerId);start=point(event);
        if(tool!=='roi'){
            stroke={points:[start],erase:tool==='erase',width:Number(root.querySelector('[data-pf-brush]').value)/100};
            config.maskStrokes.push(stroke);
        }
        session.draw();
    };
    canvasEl.onpointermove=event=>{
        if(!start)return;const p=point(event);
        if(stroke){if(stroke.points.length<2000)stroke.points.push(p);session.draw();}
        else{session.draw();context.strokeStyle='#d98212';context.strokeRect(Math.min(start[0],p[0])*canvasEl.width,Math.min(start[1],p[1])*canvasEl.height,Math.abs(start[0]-p[0])*canvasEl.width,Math.abs(start[1]-p[1])*canvasEl.height);}
    };
    canvasEl.onpointerup=event=>{
        if(!start)return;const p=point(event);
        if(tool==='roi'){
            if(config.rois.length>=3)fidelityStatus(session,'最多保留 3 个手动细节区域，请先删除不需要的区域');
            else if(Math.abs(start[0]-p[0])>.003&&Math.abs(start[1]-p[1])>.003)config.rois.push({x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),w:Math.abs(start[0]-p[0]),h:Math.abs(start[1]-p[1])});
        }
        start=null;stroke=null;fidelityCommit(session);
    };
    canvasEl.onpointercancel=()=>{start=null;stroke=null;fidelityCommit(session);};
    session.draw();fidelityRenderRois(session);
}
async function fidelityJson(url,body,signal){
    const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}:{signal});
    const data=await response.json();
    if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'本地图片处理失败，请检查输入图片');
    return data;
}
async function fidelityPreview(session){
    if(!session||!fidelityCanEdit(session.node))return;
    session.controller?.abort();const controller=session.controller=new AbortController(),config=session.node.fidelityConfig;
    const signature=fidelitySignature(session.node),canvasId=canvas?.id;
    session.busy=true;fidelitySyncAvailability(session);fidelityStatus(session,'正在处理产品区域与辅助细节图…');
    try{
        const preview=await fidelityJson('/api/product-fidelity/preview',{prompt:'产品图片本地处理',provider_id:'',model:'',local_only:true,product_fidelity:cloneSmartSettings(config),reference_images:productFidelityReferences(session.refs,config)},controller.signal);
        if(!session.root.isConnected||canvas?.id!==canvasId||session.controller!==controller||signature!==fidelitySignature(session.node))return;
        session.node.fidelityPreview={signature,generatedAssets:preview.generatedAssets,detectedRois:preview.detectedRois||[],warnings:preview.warnings||[]};
        session.detectedRois=preview.detectedRois||[];session.draw?.();fidelityRenderRois(session);
        const list=session.root.querySelector('[data-pf-assets]');
        list.innerHTML=(preview.generatedAssets||[]).filter(a=>a.role!=='product-mask').map(a=>fidelityAssetHtml(a,a.role==='highpass'?'纹理细节图':a.role==='perspective-proxy'?'目标角度示意':'局部细节图')).join('');
        const note='本地处理完成；生成时按下游模型限制准备参考图。';
        fidelityStatus(session,note+(preview.warnings.length?'\n'+preview.warnings.join('\n'):''));
        session.root.querySelector('[data-pf-debug]').textContent=JSON.stringify({localReferences:preview.reference_images.map((r,i)=>({order:i+1,id:r.reference_id,role:r.role||'user',parent:r.parentReferenceId}))},null,2);
        scheduleSave();void fidelityInspectDownstream(session);
    }catch(error){if(error.name!=='AbortError')fidelityStatus(session,error.message);}
    finally{if(session.controller===controller){session.busy=false;fidelitySyncAvailability(session);}}
}
function fidelityRenderResults(session){
    const target=session.root.querySelector('[data-pf-results]'),downstream=fidelityDownstream(session.node);
    target.replaceChildren();
    const labels={passed:'已通过可执行的检查',warning:'需要人工复核',failed:'检查发现异常',unknown:'无法判断'};
    let found=false;
    downstream.forEach(paint=>{
        const result=paint.productFidelityResult;
        if(!result||paint.runSettings?.productFidelity?.sourceNodeId!==session.node.id)return;
        found=true;const block=document.createElement('div'),title=document.createElement('strong'),text=document.createElement('p');
        const status=result.validationStatus==='passed'&&paint.runSettings?.productFidelity?.mode==='strict'?'原产品核心像素已保留':labels[result.validationStatus]||'无法判断';
        title.textContent=(paint.title||'绘画')+' · 上次生成 · '+status;
        text.textContent=(result.validations||[]).map(v=>v.reason||v.scope||'').concat(result.warnings||[]).join('\n');
        block.append(title,text);
        const config=paint.runSettings.productFidelity;
        const source=[...(paint.runInputRefs||[]),...session.refs].find(ref=>config.referenceIds?.[ref.url]===config.productReferenceId),output=paint.images?.[0];
        if(source&&output)block.insertAdjacentHTML('beforeend','<div class="pf-compare">'+fidelityAssetHtml(source,'原产品图')+fidelityAssetHtml(output,'生成结果')+'</div>');
        target.append(block);
    });
    if(!found){const note=document.createElement('p');note.className='pf-help';note.textContent='下游绘画生成完成后，在这里查看产品检查与原图对比。';target.append(note);}
}
async function fidelityInspectDownstream(session){
    const targets=fidelityDownstream(session.node),route=session.root.querySelector('[data-pf-route]');
    route.textContent=targets.length?'传给 '+targets.length+' 个绘画节点 · '+session.refs.length+' 张原始参考图':'尚未连接绘画节点；在右侧连接后设置提示词与模型';
    const key=JSON.stringify({targets:targets.map(node=>{const s=smartSettingsForNode(node);return [node.id,s.engine,s.apiKind,s.provider_id,s.model,referenceImagesFor(node).map(r=>r.url)];}),preview:session.node.fidelityPreview?.signature||''});
    if(session.capabilityKey===key)return;session.capabilityKey=key;
    session.capabilitiesController?.abort();const controller=session.capabilitiesController=new AbortController();
    const messages=[];
    for(const paint of targets){
        const s=smartSettingsForNode(paint);
        if(s.engine!=='api'||s.apiKind==='video'){messages.push((paint.title||'绘画')+'：请选择普通 API 图片模型');continue;}
        if(!s.provider_id||!s.model){messages.push((paint.title||'绘画')+'：尚未选择图片模型');continue;}
        try{
            const caps=await fidelityJson('/api/product-fidelity/capabilities?provider_id='+encodeURIComponent(s.provider_id)+'&model='+encodeURIComponent(s.model),null,controller.signal);
            if(!session.root.isConnected||session.capabilitiesController!==controller)return;
            const slots=Math.max(0,caps.applicationReferenceLimit-imageRefsOnly(referenceImagesFor(paint)).length);
            const localAssets=session.node.fidelityPreview?.generatedAssets?.filter(a=>a.role!=='product-mask').length||0;
            messages.push((paint.title||'绘画')+' · '+s.model+'：'+(!caps.supported?'当前模型不支持保真生成':slots<localAssets?'辅助图额度不足，只保留 '+slots+' 张；原图顺序不变':'可接收保真参考图')+(caps.localFeatureAlignment===false?'；自动纹理恢复不可用':''));
            if(targets.length===1&&caps.localFeatureAlignment===false){session.root.querySelector('[data-pf-field="detail.restoreMode"] option[value="auto"]').disabled=true;}
        }catch(error){if(error.name!=='AbortError')messages.push('模型能力读取失败：'+error.message);}
    }
    if(session.root.isConnected&&session.capabilitiesController===controller){
        session.root.querySelector('[data-pf-debug]').textContent=messages.join('\n')+'\n'+(session.node.fidelityPreview?.warnings||[]).join('\n');
        route.textContent=messages.join(' · ')||'尚未连接绘画节点；本地图片处理可独立使用';
    }
}
function bindProductFidelityNode(el,node){
    const root=el.querySelector('[data-pf-root]');if(!root)return;
    const refs=fidelityEnsureReferences(node),key=JSON.stringify(refs.map(r=>r.url));
    const old=productFidelitySessions.get(node.id);
    if(old?.root===root&&old.node===node){
        if(old.refsKey!==key){old.refs=refs;old.refsKey=key;old.controller?.abort();fidelityStatus(old,'输入图片已更改，请更新处理结果');void fidelityLoadEditor(old);}
        fidelityRenderResults(old);void fidelityInspectDownstream(old);return;
    }
    old?.controller?.abort();old?.capabilitiesController?.abort();
    const preview=node.fidelityPreview?.signature===fidelitySignature(node)?node.fidelityPreview:null;
    const session={node,root,refs,refsKey:key,detectedRois:preview?.detectedRois||[],busy:false};
    productFidelitySessions.set(node.id,session);
    const column=root.querySelector('.pf-settings-column');column.scrollTop=old?.scrollTop||0;
    column.onscroll=()=>{session.scrollTop=column.scrollTop;};
    for(const kind of ['pointerdown','mousedown','click','dblclick','wheel'])root.addEventListener(kind,event=>event.stopPropagation());
    root.querySelectorAll('[data-pf-jump]').forEach(button=>button.onclick=()=>{
        const section=root.querySelector('[data-pf-section="'+button.dataset.pfJump+'"]'),nav=root.querySelector('.pf-section-nav');
        const scale=column.getBoundingClientRect().width/column.offsetWidth;
        column.scrollTop+=(section.getBoundingClientRect().top-column.getBoundingClientRect().top-nav.getBoundingClientRect().height)/scale;
    });
    root.querySelectorAll('[data-pf-field]').forEach(input=>input.onchange=()=>{
        if(!fidelityCanEdit(node))return;pushUndo();const config=node.fidelityConfig;
        fidelitySetValue(config,input.dataset.pfField,input.type==='checkbox'?input.checked:input.type==='number'||input.type==='range'?Number(input.value):input.value);
        if(input.dataset.pfField==='mode'){fidelityChangeMode(config,config.mode);fidelitySyncFields(session);}
        if(input.dataset.pfField==='productReferenceId'){config.rois=[];config.maskStrokes=[];delete config.maskUrl;void fidelityLoadEditor(session);}
        fidelityCommit(session);
    });
    root.querySelector('[data-pf-mask-upload]').onchange=async event=>{
        const file=event.target.files?.[0];if(!file||!fidelityCanEdit(node))return;
        try{
            const uploaded=await uploadCroppedBlob(file,'product_protection.png');
            if(!root.isConnected)return;pushUndo();node.fidelityConfig.maskUrl=uploaded.url;node.fidelityConfig.maskStrokes=[];fidelityCommit(session);void fidelityLoadEditor(session);
        }catch(error){fidelityStatus(session,error.message);}
    };
    root.querySelectorAll('[data-pf-angle]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;pushUndo();node.fidelityConfig.view.mode='target';node.fidelityConfig.view.yaw=Number(button.dataset.pfAngle);fidelitySyncFields(session);fidelityCommit(session);
    });
    root.querySelectorAll('[data-pf-action]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;const action=button.dataset.pfAction,config=node.fidelityConfig;
        if(action==='preview'){void fidelityPreview(session);return;}
        pushUndo();
        if(action==='clear-mask'){config.maskStrokes=[];delete config.maskUrl;}
        if(action==='clear-rois'){config.rois=[];config.detail.autoCrops=false;}
        if(action==='auto-crops'){config.detail.enabled=true;config.detail.autoCrops=true;config.detail.cropCount=Math.max(1,config.detail.cropCount);if(!['crops','combined'].includes(config.detail.inputMode))config.detail.inputMode='crops';}
        fidelitySyncFields(session);fidelityCommit(session);void fidelityLoadEditor(session);
        if(action==='auto-crops')void fidelityPreview(session);
    });
    fidelitySyncAvailability(session);void fidelityLoadEditor(session);fidelityRenderResults(session);void fidelityInspectDownstream(session);
    for(const [id,s] of productFidelitySessions)if(!nodes.some(n=>n.id===id)||s.root!==root&&!s.root.isConnected){s.controller?.abort();s.capabilitiesController?.abort();productFidelitySessions.delete(id);}
}
function syncProductFidelityButton(){
    const actions=composer?.querySelector('.composer-actions');if(!actions)return;
    let button=actions.querySelector('[data-product-fidelity]');
    if(!button){button=document.createElement('button');button.type='button';button.className='prompt-optimize-btn fidelity-composer-settings';button.dataset.productFidelity='1';actions.prepend(button);}
    const node=selectedNode(),sources=node?productFidelitySourcesFor(node):[];
    button.hidden=!isSmartPaintNode(node)||settings.apiKind==='video'||settings.engine!=='api';
    const label=sources.length>1?'保真来源冲突':sources.length?'查看产品保真':'连接产品保真';
    button.title=label;button.setAttribute('aria-label',label);button.textContent=label;button.dataset.enabled=String(sources.length===1);
}
function syncProductFidelityNodes(){
    for(const [id,session] of productFidelitySessions){
        if(!session.root.isConnected||!nodes.includes(session.node)){
            session.controller?.abort();session.capabilitiesController?.abort();productFidelitySessions.delete(id);continue;
        }
        fidelityRenderResults(session);void fidelityInspectDownstream(session);
    }
}
function openProductFidelity(){
    const paint=selectedNode();if(!isSmartPaintNode(paint))return;
    const sources=productFidelitySourcesFor(paint);
    if(sources.length){selectedId=sources[0].id;selectedIds=[];render();updateComposer();return;}
    if(!fidelityCanEdit(paint))return;
    const original=cloneSmartSettings(paint.runSettings?.productFidelity||settings.productFidelity||{enabled:true});
    const beforeRefs=orderedSmartInputReferences(paint,[...activeInputImagesFor(paint),...manualReferenceImagesFor(paint)]);
    pushUndo();const source=createNode((paint.x||0)-1120,paint.y||0,[],{nodeType:SMART_PRODUCT_FIDELITY_NODE_TYPE,title:'产品保真',skipUndo:true,skipSave:true});
    if(!source)return;
    normalizeProductFidelityNode(source);source.fidelityConfig=fidelityConfig({...original,enabled:true});delete source.fidelityConfig.sourceNodeId;
    const incoming=(canvas.connections||[]).filter(c=>c.to===paint.id&&['input','flow'].includes(c.kind||'flow')&&window.SmartCanvasDataVideo.canConnect(nodes.find(n=>n.id===c.from),source));
    incoming.forEach(c=>{c.to=source.id;source.inputNodeIds=Array.from(new Set([...(source.inputNodeIds||[]),c.from]));});
    const refs=manualReferenceImagesFor(paint);
    source.manualInputRefs=refs.map(ref=>({...ref}));delete paint.manualInputRefs;
    source.inputRefOrder=beforeRefs.map(inputRefKey);
    if(paint.blockedInputRefs)source.blockedInputRefs=[...paint.blockedInputRefs];
    paint.inputNodeIds=(canvas.connections||[]).filter(c=>c.to===paint.id&&(c.kind||'flow')==='input').map(c=>c.from);
    connectInputNode(source.id,paint.id);delete paint.runSettings?.productFidelity;
    const newRefs=productFidelityInputImages(source);
    paint.inputRefOrder=beforeRefs.map(ref=>newRefs.find(item=>item.url===ref.url)).filter(Boolean).map(inputRefKey);
    render();updateComposer();scheduleSave();
}
document.addEventListener('click',event=>{
    if(event.target.closest('[data-product-fidelity]')){event.preventDefault();event.stopPropagation();openProductFidelity();}
},true);
