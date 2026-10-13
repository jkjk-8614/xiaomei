/* Product fidelity is a local processing node. Models and paid generation belong to downstream paint nodes. */
const productFidelitySessions = new Map();
function physicalDimensionPanelHtml(d){
    const pd=XiaomeiPhysicalDimensions;
    const check=(key,label)=>'<label class="pf-check"><input type="checkbox" data-pd-field="'+key+'" '+(fidelityGetValue(d,key)?'checked':'')+'>'+label+'</label>';
    const number=(key,label)=>'<label class="pf-field"><span>'+label+'</span><span class="pf-number"><input type="number" min="0" step="any" data-pd-field="'+key+'" placeholder="未知" value="'+(d[key]===null?'':escapeAttr(Number(pd.convertFromMillimeters(d[key],d.unit).toPrecision(12))))+'"></span></label>';
    const select=(key,label,options)=>'<label class="pf-field"><span>'+label+'</span><select data-pd-field="'+key+'">'+options.map(([value,text])=>'<option value="'+value+'" '+(d[key]===value?'selected':'')+'>'+text+'</option>').join('')+'</select></label>';
    return '<div class="pf-dimensions" data-pd-root><h4>真实尺寸</h4>'+check('enabled','使用真实尺寸约束')+'<div data-pd-content '+(d.enabled?'':'hidden')+'>'+
        number('width','实际宽度')+number('height','实际高度')+number('depth','实际厚度')+
        select('unit','尺寸单位',[['mm','毫米 mm'],['cm','厘米 cm'],['m','米 m'],['in','英寸 in']])+
        select('shape','尺寸测量形状',[['rectangle','矩形平面'],['cuboid','长方体'],['circle','圆形平面（直径）']])+
        '<div class="pf-checks">'+check('aspectRatioLock','锁定长宽比例')+check('thicknessLock','保持厚度比例')+check('outlineLock','锁定外轮廓')+'</div>'+
        select('constraintMode','尺寸约束方式',[['prompt','尺寸提示词'],['guide','尺寸结构参考图'],['protect','保留产品原图']])+
        '<details class="pf-help-disclosure"><summary>尺寸怎么测量？</summary><p class="pf-help" data-pd-mode></p><p class="pf-help" data-pd-semantics></p><p class="pf-help">未知尺寸请留空。填写实际测量尺寸；图片像素与 DPI 不能推断实物尺寸。输出画幅单独设置。</p></details>'+
        '<p class="pf-dimension-ratio" data-pd-ratio aria-live="polite"></p><p class="pf-dimension-error" data-pd-error role="status"></p><canvas data-pd-preview aria-label="产品尺寸几何代理预览"></canvas>'+
        '<details class="pf-options"><summary>比例校验设置</summary>'+check('validationSettings.enabled','校验近正视矩形产品比例')+
        '<label class="pf-field"><span>相对比例误差提示</span><span class="pf-number"><input type="number" min=".1" max="20" step=".1" data-pd-field="validationSettings.tolerancePct" value="'+escapeAttr(d.validationSettings.tolerancePct)+'">%</span></label><p class="pf-help">比例校验检查相对误差；缺少侧视几何时无法验证厚度。</p></details><p class="pf-help" data-pd-result></p></div></div>';
}
function bindPhysicalDimensionPanel(root,config,onChange,canEdit,referenceCount){
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
        root.querySelector('[data-pd-mode]').textContent={prompt:'将尺寸要求加入提示词，模型可能忽略。',guide:'追加无文字几何参考图，引导产品比例，结果仍需复核。',protect:'通过透明图或保护蒙版合成原产品像素，保持原视角。像素保留不能证明真实厘米尺寸。'}[d.constraintMode]+(!referenceCount()?' 请连接产品参考图；原图保护还需要透明图或蒙版。':'');
        root.querySelector('[data-pd-semantics]').textContent=d.shape==='circle'?'圆形平面：宽、高均为同一正面直径；厚度沿垂直圆面的轴向。暂不表示圆柱高度。':'宽、高为产品正面两轴；厚度为前后轴向。厚度未知时不推测体积。';
        field('height').disabled=d.shape==='circle'||!canEdit();
        const preview=root.querySelector('[data-pd-preview]');
        preview.hidden=!d.enabled||!valid.valid||!d.width||!d.height;
        if(!preview.hidden)pd.GeometryGuideGenerator.draw(preview,d);
    };
    root.querySelectorAll('[data-pd-field]').forEach(input=>{
        input.addEventListener('focus',()=>{undoInput=null;});
        const change=()=>{
            if(!canEdit())return;
            if(undoInput!==input||input.type!=='number'){pushUndo();undoInput=input;}
            const key=input.dataset.pdField;
            if(['width','height','depth'].includes(key)){
                d[key]=input.value===''?(input.validity.badInput?NaN:null):pd.convertToMillimeters(input.value,d.unit);
            }else fidelitySetValue(d,key,input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value);
            if(d.shape==='circle')d.height=d.width;
            if(d.enabled){
                config.geometry={rectangle:'plane',cuboid:'box',circle:'circle'}[d.shape];
                if(d.constraintMode==='protect')fidelityChangeMode(config,'strict');
                else if(config.mode==='strict')fidelityChangeMode(config,'structure');
            }
            d.guideAssetId=null;
            root.querySelector('[data-pd-result]').textContent='尺寸设置已变化；上次校验报告失效，请重新生成。';
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
        dimensions:XiaomeiPhysicalDimensions.defaults(),view:{enabled:false,mode:'keep',yaw:0,pitch:0,roll:0,proxyEnabled:false},
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
    if(mode!=='view')config.view.enabled=false;
    if(mode==='view'){config.view.enabled=true;config.view.mode='target';config.detail.restoreMode='off';}
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
    if(c.view?.enabled===false){c.view={...c.view,mode:'keep',yaw:0,pitch:0,roll:0,proxyEnabled:false};if(c.mode==='view')c.mode='structure';}
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
    if(url&&!choices.some(r=>r.url===url))choices.unshift({url,label:'已选保护蒙版'});
    return '<label class="pf-field"><span>画布保护蒙版</span><select data-pf-mask-select><option value="">不用已有蒙版 · 在左图涂画</option>'+choices.map(r=>'<option value="'+escapeAttr(r.url)+'" '+(url===r.url?'selected':'')+'>'+escapeHtml((r.role==='product-mask'?'蒙版 · ':'')+r.label)+'</option>').join('')+'</select></label>';
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
    if(sources.length>1)throw new Error('当前绘画连接了多个启用的产品保真节点，请只保留一个保护来源');
    const effective=productFidelitySettingsForNode(node,runSettings);
    if(effective.productFidelity)runSettings.productFidelity=effective.productFidelity;
    else if(runSettings.productFidelity?.sourceNodeId)delete runSettings.productFidelity;
    if(!runSettings.productFidelity?.enabled)return;
    const dimensions=XiaomeiPhysicalDimensions.migrate(runSettings.productFidelity.dimensions||{},runSettings.productFidelity.geometry);
    const valid=XiaomeiPhysicalDimensions.validatePhysicalDimensions(dimensions);
    if(!valid.valid)throw new Error(valid.errors.join('；'));
    if(runSettings.engine!=='api'||runSettings.apiKind==='video'||runSettings.imageOperation==='upscale')
        throw new Error('产品保真需要普通 API 图片模型；请选择图片模型或关闭上游产品保真');
    if(node?.outpaintSize||runSettings.outpaintMode)throw new Error('产品保真不能与扩图同时运行，请分别处理');
    if(fidelityEffectiveConfig(runSettings.productFidelity).mode==='strict'&&upstreamCameraNodesFor(node).length)
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
function fidelityAssetLabel(asset){return asset.role==='geometry_reference'?'尺寸结构代理图':asset.role==='highpass'?'纹理细节图':asset.role==='perspective-proxy'?'目标角度示意':'局部细节图';}
function fidelityReferenceLabel(ref,index){
    const name=ref.name||'';
    return !name||/^(?:\d{13,}|[a-f\d]{24,}|[a-f\d-]{36})(?:\.[a-z\d]+)?$/i.test(name)?'产品图 '+(index+1):name;
}
function productFidelityNodeBodyHtml(node){
    const refs=fidelityEnsureReferences(node),config=node.fidelityConfig;
    const check=(key,label)=>'<label class="pf-check"><input type="checkbox" data-pf-field="'+key+'" '+(fidelityGetValue(config,key)?'checked':'')+'><span>'+label+'</span></label>';
    const select=(key,label,choices)=>'<label class="pf-field"><span>'+label+'</span><select data-pf-field="'+key+'">'+choices.map(([v,t])=>'<option value="'+escapeAttr(v)+'" '+(fidelityGetValue(config,key)===v?'selected':'')+'>'+escapeHtml(t)+'</option>').join('')+'</select></label>';
    const number=(key,label,min,max,step,unit='')=>'<label class="pf-field"><span>'+label+'</span><span class="pf-number"><input type="number" min="'+min+'" max="'+max+'" step="'+step+'" data-pf-field="'+key+'" value="'+Number(fidelityGetValue(config,key)||0)+'">'+unit+'</span></label>';
    const custom=(key,label,placeholder,visible)=>'<label class="pf-field" data-pf-custom="'+key+'" '+(visible?'':'hidden')+'><span>'+label+'</span><input type="text" maxlength="120" data-pf-field="'+key+'" value="'+escapeAttr(fidelityGetValue(config,key)||'')+'" placeholder="'+escapeAttr(placeholder)+'"></label>';
    const help=(label,content)=>'<details class="pf-help-disclosure"><summary>'+label+'</summary>'+content+'</details>';
    const section=(id,key,title,label,content)=>'<section class="pf-section" data-pf-section="'+id+'" data-pf-module="'+key+'"><div class="pf-section-heading"><h3>'+title+'</h3>'+check(key+'.enabled',label)+'</div>'+content+'</section>';
    const previous=node.fidelityPreview,fresh=previous?.signature===fidelitySignature(node);
    const current=refs.find(ref=>config.referenceIds[ref.url]===config.productReferenceId);
    const assets=fresh?previous.generatedAssets||[]:[];
    const tabs=[['common','常用设置'],['detail','细节与视角'],['validation','尺寸与校验'],['advanced','高级参数']];
    const panel=(id,content)=>'<div class="pf-tab-panel" data-pf-panel="'+id+'" role="tabpanel" id="pf-'+escapeAttr(node.id)+'-'+id+'" aria-labelledby="pf-tab-'+escapeAttr(node.id)+'-'+id+'" '+(id==='common'?'':'hidden')+'>'+content+'</div>';
    return '<div class="pf-workbench" data-pf-root><header class="pf-heading"><div><strong>产品保真</strong><span>选主图 → 标记保护区域 → 设置保护方式</span></div>'+check('enabled','使用产品保真')+'</header>'+
        '<div class="pf-layout"><div class="pf-image-column"><div class="pf-image-heading"><strong>产品图片</strong><span data-pf-source-info>'+refs.length+' 张输入</span><button type="button" data-pf-expand aria-expanded="false">放大编辑</button></div>'+
        select('productReferenceId','选择产品主图',[...(!current?[[config.productReferenceId||'',refs.length?'请重新选择产品主图':'请先连接产品图片']]:[]),...refs.map((r,i)=>[config.referenceIds[r.url],fidelityReferenceLabel(r,i)])])+
        '<div class="pf-tools"><button type="button" data-pf-tool="mask">画保护区</button><button type="button" data-pf-tool="erase">擦除保护区</button><button type="button" data-pf-tool="roi">框选细节</button></div>'+
        '<div class="pf-editor-controls"><label class="pf-brush">画笔大小<input type="range" min="1" max="20" value="4" data-pf-brush></label><button type="button" data-pf-history="undo" title="撤销画布上一步操作">撤销</button><button type="button" data-pf-history="redo" title="重做画布上一步操作">重做</button></div>'+
        '<p class="pf-image-note" data-pf-roi-info>绿色：保护区域 · 橙色：手动细节 · 蓝色：自动候选</p>'+
        '<div class="pf-canvas-stage"><canvas data-pf-canvas aria-label="产品图片与保护区域"></canvas><p data-pf-empty '+(current?'hidden':'')+'>将产品图片连接到节点左侧输入口<br>在上方选择主图，再涂画保护区域</p></div>'+
        '<div class="pf-secondary-actions"><button type="button" data-pf-action="clear-mask">重置保护区域</button><button type="button" data-pf-action="clear-rois">清空细节选区</button></div>'+
        '<div class="pf-roi-list" data-pf-rois></div><details class="pf-asset-panel" '+(assets.length?'open':'')+'><summary>辅助参考图 <span data-pf-asset-count>'+assets.filter(a=>a.role!=='product-mask').length+' 张</span></summary><p class="pf-help" data-pf-assets-empty '+(assets.some(a=>a.role!=='product-mask')?'hidden':'')+'>设置细节或尺寸引导后，点击底部「更新辅助参考图」查看。</p><div class="pf-assets" data-pf-assets>'+assets.filter(a=>a.role!=='product-mask').map(a=>fidelityAssetHtml(a,fidelityAssetLabel(a))).join('')+'</div></details></div>'+
        '<div class="pf-settings-column"><nav class="pf-section-nav" role="tablist" aria-label="产品保真设置">'+tabs.map(([id,title],index)=>'<button type="button" role="tab" id="pf-tab-'+escapeAttr(node.id)+'-'+id+'" aria-controls="pf-'+escapeAttr(node.id)+'-'+id+'" aria-selected="'+(index===0)+'" tabindex="'+(index===0?'0':'-1')+'" data-pf-tab="'+id+'">'+title+'</button>').join('')+'</nav><div class="pf-settings-content">'+
        panel('common',section('01','identification','产品信息','使用产品信息',
            select('category','产品类型',[['auto','请选择产品类型'],['textile','地毯／布艺／家纺'],['clothing','服装／鞋帽'],['bag','箱包／皮具'],['furniture','家具／家居摆件'],['frame','相框／装饰画'],['box','包装盒'],['cylinder','瓶罐／杯具'],['beauty','美妆／个护'],['jewelry','珠宝／饰品'],['electronics','电子设备'],['appliance','家用电器'],['food','食品／饮料'],['toy','玩具／文具'],['other','其他（自定义）']])+
            custom('categoryCustom','自定义类型','例如：入户门垫、宠物窝',config.category==='other')+
            select('geometry','外形特征',[['auto','请选择外形'],['plane','矩形／方形平面'],['circle','圆形平面'],['oval','椭圆形平面'],['polygon','多边形平面'],['box','长方体／盒状'],['cylinder','圆柱形'],['cone','圆锥／收口形'],['sphere','球形'],['curved','弧面／曲面'],['soft','软质／可折叠'],['other','不规则'],['custom','自定义形状']])+
            custom('geometryCustom','自定义外形','例如：半圆门垫、带提手的异形瓶',config.geometry==='custom'))+
        section('02','structure','保护方式','使用结构保护',
            select('mode','如何保护产品',[['strict','保留原产品像素 · 换背景'],['structure','保持结构 · 可改光照'],['view','保持身份 · 可换角度']])+
            fidelityMaskSelectHtml(node)+
            help('保护蒙版怎么用？','<p class="pf-help">白色保护、黑色改变，蒙版尺寸应与主图一致。可在左图涂画，或选择图片节点「设置 → 蒙版」生成的蒙版。</p>')+
            '<details class="pf-options"><summary>结构保护选项</summary><div class="pf-checks">'+check('structure.lockRatio','保持产品比例')+check('structure.lockOutline','保持产品外形')+check('structure.lockLines','保持直线与边框')+check('structure.lockSymmetry','保持对称')+check('structure.lockLayout','保持按钮与接口位置')+'</div><p class="pf-help">原像素模式采用本地合成；重绘模式通过参考图和提示词约束结构，结果需要复核。</p></details>')+
        section('04','generation','允许的改动','使用改动限制',
            select('generation.allowedEdits','允许改变什么',[['background','只改变背景'],['lighting','背景与产品光照'],['material','局部材质'],['view','产品观察角度']])+
            '<p class="pf-strategy" data-pf-strategy></p>'))+
        panel('detail','<section class="pf-section pf-detail" data-pf-module="detail"><div class="pf-section-heading"><h3>细节保护</h3>'+check('detail.enabled','补充细节参考')+'</div>'+
            select('detail.inputMode','参考图内容',[['original','只使用原产品图'],['highpass','增加纹理细节图'],['crops','增加局部细节图'],['combined','纹理图＋局部细节图']])+
            '<details class="pf-options" data-pf-crop-options><summary>局部细节选区</summary>'+check('detail.autoCrops','自动寻找细节区域')+number('detail.cropCount','最多局部参考图',0,3,1,'张')+
            '<div class="pf-secondary-actions"><button type="button" data-pf-action="auto-crops">寻找细节并预览</button><button type="button" data-pf-action="manual-rois">改为手动框选</button></div><p class="pf-help">选区可拖动、缩放，也可在左侧列表中重画或删除。</p></details>'+
            '<details class="pf-options"><summary>生成后恢复纹理</summary>'+select('detail.restoreMode','纹理回填',[['off','不回填'],['auto','对齐可靠后恢复原纹理']])+
            '<label class="pf-field"><span>纹理恢复量</span><span class="pf-range"><small>少量</small><input type="range" min="0" max="1" step=".05" data-pf-field="detail.restoreStrength" value="'+config.detail.restoreStrength+'"><small>较多</small></span></label><p class="pf-help" data-pf-restore-note></p></details></section>'+
        section('03','view','产品视角','调整产品视角',
            select('view.mode','观察角度',[['keep','保持原角度'],['minor','轻微调整'],['target','指定新角度']])+
            '<div class="pf-angle-presets" aria-label="左右转动快捷角度"><button type="button" data-pf-angle="-30">向左 30°</button><button type="button" data-pf-angle="0">正面</button><button type="button" data-pf-angle="30">向右 30°</button></div>'+
            number('view.yaw','左右转动',-90,90,15,'°')+
            '<details class="pf-options"><summary>俯仰与旋转</summary>'+number('view.pitch','俯仰角度',-90,90,15,'°')+number('view.roll','画面旋转',-90,90,15,'°')+check('view.proxyEnabled','增加平面角度示意图')+'</details>'+
            help('视角参考与限制','<p class="pf-help">其他真实视角图接入同一输入口，在绘画提示词中注明前／侧／背。角度示意适用于平面矩形；未拍摄的隐藏面由 AI 推测。</p>')))+
        panel('validation',physicalDimensionPanelHtml(config.dimensions)+section('05','validation','生成结果检查','检查生成结果',
            '<div class="pf-results" data-pf-results></div><details class="pf-options"><summary>检查容差与适用范围</summary>'+number('validation.ratioTolerancePct','平面边长允许偏差',1,20,1,'%')+
            '<p class="pf-help">原像素模式核对核心像素；结构模式检查可靠匹配的平面边框。遮挡、透明材质或匹配不足时显示无法判断。文字与接口数量需人工复核。</p></details>'))+
        panel('advanced',section('06','advanced','本地处理参数','自定义处理参数',
            number('detail.highPassRadiusPx','纹理提取半径',.5,8,.5,'px')+number('detail.highPassGain','纹理图对比强度',.5,4,.25)+
            number('maskFeatherPx','保护边缘过渡',0,8,.5,'px')+number('alignmentThreshold','对齐最低置信度',.7,1,.05)+
            '<p class="pf-help">关闭自定义时使用默认值。置信度范围为 0–1，数值越高要求越严格；对齐不足时跳过纹理回填。</p>'+
            '<details class="pf-debug"><summary>查看下游模型与实际参考图</summary><pre data-pf-debug></pre></details>'))+
        '</div></div></div><footer class="pf-footer"><div><p data-pf-status role="status">'+(fresh?'辅助参考图已更新':refs.length?'设置已保存，可更新辅助参考图':'请先连接产品图片')+'</p><p class="pf-footer-validation" data-pf-validation-status role="status" hidden></p><span data-pf-route>连接绘画节点，设置提示词与模型</span></div><div class="pf-footer-action"><button type="button" class="pf-update" data-pf-action="preview">更新辅助参考图</button><span>本地处理 · 不消耗生图额度</span></div></footer></div>';
}
function fidelityCanEdit(node){
    return collabCanMutateCanvas()&&(typeof collabCanEditNode!=='function'||collabCanEditNode(node.id,true));
}
function fidelityStatus(session,message){const el=session.root.querySelector('[data-pf-status]');if(el)el.textContent=message;}
function fidelitySyncAssetSummary(session){
    const count=session.root.querySelector('[data-pf-assets]').childElementCount;
    session.root.querySelector('[data-pf-asset-count]').textContent=count+' 张';
    session.root.querySelector('[data-pf-assets-empty]').hidden=count>0;
}
function fidelitySelectTab(session,id,focus=false){
    const content=session.root.querySelector('.pf-settings-content');
    session.tabScroll||={};
    if(session.activeTab)session.tabScroll[session.activeTab]=content.scrollTop;
    session.activeTab=id;
    session.root.querySelectorAll('[data-pf-panel]').forEach(panel=>panel.hidden=panel.dataset.pfPanel!==id);
    session.root.querySelectorAll('[data-pf-tab]').forEach(button=>{
        const active=button.dataset.pfTab===id;
        button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
        if(active&&focus)button.focus();
    });
    content.scrollTop=session.tabScroll[id]||0;
}
function fidelityCommit(session,withRender=false,skipEditor=false){
    session.controller?.abort();session.detectedRois=[];delete session.node.fidelityPreview;
    fidelityStatus(session,'设置已保存，可更新辅助参考图');
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
    session.root.querySelector('[data-pf-restore-note]').textContent=config.mode==='strict'?'原产品像素直接合成，纹理随原图保留。':config.mode==='view'?'换角度时不回填旧视角纹理，避免重影。':'需要保护蒙版和可靠同视角对齐；形状异常或匹配不足时自动跳过。';
    for(const key of ['view.mode','view.yaw','view.pitch','view.roll','view.proxyEnabled'])field(key).disabled=!config.view.enabled;
    session.root.querySelectorAll('[data-pf-angle]').forEach(el=>el.disabled=!config.view.enabled);
    for(const option of field('generation.allowedEdits').options)option.disabled=effective.mode==='strict'?option.value!=='background':effective.mode==='structure'&&option.value==='view';
    session.root.querySelector('[data-pf-strategy]').textContent=config.mode==='strict'?'生成后保留原产品位置、比例和核心像素；只改变背景。':config.mode==='view'?'使用产品和视角参考生成；未拍摄的隐藏面由 AI 推测。':'使用原图与辅助细节参考；可靠对齐后才执行已开启的纹理恢复。';
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
    session.root.querySelectorAll('[data-pf-angle]').forEach(button=>button.setAttribute('aria-pressed',String(config.view.enabled&&config.view.mode==='target'&&config.view.yaw===Number(button.dataset.pfAngle))));
    const dimensionErrors=config.dimensions.enabled?XiaomeiPhysicalDimensions.validatePhysicalDimensions(config.dimensions).errors:[];
    const validationStatus=session.root.querySelector('[data-pf-validation-status]');
    validationStatus.hidden=!dimensionErrors.length;
    validationStatus.textContent=dimensionErrors.length?'尺寸设置需要修改：'+dimensionErrors.join('；')+'。打开「尺寸与校验」填写。':'';
    session.root.querySelector('[data-pf-action="preview"]').disabled||=dimensionErrors.length>0;
    session.root.querySelector('[data-pf-action="preview"]').textContent=session.busy?'正在处理…':'更新辅助参考图';
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
    [...config.rois.map((roi,index)=>({roi,index,auto:false})),...(session.detectedRois||[]).map((roi,index)=>({roi,index,auto:true}))].forEach(({roi,index,auto})=>{
        const item=document.createElement('div'),button=document.createElement('button');
        const position=auto?config.rois.length+index:index;
        item.className='pf-roi-item';item.append(document.createTextNode((auto?'自动候选 ':'手动细节 ')+(index+1)));
        item.setAttribute('aria-current',String(session.selectedRoi===position));
        for(const [action,label] of [['adjust','调整'],['redraw','重画']]){
            const control=document.createElement('button');control.type='button';control.textContent=label;
            control.dataset.pfRoiAction=action;control.dataset.pfRoiIndex=String(position);
            control.disabled=!fidelityCanEdit(session.node);
            control.onclick=()=>{
                if(!fidelityCanEdit(session.node))return;
                pushUndo();fidelityAdoptDetectedRois(session);session.selectedRoi=position;
                session.replaceRoiIndex=action==='redraw'?position:null;session.setTool?.('roi');
                fidelitySyncFields(session);fidelityCommit(session);
                fidelityStatus(session,action==='redraw'?'在图上拖出新框，替换所选细节区域':'拖动选区移动，拖动四角调整大小');
            };item.append(control);
        }
        button.type='button';button.textContent='删除';
        button.disabled=!fidelityCanEdit(session.node);
        button.onclick=()=>{
            if(!fidelityCanEdit(session.node))return;pushUndo();
            fidelityAdoptDetectedRois(session);config.rois.splice(position,1);session.selectedRoi=null;session.replaceRoiIndex=null;
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
    if(maskImage){maskImage.src=config.maskUrl;try{await maskImage.decode();}catch{fidelityStatus(session,'蒙版图片无法读取，请重新上传');}}
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
            for(let i=0;i<pixels.data.length;i+=4){const alpha=pixels.data[i];pixels.data[i]=0;pixels.data[i+1]=212;pixels.data[i+2]=143;pixels.data[i+3]=alpha;}
            overlay.putImageData(pixels,0,0);
        }else if(!config.maskStrokes.length){
            overlay.drawImage(image,0,0,layer.width,layer.height);
            const pixels=overlay.getImageData(0,0,layer.width,layer.height);
            let transparent=false;for(let i=3;i<pixels.data.length;i+=4)if(pixels.data[i]<255){transparent=true;break;}
            if(transparent){
                for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=0;pixels.data[i+1]=212;pixels.data[i+2]=143;}
                overlay.putImageData(pixels,0,0);
            }else overlay.clearRect(0,0,layer.width,layer.height);
        }
        for(const s of config.maskStrokes){
            overlay.globalCompositeOperation=s.erase?'destination-out':'source-over';overlay.strokeStyle='#00d48f';overlay.fillStyle='#00d48f';overlay.lineWidth=s.width*Math.min(layer.width,layer.height);overlay.lineCap='round';overlay.lineJoin='round';
            overlay.beginPath();s.points.forEach((p,i)=>i?overlay.lineTo(p[0]*layer.width,p[1]*layer.height):overlay.moveTo(p[0]*layer.width,p[1]*layer.height));overlay.stroke();
            if(s.points[0]){overlay.beginPath();overlay.arc(s.points[0][0]*layer.width,s.points[0][1]*layer.height,overlay.lineWidth/2,0,Math.PI*2);overlay.fill();}
        }
        context.globalAlpha=.48;context.drawImage(layer,0,0);context.globalAlpha=1;
        config.rois.forEach((r,index)=>drawRoi(r,index,false,session.selectedRoi===index));
        (session.detectedRois||[]).forEach((r,index)=>drawRoi(r,index,true,session.selectedRoi===config.rois.length+index));
        root.querySelector('[data-pf-source-info]').textContent=image.naturalWidth+' × '+image.naturalHeight+' · 原图';
        root.querySelector('[data-pf-roi-info]').textContent='手动 '+config.rois.length+' 区 · 自动候选 '+(session.detectedRois?.length||0)+' 区；绿色为保护区';
    };
    const point=event=>{const r=canvasEl.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))];};
    session.setTool=value=>{tool=value;session.tool=value;root.querySelectorAll('[data-pf-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pfTool===value)));};
    root.querySelectorAll('[data-pf-tool]').forEach(b=>b.onclick=()=>{session.setTool(b.dataset.pfTool);fidelityStatus(session,tool==='roi'?'拖动框选细节；已有框可移动或拖动四角缩放':'涂抹需要保护的区域');});
    session.setTool(tool);
    canvasEl.onpointerdown=event=>{
        if(!fidelityCanEdit(node))return;event.preventDefault();event.stopPropagation();
        if(tool!=='roi'&&config.maskUrl){fidelityStatus(session,'修改已有蒙版请先重置保护区域，再重新涂抹');return;}
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
        if(tool==='roi'&&!hit&&session.replaceRoiIndex==null&&config.rois.length+(session.detectedRois?.length||0)>=3){fidelityStatus(session,'已选 3 个区域，可拖动已有框，或点击“重画”替换');return;}
        pushUndo();
        canvasEl.setPointerCapture(event.pointerId);start=p;
        if(tool==='roi'){
            fidelityAdoptDetectedRois(session);
            if(hit){session.selectedRoi=hit.index;roiDrag={...hit,original:{...config.rois[hit.index]}};}
            fidelitySyncFields(session);
        }
        if(tool!=='roi'){
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
        }else{session.draw();drawRoi({x:Math.min(start[0],p[0]),y:Math.min(start[1],p[1]),w:Math.abs(start[0]-p[0]),h:Math.abs(start[1]-p[1])},session.replaceRoiIndex??config.rois.length,false,true);}
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
        canvasEl.releasePointerCapture?.(event.pointerId);start=null;stroke=null;roiDrag=null;session.replaceRoiIndex=null;fidelityCommit(session);
    };
    canvasEl.onpointercancel=()=>{start=null;stroke=null;fidelityCommit(session);};
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
        const list=session.root.querySelector('[data-pf-assets]');
        list.innerHTML=(preview.generatedAssets||[]).filter(a=>a.role!=='product-mask').map(a=>fidelityAssetHtml(a,fidelityAssetLabel(a))).join('');
        fidelitySyncAssetSummary(session);
        session.root.querySelector('.pf-asset-panel').open=list.childElementCount>0;
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
        if(old.refsKey!==key){old.refs=refs;old.refsKey=key;old.controller?.abort();fidelityStatus(old,'输入图片已更改，请更新辅助参考图');void fidelityLoadEditor(old);}
        fidelityRenderResults(old);void fidelityInspectDownstream(old);return;
    }
    old?.controller?.abort();old?.capabilitiesController?.abort();old?.editorObserver?.disconnect();
    const preview=node.fidelityPreview?.signature===fidelitySignature(node)?node.fidelityPreview:null;
    const session={node,root,refs,refsKey:key,detectedRois:preview?.detectedRois||[],busy:false,tabScroll:{...old?.tabScroll},tool:old?.tool};
    productFidelitySessions.set(node.id,session);
    const column=root.querySelector('.pf-settings-content');
    column.onscroll=()=>{session.tabScroll[session.activeTab]=column.scrollTop;};
    const oldDetails=old?.root.querySelectorAll('details');
    root.querySelectorAll('details').forEach((details,index)=>{if(oldDetails?.[index])details.open=oldDetails[index].open;});
    fidelitySelectTab(session,old?.activeTab||'common');
    for(const kind of ['pointerdown','mousedown','click','dblclick','wheel'])root.addEventListener(kind,event=>event.stopPropagation());
    const tabs=[...root.querySelectorAll('[data-pf-tab]')];
    tabs.forEach((button,index)=>{
        button.onclick=()=>fidelitySelectTab(session,button.dataset.pfTab);
        button.onkeydown=event=>{
            const target=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
            if(target===null)return;event.preventDefault();fidelitySelectTab(session,tabs[target].dataset.pfTab,true);
        };
    });
    root.querySelectorAll('[data-pf-history]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;
        if(button.dataset.pfHistory==='undo')performUndo();else performRedo();
    });
    root.querySelectorAll('[data-pf-field]').forEach(input=>input.onchange=()=>{
        if(!fidelityCanEdit(node))return;pushUndo();const config=node.fidelityConfig;
        fidelitySetValue(config,input.dataset.pfField,input.type==='checkbox'?input.checked:input.type==='number'||input.type==='range'?Number(input.value):input.value);
        if(input.dataset.pfField==='mode'){fidelityChangeMode(config,config.mode);fidelitySyncFields(session);}
        if(input.dataset.pfField==='view.enabled'&&config.view.enabled){fidelityChangeMode(config,'view');fidelitySyncFields(session);}
        if(input.dataset.pfField==='view.enabled'&&!config.view.enabled&&config.mode==='view'){
            config.mode='structure';config.generation.allowedEdits='lighting';fidelitySyncFields(session);
        }
        if(input.dataset.pfField==='structure.enabled'&&!config.structure.enabled&&config.mode==='strict'&&!(config.dimensions.enabled&&config.dimensions.constraintMode==='protect')){fidelityChangeMode(config,'structure');fidelitySyncFields(session);}
        if(input.dataset.pfField==='mode'&&config.dimensions.enabled){
            if(config.mode==='strict')config.dimensions.constraintMode='protect';
            else if(config.dimensions.constraintMode==='protect')config.dimensions.constraintMode='prompt';
            root.querySelector('[data-pd-root]')?.pdRefresh?.();
        }
        if(input.dataset.pfField==='productReferenceId'){config.rois=[];config.maskStrokes=[];delete config.maskUrl;void fidelityLoadEditor(session);}
        fidelityCommit(session);
    });
    bindPhysicalDimensionPanel(root.querySelector('[data-pd-root]'),node.fidelityConfig,()=>{
        fidelitySyncFields(session);fidelityCommit(session,false,true);
    },()=>fidelityCanEdit(node),()=>session.refs.length);
    root.querySelector('[data-pf-mask-select]').onchange=async event=>{
        if(!fidelityCanEdit(node))return;
        const url=event.target.value,previous=node.fidelityConfig.maskUrl||'';
        try{
            if(url){
                const mask=new Image();mask.src=url;await mask.decode();
                const ref=session.refs.find(r=>node.fidelityConfig.referenceIds[r.url]===node.fidelityConfig.productReferenceId);
                if(!ref)throw new Error('请先选择产品主图');
                const source=new Image();source.src=ref.url;await source.decode();
                if(mask.naturalWidth!==source.naturalWidth||mask.naturalHeight!==source.naturalHeight)throw new Error('蒙版与产品图尺寸不同，请从同一产品原图制作蒙版');
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
    root.querySelectorAll('[data-pf-angle]').forEach(button=>button.onclick=()=>{
        if(!fidelityCanEdit(node))return;pushUndo();node.fidelityConfig.view.mode='target';node.fidelityConfig.view.yaw=Number(button.dataset.pfAngle);fidelitySyncFields(session);fidelityCommit(session);
    });
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
