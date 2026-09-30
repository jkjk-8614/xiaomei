(function(){
    'use strict';

    const CUSTOM_MODES = new Set(['local-move', 'local-repair', 'smart-edit']);
    const state = {
        moveSource:null,
        repairQuad:null,
        smartRegions:[],
        smartDraft:null,
        smartBusy:false,
        smartSession:0,
        smartPrompt:'',
        drag:null,
        references:[]
    };

    const byId = id => document.getElementById(id);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const copyRect = rect => rect ? ({x:rect.x, y:rect.y, w:rect.w, h:rect.h}) : null;
    const currentRect = () => copyRect(cropState);
    const cropSize = () => {
        const img = byId('cropImage');
        return {w:Math.max(1, img?.clientWidth || 1), h:Math.max(1, img?.clientHeight || 1)};
    };
    const naturalScale = () => {
        const img = byId('cropImage');
        return {
            x:Math.max(1, img?.naturalWidth || 1) / Math.max(1, img?.clientWidth || 1),
            y:Math.max(1, img?.naturalHeight || 1) / Math.max(1, img?.clientHeight || 1)
        };
    };
    const naturalRect = rect => {
        const scale = naturalScale();
        return {
            x:Math.round(rect.x * scale.x), y:Math.round(rect.y * scale.y),
            w:Math.max(1, Math.round(rect.w * scale.x)), h:Math.max(1, Math.round(rect.h * scale.y))
        };
    };
    const rectFromQuad = points => {
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        return {x:Math.min(...xs), y:Math.min(...ys), w:Math.max(...xs)-Math.min(...xs), h:Math.max(...ys)-Math.min(...ys)};
    };
    const defaultQuad = () => {
        const r = currentRect() || {x:20,y:20,w:180,h:120};
        return [{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}];
    };
    const imageCandidates = () => {
        const current = currentEditImage();
        const targetUrl = current?.image?.url || '';
        const result = [];
        (nodes || []).forEach(node => (node.images || []).forEach((image, index) => {
            if(!image?.url || image.url === targetUrl || mediaKindForItem(image) !== 'image') return;
            result.push({url:image.url, name:image.name || node.title || `参考图 ${result.length + 1}`, nodeId:node.id, imageIndex:index});
        }));
        return uniqueReferenceImages(result);
    };
    function syncReferenceSelects(){
        state.references = imageCandidates();
        ['localRepairReferenceSelect'].forEach(id => {
            const select = byId(id);
            if(!select) return;
            const old = select.value;
            select.innerHTML = state.references.length
                ? state.references.map((ref, index) => `<option value="${index}">${escapeHtml(ref.name)}</option>`).join('')
                : '<option value="">请先在画布添加另一张参考图</option>';
            if(old && Number(old) < state.references.length) select.value = old;
        });
    }
    function selectedReference(selectId){
        const index = Number(byId(selectId)?.value);
        return Number.isInteger(index) ? state.references[index] : null;
    }
    function positionRect(el, rect){
        if(!el || !rect) return;
        el.style.left = `${rect.x}px`; el.style.top = `${rect.y}px`;
        el.style.width = `${Math.max(8, rect.w)}px`; el.style.height = `${Math.max(8, rect.h)}px`;
    }
    function renderMove(){
        const box = byId('localMoveSourceBox');
        const visible = imageEditMode === 'local-move' && state.moveSource;
        box?.classList.toggle('active', Boolean(visible));
        if(visible) positionRect(box, state.moveSource);
    }
    function renderQuad(){
        const quad = byId('localRepairQuad');
        const points = state.repairQuad || defaultQuad();
        const visible = imageEditMode === 'local-repair';
        quad?.classList.toggle('active', visible);
        if(!quad || !visible) return;
        const bounds = rectFromQuad(points);
        positionRect(quad, bounds);
        const local = points.map(p => ({x:p.x-bounds.x,y:p.y-bounds.y}));
        const corners = quad.querySelectorAll('[data-repair-corner]');
        corners.forEach((el, index) => { el.style.left=`${local[index].x}px`; el.style.top=`${local[index].y}px`; });
        const edges = quad.querySelectorAll('.local-repair-edge');
        [[0,1],[1,2],[2,3],[3,0]].forEach((pair, index) => {
            const a=local[pair[0]], b=local[pair[1]], dx=b.x-a.x, dy=b.y-a.y;
            edges[index].style.left=`${a.x}px`; edges[index].style.top=`${a.y}px`;
            edges[index].style.width=`${Math.hypot(dx,dy)}px`;
            edges[index].style.transform=`rotate(${Math.atan2(dy,dx)}rad)`;
        });
    }
    function renderSmartMarkers(){
        const layer = byId('smartEditMarkerLayer');
        const visible = imageEditMode === 'smart-edit';
        layer?.classList.toggle('active', visible);
        if(layer){
            layer.replaceChildren();
            if(visible){
                const size = cropSize();
                const drawRegion = (region, index, draft=false) => {
                    const box = document.createElement(draft ? 'div' : 'button');
                    box.className = `smart-edit-region${draft ? ' draft' : ''}`;
                    Object.assign(box.style, {left:`${region.x*size.w}px`, top:`${region.y*size.h}px`, width:`${region.w*size.w}px`, height:`${region.h*size.h}px`});
                    const label = document.createElement('span');
                    label.textContent = String(index + 1);
                    box.appendChild(label);
                    if(!draft){
                        box.type = 'button';
                        box.title = `区域 ${index + 1}：${region.prompt}`;
                        box.setAttribute('aria-label', `编辑区域 ${index + 1}：${region.prompt}`);
                        box.disabled = state.smartBusy;
                        box.onclick = () => editSmartRegion(index);
                    }
                    layer.appendChild(box);
                };
                state.smartRegions.forEach((region, index) => {
                    if(state.smartDraft?.index !== index) drawRegion(region, index);
                });
                if(state.smartDraft) drawRegion(state.smartDraft, state.smartDraft.index, true);
            }
        }
        const refs = byId('smartEditMarkerRefs');
        if(refs){
            refs.replaceChildren();
            state.smartRegions.forEach((region, index) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'smart-edit-marker-ref';
                chip.textContent = `区域 ${index + 1} · ${region.prompt}`;
                chip.title = '点击修改或删除这条指令';
                chip.disabled = state.smartBusy;
                chip.onclick = () => editSmartRegion(index);
                refs.appendChild(chip);
            });
        }
        const hint = byId('smartEditMarkerHint');
        if(hint) hint.textContent = state.smartDraft ? '填写这一区域的修改要求，点 ✓ 确认后可继续框选。'
            : state.smartRegions.length ? `已确认 ${state.smartRegions.length} 条修改；点击条目可编辑，发送后统一生成。`
            : '在图片上拖动框选区域，也可直接输入整图修改要求。';
        const editor = byId('smartEditRegionEditor');
        if(editor){
            editor.hidden = !visible || !state.smartDraft || state.drag?.type === 'smart-region';
            if(!editor.hidden){
                byId('smartEditRegionLabel').textContent = `区域 ${state.smartDraft.index + 1}`;
                positionSmartRegionEditor();
            }
        }
        byId('smartEditSubmitBtn').disabled = state.smartBusy;
        byId('smartEditSubmitBtn').querySelector('span').textContent = state.smartBusy ? '正在提交…' : '发送改图';
        byId('smartEditPrompt').disabled = state.smartBusy;
        byId('smartEditClearMarkersBtn').disabled = state.smartBusy || (!state.smartRegions.length && !state.smartDraft);
        editor?.querySelectorAll('button,textarea').forEach(el => {el.disabled = state.smartBusy;});
    }
    function positionSmartRegionEditor(){
        const draft = state.smartDraft, editor = byId('smartEditRegionEditor');
        if(!draft || !editor || editor.hidden) return;
        const img = byId('cropImage').getBoundingClientRect();
        const stage = byId('imageEditStage').getBoundingClientRect();
        const left = img.left - stage.left + (draft.x + draft.w)*img.width + 10;
        const top = img.top - stage.top + draft.y*img.height;
        const bottom = byId('imageSmartEditTools').getBoundingClientRect().top - stage.top - 10;
        editor.style.left = `${clamp(left, 12, Math.max(12, stage.width-editor.offsetWidth-12))}px`;
        editor.style.top = `${clamp(top, 60, Math.max(60, bottom-editor.offsetHeight))}px`;
    }
    function editSmartRegion(index){
        if(state.smartBusy) return;
        if(state.smartDraft){toast('请先确认或取消当前区域的修改');byId('smartEditRegionPrompt')?.focus();return;}
        state.smartDraft = {...state.smartRegions[index], index};
        byId('smartEditRegionPrompt').value = state.smartDraft.prompt;
        renderSmartMarkers();
        byId('smartEditRegionPrompt').focus();
    }
    window.confirmSmartEditRegion = function(){
        if(!state.smartDraft || state.smartBusy) return;
        const prompt = byId('smartEditRegionPrompt').value.trim();
        if(!prompt){toast('请填写这一区域的修改要求');byId('smartEditRegionPrompt').focus();return;}
        const {index, x, y, w, h} = state.smartDraft;
        state.smartRegions[index] = {x,y,w,h,prompt};
        state.smartDraft = null;
        renderSmartMarkers();
    };
    window.cancelSmartEditRegion = function(){
        if(state.smartBusy) return;
        state.smartDraft = null;
        renderSmartMarkers();
    };
    window.deleteSmartEditRegion = function(){
        if(!state.smartDraft || state.smartBusy) return;
        state.smartRegions.splice(state.smartDraft.index, 1);
        state.smartDraft = null;
        renderSmartMarkers();
    }
    function syncCustomUi(){
        document.querySelectorAll('[data-image-edit-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.imageEditMode === imageEditMode));
        ['imageCropTools','imageMaskTools','imageBrushTools','imageResizeTools','imageGridTools'].forEach(id => byId(id)?.classList.remove('active'));
        byId('imageLocalMoveTools')?.classList.toggle('active', imageEditMode === 'local-move');
        byId('imageLocalRepairTools')?.classList.toggle('active', imageEditMode === 'local-repair');
        byId('imageSmartEditTools')?.classList.toggle('active', imageEditMode === 'smart-edit');
        byId('imageEditModal')?.classList.toggle('smart-edit-redesign', imageEditMode === 'smart-edit');
        byId('cropCanvas')?.classList.toggle('smart-edit-mode', imageEditMode === 'smart-edit');
        const meta = {
            'local-move':['移动与缩放','框选对象并确认，再移动或缩放目标框','move-3d','应用移动缩放'],
            'local-repair':['局部修复','选择唯一正确参考图，调整四点透视后生成修复参考','wand-sparkles','准备局部修复'],
            'smart-edit':['智能改图','框选区域并逐条确认修改要求，最后统一发送','wand-sparkles','发送改图']
        }[imageEditMode];
        if(meta){
            byId('imageEditTitle').textContent=meta[0]; byId('imageEditSub').textContent=meta[1];
            byId('imageEditApplyBtn').innerHTML=`<i data-lucide="${meta[2]}" class="w-4 h-4"></i><span>${meta[3]}</span>`;
        }
        renderMove(); renderQuad(); renderSmartMarkers(); refreshIcons();
    }

    const baseSetImageEditMode = window.setImageEditMode;
    window.setImageEditMode = function(mode, userTouched=false){
        if(!CUSTOM_MODES.has(mode)){
            if(imageEditMode === 'smart-edit') resetSmartEdit();
            byId('imageEditModal')?.classList.remove('smart-edit-redesign');
            byId('cropCanvas')?.classList.remove('smart-edit-mode');
            byId('imageSmartEditTools')?.classList.remove('active');
            byId('smartEditMarkerLayer')?.classList.remove('active');
            if(byId('smartEditRegionEditor')) byId('smartEditRegionEditor').hidden = true;
            return baseSetImageEditMode(mode, userTouched);
        }
        baseSetImageEditMode('crop', userTouched);
        imageEditMode = mode;
        if(mode === 'local-move') resetLocalMoveEdit();
        if(mode === 'local-repair') resetLocalRepairEdit();
        if(mode === 'smart-edit') resetSmartEdit();
        syncReferenceSelects();
        syncCustomUi();
    };
    const baseOpenImageEditor = window.openImageEditor;
    window.openImageEditor = function(...args){
        state.moveSource=null; state.repairQuad=null; state.drag=null;
        resetSmartEdit();
        const result=baseOpenImageEditor(...args);
        syncCustomUi();
        return result;
    };
    const baseCloseImageEditor = window.closeImageEditor;
    window.closeImageEditor = function(...args){
        resetSmartEdit();
        const result = baseCloseImageEditor(...args);
        byId('imageEditModal')?.classList.remove('smart-edit-redesign');
        return result;
    };
    const baseResizeEditDrawCanvas = window.resizeEditDrawCanvas;
    window.resizeEditDrawCanvas = function(...args){
        const result = baseResizeEditDrawCanvas(...args);
        renderMove(); renderQuad(); renderSmartMarkers();
        return result;
    };

    window.confirmLocalMoveSource = function(){
        state.moveSource=currentRect();
        if(!state.moveSource) return;
        byId('localMovePickBtn')?.querySelector('span') && (byId('localMovePickBtn').querySelector('span').textContent='重新选定');
        byId('localMoveHint').textContent='虚线框是原对象；拖动实线框移动，拉四角自由缩放。';
        renderMove();
    };
    window.resetLocalMoveEdit = function(){
        state.moveSource=null;
        requestAnimationFrame(() => { resetCropBox(); renderMove(); });
        const label=byId('localMovePickBtn')?.querySelector('span'); if(label) label.textContent='选定对象';
    };
    window.resetLocalRepairEdit = function(){
        state.repairQuad=defaultQuad();
        requestAnimationFrame(renderQuad);
    };
    function resetSmartEdit(){
        state.smartSession++;
        state.smartRegions=[];
        state.smartDraft=null;
        state.smartBusy=false;
        if(state.drag?.type === 'smart-region') state.drag=null;
        state.smartPrompt='';
        const prompt = byId('smartEditPrompt');
        if(prompt) prompt.value='';
        requestAnimationFrame(renderSmartMarkers);
    }
    window.clearSmartEditMarkers = function(){
        if(state.smartBusy) return;
        state.smartRegions=[];
        state.smartDraft=null;
        renderSmartMarkers();
    };

    function averageBorderColor(ctx, rect, width, height){
        const points=[], step=Math.max(1,Math.floor(Math.min(rect.w,rect.h)/24));
        for(let x=rect.x;x<rect.x+rect.w;x+=step){points.push([x,rect.y-2],[x,rect.y+rect.h+1]);}
        for(let y=rect.y;y<rect.y+rect.h;y+=step){points.push([rect.x-2,y],[rect.x+rect.w+1,y]);}
        let r=0,g=0,b=0,n=0;
        points.forEach(([x,y])=>{x=clamp(Math.round(x),0,width-1);y=clamp(Math.round(y),0,height-1);const d=ctx.getImageData(x,y,1,1).data;r+=d[0];g+=d[1];b+=d[2];n++;});
        return `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`;
    }
    async function uploadCanvas(canvasEl, name){
        const blob=await new Promise(resolve=>canvasEl.toBlob(resolve,'image/png'));
        return blob ? uploadCroppedBlob(blob,name) : null;
    }
    async function applyLocalMove(){
        if(!state.moveSource){ toast('请先选定要移动或缩放的对象'); return; }
        const {node,image}=currentEditImage(), img=byId('cropImage');
        if(!node||!image||!img?.naturalWidth) return;
        const source=naturalRect(state.moveSource), target=naturalRect(currentRect());
        const canvasEl=document.createElement('canvas'); canvasEl.width=img.naturalWidth; canvasEl.height=img.naturalHeight;
        const ctx=canvasEl.getContext('2d'); ctx.drawImage(img,0,0);
        const patch=document.createElement('canvas'); patch.width=source.w; patch.height=source.h;
        patch.getContext('2d').drawImage(img,source.x,source.y,source.w,source.h,0,0,source.w,source.h);
        ctx.fillStyle=averageBorderColor(ctx,source,canvasEl.width,canvasEl.height); ctx.fillRect(source.x,source.y,source.w,source.h);
        ctx.save(); ctx.shadowColor='rgba(0,0,0,.12)'; ctx.shadowBlur=Math.max(2,Math.min(target.w,target.h)*.02);
        ctx.drawImage(patch,target.x,target.y,target.w,target.h); ctx.restore();
        const base=(image.name||'image').replace(/\.[^.]+$/,'');
        const file=await uploadCanvas(canvasEl,`${base}_move_scale.png`);
        if(file&&replaceEditedImage(file)){closeImageEditor();render();scheduleSave();toast('已应用移动缩放');}
    }
    function loadImage(url){
        return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=displayMediaUrl({url});});
    }
    function drawPerspective(ctx,img,quad,steps=12){
        const bilinear=(u,v)=>({x:(1-u)*(1-v)*quad[0].x+u*(1-v)*quad[1].x+u*v*quad[2].x+(1-u)*v*quad[3].x,y:(1-u)*(1-v)*quad[0].y+u*(1-v)*quad[1].y+u*v*quad[2].y+(1-u)*v*quad[3].y});
        for(let y=0;y<steps;y++) for(let x=0;x<steps;x++){
            const u=x/steps,v=y/steps,u2=(x+1)/steps,v2=(y+1)/steps;
            [[bilinear(u,v),bilinear(u2,v),bilinear(u2,v2),u,v,u2,v2],[bilinear(u,v),bilinear(u2,v2),bilinear(u,v2),u,v,u2,v2]].forEach(t=>{
                const [a,b,c,su,sv,eu,ev]=t, sx=su*img.naturalWidth, sy=sv*img.naturalHeight, sw=(eu-su)*img.naturalWidth, sh=(ev-sv)*img.naturalHeight;
                ctx.save();ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);ctx.closePath();ctx.clip();
                const den=sx*(sy+sh)+ (sx+sw)*sy + (sx+sw)*(sy+sh) - (sx+sw)*(sy+sh) - (sx+sw)*sy - sx*(sy+sh);
                ctx.transform((b.x-a.x)/sw,(b.y-a.y)/sw,(c.x-b.x)/sh,(c.y-b.y)/sh,a.x-sx*(b.x-a.x)/sw-sy*(c.x-b.x)/sh,a.y-sx*(b.y-a.y)/sw-sy*(c.y-b.y)/sh);
                ctx.drawImage(img,0,0);ctx.restore();
            });
        }
    }
    async function addHelperReference(node, file, name){
        if(!file?.url) return;
        const refs=Array.isArray(node.manualInputRefs)?node.manualInputRefs.slice():[];
        if(!refs.some(ref=>ref.url===file.url)) refs.push({url:file.url,name:file.name||name,kind:'image',manualAdded:true,helperRole:name});
        node.manualInputRefs=refs;
    }
    async function applyLocalRepair(){
        const ref=selectedReference('localRepairReferenceSelect');
        if(!ref){toast('请先选择正确参考图');return;}
        const {node,image}=currentEditImage(), target=byId('cropImage');
        if(!node||!image||!target?.naturalWidth)return;
        const scale=naturalScale(), quad=(state.repairQuad||defaultQuad()).map(p=>({x:p.x*scale.x,y:p.y*scale.y}));
        const mask=document.createElement('canvas');mask.width=target.naturalWidth;mask.height=target.naturalHeight;
        const m=mask.getContext('2d');m.fillStyle='#000';m.fillRect(0,0,mask.width,mask.height);m.fillStyle='#fff';m.beginPath();quad.forEach((p,i)=>i?m.lineTo(p.x,p.y):m.moveTo(p.x,p.y));m.closePath();m.fill();
        const guide=document.createElement('canvas');guide.width=target.naturalWidth;guide.height=target.naturalHeight;
        const g=guide.getContext('2d');g.drawImage(target,0,0);
        try{drawPerspective(g,await loadImage(ref.url),quad);}catch(_){toast('正确参考图加载失败');return;}
        const base=(image.name||'image').replace(/\.[^.]+$/,'');
        const [maskFile,guideFile]=await Promise.all([uploadCanvas(mask,`${base}_repair_mask.png`),uploadCanvas(guide,`${base}_repair_guide.png`)]);
        await addHelperReference(node,ref,'正确参考图');await addHelperReference(node,maskFile,'局部修复遮罩');await addHelperReference(node,guideFile,'透视定位参考');
        setPromptDraftForNode(node,'严格以“正确参考图”为唯一正确的文字、标签和 Logo 来源，只修复白色遮罩区域；按照透视定位参考的位置、大小和四点透视贴合，保持其他区域、产品结构、光影和背景完全不变，只在边缘做自然融合。');
        closeImageEditor();render();updateComposer();scheduleSave();toast('局部修复参考已准备，可点击运行生成');
    }
    function smartEditMarkerGuide(target, regions){
        const guide=document.createElement('canvas');
        guide.width=target.naturalWidth; guide.height=target.naturalHeight;
        const ctx=guide.getContext('2d');
        if(!ctx) return null;
        ctx.drawImage(target,0,0);
        const radius=Math.max(12,Math.min(guide.width,guide.height)*.018);
        regions.forEach((region,index)=>{
            const x=region.x*guide.width, y=region.y*guide.height;
            const w=region.w*guide.width, h=region.h*guide.height;
            ctx.save();
            ctx.lineWidth=Math.max(2,radius*.15);ctx.strokeStyle='#1677ff';ctx.strokeRect(x,y,w,h);
            const cx=clamp(x+radius,radius,guide.width-radius), cy=clamp(y+radius,radius,guide.height-radius);
            ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);
            ctx.fillStyle='#1677ff';ctx.fill();
            ctx.fillStyle='#fff';ctx.font=`bold ${Math.round(radius*1.2)}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(index+1),cx,cy);
            ctx.restore();
        });
        return guide;
    }
    async function applySmartEdit(){
        if(state.smartBusy) return;
        if(state.smartDraft){toast('请先确认或取消当前区域的修改，再统一发送');byId('smartEditRegionPrompt').focus();return;}
        const promptEl=byId('smartEditPrompt');
        const prompt=String(promptEl?.value || state.smartPrompt || '').trim();
        const regions=state.smartRegions.map(region=>({...region}));
        if(!prompt && !regions.length){
            toast('请先框选区域并填写要求，或输入整图修改要求');
            promptEl?.focus();
            return;
        }
        if(!collabCanMutateCanvas()) return;
        const {node,image,index}=currentEditImage(), target=byId('cropImage');
        if(!node||!image||!target?.naturalWidth){toast('当前图片尚未加载完成，请稍后再试');return;}
        const session=state.smartSession;
        const sourceUrl=smartOriginalMediaUrl(image);
        const width=target.naturalWidth, height=target.naturalHeight;
        const sourceRef={...image,url:sourceUrl,nodeId:node.id,imageIndex:index,name:'智能改图原图',kind:'image',width,height};
        state.smartBusy=true;
        renderSmartMarkers();
        try{
            let markerFile=null;
            if(regions.length){
                const guide=smartEditMarkerGuide(target,regions);
                markerFile=guide ? await uploadCanvas(guide,`${(image.name||'image').replace(/\.[^.]+$/,'')}_smart_edit_regions.png`) : null;
                if(!markerFile?.url) throw new Error('区域参考图上传失败，请重试');
            }
            // 上传期间关闭或切换图片时，不再提交旧会话的生成任务。
            if(session!==state.smartSession || imageEditMode!=='smart-edit') return;
            if(!collabCanMutateCanvas() || !nodes.includes(node)) return;
            pushUndo();
            const rect=nodeRect(node);
            const outputNode=createPaintNodeAt({x:rect.x+rect.width+260,y:rect.y+rect.height/2},{select:true,skipUndo:true,title:'智能改图'});
            if(!outputNode) return;
            if(!connectInputNode(node.id,outputNode.id)){
                const createdIndex=nodes.indexOf(outputNode);
                if(createdIndex>=0) nodes.splice(createdIndex,1);
                canvas.connections=(canvas.connections||[]).filter(connection=>connection.from!==outputNode.id&&connection.to!==outputNode.id);
                selectedId=node.id;selectedIds=[];selectedImage={nodeId:node.id,index};render();scheduleSave();
                toast('当前图片无法作为智能改图输入');
                return;
            }
            const regionInstructions=regions.map((region,i)=>{
                const x=Math.round(region.x*width), y=Math.round(region.y*height);
                const right=Math.round((region.x+region.w)*width), bottom=Math.round((region.y+region.h)*height);
                return `区域 ${i+1}（原图像素范围：左上 ${x},${y}，右下 ${right},${bottom}）：${region.prompt}`;
            });
            const finalPrompt=[
                `编辑图1“智能改图原图”，原图尺寸 ${width}×${height}。`,
                regions.length ? '图2“智能改图区域图”仅用于定位，蓝色框与编号对应以下各条指令。所有区域在同一张结果中一起修改，不要把框线、编号或标注文字画进结果。' : '',
                ...regionInstructions,
                prompt ? `整图补充要求：${prompt}` : '',
                '除明确要求修改的内容外，保持原图其他内容、构图和比例。输出完整图片。'
            ].filter(Boolean).join('\n');
            outputNode.title='智能改图';
            outputNode.smartEditSource={nodeId:node.id,imageIndex:index,sourceUrl,width,height};
            outputNode.smartEditRegions=regions;
            if(typeof smartSettingsForNode==='function'&&typeof settingsForStorage==='function') outputNode.runSettings=settingsForStorage(smartSettingsForNode(node));
            Object.assign(outputNode.runSettings,{apiKind:'image',imageOperation:'generate',ratio:'source',customRatio:`${width}:${height}`,customRatioWidth:width,customRatioHeight:height});
            if(outputNode.runSettings.resolution==='custom') Object.assign(outputNode.runSettings,{customWidth:width,customHeight:height,customSize:`${width}x${height}`});
            if(markerFile) outputNode.manualInputRefs=[{...markerFile,name:'智能改图区域图',kind:'image',manualAdded:true,helperRole:'智能改图区域图'}];
            setPromptDraftForNode(outputNode,finalPrompt);
            selectedId=outputNode.id;selectedIds=[];selectedImage={nodeId:'',index:-1};
            if(typeof smartSettingsForNode==='function') settings=smartSettingsForNode(outputNode);
            closeImageEditor();render();updateComposer();
            if(promptInput){promptInput.textContent=finalPrompt;promptInput.dataset.preserveDraftOnce='1';}
            scheduleSave();
            await runGeneration('default', [sourceRef,...(outputNode.manualInputRefs||[])], finalPrompt);
        }catch(error){
            if(session===state.smartSession) toast(error?.message || '提交智能改图失败，请重试');
        }finally{
            if(session===state.smartSession){state.smartBusy=false;renderSmartMarkers();}
        }
    }
    const baseApplyImageEdit=window.applyImageEdit;
    window.applyImageEdit=function(){
        if(imageEditMode==='local-move')return applyLocalMove();
        if(imageEditMode==='local-repair')return applyLocalRepair();
        if(imageEditMode==='smart-edit')return applySmartEdit();
        return baseApplyImageEdit();
    };

    function pointFromEvent(event){
        const canvas=byId('cropCanvas').getBoundingClientRect();
        return {x:clamp(event.clientX-canvas.left,0,cropSize().w),y:clamp(event.clientY-canvas.top,0,cropSize().h)};
    }
    function smartPointFromEvent(event){
        const rect=byId('cropImage').getBoundingClientRect();
        return {x:clamp((event.clientX-rect.left)/rect.width,0,1),y:clamp((event.clientY-rect.top)/rect.height,0,1)};
    }
    byId('cropCanvas')?.addEventListener('pointerdown',event=>{
        if(imageEditMode!=='smart-edit' || event.button!==0 || event.target.closest('button'))return;
        event.preventDefault();event.stopPropagation();
        if(state.smartBusy)return;
        if(state.smartDraft){toast('请先确认或取消当前区域的修改');byId('smartEditRegionPrompt').focus();return;}
        if(state.smartRegions.length>=9){toast('最多添加 9 个区域');return;}
        const img=byId('cropImage');
        if(!img.complete || !img.naturalWidth)return;
        const rect=img.getBoundingClientRect();
        if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)return;
        const point=smartPointFromEvent(event);
        state.drag={type:'smart-region',start:point,pointerId:event.pointerId};
        state.smartDraft={index:state.smartRegions.length,x:point.x,y:point.y,w:0,h:0,prompt:''};
        event.currentTarget.setPointerCapture?.(event.pointerId);
        renderSmartMarkers();
    },true);
    byId('localRepairQuad')?.addEventListener('pointerdown',event=>{
        const corner=event.target.closest('[data-repair-corner]');if(!corner)return;
        event.preventDefault();event.stopPropagation();state.drag={type:'repair',index:Number(corner.dataset.repairCorner),pointerId:event.pointerId};corner.setPointerCapture?.(event.pointerId);
    });
    window.addEventListener('pointermove',event=>{
        if(!state.drag)return;
        if(state.drag.type==='smart-region'){
            if(event.pointerId!==state.drag.pointerId)return;
            const p=smartPointFromEvent(event),start=state.drag.start;
            Object.assign(state.smartDraft,{x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)});
            renderSmartMarkers();return;
        }
        if(state.drag.type==='repair'){state.repairQuad=state.repairQuad||defaultQuad();state.repairQuad[state.drag.index]=pointFromEvent(event);renderQuad();return;}
    });
    function finishSmartDrag(event){
        if(state.drag?.type!=='smart-region'){state.drag=null;return;}
        if(event.pointerId!==state.drag.pointerId)return;
        state.drag=null;
        const rect=byId('cropImage').getBoundingClientRect();
        if(event.type==='pointercancel' || state.smartDraft.w*rect.width<6 || state.smartDraft.h*rect.height<6){
            state.smartDraft=null;
        }else{
            byId('smartEditRegionPrompt').value='';
        }
        renderSmartMarkers();
        if(state.smartDraft)byId('smartEditRegionPrompt').focus();
    }
    window.addEventListener('pointerup',finishSmartDrag);
    window.addEventListener('pointercancel',finishSmartDrag);
    window.addEventListener('resize',()=>{if(imageEditMode==='smart-edit')renderSmartMarkers();});
    byId('smartEditRegionEditor')?.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelSmartEditRegion();}
        if(event.key==='Enter' && (event.ctrlKey||event.metaKey) && !event.isComposing){event.preventDefault();event.stopPropagation();confirmSmartEditRegion();}
    });
    byId('smartEditPrompt')?.addEventListener('input',event=>{state.smartPrompt=event.target.value;});
})();
