/* Product fidelity is a local processing node. Models and paid generation belong to downstream paint nodes. */
const productFidelitySessions = new Map();
function physicalDimensionPanelHtml(d){
    const pd=XiaomeiPhysicalDimensions;
    const check=(key,label)=>'<label class="pf-check"><input type="checkbox" data-pd-field="'+key+'" '+(fidelityGetValue(d,key)?'checked':'')+'>'+label+'</label>';
    const number=(key,label)=>'<label class="pf-field"><span>'+label+'</span><span class="pf-number"><input type="number" min="0" step="any" data-pd-field="'+key+'" placeholder="未知" value="'+(d[key]===null?'':escapeAttr(Number(pd.convertFromMillimeters(d[key],d.unit).toPrecision(12))))+'"></span></label>';
    const select=(key,label,options)=>'<label class="pf-field"><span>'+label+'</span><select data-pd-field="'+key+'">'+options.map(([value,text])=>'<option value="'+value+'" '+(d[key]===value?'selected':'')+'>'+text+'</option>').join('')+'</select></label>';
    return '<div class="pf-dimensions" data-pd-root><h4>商品实物尺寸</h4>'+check('enabled','填写商品实际宽高')+'<div data-pd-content '+(d.enabled?'':'hidden')+'>'+
        number('width','实际宽度')+number('height','实际高度')+number('depth','实际厚度（选填）')+
        select('unit','尺寸单位',[['mm','毫米 mm'],['cm','厘米 cm'],['m','米 m'],['in','英寸 in']])+
        select('shape','按哪种形状计算',[['rectangle','平面长方形'],['cuboid','立体方盒'],['circle','圆形平面（按直径）']])+
        '<div class="pf-checks">'+check('aspectRatioLock','保持长宽比例')+check('thicknessLock','保持厚度比例')+check('outlineLock','保持商品外轮廓')+'</div>'+
        select('constraintMode','尺寸如何参与出图',[['prompt','在描述中说明尺寸'],['guide','增加形状参考图'],['protect','保留商品原图']])+
        '<details class="pf-help-disclosure"><summary>为什么要填实物尺寸？</summary><p class="pf-help" data-pd-mode></p><p class="pf-help" data-pd-semantics></p><p class="pf-help">请填实际测量的尺寸，不清楚可留空。图片像素和 DPI 不能推断商品实物尺寸；输出画幅在绘画节点设置。</p></details>'+
        '<p class="pf-dimension-ratio" data-pd-ratio aria-live="polite"></p><p class="pf-dimension-error" data-pd-error role="status"></p><canvas data-pd-preview aria-label="产品尺寸几何代理预览"></canvas>'+
        '<details class="pf-options"><summary>比例偏差提醒</summary>'+check('validationSettings.enabled','检查商品正面比例')+
        '<label class="pf-field"><span>偏差超过多少时提醒</span><span class="pf-number"><input type="number" min=".1" max="20" step=".1" data-pd-field="validationSettings.tolerancePct" value="'+escapeAttr(d.validationSettings.tolerancePct)+'">%</span></label><p class="pf-help">没有侧面实拍图时，无法核对厚度。</p></details><p class="pf-help" data-pd-result></p></div></div>';
}
function bindPhysicalDimensionPanel(root,config,onChange,canEdit,referenceCount,confirmChange){
    if(!root)return;
    const pd=XiaomeiPhysicalDimensions,d=config.dimensions;
    let timer=0,undoInput=null;
    const field=key=>root.querySelector('[data-pd-field="'+key+'"]');
    const sync=()=>{
        root.querySelectorAll('[data-pd-field]').forEach(input=>{
            const key=input.dataset.pdField,value=fidelityGetValue(d,key);
            if(input.type==='checkbox')input.checked=Boolean(value);
            else input.value=['width','height','depth'].includes(key)?value===null?'':Number(pd.convertFromMillimeters(value,d.unit).toPrecision(12)):value;
        });
    };
    const refresh=()=>{
        if(!root.isConnected)return;
        const valid=pd.validatePhysicalDimensions(d),ratio=pd.calculateAspectRatio(d.width,d.height),thickness=pd.calculateThicknessRatio(d.width,d.height,d.depth);
        root.querySelector('[data-pd-error]').textContent=d.enabled?valid.errors.join('；'):'';
        root.querySelector('[data-pd-content]').hidden=!d.enabled;
        root.querySelector('[data-pd-ratio]').textContent='正面比例：'+(ratio?ratio.label:'待填写宽、高')+' · 厚／宽：'+(thickness?Number(thickness.depthToWidth.toPrecision(6)):'未知')+' · 厚／高：'+(thickness?Number(thickness.depthToHeight.toPrecision(6)):'未知');
        root.querySelector('[data-pd-mode]').textContent={prompt:'把实物尺寸写入绘画要求；生成结果仍需检查。',guide:'增加商品形状参考图，引导长宽比例；结果仍需检查。',protect:'保留已标记商品区域的原图像素与原视角；这不等于证明生成图中的真实厘米尺寸。'}[d.constraintMode]+(!referenceCount()?' 请先连接商品原图；保留原图还需要透明图或黑白保护图。':'');
        root.querySelector('[data-pd-semantics]').textContent=d.shape==='circle'?'圆形平面：宽、高均为同一正面直径；厚度沿垂直圆面的轴向。暂不表示圆柱高度。':'宽、高为产品正面两轴；厚度为前后轴向。厚度未知时不推测体积。';
        field('height').disabled=d.shape==='circle'||!canEdit();
        const preview=root.querySelector('[data-pd-preview]');
        preview.hidden=!d.enabled||!valid.valid||!d.width||!d.height;
        if(!preview.hidden)pd.GeometryGuideGenerator.draw(preview,d);
    };
    root.querySelectorAll('[data-pd-field]').forEach(input=>{
        input.addEventListener('focus',()=>{undoInput=null;});
        const change=async()=>{
            if(!canEdit())return;
            const key=input.dataset.pdField;
            const proposed=cloneSmartSettings(config),next=proposed.dimensions;
            if(['width','height','depth'].includes(key)){
                next[key]=input.value===''?(input.validity.badInput?NaN:null):pd.convertToMillimeters(input.value,d.unit);
            }else fidelitySetValue(next,key,input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value);
            if(next.shape==='circle')next.height=next.width;
            if(next.enabled){
                proposed.geometry={rectangle:'plane',cuboid:'box',circle:'circle'}[next.shape];
                if(next.constraintMode==='protect')fidelityChangeMode(proposed,'strict');
                else if(proposed.mode==='strict')fidelityChangeMode(proposed,'structure');
            }
            next.guideAssetId=null;
            if(confirmChange&&!(await confirmChange(config,proposed,'dimensions.'+key))){sync();refresh();return;}
            if(!root.isConnected)return;
            if(undoInput!==input||input.type!=='number'){pushUndo();undoInput=input;}
            fidelityAssignConfig(config,proposed);
            root.querySelector('[data-pd-result]').textContent='实物尺寸已更新；请重新出图并检查商品比例。';
            if(key==='unit'||key==='shape')sync();
            onChange();
            clearTimeout(timer);timer=setTimeout(refresh,90);
        };
        input.addEventListener(input.type==='number'?'input':'change',change);
        input.disabled=!canEdit();
    });
    root.pdRefresh=()=>{sync();refresh();};
    refresh();
}
function pdSameDimensions(a,b){return XiaomeiPhysicalDimensions.signature(a)===XiaomeiPhysicalDimensions.signature(b);}
function acceptProductFidelityResult(node,result){
    node.productFidelityResult=result;
    const current=result.dimensions,config=node.runSettings?.productFidelity;
    if(!current||!config)return;
    if(config.dimensions&&pdSameDimensions(config.dimensions,current))config.dimensions.guideAssetId=current.guideAssetId;
    const source=nodes.find(item=>item.id===config.sourceNodeId);
    if(source?.fidelityConfig?.dimensions&&pdSameDimensions(source.fidelityConfig.dimensions,current)){
        source.fidelityConfig.dimensions.guideAssetId=current.guideAssetId;
        if(source.fidelityPreview)source.fidelityPreview.signature=fidelitySignature(source);
    }
}
function productFidelityDefaults(){
    return {version:1,enabled:false,mode:'strict',category:'auto',categoryCustom:'',geometry:'auto',geometryCustom:'',referenceIds:{},rois:[],maskStrokes:[],
        identification:{enabled:true},structure:{enabled:true,lockRatio:true,lockOutline:true,lockLines:true,lockSymmetry:false,lockLayout:true},
        detail:{enabled:true,inputMode:'combined',highPassRadiusPx:2,highPassGain:2,autoCrops:false,cropCount:2,restoreMode:'off',restoreStrength:.3},
        dimensions:XiaomeiPhysicalDimensions.defaults(),view:{enabled:false,mode:'keep',yaw:0,pitch:0,roll:0,framing:'medium',fov:50,proxyEnabled:false},
        generation:{enabled:true,allowedEdits:'background'},validation:{enabled:true,ratioTolerancePct:5},advanced:{enabled:false},
        maskFeatherPx:0,alignmentThreshold:.85};
}
function fidelityConfig(raw){
    const base=productFidelityDefaults(), old=cloneSmartSettings(raw||{});
    const config={...base,...old};
    for(const key of ['identification','structure','detail','dimensions','view','generation','validation','advanced']) config[key]={...base[key],...old[key]};
    if(old.view&&old.view.enabled===undefined)config.view.enabled=old.mode==='view';
    if(!old.advanced&&old.version)config.advanced.enabled=true;
    config.dimensions=XiaomeiPhysicalDimensions.migrate(old.dimensions||base.dimensions,config.geometry);
    config.referenceIds={...config.referenceIds};config.rois=config.rois||[];config.maskStrokes=config.maskStrokes||[];
    return config;
}
function normalizeProductFidelityNode(node){
    node.type=SMART_PRODUCT_FIDELITY_NODE_TYPE;
    if(!node.fidelityConfig) node.fidelityConfig=fidelityConfig(node.runSettings?.productFidelity||{enabled:true});
    if(node.fidelityConfig.dimensions?.version!==2||!node.fidelityConfig.identification||!node.fidelityConfig.advanced)node.fidelityConfig=fidelityConfig(node.fidelityConfig);
    node.fidelityConfig.enabled=true;
    node.w=Math.max(760,Number(node.w)||980);node.h=Math.max(560,Number(node.h)||720);
    node.title='产品保护';
    return node;
}
function createProductFidelityNodeAt(point){
    const height=Math.max(560,Math.min(720,window.innerHeight-160));
    const node=createNode((point?.x||0)-490,(point?.y||0)-height/2,[],{nodeType:SMART_PRODUCT_FIDELITY_NODE_TYPE,title:'产品保护',skipSave:true});
    if(!node)return null;
    node.h=height;
    const top=clientToWorldPoint(0,76).y,bottom=clientToWorldPoint(0,window.innerHeight-20).y;
    if(bottom-top>=height)node.y=Math.max(top,Math.min(node.y,bottom-height));
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
    if(mode!=='view')config.view.enabled=false;
    if(mode==='view'){
        config.view.enabled=true;config.view.mode='target';config.detail.restoreMode='off';
        if(config.dimensions.enabled&&config.dimensions.constraintMode==='protect')config.dimensions.constraintMode='prompt';
    }
}
function fidelityAssignConfig(target,source){
    const dimensions=target.dimensions;
    Object.assign(target,source);
    Object.assign(dimensions,source.dimensions);
    target.dimensions=dimensions;
}
function fidelityLinkedChangeMessage(before,after,directKey){
    if(directKey==='identification.enabled'&&before.identification.enabled&&!after.identification.enabled&&before.dimensions.enabled)
        return '关闭产品信息后，已填写的产品尺寸会暂时不生效；尺寸数值会保留。';
    const labels=[['mode','保护方式'],['generation.allowedEdits','改动范围'],['view.enabled','拍摄角度'],['detail.restoreMode','原图纹理'],['dimensions.constraintMode','尺寸处理方式'],['geometry','产品外形']];
    const affected=labels.filter(([key])=>key!==directKey&&fidelityGetValue(before,key)!==fidelityGetValue(after,key));
    const expectedMode=before.mode==='strict'?'background':before.mode==='view'?'view':'lighting';
    const needsConfirmation=affected.filter(([key])=>key!=='generation.allowedEdits'||before.generation.allowedEdits!==expectedMode);
    if(!needsConfirmation.length)return '';
    const names={strict:'仅换背景',structure:'光影融合',view:'换拍摄角度'};
    const change=before.mode!==after.mode?'将从「'+names[before.mode]+'」切换为「'+names[after.mode]+'」。':'';
    return change+'同时调整：'+needsConfirmation.map(([,label])=>label).join('、')+'。';
}
function fidelityConfigurationWarning(config,effective){
    if(config.identification.enabled===false&&config.dimensions.enabled)return '产品信息已关闭，已填写的产品尺寸暂时不生效。';
    if(config.mode!==effective.mode)return '当前保护方式与尺寸或角度设置冲突，实际处理方式是'+({strict:'只换背景',structure:'换背景和光线',view:'换角度'}[effective.mode]||effective.mode)+'。';
    return '';
}
function fidelityHasCustomSettings(config){
    const base=productFidelityDefaults();
    fidelityChangeMode(base,config.mode);
    return ['category','categoryCustom','geometry','geometryCustom','structure.lockRatio','structure.lockOutline','structure.lockLines','structure.lockSymmetry','structure.lockLayout','detail.inputMode','detail.cropCount','detail.restoreMode','detail.restoreStrength','view.yaw','view.pitch','view.roll','view.framing','view.fov','generation.allowedEdits','validation.enabled','validation.ratioTolerancePct','advanced.enabled','maskFeatherPx','alignmentThreshold'].some(key=>fidelityGetValue(config,key)!==fidelityGetValue(base,key));
}
function fidelityConfirmReplacement(message){
    return new Promise(resolve=>{
        const dialog=document.createElement('dialog');
        dialog.className='pf-confirm-dialog';
        dialog.setAttribute('aria-labelledby','pfConfirmTitle');
        dialog.setAttribute('aria-describedby','pfConfirmDescription');
        dialog.innerHTML='<h2 id="pfConfirmTitle">确认调整保护设置</h2><p id="pfConfirmDescription"></p><div><button type="button" data-pf-confirm="cancel">取消</button><button type="button" data-pf-confirm="accept">确认调整</button></div>';
        dialog.querySelector('p').textContent=message;
        const finish=value=>{if(dialog.open)dialog.close();dialog.remove();resolve(value);};
        dialog.querySelector('[data-pf-confirm="cancel"]').onclick=()=>finish(false);
        dialog.querySelector('[data-pf-confirm="accept"]').onclick=()=>finish(true);
        dialog.oncancel=event=>{event.preventDefault();finish(false);};
        document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-pf-confirm="cancel"]').focus();
    });
}
function fidelityEffectiveConfig(raw){
    const c=cloneSmartSettings(raw);
    if(c.identification?.enabled===false){c.category='auto';c.geometry='auto';c.dimensions.enabled=false;}
    const dimensionProtect=c.dimensions?.enabled&&c.dimensions.constraintMode==='protect';
    if(c.dimensions?.enabled){
        if(dimensionProtect)c.mode='strict';
        else if(c.mode==='strict')c.mode='structure';
    }
    if(c.structure?.enabled===false){for(const key of ['lockRatio','lockOutline','lockLines','lockSymmetry','lockLayout'])c.structure[key]=false;if(c.mode==='strict'&&!dimensionProtect)c.mode='structure';}
    if(c.view?.enabled===false){c.view={...c.view,mode:'keep',yaw:0,pitch:0,roll:0,framing:'medium',fov:50,proxyEnabled:false};if(c.mode==='view')c.mode='structure';}
    if(c.generation?.enabled===false||c.structure?.enabled===false||raw.mode!==c.mode)c.generation.allowedEdits=c.mode==='strict'?'background':c.mode==='view'?'view':'lighting';
    if(c.advanced?.enabled===false){c.detail.highPassRadiusPx=2;c.detail.highPassGain=2;c.maskFeatherPx=0;c.alignmentThreshold=.85;}
    return c;
}
function fidelityCanvasMaskChoices(node){
    const seen=new Set();
    return nodes.filter(n=>n.id!==node.id&&!isProductFidelityNode(n)).flatMap(n=>(n.images||[]).map((ref,index)=>({...ref,canvasNodeId:n.id,label:(n.title==='Image'?'图片':n.title||'图片')+' · '+(ref.name||'图片 '+(index+1))})))
        .filter(ref=>ref.url&&mediaKindForItem(ref)==='image'&&(ref.role==='product-mask'||/蒙版|mask/i.test(ref.label))&&!seen.has(ref.url)&&seen.add(ref.url))
        .sort((a,b)=>Number(b.role==='product-mask')-Number(a.role==='product-mask'));
}
function fidelityMaskSelectHtml(node){
    const url=node.fidelityConfig.maskUrl||'',choices=fidelityCanvasMaskChoices(node);
    if(url&&!choices.some(r=>r.url===url))choices.unshift({url,label:'已选黑白保护图'});
    return '<label class="pf-field"><span>保留区域来源</span><select data-pf-mask-select><option value="">直接在左侧商品图上涂抹</option>'+choices.map(r=>'<option value="'+escapeAttr(r.url)+'" '+(url===r.url?'selected':'')+'>'+escapeHtml((r.role==='product-mask'?'保护图 · ':'')+r.label)+'</option>').join('')+'</select></label>';
}
function productFidelityInputImages(node,ctx=smartLoopContext,visited=new Set()){
    if(!node||visited.has(node.id))return [];
    visited.add(node.id);
    const source=workflowInputNodesFor(node).flatMap(input=>isProductFidelityNode(input)?productFidelityInputImages(input,ctx,visited):outputImagesForNode(input,false,ctx));
    const own=(node.images||[]).map((image,index)=>({...image,nodeId:node.id,imageIndex:index}));
    const seen=new Set(), maskUrl=node.fidelityConfig?.maskUrl;
    return orderedSmartInputReferences(node,[...source,...manualReferenceImagesFor(node),...own])
        .filter(ref=>ref?.url&&mediaKindForItem(ref)==='image'&&ref.role!=='product-mask'&&ref.url!==maskUrl&&!isInputRefBlocked(node,ref))
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
    const ordered=imageRefsOnly(refs).map(ref=>{
        config.referenceIds[ref.url]||=source?.fidelityConfig?.referenceIds?.[ref.url]||ref.reference_id||('url:'+ref.url);
        if(source)source.fidelityConfig.referenceIds[ref.url]=config.referenceIds[ref.url];
        return {...ref,reference_id:config.referenceIds[ref.url]};
    });
    if(!config.productReferenceId&&ordered[0])config.productReferenceId=ordered[0].reference_id;
    return ordered.map(ref=>({...ref,role:ref.reference_id===config.productReferenceId?'product_reference':'user_reference'}));
}
function validateProductFidelityRun(node,runSettings){
    const sources=productFidelitySourcesFor(node);
    if(sources.length>1)throw new Error('当前绘画连接了多个启用的产品保护节点，请只保留一个保护来源');
    const effective=productFidelitySettingsForNode(node,runSettings);
    if(effective.productFidelity)runSettings.productFidelity=effective.productFidelity;
    else if(runSettings.productFidelity?.sourceNodeId)delete runSettings.productFidelity;
    if(!runSettings.productFidelity?.enabled)return;
    const dimensions=XiaomeiPhysicalDimensions.migrate(runSettings.productFidelity.dimensions||{},runSettings.productFidelity.geometry);
    const valid=XiaomeiPhysicalDimensions.validatePhysicalDimensions(dimensions);
    if(!valid.valid)throw new Error(valid.errors.join('；'));
    if(runSettings.engine!=='api'||runSettings.apiKind==='video'||runSettings.imageOperation==='upscale')
        throw new Error('产品保护需要普通 API 图片模型；请选择图片模型或关闭上游产品保护');
    if(node?.outpaintSize||runSettings.outpaintMode)throw new Error('产品保护不能与扩图同时运行，请分别处理');
    if(fidelityEffectiveConfig(runSettings.productFidelity).mode==='strict'&&upstreamCameraNodesFor(node).length)
        throw new Error('保留原产品像素需要保持原角度，请关闭视角控制或改用视角保真');
    if(fidelityEffectiveConfig(runSettings.productFidelity).mode==='view'&&upstreamCameraNodesFor(node).length)
        throw new Error('当前绘画同时连接产品视角和视角控制，请只保留一个视角来源');
}
function validateProductFidelityConnection(from,to){
    if(!isProductFidelityNode(from)&&!isProductFidelityNode(to))return true;
    if(isProductFidelityNode(from)&&isProductFidelityNode(to)){toast('产品保护节点不串联，请将它连接到绘画节点');return false;}
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
function fidelityAssetLabel(asset){return asset.role==='geometry_reference'?'尺寸结构代理图':asset.role==='highpass'?'纹理细节图':asset.role==='perspective-proxy'?'目标角度示意':'局部细节图';}
function fidelityReferenceLabel(ref,index){
    let name=ref.name||'';
    try{name=decodeURIComponent(name);}catch{}
    return !name||/^(?:\d{13,}|[a-f\d]{24,}|[a-f\d-]{36})(?:\.[a-z\d]+)?$/i.test(name)?'产品图 '+(index+1):name;
}
const FIDELITY_VIEW_FRAMING={closeup:'特写',close:'近景',medium:'中景',full:'全景',wide:'远景'};
function fidelityViewSummary(view){
    const yaw=Number(view?.yaw)||0,pitch=Number(view?.pitch)||0,roll=Number(view?.roll)||0;
    const direction=Math.abs(yaw)===180?'反向机位 180°':Math.abs(yaw)<1?'原图机位':`相机向${yaw<0?'左':'右'} ${Math.abs(yaw)}°`;
    const height=Math.abs(pitch)<1?'原图俯仰':`${pitch>0?'俯拍':'仰拍'} ${Math.abs(pitch)}°`;
    const framing=FIDELITY_VIEW_FRAMING[view?.framing]||'中景';
    return [direction,height,framing,roll?`画面旋转 ${roll}°`:'',Number(view?.fov)>=100?'鱼眼效果':''].filter(Boolean).join(' · ');
}
function productFidelityNodeBodyHtml(node){
    const refs=fidelityEnsureReferences(node),config=node.fidelityConfig;
    const check=(key,label)=>`<label class="pf-check"><input type="checkbox" data-pf-field="${key}" ${fidelityGetValue(config,key)?'checked':''}><span>${label}</span></label>`;
    const select=(key,label,choices)=>`<label class="pf-field"><span>${label}</span><select data-pf-field="${key}">${choices.map(([value,text])=>`<option value="${escapeAttr(value)}" ${fidelityGetValue(config,key)===value?'selected':''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
    const number=(key,label,min,max,step,unit='')=>`<label class="pf-field"><span>${label}</span><span class="pf-number"><input type="number" min="${min}" max="${max}" step="${step}" data-pf-field="${key}" value="${Number(fidelityGetValue(config,key)||0)}">${unit}</span></label>`;
    const custom=(key,label,placeholder,visible)=>`<label class="pf-field" data-pf-custom="${key}" ${visible?'':'hidden'}><span>${label}</span><input type="text" maxlength="120" data-pf-field="${key}" value="${escapeAttr(fidelityGetValue(config,key)||'')}" placeholder="${escapeAttr(placeholder)}"></label>`;
    const help=(label,content)=>`<details class="pf-help-disclosure"><summary>${label}</summary>${content}</details>`;
    const section=(id,key,title,label,content)=>`<section class="pf-section" data-pf-section="${id}" data-pf-module="${key}"><div class="pf-section-heading"><h3>${title}</h3>${check(key+'.enabled',label)}</div>${content}</section>`;
    const group=(key,title,content,open=false)=>`<details class="pf-group" data-pf-group="${key}" ${open?'open':''}><summary>${title}</summary><div class="pf-group-body">${content}</div></details>`;
    const previous=node.fidelityPreview,fresh=previous?.signature===fidelitySignature(node);
    const current=refs.find(ref=>config.referenceIds[ref.url]===config.productReferenceId);
    const assets=fresh?previous.generatedAssets||[]:[];
    const productChoices=[...(!current?[[config.productReferenceId||'',refs.length?'请重新选择产品主图':'请先连接产品图片']]:[]),...refs.map((ref,index)=>[config.referenceIds[ref.url],fidelityReferenceLabel(ref,index)])];
    const modeChoices=[['strict','仅换背景','保留标记区原图，保持原机位'],['structure','光影融合','同角度调整光照，颜色和细节可能变化'],['view','换拍摄角度','按新机位重绘，未见面由 AI 推测']];
    const dimensions=config.dimensions;
    const simpleDimension=(key,label)=>`<label class="pf-simple-dimension"><span>${label}</span><input type="number" min="0" step="any" data-pf-simple-dimension="${key}" value="${dimensions[key]===null?'':escapeAttr(Number(XiaomeiPhysicalDimensions.convertFromMillimeters(dimensions[key],dimensions.unit).toPrecision(12)))}" placeholder="未知"></label>`;
    return `<div class="pf-workbench" data-pf-root>
        <header class="pf-heading"><div><strong>商品保护设置</strong></div><div class="pf-heading-actions"><nav class="pf-ui-modes" role="tablist" aria-label="设置模式"><button type="button" role="tab" id="pf-ui-${escapeAttr(node.id)}-simple" aria-controls="pf-ui-panel-${escapeAttr(node.id)}-simple" data-pf-ui-mode="simple" aria-selected="true">简单设置</button><button type="button" role="tab" id="pf-ui-${escapeAttr(node.id)}-all" aria-controls="pf-ui-panel-${escapeAttr(node.id)}-all" data-pf-ui-mode="all" aria-selected="false">全部设置</button></nav></div></header>
        <div class="pf-layout"><div class="pf-image-column">
            <div class="pf-image-heading"><strong>1. 选择商品原图</strong></div>
            <div class="pf-source-picker"><img data-pf-source-thumb alt="" ${current?`src="${escapeAttr(current.url)}"`:'hidden'}><div class="pf-source-copy"><label class="pf-field" data-pf-source-select ${current&&refs.length===1?'hidden':''}><span>选择商品原图</span><select data-pf-field="productReferenceId">${productChoices.map(([value,label])=>`<option value="${escapeAttr(value)}" ${config.productReferenceId===value?'selected':''}>${escapeHtml(label)}</option>`).join('')}</select></label><strong data-pf-source-name ${current&&refs.length===1?'':'hidden'}>${current?escapeHtml(fidelityReferenceLabel(current,refs.indexOf(current))):''}</strong><span data-pf-source-info>${current?'正在读取图片尺寸…':'请先连接商品原图'}</span></div></div>
            <div class="pf-image-heading pf-editor-title"><strong>2. 标记保留区域</strong><button type="button" data-pf-expand aria-expanded="false">放大编辑</button></div>
            <div class="pf-editor-region"><div class="pf-toolbar-card"><div class="pf-tools" role="group" aria-label="标记工具"><button type="button" data-pf-tool="mask">涂抹商品</button><button type="button" data-pf-tool="erase">橡皮擦</button><button type="button" data-pf-tool="rect">框选商品</button></div>
            <div class="pf-editor-controls"><div class="pf-control-context"><label class="pf-brush">画笔大小<input type="range" min="1" max="20" value="4" data-pf-brush><output data-pf-brush-size></output></label><span class="pf-roi-hint" data-pf-roi-hint hidden>在图上拖出商品保护区</span></div>
            <div class="pf-control-actions"><div class="pf-history-actions"><button type="button" data-pf-history="undo" title="撤销画布上一步操作">撤销</button><button type="button" data-pf-history="redo" title="重做画布上一步操作">重做</button></div><div class="pf-secondary-actions"><button type="button" data-pf-action="clear-mask">清空保护区</button><button type="button" data-pf-action="clear-rois" hidden>清空细节框</button></div></div>
            </div><p class="pf-image-note" data-pf-roi-info>涂成灰色的商品区域将被标记为保留区，背景留空。</p></div>
            <div class="pf-canvas-stage"><canvas data-pf-canvas tabindex="0" aria-label="产品图片与保护区域"></canvas><p data-pf-empty ${current?'hidden':''}>请将商品图片连到节点左侧输入口<br>选好主图，再涂抹需要保留的区域</p></div>
            </div>
            <div class="pf-roi-list" data-pf-rois></div><details class="pf-asset-panel" hidden ${assets.length?'open':''}><summary>查看保护参考图 <span data-pf-asset-count>${assets.filter(asset=>asset.role!=='product-mask').length} 张</span></summary><p class="pf-help" data-pf-assets-empty ${assets.some(asset=>asset.role!=='product-mask')?'hidden':''}>点击底部「生成保护参考图」后可在这里查看。</p><div class="pf-assets" data-pf-assets>${assets.filter(asset=>asset.role!=='product-mask').map(asset=>fidelityAssetHtml(asset,fidelityAssetLabel(asset))).join('')}</div></details>
        </div><div class="pf-settings-column"><div class="pf-settings-content">
            <div class="pf-simple" data-pf-ui-panel="simple" role="tabpanel" id="pf-ui-panel-${escapeAttr(node.id)}-simple" aria-labelledby="pf-ui-${escapeAttr(node.id)}-simple"><h2>3. 选择出图方式</h2><div class="pf-preset-list">${modeChoices.map(([mode,label,description])=>`<button type="button" class="pf-preset" data-pf-preset="${mode}" aria-pressed="${config.mode===mode}"><span class="pf-preset-radio" aria-hidden="true"></span><span><strong>${label}</strong><small>${description}</small></span></button>`).join('')}</div>
                <div class="pf-mode-explanation" data-pf-mode-explanation role="status" aria-live="polite"><strong class="pf-sr-only" data-pf-mode-title></strong><div class="pf-mode-view" data-pf-mode-view hidden><span data-pf-simple-view-summary></span><button type="button" data-pf-simple-view-open>设置拍摄角度</button></div><p class="pf-mode-next" data-pf-mode-next hidden></p></div>
                <p class="pf-custom-warning" data-pf-custom-warning hidden>当前含微调参数，切换方式前会提示关联调整。</p>
                <div class="pf-simple-options"><label class="pf-simple-toggle"><span><strong>保护文字和花纹</strong><small>为 Logo、标签、纹理增加细节参考</small></span><input type="checkbox" data-pf-simple-detail ${config.detail.enabled?'checked':''}></label><label class="pf-simple-toggle"><span><strong>填写商品实物尺寸</strong><small>宽、高与尺寸单位</small></span><input type="checkbox" data-pf-simple-dimensions ${dimensions.enabled?'checked':''}></label></div>
                <div class="pf-simple-dimensions" data-pf-simple-dimensions-content ${dimensions.enabled?'':'hidden'}><div class="pf-simple-dimensions-grid">${simpleDimension('width','宽')}${simpleDimension('height','高')}<label class="pf-simple-dimension"><span>单位</span><select data-pf-simple-dimension="unit">${[['mm','毫米'],['cm','厘米'],['m','米'],['in','英寸']].map(([unit,label])=>`<option value="${unit}" ${dimensions.unit===unit?'selected':''}>${label}</option>`).join('')}</select></label></div><p data-pf-simple-dimension-error role="status"></p></div>
                <p class="pf-simple-note" data-pf-simple-note></p>
            </div>
            <div class="pf-all" data-pf-ui-panel="all" role="tabpanel" id="pf-ui-panel-${escapeAttr(node.id)}-all" aria-labelledby="pf-ui-${escapeAttr(node.id)}-all" hidden><h2>全部设置</h2><p class="pf-all-intro">按需要展开设置；日常出图通常只需简单设置。</p>
                ${group('change','出图方式与改动范围',select('mode','商品保护方式',modeChoices)+section('04','generation','允许 AI 改哪里？','启用',select('generation.allowedEdits','AI 可调整的范围',[['background','只更换背景'],['lighting','背景与商品光照'],['material','局部材质质感'],['view','商品拍摄角度']])+`<p class="pf-strategy" data-pf-strategy></p>`),true)}
                ${group('identity','这是什么商品？',section('01','identification','商品信息','启用',select('category','商品类目',[['auto','不指定／请选择类目'],['textile','地毯／布艺／家纺'],['clothing','服装／鞋帽'],['bag','箱包／皮具'],['furniture','家具／家居摆件'],['frame','相框／装饰画'],['box','包装盒'],['cylinder','瓶罐／杯具'],['beauty','美妆／个护'],['jewelry','珠宝／饰品'],['electronics','电子数码'],['appliance','家用电器'],['food','食品／饮料'],['toy','玩具／文具'],['other','其他商品（手动填写）']])+custom('categoryCustom','填写商品名称','例如：入户门垫、宠物窝',config.category==='other')+select('geometry','商品外形',[['auto','不指定形状'],['plane','平整表面（如画框／地毯）'],['circle','圆形平面'],['oval','椭圆形平面'],['polygon','多边形平面'],['box','立体方盒'],['cylinder','圆柱体（如瓶罐）'],['cone','上窄下宽／收口形'],['sphere','球体'],['curved','弧面／曲面'],['soft','软质／可折叠'],['other','不规则异形'],['custom','手动描述形状']])+custom('geometryCustom','描述商品形状','例如：半圆门垫、带提手的异形瓶',config.geometry==='custom')))}
                ${group('shape','商品怎么保持形状？',section('02','structure','形状保护','启用',fidelityMaskSelectHtml(node)+help('灰色涂抹和黑白保护图是什么关系？','<p class="pf-help">左侧半透明灰色只是保护区预览，生成黑白保护图时，涂抹的地方是白色（保留原图），未涂抹的地方是黑色（可改变）。也可导入与主图同尺寸的黑白保护图。</p>')+`<div class="pf-checks">${check('structure.lockRatio','保持长宽比例')}${check('structure.lockOutline','保持外轮廓')}${check('structure.lockLines','保持边缘直线')}${check('structure.lockSymmetry','保持左右对称')}${check('structure.lockLayout','保持商品部件位置')}</div>`))}
                ${group('detail','Logo、文字与纹理',section('03','detail','细节参考','启用',select('detail.inputMode','细节参考方式',[['original','只用商品原图'],['highpass','增加表面纹理参考图'],['crops','增加局部细节图'],['combined','纹理图＋局部细节图']])+`<details class="pf-options" data-pf-crop-options><summary>重点细节框（Logo、标签文字）</summary>${check('detail.autoCrops','按纹理自动寻找候选区域')}${number('detail.cropCount','最多提取几处细节',0,3,1,'张')}<div class="pf-secondary-actions"><button type="button" data-pf-action="auto-crops">寻找细节并预览</button><button type="button" data-pf-action="manual-rois">自己框选细节</button></div><p class="pf-help">自动选区按图像纹理和边缘寻找，不识别 Logo 或文字；请检查后使用。点击下方裁切预览可定位；在左图拖动或缩放，按 Delete 删除后可重新圈选。</p></details><details class="pf-options"><summary>出图后恢复原图纹理</summary>${select('detail.restoreMode','纹理如何处理',[['off','不贴回原图纹理'],['auto','可靠对齐后恢复原图纹理']])}<label class="pf-field"><span>原图纹理叠加强度</span><span class="pf-range"><small>少量</small><input type="range" min="0" max="1" step=".05" data-pf-field="detail.restoreStrength" value="${config.detail.restoreStrength}"><small>较多</small></span></label><p class="pf-help" data-pf-restore-note></p></details>`))}
                ${group('angle','商品拍摄角度',section('05','view','调整拍摄角度','启用',`<div class="pf-view-card"><div class="pf-view-card-main"><div class="pf-view-thumb">${current?`<img src="${escapeAttr(current.url)}" alt="当前产品主图">`:'<span>暂无主图</span>'}</div><div class="pf-view-card-copy"><span>当前拍摄角度</span><strong data-pf-view-summary>${escapeHtml(config.view.enabled?fidelityViewSummary(config.view):'保持原图角度')}</strong><small>以原图当前角度为 0°</small></div></div><button type="button" data-pf-view-open>选择新角度</button></div><p class="pf-help" data-pf-view-note>换角度时 AI 会重绘商品；原图看不到的侧面和背面需要推测。</p>`+help('其他角度的实拍图','<p class="pf-help">可连接同一商品其他角度的实拍图，并在绘画提示词中说明方向，提高结构参考的可靠性。</p>')))}
                ${group('size','商品实物尺寸',physicalDimensionPanelHtml(dimensions))}
                ${group('check','出图后检查',section('06','validation','结果检查','启用',`<div class="pf-results" data-pf-results></div><details class="pf-options"><summary>比例偏差提醒</summary>${number('validation.ratioTolerancePct','允许的外形比例偏差',1,20,1,'%')}<p class="pf-help">遮挡或匹配不足时会显示无法判断；文字和接缝仍需人工检查。</p></details>`))}
                ${group('more','微调参数',section('07','advanced','本地处理（日常无需修改）','启用',number('detail.highPassRadiusPx','纹理提取粗细',.5,8,.5,'px')+number('detail.highPassGain','纹理图清晰度',.5,4,.25)+number('maskFeatherPx','商品边缘过渡',0,8,.5,'px')+number('alignmentThreshold','原图纹理匹配门槛',.7,1,.05)+`<details class="pf-debug"><summary>查看模型与实际参考图</summary><pre data-pf-debug></pre></details>`))}
            </div>
        </div></div></div><footer class="pf-footer"><div><p data-pf-status role="status">${fresh?'保护参考图已更新':refs.length?'保护设置已更新，可生成参考图':'请先连接商品图片'}</p><p class="pf-footer-validation" data-pf-validation-status role="status" hidden></p><span class="pf-output-note">左侧为原图，最终图片在下游「绘画」节点生成</span><span data-pf-route hidden></span></div><div class="pf-footer-action"><button type="button" class="pf-update" data-pf-action="preview">生成保护参考图</button></div></footer></div>`;
}
function fidelityCanEdit(node){
    return collabCanMutateCanvas()&&(typeof collabCanEditNode!=='function'||collabCanEditNode(node.id,true));
}
let activeProductViewEditor=null;
const FIDELITY_VIEW_PRESETS=[
    ['original','原图 0°',{yaw:0,pitch:0,roll:0,framing:'medium',fov:50}],
    ['left','左前 45°',{yaw:-45,pitch:0,roll:0,framing:'medium',fov:50}],
    ['right','右前 45°',{yaw:45,pitch:0,roll:0,framing:'medium',fov:50}],
    ['leftSide','左侧 90°',{yaw:-90,pitch:0,roll:0,framing:'medium',fov:50}],
    ['rightSide','右侧 90°',{yaw:90,pitch:0,roll:0,framing:'medium',fov:50}],
    ['top','俯拍',{yaw:0,pitch:60,roll:0,framing:'medium',fov:50}],
    ['low','仰拍',{yaw:0,pitch:-30,roll:0,framing:'medium',fov:50}],
    ['back','背面 180°',{yaw:180,pitch:0,roll:0,framing:'medium',fov:50}]
];
const FIDELITY_FRAMING_VALUES=['wide','full','medium','close','closeup'];
const FIDELITY_VIEW_IMAGE_SIZES={closeup:126,close:104,medium:84,full:66,wide:50};
function fidelitySphereGridSvg(view){
    const turn=.24+(Number(view.yaw)||0)*Math.PI/180,tilt=.16+(Number(view.pitch)||0)*Math.PI/180;
    const cosTurn=Math.cos(turn),sinTurn=Math.sin(turn),cosTilt=Math.cos(tilt),sinTilt=Math.sin(tilt);
    const point=(latitude,longitude)=>{
        const x=Math.cos(latitude)*Math.sin(longitude),y=Math.sin(latitude),z=Math.cos(latitude)*Math.cos(longitude);
        const rotatedX=x*cosTurn+z*sinTurn,rotatedZ=z*cosTurn-x*sinTurn;
        const rotatedY=y*cosTilt-rotatedZ*sinTilt,depth=y*sinTilt+rotatedZ*cosTilt;
        return {x:(120+92*rotatedX).toFixed(1),y:(120-92*rotatedY).toFixed(1),front:depth>=0};
    };
    const paths=[];
    const trace=(points,featured=false)=>{
        const back=points.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join('');
        let front='',drawing=false;
        for(const p of points){
            if(p.front){front+=(drawing?'L':'M')+p.x+' '+p.y;drawing=true;}
            else drawing=false;
        }
        const feature=featured?' pf-view-mesh-feature':'';
        paths.push(`<path class="pf-view-mesh-back${feature}" d="${back}"/>`);
        if(front)paths.push(`<path class="pf-view-mesh-front${feature}" d="${front}"/>`);
    };
    for(let longitude=0;longitude<360;longitude+=20){
        trace(Array.from({length:37},(_,i)=>point(-Math.PI/2+i*Math.PI/36,longitude*Math.PI/180)),longitude===0);
    }
    for(let latitude=-72;latitude<=72;latitude+=18){
        trace(Array.from({length:73},(_,i)=>point(latitude*Math.PI/180,i*Math.PI/36)));
    }
    return `<svg class="pf-view-globe" data-pf-view-globe viewBox="0 0 240 240" aria-hidden="true"><circle class="pf-view-globe-core" cx="120" cy="120" r="92"/>${paths.join('')}<circle class="pf-view-globe-outline" cx="120" cy="120" r="92"/></svg>`;
}
function fidelityViewDraft(source={}){
    const angle=(key,min,max,fallback)=>{
        const value=Number(source[key]);
        return Math.max(min,Math.min(max,Number.isFinite(value)?Math.round(value):fallback));
    };
    return {
        yaw:angle('yaw',-180,180,0),pitch:angle('pitch',-90,90,0),roll:angle('roll',-90,90,0),
        framing:FIDELITY_FRAMING_VALUES.includes(source.framing)?source.framing:'medium',
        fov:angle('fov',18,120,50),proxyEnabled:Boolean(source.proxyEnabled)
    };
}
function fidelityViewInstruction(view){
    const yaw=Number(view.yaw),pitch=Number(view.pitch);
    const orbit=Math.abs(yaw)===180?'相机移动到原图机位的反向 180°':Math.abs(yaw)<1?'保持原图拍摄方向':`相机从原图机位向${yaw<0?'左':'右'}环绕 ${Math.abs(yaw)}°`;
    const height=Math.abs(pitch)<1?'保持原图俯仰角度':`相机${pitch>0?'俯拍':'仰拍'} ${Math.abs(pitch)}°`;
    return `以原图当前机位为 0°。${orbit}，${height}，采用${FIDELITY_VIEW_FRAMING[view.framing]}。${view.roll?`画面旋转 ${view.roll}°。`:''}${view.fov>=100?'使用鱼眼广角效果，边缘透视可能变形。':'保持自然镜头透视。'}保持同一产品的真实结构、材质、颜色、标识和部件位置；不要镜像或平面拉斜原图。`;
}
function openProductViewEditor(session){
    const node=session.node,config=node.fidelityConfig;
    if(!fidelityCanEdit(node)||!config.view.enabled)return;
    const refs=fidelityEnsureReferences(node),source=refs.find(ref=>config.referenceIds[ref.url]===config.productReferenceId);
    if(!source){fidelityStatus(session,'请先连接并选择商品原图，再调整角度');return;}
    activeProductViewEditor?.close();
    const original=fidelityViewDraft(config.view),draft={...original};
    const dialog=document.createElement('dialog');
    dialog.className='pf-view-dialog';
    dialog.setAttribute('aria-labelledby','pfViewDialogTitle');
    dialog.innerHTML=`<header class="pf-view-dialog-head"><div><h2 id="pfViewDialogTitle">选择新的拍摄角度</h2><p>以原图机位为 0°；球面表示相机方向，不是生成预览。</p></div><button type="button" data-pf-view-close aria-label="关闭视角编辑器">×</button></header>
        <div class="pf-view-dialog-body"><div class="pf-view-presets" aria-label="常用机位">${FIDELITY_VIEW_PRESETS.map(([key,label])=>`<button type="button" data-pf-view-preset="${key}">${label}</button>`).join('')}</div>
        <div class="pf-view-dialog-grid"><div class="pf-view-orbit-column"><div class="pf-view-orbit" data-pf-view-orbit tabindex="0" role="group" aria-label="拖动或使用方向键调整机位">${fidelitySphereGridSvg(draft)}<img src="${escapeAttr(source.url)}" alt="原图产品主图"><span class="pf-view-marker" data-pf-view-marker aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3v12H4V7Z"/><circle cx="12" cy="13" r="3.3"/></svg></span><button type="button" class="pf-view-nudge pf-view-nudge-left" data-pf-view-nudge="left" aria-label="相机向左环绕 15 度">‹</button><button type="button" class="pf-view-nudge pf-view-nudge-right" data-pf-view-nudge="right" aria-label="相机向右环绕 15 度">›</button><button type="button" class="pf-view-nudge pf-view-nudge-up" data-pf-view-nudge="up" aria-label="相机向上俯拍 15 度">⌃</button><button type="button" class="pf-view-nudge pf-view-nudge-down" data-pf-view-nudge="down" aria-label="相机向下仰拍 15 度">⌄</button></div><p>景别缩放会同时改变球面线框和球心原图；球面为机位示意。</p><strong data-pf-view-orbit-label></strong></div>
        <div class="pf-view-controls"><label><span>水平环绕</span><div><input type="range" min="-180" max="180" step="1" data-pf-view-range="yaw"><input type="number" min="-180" max="180" step="1" data-pf-view-number="yaw" aria-label="水平环绕角度">°</div></label><label><span>垂直俯仰</span><div><input type="range" min="-90" max="90" step="1" data-pf-view-range="pitch"><input type="number" min="-90" max="90" step="1" data-pf-view-number="pitch" aria-label="垂直俯仰角度">°</div></label><label><span>景别缩放</span><div><input type="range" min="0" max="4" step="1" data-pf-view-framing><output data-pf-view-framing-label></output></div></label><details class="pf-view-advanced"><summary>镜头与示意图</summary><label><span>画面旋转</span><div><input type="range" min="-90" max="90" step="1" data-pf-view-range="roll"><input type="number" min="-90" max="90" step="1" data-pf-view-number="roll" aria-label="画面旋转角度">°</div></label><label class="pf-view-check"><input type="checkbox" data-pf-view-fisheye>鱼眼广角效果</label><label class="pf-view-check"><input type="checkbox" data-pf-view-proxy>增加平面角度示意图</label><p data-pf-view-proxy-note></p></details></div></div>
        <p class="pf-view-warning" data-pf-view-warning role="status"></p><details class="pf-view-prompt"><summary>查看视角提示词</summary><p data-pf-view-prompt-text></p><small>生成时会与产品保护要求、绘画提示词合并。</small></details></div>
        <footer class="pf-view-dialog-foot"><span>调整角度不会立即调用生图模型</span><div><button type="button" data-pf-view-reset>重置</button><button type="button" data-pf-view-cancel>取消</button><button type="button" data-pf-view-apply>应用角度</button></div></footer>`;
    document.body.appendChild(dialog);
    const close=()=>{if(activeProductViewEditor?.dialog===dialog)activeProductViewEditor=null;if(dialog.open)dialog.close();dialog.remove();};
    activeProductViewEditor={dialog,close};
    let renderedGridAngles=`${draft.yaw}:${draft.pitch}`;
    const render=()=>{
        if((Math.abs(draft.yaw)>60||Math.abs(draft.pitch)>60)&&draft.proxyEnabled)draft.proxyEnabled=false;
        dialog.querySelectorAll('[data-pf-view-range]').forEach(input=>{input.value=draft[input.dataset.pfViewRange];});
        dialog.querySelectorAll('[data-pf-view-number]').forEach(input=>{input.value=draft[input.dataset.pfViewNumber];});
        dialog.querySelector('[data-pf-view-framing]').value=FIDELITY_FRAMING_VALUES.indexOf(draft.framing);
        dialog.querySelector('[data-pf-view-framing-label]').textContent=FIDELITY_VIEW_FRAMING[draft.framing];
        dialog.querySelector('[data-pf-view-fisheye]').checked=draft.fov>=100;
        const proxy=dialog.querySelector('[data-pf-view-proxy]');
        proxy.checked=draft.proxyEnabled;proxy.disabled=config.geometry!=='plane'||Math.abs(draft.yaw)>60||Math.abs(draft.pitch)>60;
        dialog.querySelector('[data-pf-view-proxy-note]').textContent=proxy.disabled?'平面角度示意仅适用于矩形平面，且水平和俯仰不超过 60°。':'这张示意图只引导透视，不包含产品真实侧面。';
        const yaw=draft.yaw*Math.PI/180,pitch=draft.pitch*Math.PI/180;
        const marker=dialog.querySelector('[data-pf-view-marker]');
        const orbit=dialog.querySelector('[data-pf-view-orbit]'),framingIndex=FIDELITY_FRAMING_VALUES.indexOf(draft.framing);
        orbit.style.setProperty('--pf-view-image-size',`${FIDELITY_VIEW_IMAGE_SIZES[draft.framing]}px`);
        orbit.style.setProperty('--pf-view-globe-scale',String(.9+framingIndex*.05));
        const gridAngles=`${draft.yaw}:${draft.pitch}`;
        if(gridAngles!==renderedGridAngles){dialog.querySelector('[data-pf-view-globe]').outerHTML=fidelitySphereGridSvg(draft);renderedGridAngles=gridAngles;}
        const markerRadius=36*(.9+framingIndex*.05);
        marker.style.left=`${50+markerRadius*Math.sin(yaw)*Math.cos(pitch)}%`;
        marker.style.top=`${50-markerRadius*Math.sin(pitch)}%`;
        marker.dataset.back=String(Math.cos(yaw)<0);
        dialog.querySelector('[data-pf-view-orbit-label]').textContent=fidelityViewSummary(draft);
        dialog.querySelectorAll('[data-pf-view-preset]').forEach(button=>{
            const preset=FIDELITY_VIEW_PRESETS.find(item=>item[0]===button.dataset.pfViewPreset)?.[2];
            button.setAttribute('aria-pressed',String(Object.entries(preset||{}).every(([key,value])=>draft[key]===value)));
        });
        const warning=Math.abs(draft.yaw)>=60||Math.abs(draft.pitch)>=60
            ?'大角度会显示原图未拍摄的区域。请补充对应方向的实拍图；缺少参考时由 AI 推测，生成后检查 LOGO、文字和接口。'
            :'调整视角会重绘产品，原图像素无法原样保留；生成后请检查外形与细节。';
        dialog.querySelector('[data-pf-view-warning]').textContent=warning+(draft.fov>=100?'鱼眼效果会使画面边缘及产品外形变形；请核对产品轮廓。':'');
        dialog.querySelector('[data-pf-view-prompt-text]').textContent=fidelityViewInstruction(draft);
    };
    dialog.querySelectorAll('[data-pf-view-preset]').forEach(button=>button.onclick=()=>{Object.assign(draft,FIDELITY_VIEW_PRESETS.find(item=>item[0]===button.dataset.pfViewPreset)[2]);render();});
    dialog.querySelectorAll('[data-pf-view-range]').forEach(input=>input.oninput=()=>{draft[input.dataset.pfViewRange]=Number(input.value);render();});
    dialog.querySelectorAll('[data-pf-view-number]').forEach(input=>input.onchange=()=>{if(input.value!=='')draft[input.dataset.pfViewNumber]=Number(input.value);Object.assign(draft,fidelityViewDraft(draft));render();});
    dialog.querySelector('[data-pf-view-framing]').oninput=event=>{draft.framing=FIDELITY_FRAMING_VALUES[Number(event.target.value)];render();};
    dialog.querySelector('[data-pf-view-fisheye]').onchange=event=>{draft.fov=event.target.checked?110:50;render();};
    dialog.querySelector('[data-pf-view-proxy]').onchange=event=>{draft.proxyEnabled=event.target.checked;render();};
    dialog.querySelectorAll('[data-pf-view-nudge]').forEach(button=>button.onclick=()=>{
        const delta={left:['yaw',-15],right:['yaw',15],up:['pitch',15],down:['pitch',-15]}[button.dataset.pfViewNudge];
        const [key,step]=delta;draft[key]=Math.max(key==='yaw'?-180:-90,Math.min(key==='yaw'?180:90,draft[key]+step));render();
    });
    const orbit=dialog.querySelector('[data-pf-view-orbit]');let drag=null;
    orbit.onpointerdown=event=>{if(event.button!==0||event.target.closest('[data-pf-view-nudge]'))return;drag={x:event.clientX,y:event.clientY,yaw:draft.yaw,pitch:draft.pitch};orbit.setPointerCapture(event.pointerId);event.preventDefault();};
    orbit.onpointermove=event=>{if(!drag)return;draft.yaw=Math.max(-180,Math.min(180,Math.round(drag.yaw+(event.clientX-drag.x)*.8)));draft.pitch=Math.max(-90,Math.min(90,Math.round(drag.pitch-(event.clientY-drag.y)*.7)));render();};
    orbit.onpointerup=orbit.onpointercancel=()=>{drag=null;};
    orbit.onkeydown=event=>{const change={ArrowLeft:['yaw',-5],ArrowRight:['yaw',5],ArrowUp:['pitch',5],ArrowDown:['pitch',-5]}[event.key];if(!change)return;event.preventDefault();const [key,delta]=change;draft[key]=Math.max(key==='yaw'?-180:-90,Math.min(key==='yaw'?180:90,draft[key]+delta));render();};
    dialog.querySelector('[data-pf-view-reset]').onclick=()=>{Object.assign(draft,fidelityViewDraft({}));render();};
    dialog.querySelector('[data-pf-view-close]').onclick=close;
    dialog.querySelector('[data-pf-view-cancel]').onclick=close;
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialog.addEventListener('paste',event=>event.stopPropagation());
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    dialog.querySelector('[data-pf-view-apply]').onclick=()=>{
        if(!fidelityCanEdit(node)||!nodes.includes(node)){close();return;}
        if(JSON.stringify(original)!==JSON.stringify(draft)){
            pushUndo();fidelityChangeMode(config,'view');Object.assign(config.view,draft);
            config.view.mode=draft.yaw||draft.pitch||draft.roll||draft.framing!=='medium'||draft.fov!==50?'target':'keep';
            session.root.querySelector('[data-pd-root]')?.pdRefresh?.();
            fidelitySyncFields(session);fidelityCommit(session);
        }
        close();
    };
    dialog.showModal();render();dialog.querySelector('[data-pf-view-preset="original"]')?.focus();
}
function fidelityStatus(session,message){const el=session.root.querySelector('[data-pf-status]');if(el)el.textContent=message;}
function fidelitySyncToolUi(session){
    const root=session.root,tool=session.tool||'mask',roi=tool==='roi',rect=tool==='rect';
    root.querySelector('.pf-brush').hidden=roi||rect;
    root.querySelector('[data-pf-roi-hint]').hidden=!roi&&!rect;
    root.querySelector('[data-pf-roi-hint]').textContent=roi?'在图上拖出重点细节框':'在图上拖出商品保护区';
    root.querySelector('[data-pf-action="clear-mask"]').hidden=roi;
    root.querySelector('[data-pf-action="clear-rois"]').hidden=!roi;
    root.querySelector('[data-pf-roi-info]').textContent=roi?'框选需要额外保留的细节'+(session.node.fidelityConfig.rois.length?'（已圈 '+session.node.fidelityConfig.rois.length+' 处）':''):rect?'框内背景也会被保留，可用橡皮擦修整。':tool==='erase'?'擦掉不小心涂出商品边缘的灰色区域。':'涂成灰色的商品区域将被标记为保留区，背景留空。';
}
function fidelitySyncAssetSummary(session){
    const count=session.root.querySelector('[data-pf-assets]').childElementCount;
    session.root.querySelector('[data-pf-asset-count]').textContent=count+' 张';
    session.root.querySelector('[data-pf-assets-empty]').hidden=count>0;
    session.root.querySelector('.pf-asset-panel').hidden=count===0||session.uiMode==='simple';
}
function fidelitySelectUiMode(session,id,focus=false){
    const content=session.root.querySelector('.pf-settings-content');
    session.uiScroll||={};
    if(session.uiMode)session.uiScroll[session.uiMode]=content.scrollTop;
    session.uiMode=id;
    session.root.querySelectorAll('[data-pf-ui-panel]').forEach(panel=>panel.hidden=panel.dataset.pfUiPanel!==id);
    session.root.querySelectorAll('[data-pf-ui-mode]').forEach(button=>{
        const active=button.dataset.pfUiMode===id;
        button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
        if(active&&focus)button.focus();
    });
    content.scrollTop=session.uiScroll[id]||0;
    fidelitySyncAssetSummary(session);
}
function fidelitySyncSimple(session){
    const root=session.root,config=session.node.fidelityConfig,d=config.dimensions;
    root.querySelectorAll('[data-pf-preset]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pfPreset===config.mode)));
    const modeCopy={
        strict:'已选：仅换背景',structure:'已选：光影融合',view:'已选：换拍摄角度'
    }[config.mode]||'';
    root.querySelector('[data-pf-mode-title]').textContent=modeCopy;
    const viewChanged=config.view.enabled&&(['yaw','pitch','roll'].some(key=>Number(config.view[key])!==0)||config.view.framing!=='medium'||Number(config.view.fov)!==50);
    const next=root.querySelector('[data-pf-mode-next]');
    next.hidden=config.mode!=='view';
    next.textContent=viewChanged?'目标机位已设置，生成时将按该角度重绘。':'要换机位，请先设置拍摄角度。';
    root.querySelector('[data-pf-mode-view]').hidden=config.mode!=='view';
    root.querySelector('[data-pf-simple-view-summary]').textContent=viewChanged?fidelityViewSummary(config.view):'当前：原图角度（0°）';
    root.querySelector('[data-pf-simple-detail]').checked=config.detail.enabled;
    root.querySelector('[data-pf-simple-dimensions]').checked=d.enabled;
    root.querySelector('[data-pf-simple-dimensions-content]').hidden=!d.enabled;
    root.querySelector('[data-pf-custom-warning]').hidden=!session.customized;
    root.querySelectorAll('[data-pf-simple-dimension]').forEach(input=>{
        const key=input.dataset.pfSimpleDimension;
        input.value=key==='unit'?d.unit:d[key]===null||!Number.isFinite(d[key])?'':Number(XiaomeiPhysicalDimensions.convertFromMillimeters(d[key],d.unit).toPrecision(12));
    });
    const errors=d.enabled?XiaomeiPhysicalDimensions.validatePhysicalDimensions(d).errors:[];
    root.querySelector('[data-pf-simple-dimension-error]').textContent=errors.join('；');
    const note=root.querySelector('[data-pf-simple-note]');
    note.textContent=fidelityConfigurationWarning(config,fidelityEffectiveConfig(config));
    note.hidden=!note.textContent;
}
async function fidelityApplyFieldChange(session,key,value,{preset=false}={}){
    const config=session.node.fidelityConfig,proposed=cloneSmartSettings(config);
    fidelitySetValue(proposed,key,value);
    if(key==='mode'){
        fidelityChangeMode(proposed,proposed.mode);
        if(proposed.dimensions.enabled){
            if(proposed.mode==='strict')proposed.dimensions.constraintMode='protect';
            else if(proposed.dimensions.constraintMode==='protect')proposed.dimensions.constraintMode='prompt';
        }
    }
    if(key==='view.enabled'&&value)fidelityChangeMode(proposed,'view');
    if(key==='view.enabled'&&!value&&proposed.mode==='view')fidelityChangeMode(proposed,'structure');
    if(key==='structure.enabled'&&!value&&proposed.mode==='strict'&&!(proposed.dimensions.enabled&&proposed.dimensions.constraintMode==='protect'))fidelityChangeMode(proposed,'structure');
    if(key==='productReferenceId'){proposed.rois=[];proposed.maskStrokes=[];delete proposed.maskUrl;}
    if(JSON.stringify(config)===JSON.stringify(proposed)){fidelitySyncFields(session);return false;}
    const linked=fidelityLinkedChangeMessage(config,proposed,key);
    const warning=(preset&&session.customized?'当前含微调参数，将应用所选出图方式。':'')+linked;
    if(warning&&!(await fidelityConfirmReplacement(warning))){fidelitySyncFields(session);session.root.querySelector('[data-pd-root]')?.pdRefresh?.();return false;}
    if(!session.root.isConnected||!fidelityCanEdit(session.node))return false;
    pushUndo();fidelityAssignConfig(config,proposed);
    if(session.uiMode==='all'&&key!=='mode'&&key!=='productReferenceId')session.customized=true;
    fidelitySyncFields(session);
    session.root.querySelector('[data-pd-root]')?.pdRefresh?.();
    if(key==='productReferenceId')void fidelityLoadEditor(session);
    fidelityCommit(session);
    return true;
}
function fidelityCommit(session,withRender=false,skipEditor=false){
    session.controller?.abort();session.detectedRois=[];delete session.node.fidelityPreview;
    fidelityStatus(session,'保护设置已更新，可生成参考图');
    session.root.querySelector('[data-pf-assets]')?.replaceChildren();scheduleSave();
    fidelitySyncAssetSummary(session);
    session.node.fidelityConfig.dimensions.guideAssetId=null;
    fidelityRenderResults(session);
    if(withRender)render({nodeIds:[session.node.id]});
    else {fidelitySyncAvailability(session);if(!skipEditor){session.draw?.();fidelityRenderRois(session);}}
}
function fidelitySyncFields(session){
    session.root.querySelectorAll('[data-pf-field]').forEach(el=>{
        const value=fidelityGetValue(session.node.fidelityConfig,el.dataset.pfField);
        if(el.type==='checkbox')el.checked=Boolean(value);else el.value=value??'';
    });
    fidelitySyncSimple(session);
}
function fidelitySyncAvailability(session){
    const config=session.node.fidelityConfig,field=key=>session.root.querySelector('[data-pf-field="'+key+'"]');
    const effective=fidelityEffectiveConfig(config);
    session.root.querySelectorAll('[data-pf-field]').forEach(el=>el.disabled=false);
    session.root.querySelectorAll('[data-pd-field]').forEach(el=>el.disabled=el.dataset.pdField==='height'&&config.dimensions.shape==='circle');
    session.root.querySelector('[data-pf-custom="categoryCustom"]').hidden=config.category!=='other';
    session.root.querySelector('[data-pf-custom="geometryCustom"]').hidden=config.geometry!=='custom';
    const enabled=config.detail.enabled,usesHigh=enabled&&['highpass','combined'].includes(config.detail.inputMode),usesCrops=enabled&&['crops','combined'].includes(config.detail.inputMode);
    for(const key of ['detail.highPassRadiusPx','detail.highPassGain'])field(key).disabled=!usesHigh;
    for(const key of ['detail.autoCrops','detail.cropCount'])field(key).disabled=!usesCrops;
    field('detail.inputMode').disabled=!enabled;
    const restore=effective.mode==='structure'&&enabled;
    field('detail.restoreMode').disabled=!restore;
    field('detail.restoreStrength').disabled=!restore||config.detail.restoreMode!=='auto';
    session.root.querySelector('[data-pf-restore-note]').textContent=config.mode==='strict'?'原产品像素直接合成，纹理随原图保留。':config.mode==='view'?'换角度时不回填旧视角纹理，避免重影。':'需要黑白保护图和可靠同视角对齐；形状异常或匹配不足时自动跳过。';
    const viewRef=session.refs.find(ref=>config.referenceIds[ref.url]===config.productReferenceId);
    const viewThumb=session.root.querySelector('.pf-view-thumb');
    if(viewThumb)viewThumb.innerHTML=viewRef?'<img src="'+escapeAttr(viewRef.url)+'" alt="当前产品主图">':'<span>暂无主图</span>';
    session.root.querySelector('[data-pf-view-summary]').textContent=config.view.enabled?fidelityViewSummary(config.view):'保持原图角度';
    for(const option of field('generation.allowedEdits').options)option.disabled=effective.mode==='strict'?option.value!=='background':effective.mode==='structure'&&option.value==='view';
    session.root.querySelector('[data-pf-strategy]').textContent=config.mode==='strict'?'仅换背景会保留已标记商品区域的原图像素；请检查保护区是否完整。':config.mode==='view'?'使用商品与视角参考生成；未拍摄到的侧面和背面由 AI 推测。':'结合原图与细节参考生成；只有对齐可靠时才尝试恢复原图纹理。';
    session.root.querySelectorAll('[data-pf-action="preview"],[data-pf-action="auto-crops"]').forEach(el=>el.disabled=!config.enabled||(!session.refs.length&&!config.dimensions.enabled)||Boolean(session.busy));
    session.root.querySelectorAll('[data-pf-module]').forEach(module=>{
        const key=module.dataset.pfModule,off=!config[key].enabled;module.dataset.pfDisabled=String(off);
        module.querySelectorAll('input,select,button').forEach(el=>{
            if(el.closest('[data-pf-module]')!==module||el.dataset.pfField===key+'.enabled'||el.dataset.pfField==='productReferenceId'||el.hasAttribute('data-pf-mask-select'))return;
            if(off)el.disabled=true;
            else if(!el.dataset.pfField&&!el.dataset.pdField)el.disabled=Boolean(session.busy);
        });
    });
    field('validation.ratioTolerancePct').disabled=!config.validation.enabled;
    const dimensionErrors=config.dimensions.enabled?XiaomeiPhysicalDimensions.validatePhysicalDimensions(config.dimensions).errors:[];
    const validationStatus=session.root.querySelector('[data-pf-validation-status]');
    const conflict=fidelityConfigurationWarning(config,effective);
    validationStatus.hidden=!dimensionErrors.length&&!conflict;
    validationStatus.textContent=[dimensionErrors.length?'产品尺寸需要修改：'+dimensionErrors.join('；')+'。':'',conflict].filter(Boolean).join(' ');
    session.root.querySelector('[data-pf-action="preview"]').disabled||=dimensionErrors.length>0;
    session.root.querySelector('[data-pf-action="preview"]').textContent=session.busy?'正在生成参考图…':'生成保护参考图';
    session.root.querySelectorAll('[data-pf-view-open],[data-pf-simple-view-open]').forEach(button=>button.disabled=!config.view.enabled||!viewRef||Boolean(session.busy));
    session.root.querySelectorAll('[data-pf-preset],[data-pf-simple-detail],[data-pf-simple-dimensions],[data-pf-simple-dimension]').forEach(el=>el.disabled=Boolean(session.busy));
    fidelitySyncSimple(session);
    if(sharedCanvasReadOnly)session.root.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
}
function fidelityAdoptDetectedRois(session){
    const config=session.node.fidelityConfig;
    if(session.detectedRois?.length){
        config.rois.push(...session.detectedRois.slice(0,3-config.rois.length).map(({x,y,w,h})=>({x,y,w,h})));
        session.detectedRois=[];
    }
    config.detail.autoCrops=false;
    config.detail.enabled=true;
    config.detail.cropCount=Math.max(config.detail.cropCount,config.rois.length,1);
    if(!['crops','combined'].includes(config.detail.inputMode))config.detail.inputMode='combined';
}
function fidelityRenderRois(session){
    const list=session.root.querySelector('[data-pf-rois]');list.replaceChildren();
    const config=session.node.fidelityConfig;
    const source=session.roiSourceImage;
    if(!source){fidelitySyncToolUi(session);return;}
    [...config.rois.map((roi,index)=>({roi,index,auto:false})),...(session.detectedRois||[]).map((roi,index)=>({roi,index,auto:true}))].forEach(({roi,index,auto})=>{
        const item=document.createElement('button'),thumb=document.createElement('canvas'),caption=document.createElement('span');
        const position=auto?config.rois.length+index:index;
        item.type='button';item.className='pf-roi-preview';item.dataset.pfRoiPreview=String(position);
        item.setAttribute('aria-pressed',String(session.selectedRoi===position));
        item.setAttribute('aria-label',(auto?'自动找到的候选区域 ':'已圈的细节区域 ')+(index+1)+'，点击后在画布调整，按 Delete 删除');
        item.disabled=!fidelityCanEdit(session.node);
        thumb.width=160;thumb.height=104;thumb.setAttribute('aria-hidden','true');
        const sx=Math.max(0,roi.x*source.naturalWidth),sy=Math.max(0,roi.y*source.naturalHeight);
        const sw=Math.max(1,Math.min(source.naturalWidth-sx,roi.w*source.naturalWidth));
        const sh=Math.max(1,Math.min(source.naturalHeight-sy,roi.h*source.naturalHeight));
        const scale=Math.min(thumb.width/sw,thumb.height/sh),dw=sw*scale,dh=sh*scale;
        thumb.getContext('2d').drawImage(source,sx,sy,sw,sh,(thumb.width-dw)/2,(thumb.height-dh)/2,dw,dh);
        caption.textContent=(auto?'候选 ':'细节 ')+(index+1);
        item.append(thumb,caption);
        item.onclick=()=>{
            if(!fidelityCanEdit(session.node))return;
            if(auto){pushUndo();fidelityAdoptDetectedRois(session);fidelitySyncFields(session);}
            session.selectedRoi=position;session.replaceRoiIndex=null;session.setTool?.('roi');
            if(auto)fidelityCommit(session);else{session.draw?.();fidelityRenderRois(session);}
            session.root.querySelector('[data-pf-canvas]')?.focus({preventScroll:true});
        };
        list.append(item);
    });
    fidelitySyncToolUi(session);
}
async function fidelityLoadEditor(session){
    const node=session.node,config=node.fidelityConfig,root=session.root;
    const ref=session.refs.find(r=>config.referenceIds[r.url]===config.productReferenceId);
    const sourceSelect=root.querySelector('[data-pf-field="productReferenceId"]'),sourceName=root.querySelector('[data-pf-source-name]'),sourceThumb=root.querySelector('[data-pf-source-thumb]');
    const choices=[...(!ref?[[config.productReferenceId||'',session.refs.length?'请重新选择产品主图':'请先连接产品图片']]:[]),...session.refs.map((item,index)=>[config.referenceIds[item.url],fidelityReferenceLabel(item,index)])];
    sourceSelect.innerHTML=choices.map(([value,label])=>'<option value="'+escapeAttr(value)+'" '+(config.productReferenceId===value?'selected':'')+'>'+escapeHtml(label)+'</option>').join('');
    const label=ref?fidelityReferenceLabel(ref,session.refs.indexOf(ref)):'';
    sourceSelect.title=label;sourceName.textContent=label;sourceName.title=label;
    root.querySelector('[data-pf-source-select]').hidden=Boolean(ref)&&session.refs.length===1;
    sourceName.hidden=!ref||session.refs.length!==1;sourceThumb.hidden=!ref;
    if(ref)sourceThumb.src=ref.url;else sourceThumb.removeAttribute('src');
    root.querySelector('[data-pf-source-info]').textContent=ref?'正在读取图片尺寸…':'请先选择商品原图';
    const canvasEl=root.querySelector('[data-pf-canvas]'),empty=root.querySelector('[data-pf-empty]');
    empty.hidden=Boolean(ref);canvasEl.hidden=!ref;
    if(!ref){session.draw=null;session.roiSourceImage=null;session.syncBrushSize?.();fidelityRenderRois(session);empty.textContent=session.refs.length?'原产品图已移除，请在上方重新选择要保护的图片':'将商品图片连接到此节点，随后在图上标出需要保护的区域';fidelityStatus(session,empty.textContent);return;}
    session.roiSourceImage=null;fidelityRenderRois(session);
    const seq=session.editorSeq=(session.editorSeq||0)+1;
    const image=new Image();image.src=ref.url;
    try{await image.decode();}catch{fidelityStatus(session,'产品图片无法读取，请重新导入');return;}
    if(!root.isConnected||seq!==session.editorSeq)return;
    session.roiSourceImage=image;
    session.syncBrushSize?.();
    canvasEl.width=Math.min(1400,image.naturalWidth);canvasEl.height=Math.round(canvasEl.width*image.naturalHeight/image.naturalWidth);
    session.resizeCanvas=()=>{
        canvasEl.style.width='';canvasEl.style.height='';
        const stage=canvasEl.parentElement,scale=Math.min((stage.clientWidth-16)/canvasEl.width,(stage.clientHeight-16)/canvasEl.height);
        if(scale>0){canvasEl.style.width=Math.round(canvasEl.width*scale)+'px';canvasEl.style.height=Math.round(canvasEl.height*scale)+'px';}
    };
    session.editorObserver?.disconnect();
    session.editorObserver=new ResizeObserver(()=>session.resizeCanvas?.());
    session.editorObserver.observe(canvasEl.parentElement);
    const context=canvasEl.getContext('2d'),maskImage=config.maskUrl?new Image():null;
    if(maskImage){maskImage.src=config.maskUrl;try{await maskImage.decode();}catch{fidelityStatus(session,'黑白保护图无法读取，请重新上传');}}
    if(!root.isConnected||seq!==session.editorSeq)return;
    let tool=session.tool||'mask',start=null,stroke=null,roiDrag=null;
    const drawRoi=(r,index,auto=false,selected=false)=>{
        const ratio=canvasEl.width/(canvasEl.getBoundingClientRect().width||canvasEl.width),color=auto?'#00baff':'#ff9d00';
        const x=r.x*canvasEl.width,y=r.y*canvasEl.height,w=r.w*canvasEl.width,h=r.h*canvasEl.height;
        context.save();context.setLineDash([]);context.strokeStyle='#111';context.lineWidth=7*ratio;context.strokeRect(x,y,w,h);
        context.strokeStyle='#fff';context.lineWidth=5*ratio;context.strokeRect(x,y,w,h);
        context.strokeStyle=color;context.lineWidth=3*ratio;if(auto)context.setLineDash([8*ratio,5*ratio]);context.strokeRect(x,y,w,h);context.setLineDash([]);
        const label=(auto?'自动 ':'手动 ')+(index+1);context.font='bold '+12*ratio+'px sans-serif';
        const labelW=context.measureText(label).width+12*ratio,labelY=Math.max(0,y-22*ratio);
        context.fillStyle='#111';context.fillRect(x,labelY,labelW,22*ratio);context.fillStyle=color;context.fillText(label,x+6*ratio,labelY+16*ratio);
        if(selected)for(const [hx,hy] of [[x,y],[x+w,y],[x,y+h],[x+w,y+h]]){
            context.fillStyle='#fff';context.fillRect(hx-5*ratio,hy-5*ratio,10*ratio,10*ratio);
            context.strokeStyle=color;context.lineWidth=2*ratio;context.strokeRect(hx-5*ratio,hy-5*ratio,10*ratio,10*ratio);
        }
        context.restore();
    };
    session.draw=()=>{
        context.clearRect(0,0,canvasEl.width,canvasEl.height);context.drawImage(image,0,0,canvasEl.width,canvasEl.height);
        const layer=document.createElement('canvas');layer.width=canvasEl.width;layer.height=canvasEl.height;const overlay=layer.getContext('2d');
        if(maskImage?.naturalWidth){
            overlay.drawImage(maskImage,0,0,layer.width,layer.height);
            const pixels=overlay.getImageData(0,0,layer.width,layer.height);
            for(let i=0;i<pixels.data.length;i+=4){const alpha=pixels.data[i];pixels.data[i]=128;pixels.data[i+1]=128;pixels.data[i+2]=128;pixels.data[i+3]=alpha;}
            overlay.putImageData(pixels,0,0);
        }else if(!config.maskStrokes.length){
            overlay.drawImage(image,0,0,layer.width,layer.height);
            const pixels=overlay.getImageData(0,0,layer.width,layer.height);
            let transparent=false;for(let i=3;i<pixels.data.length;i+=4)if(pixels.data[i]<255){transparent=true;break;}
            if(transparent){
                for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=128;pixels.data[i+1]=128;pixels.data[i+2]=128;}
                overlay.putImageData(pixels,0,0);
            }else overlay.clearRect(0,0,layer.width,layer.height);
        }
        for(const s of config.maskStrokes){
            if(s.rect){
                overlay.globalCompositeOperation=s.erase?'destination-out':'source-over';overlay.fillStyle='#808080';
                overlay.fillRect(s.rect[0]*layer.width,s.rect[1]*layer.height,s.rect[2]*layer.width,s.rect[3]*layer.height);
                continue;
            }
            overlay.globalCompositeOperation=s.erase?'destination-out':'source-over';overlay.strokeStyle='#808080';overlay.fillStyle='#808080';overlay.lineWidth=s.width*Math.min(layer.width,layer.height);overlay.lineCap='round';overlay.lineJoin='round';
            overlay.beginPath();s.points.forEach((p,i)=>i?overlay.lineTo(p[0]*layer.width,p[1]*layer.height):overlay.moveTo(p[0]*layer.width,p[1]*layer.height));overlay.stroke();
            if(s.points[0]){overlay.beginPath();overlay.arc(s.points[0][0]*layer.width,s.points[0][1]*layer.height,overlay.lineWidth/2,0,Math.PI*2);overlay.fill();}
        }
        context.globalAlpha=.48;context.drawImage(layer,0,0);context.globalAlpha=1;
        config.rois.forEach((r,index)=>drawRoi(r,index,false,session.selectedRoi===index));
        (session.detectedRois||[]).forEach((r,index)=>drawRoi(r,index,true,session.selectedRoi===config.rois.length+index));
        root.querySelector('[data-pf-source-info]').textContent=image.naturalWidth+' × '+image.naturalHeight+' · 原图';
        fidelitySyncToolUi(session);
    };
    const point=event=>{const r=canvasEl.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
    session.setTool=value=>{tool=value;session.tool=value;root.querySelectorAll('[data-pf-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pfTool===value)));fidelitySyncToolUi(session);};
    root.querySelectorAll('[data-pf-tool]').forEach(b=>b.onclick=()=>session.setTool(b.dataset.pfTool));
    session.setTool(tool);
    canvasEl.onpointerdown=event=>{
        if(!fidelityCanEdit(node))return;event.preventDefault();event.stopPropagation();
        canvasEl.focus({preventScroll:true});
        if(tool!=='roi'&&config.maskUrl){fidelityStatus(session,'修改已有黑白保护图，请先清空保护区，再重新标记');return;}
        const p=point(event);
        let hit=null;
        if(tool==='roi'&&session.replaceRoiIndex==null){
            const rect=canvasEl.getBoundingClientRect(),tx=12/rect.width,ty=12/rect.height;
            [...config.rois,...session.detectedRois||[]].forEach((r,index)=>{
                for(const corner of ['tl','tr','bl','br']){
                    const cx=corner.endsWith('r')?r.x+r.w:r.x,cy=corner.startsWith('b')?r.y+r.h:r.y;
                    if(Math.abs(p[0]-cx)<tx&&Math.abs(p[1]-cy)<ty)hit={index,corner};
                }
                if(!hit&&p[0]>=r.x&&p[0]<=r.x+r.w&&p[1]>=r.y&&p[1]<=r.y+r.h)hit={index,corner:null};
            });
        }
        if(tool==='roi'&&!hit&&session.replaceRoiIndex==null&&config.rois.length+(session.detectedRois?.length||0)>=3){fidelityStatus(session,'已圈 3 处；选中不需要的框，按 Delete 删除后再圈选');return;}
        pushUndo();
        canvasEl.setPointerCapture(event.pointerId);start=p;
        if(tool==='roi'){
            fidelityAdoptDetectedRois(session);
            if(hit){session.selectedRoi=hit.index;roiDrag={...hit,original:{...config.rois[hit.index]}};}
            fidelitySyncFields(session);
        }
        if(tool==='mask'||tool==='erase'){
            stroke={points:[start],erase:tool==='erase',width:Number(root.querySelector('[data-pf-brush]').value)/100};
            config.maskStrokes.push(stroke);
        }
        session.draw();
    };
    canvasEl.onpointermove=event=>{
        if(!start)return;const p=point(event);
        if(stroke){if(stroke.points.length<2000)stroke.points.push(p);session.draw();}
        else if(roiDrag){
            const r=roiDrag.original;
            if(!roiDrag.corner)config.rois[roiDrag.index]={...r,x:Math.max(0,Math.min(1-r.w,r.x+p[0]-start[0])),y:Math.max(0,Math.min(1-r.h,r.y+p[1]-start[1]))};
            else{
            const x=roiDrag.corner.endsWith('r')?r.x:r.x+r.w,y=roiDrag.corner.startsWith('b')?r.y:r.y+r.h;
            const px=Math.abs(x-p[0])<.005?(x<.5?Math.min(1,x+.005):Math.max(0,x-.005)):p[0];
            const py=Math.abs(y-p[1])<.005?(y<.5?Math.min(1,y+.005):Math.max(0,y-.005)):p[1];
            config.rois[roiDrag.index]={x:Math.min(x,px),y:Math.min(y,py),w:Math.abs(x-px),h:Math.abs(y-py)};
            }session.draw();
        }else{
            session.draw();
            const r={x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),w:Math.abs(start[0]-p[0]),h:Math.abs(start[1]-p[1])};
            if(tool==='rect'){context.save();context.fillStyle='rgba(128,128,128,.48)';context.fillRect(r.x*canvasEl.width,r.y*canvasEl.height,r.w*canvasEl.width,r.h*canvasEl.height);context.restore();}
            else drawRoi(r,session.replaceRoiIndex??config.rois.length,false,true);
        }
    };
    canvasEl.onpointerup=event=>{
        if(!start)return;const p=point(event);
        if(tool==='roi'&&!roiDrag){
            if(Math.abs(start[0]-p[0])>.003&&Math.abs(start[1]-p[1])>.003){
                const r={x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),w:Math.abs(start[0]-p[0]),h:Math.abs(start[1]-p[1])};
                if(session.replaceRoiIndex!=null){config.rois[session.replaceRoiIndex]=r;session.selectedRoi=session.replaceRoiIndex;}
                else{config.rois.push(r);session.selectedRoi=config.rois.length-1;}
                config.detail.cropCount=Math.max(config.detail.cropCount,config.rois.length);
            }
        }
        if(tool==='rect'&&Math.abs(start[0]-p[0])>.003&&Math.abs(start[1]-p[1])>.003)
            config.maskStrokes.push({rect:[Math.min(start[0],p[0]),Math.min(start[1],p[1]),Math.abs(start[0]-p[0]),Math.abs(start[1]-p[1])]});
        canvasEl.releasePointerCapture?.(event.pointerId);start=null;stroke=null;roiDrag=null;session.replaceRoiIndex=null;fidelityCommit(session);
        if(session.selectedRoi!=null)root.querySelector('[data-pf-roi-preview="'+session.selectedRoi+'"]')?.scrollIntoView({block:'end'});
    };
    canvasEl.onpointercancel=()=>{start=null;stroke=null;fidelityCommit(session);};
    canvasEl.onkeydown=event=>{
        if(tool!=='roi'||!['Delete','Backspace'].includes(event.key)||session.selectedRoi==null||!fidelityCanEdit(node))return;
        event.preventDefault();event.stopPropagation();
        if(session.selectedRoi>=config.rois.length)return;
        pushUndo();config.rois.splice(session.selectedRoi,1);session.selectedRoi=null;session.replaceRoiIndex=null;
        fidelitySyncFields(session);fidelityCommit(session);
    };
    session.resizeCanvas();session.draw();fidelityRenderRois(session);
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
        const geometryAsset=(preview.generatedAssets||[]).find(a=>a.role==='geometry_reference');
        if(geometryAsset)config.dimensions.guideAssetId=geometryAsset.reference_id;
        session.node.fidelityPreview.signature=fidelitySignature(session.node);
        session.detectedRois=preview.detectedRois||[];session.draw?.();fidelityRenderRois(session);
        if(session.detectedRois.length)session.root.querySelector('[data-pf-roi-preview]')?.scrollIntoView({block:'end'});
        const list=session.root.querySelector('[data-pf-assets]');
        list.innerHTML=(preview.generatedAssets||[]).filter(a=>a.role!=='product-mask').map(a=>fidelityAssetHtml(a,fidelityAssetLabel(a))).join('');
        fidelitySyncAssetSummary(session);
        session.root.querySelector('.pf-asset-panel').open=list.childElementCount>0;
        const note='保护参考图已更新';
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
        const snapshot=result.dimensions||paint.runSettings.productFidelity.dimensions;
        if(snapshot?.version===2&&XiaomeiPhysicalDimensions.signature(snapshot)!==XiaomeiPhysicalDimensions.signature(session.node.fidelityConfig.dimensions))return;
        found=true;const block=document.createElement('div'),title=document.createElement('strong'),text=document.createElement('p');
        const status=result.validationStatus==='passed'&&paint.runSettings?.productFidelity?.mode==='strict'?'原产品核心像素已保留':labels[result.validationStatus]||'无法判断';
        title.textContent=(paint.title||'绘画')+' · 上次生成 · '+status;
        text.textContent=(result.validations||[]).map(v=>v.reason||v.scope||'').concat(result.warnings||[]).join('\n');
        const geometry=result.validations?.[0]?.physicalGeometry;
        if(geometry)text.textContent+='\n正面比例：'+({pass:'通过相对比例检查',warning:'比例需要复核',fail:'比例偏差超限',unknown:'无法验证'}[geometry.status]||'无法验证')+'；'+geometry.reason+(geometry.relativeErrorPct!==undefined?'；相对误差 '+geometry.relativeErrorPct.toFixed(2)+'%':'')+'\n'+geometry.thicknessReason;
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
    route.hidden=!targets.length;
    route.textContent=targets.length?'已连接 '+targets.length+' 个绘画（AI 生图）节点 · '+session.refs.length+' 张商品原图':'将本节点连线至「AI生图」节点即可开始出图';
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
        route.textContent=messages.join(' · ')||'将本节点连线至「AI生图」节点即可开始出图';
    }
}
function bindProductFidelityNode(el,node){
    const root=el.querySelector('[data-pf-root]');if(!root)return;
    const refs=fidelityEnsureReferences(node),key=JSON.stringify(refs.map(r=>r.url));
    const old=productFidelitySessions.get(node.id);
    if(old?.root===root&&old.node===node){
        if(old.refsKey!==key){old.refs=refs;old.refsKey=key;old.controller?.abort();fidelityStatus(old,'商品图片已更改，请重新生成保护参考图');void fidelityLoadEditor(old);}
        fidelityRenderResults(old);void fidelityInspectDownstream(old);return;
    }
    old?.controller?.abort();old?.capabilitiesController?.abort();old?.editorObserver?.disconnect();
    const preview=node.fidelityPreview?.signature===fidelitySignature(node)?node.fidelityPreview:null;
    const session={node,root,refs,refsKey:key,detectedRois:preview?.detectedRois||[],busy:false,uiScroll:{...old?.uiScroll},uiMode:old?.uiMode||'simple',customized:Boolean(old?.customized)||fidelityHasCustomSettings(node.fidelityConfig),tool:old?.tool,brushSize:old?.brushSize||4};
    productFidelitySessions.set(node.id,session);
    const brush=root.querySelector('[data-pf-brush]');
    brush.value=session.brushSize;
    session.syncBrushSize=()=>{
        session.brushSize=Number(brush.value);
        const image=session.roiSourceImage;
        root.querySelector('[data-pf-brush-size]').textContent=image?Math.round(Math.min(image.naturalWidth,image.naturalHeight)*session.brushSize/100)+' px':'—';
    };
    brush.oninput=session.syncBrushSize;session.syncBrushSize();
    const column=root.querySelector('.pf-settings-content');
    column.onscroll=()=>{session.uiScroll[session.uiMode]=column.scrollTop;};
    const oldDetails=old?.root.querySelectorAll('details');
    root.querySelectorAll('details').forEach((details,index)=>{if(oldDetails?.[index])details.open=oldDetails[index].open;});
    fidelitySelectUiMode(session,session.uiMode);
    for(const kind of ['pointerdown','mousedown','click','dblclick','wheel'])root.addEventListener(kind,event=>event.stopPropagation());
    const tabs=[...root.querySelectorAll('[data-pf-ui-mode]')];
    tabs.forEach((button,index)=>{
        button.onclick=()=>fidelitySelectUiMode(session,button.dataset.pfUiMode);
        button.onkeydown=event=>{
            const target=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
            if(target===null)return;event.preventDefault();fidelitySelectUiMode(session,tabs[target].dataset.pfUiMode,true);
        };
    });
    root.querySelectorAll('[data-pf-preset]').forEach(button=>button.onclick=()=>{
        if(fidelityCanEdit(node))void fidelityApplyFieldChange(session,'mode',button.dataset.pfPreset,{preset:true});
    });
    root.querySelector('[data-pf-simple-detail]').onchange=event=>{
        if(fidelityCanEdit(node))void fidelityApplyFieldChange(session,'detail.enabled',event.target.checked);
    };
    root.querySelector('[data-pf-simple-dimensions]').onchange=event=>{
        const field=root.querySelector('[data-pd-field="enabled"]');field.checked=event.target.checked;field.dispatchEvent(new Event('change',{bubbles:true}));
    };
    root.querySelectorAll('[data-pf-simple-dimension]').forEach(input=>{
        input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{
            const field=root.querySelector('[data-pd-field="'+input.dataset.pfSimpleDimension+'"]');
            field.value=input.value;field.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));
        });
    });
    root.querySelectorAll('[data-pf-history]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;
        if(button.dataset.pfHistory==='undo')performUndo();else performRedo();
    });
    root.querySelectorAll('[data-pf-field]').forEach(input=>input.onchange=()=>{
        if(!fidelityCanEdit(node))return;
        const value=input.type==='checkbox'?input.checked:input.type==='number'||input.type==='range'?Number(input.value):input.value;
        void fidelityApplyFieldChange(session,input.dataset.pfField,value);
    });
    bindPhysicalDimensionPanel(root.querySelector('[data-pd-root]'),node.fidelityConfig,()=>{
        if(session.uiMode==='all')session.customized=true;
        fidelitySyncFields(session);fidelityCommit(session,false,true);
    },()=>fidelityCanEdit(node),()=>session.refs.length,async(before,after,directKey)=>{
        const message=fidelityLinkedChangeMessage(before,after,directKey);
        const accepted=!message||await fidelityConfirmReplacement(message);
        if(!accepted)fidelitySyncSimple(session);
        return accepted;
    });
    root.querySelector('[data-pf-mask-select]').onchange=async event=>{
        if(!fidelityCanEdit(node))return;
        const url=event.target.value,previous=node.fidelityConfig.maskUrl||'';
        try{
            if(url){
                const mask=new Image();mask.src=url;await mask.decode();
                const ref=session.refs.find(r=>node.fidelityConfig.referenceIds[r.url]===node.fidelityConfig.productReferenceId);
                if(!ref)throw new Error('请先选择产品主图');
                const source=new Image();source.src=ref.url;await source.decode();
                if(mask.naturalWidth!==source.naturalWidth||mask.naturalHeight!==source.naturalHeight)throw new Error('黑白保护图与产品图尺寸不同，请从同一产品原图制作');
            }
            if(!root.isConnected)return;pushUndo();
            if(url)node.fidelityConfig.maskUrl=url;else delete node.fidelityConfig.maskUrl;
            node.fidelityConfig.maskStrokes=[];fidelityCommit(session);void fidelityLoadEditor(session);
        }catch(error){event.target.value=previous;fidelityStatus(session,error.message);}
    };
    const imageColumn=root.querySelector('.pf-image-column'),expand=root.querySelector('[data-pf-expand]');
    const syncExpanded=()=>{
        const open=imageColumn.matches(':popover-open');expand.textContent=open?'收起编辑':'放大编辑';expand.setAttribute('aria-expanded',String(open));
        if(!open)imageColumn.removeAttribute('popover');requestAnimationFrame(()=>{session.resizeCanvas?.();session.draw?.();});
    };
    expand.onclick=()=>{
        if(imageColumn.matches(':popover-open'))imageColumn.hidePopover();
        else{imageColumn.setAttribute('popover','auto');imageColumn.showPopover();}
        syncExpanded();
    };
    imageColumn.addEventListener('toggle',syncExpanded);
    root.querySelectorAll('[data-pf-view-open],[data-pf-simple-view-open]').forEach(button=>button.onclick=()=>openProductViewEditor(session));
    root.querySelectorAll('[data-pf-action]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;const action=button.dataset.pfAction,config=node.fidelityConfig;
        if(action==='preview'){void fidelityPreview(session);return;}
        pushUndo();
        if(action==='clear-mask'){config.maskStrokes=[];delete config.maskUrl;root.querySelector('[data-pf-mask-select]').value='';}
        if(action==='clear-rois'){config.rois=[];config.detail.autoCrops=false;}
        if(action==='auto-crops'){config.detail.enabled=true;config.detail.autoCrops=true;config.detail.cropCount=Math.max(1,config.detail.cropCount);if(!['crops','combined'].includes(config.detail.inputMode))config.detail.inputMode='crops';}
        if(action==='manual-rois'){
            session.detectedRois=[];config.detail.autoCrops=false;config.detail.enabled=true;
            session.selectedRoi=null;session.replaceRoiIndex=null;
            if(!['crops','combined'].includes(config.detail.inputMode))config.detail.inputMode='combined';
        }
        fidelitySyncFields(session);fidelityCommit(session);
        if(action==='manual-rois'){session.setTool?.('roi');fidelityStatus(session,'已舍弃自动候选；在左图拖动框选需要保留的细节');return;}
        void fidelityLoadEditor(session);
        if(action==='auto-crops')void fidelityPreview(session);
    });
    fidelitySyncAvailability(session);void fidelityLoadEditor(session);fidelityRenderResults(session);void fidelityInspectDownstream(session);
    for(const [id,s] of productFidelitySessions)if(!nodes.some(n=>n.id===id)||s.root!==root&&!s.root.isConnected){s.controller?.abort();s.capabilitiesController?.abort();s.editorObserver?.disconnect();productFidelitySessions.delete(id);}
}
function syncProductFidelityNodes(){
    for(const [id,session] of productFidelitySessions){
        if(!session.root.isConnected||!nodes.includes(session.node)){
            session.controller?.abort();session.capabilitiesController?.abort();session.editorObserver?.disconnect();productFidelitySessions.delete(id);continue;
        }
        fidelityRenderResults(session);void fidelityInspectDownstream(session);
    }
}
