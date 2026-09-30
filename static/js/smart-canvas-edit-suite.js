(function(){
    'use strict';

    const CUSTOM_MODES = new Set(['local-move', 'local-repair', 'point-replace']);
    const state = {
        moveSource:null,
        repairQuad:null,
        pointRect:null,
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
        ['localRepairReferenceSelect','pointReplaceReferenceSelect'].forEach(id => {
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
    function renderPoint(){
        const box = byId('pointReplaceBox');
        const visible = imageEditMode === 'point-replace' && state.pointRect;
        box?.classList.toggle('active', Boolean(visible));
        if(visible) positionRect(box, state.pointRect);
    }
    function syncCustomUi(){
        document.querySelectorAll('[data-image-edit-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.imageEditMode === imageEditMode));
        ['imageCropTools','imageMaskTools','imageBrushTools','imageResizeTools','imageGridTools'].forEach(id => byId(id)?.classList.remove('active'));
        byId('imageLocalMoveTools')?.classList.toggle('active', imageEditMode === 'local-move');
        byId('imageLocalRepairTools')?.classList.toggle('active', imageEditMode === 'local-repair');
        byId('imagePointReplaceTools')?.classList.toggle('active', imageEditMode === 'point-replace');
        const meta = {
            'local-move':['移动与缩放','框选对象并确认，再移动或缩放目标框','move-3d','应用移动缩放'],
            'local-repair':['局部修复','选择唯一正确参考图，调整四点透视后生成修复参考','wand-sparkles','准备局部修复'],
            'point-replace':['定点替换','点击目标并微调蓝色识别框','scan-search','准备定点替换']
        }[imageEditMode];
        if(meta){
            byId('imageEditTitle').textContent=meta[0]; byId('imageEditSub').textContent=meta[1];
            byId('imageEditApplyBtn').innerHTML=`<i data-lucide="${meta[2]}" class="w-4 h-4"></i><span>${meta[3]}</span>`;
        }
        renderMove(); renderQuad(); renderPoint(); refreshIcons();
    }

    const baseSetImageEditMode = window.setImageEditMode;
    window.setImageEditMode = function(mode, userTouched=false){
        if(!CUSTOM_MODES.has(mode)) return baseSetImageEditMode(mode, userTouched);
        baseSetImageEditMode('crop', userTouched);
        imageEditMode = mode;
        if(mode === 'local-move') resetLocalMoveEdit();
        if(mode === 'local-repair') resetLocalRepairEdit();
        if(mode === 'point-replace') resetPointReplaceEdit();
        syncReferenceSelects();
        syncCustomUi();
    };
    const baseOpenImageEditor = window.openImageEditor;
    window.openImageEditor = function(...args){
        state.moveSource=null; state.repairQuad=null; state.pointRect=null; state.drag=null;
        return baseOpenImageEditor(...args);
    };
    const baseResizeEditDrawCanvas = window.resizeEditDrawCanvas;
    window.resizeEditDrawCanvas = function(...args){
        const result = baseResizeEditDrawCanvas(...args);
        renderMove(); renderQuad(); renderPoint();
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
    window.resetPointReplaceEdit = function(){
        state.pointRect=null; requestAnimationFrame(renderPoint);
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
    async function applyPointReplace(){
        const ref=selectedReference('pointReplaceReferenceSelect');
        if(!state.pointRect){toast('请先点击图片确定替换区域');return;}
        if(!ref){toast('请先选择替换参考图');return;}
        const {node,image}=currentEditImage(), target=byId('cropImage');if(!node||!target?.naturalWidth)return;
        const rect=naturalRect(state.pointRect), guide=document.createElement('canvas');guide.width=target.naturalWidth;guide.height=target.naturalHeight;
        const ctx=guide.getContext('2d');ctx.drawImage(target,0,0);ctx.strokeStyle='#1677ff';ctx.lineWidth=Math.max(4,guide.width/300);ctx.setLineDash([14,10]);ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);
        ctx.fillStyle='#1677ff';ctx.font=`bold ${Math.max(24,guide.width/32)}px sans-serif`;ctx.fillText('替换区域',rect.x,Math.max(32,rect.y-10));
        const base=(image?.name||'image').replace(/\.[^.]+$/,'');const file=await uploadCanvas(guide,`${base}_replace_guide.png`);
        await addHelperReference(node,ref,'替换目标参考图');await addHelperReference(node,file,'定点替换定位图');
        setPromptDraftForNode(node,'把“定点替换定位图”蓝色虚线框内的物品，替换为“替换目标参考图”中的主体。严格保持蓝框外画面、构图、背景、文字、光影和其他物体不变；新物品需匹配蓝框的位置、尺寸、视角和原场景光照。');
        closeImageEditor();render();updateComposer();scheduleSave();toast('定点替换参考已准备，可点击运行生成');
    }
    const baseApplyImageEdit=window.applyImageEdit;
    window.applyImageEdit=function(){
        if(imageEditMode==='local-move')return applyLocalMove();
        if(imageEditMode==='local-repair')return applyLocalRepair();
        if(imageEditMode==='point-replace')return applyPointReplace();
        return baseApplyImageEdit();
    };

    function pointFromEvent(event){
        const canvas=byId('cropCanvas').getBoundingClientRect();
        return {x:clamp(event.clientX-canvas.left,0,cropSize().w),y:clamp(event.clientY-canvas.top,0,cropSize().h)};
    }
    byId('cropCanvas')?.addEventListener('click',event=>{
        if(imageEditMode!=='point-replace'||event.target.closest('#pointReplaceBox'))return;
        const p=pointFromEvent(event),size=cropSize(),w=Math.max(48,size.w*.28),h=Math.max(48,size.h*.28);
        state.pointRect={x:clamp(p.x-w/2,0,size.w-w),y:clamp(p.y-h/2,0,size.h-h),w,h};renderPoint();
    });
    byId('localRepairQuad')?.addEventListener('pointerdown',event=>{
        const corner=event.target.closest('[data-repair-corner]');if(!corner)return;
        event.preventDefault();event.stopPropagation();state.drag={type:'repair',index:Number(corner.dataset.repairCorner),pointerId:event.pointerId};corner.setPointerCapture?.(event.pointerId);
    });
    byId('pointReplaceBox')?.addEventListener('pointerdown',event=>{
        event.preventDefault();event.stopPropagation();
        const handle=event.target.closest('[data-box-handle]')?.dataset.boxHandle||'move';
        state.drag={type:'point',handle,start:pointFromEvent(event),rect:copyRect(state.pointRect),pointerId:event.pointerId};event.currentTarget.setPointerCapture?.(event.pointerId);
    });
    window.addEventListener('pointermove',event=>{
        if(!state.drag)return;
        if(state.drag.type==='repair'){state.repairQuad=state.repairQuad||defaultQuad();state.repairQuad[state.drag.index]=pointFromEvent(event);renderQuad();return;}
        const p=pointFromEvent(event),d=state.drag,r=copyRect(d.rect),dx=p.x-d.start.x,dy=p.y-d.start.y,size=cropSize(),min=24;
        if(d.handle==='move'){r.x=clamp(r.x+dx,0,size.w-r.w);r.y=clamp(r.y+dy,0,size.h-r.h);}
        else {if(d.handle.includes('e'))r.w=clamp(r.w+dx,min,size.w-r.x);if(d.handle.includes('s'))r.h=clamp(r.h+dy,min,size.h-r.y);if(d.handle.includes('w')){const nx=clamp(r.x+dx,0,r.x+r.w-min);r.w+=r.x-nx;r.x=nx;}if(d.handle.includes('n')){const ny=clamp(r.y+dy,0,r.y+r.h-min);r.h+=r.y-ny;r.y=ny;}}
        state.pointRect=r;renderPoint();
    });
    window.addEventListener('pointerup',()=>{state.drag=null;});
})();
