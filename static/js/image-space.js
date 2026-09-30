/* Shared image-space filters, saved queries and manual classification editor. */
function imageSpaceMatches(item, filters){
    const c = item.classification || {}, categories = c.categories || {}, tags = c.tags || [];
    const ext = String(item.url || item.name || '').split('?')[0].split('.').pop().toLowerCase();
    const kind = ['image','video','audio','text'].includes(item.kind) ? item.kind : (/^(mp4|webm|mov|m4v|avi|mkv)$/.test(ext) ? 'video' : 'image');
    if(filters.kind && filters.kind !== kind) return false;
    if(filters.format && !filters.format.toLowerCase().split(',').includes(ext)) return false;
    for(const dimension of ['color','materials','style','use_case','tags']){
        const wanted = String(filters[dimension] || '').split(/[,，、\n]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
        const actual = (dimension === 'tags' ? tags : categories[dimension] || []).map(t => String(t).toLowerCase());
        if(wanted.length && !wanted.some(t => actual.includes(t))) return false;
    }
    const w = Number(item.width || item.natural_w || 0), h = Number(item.height || item.natural_h || 0);
    if((filters.shape || Number(filters.min_edge)) && !(w && h)) return false;
    if(Number(filters.min_edge) && Math.min(w,h) < Number(filters.min_edge)) return false;
    if(filters.shape === 'landscape' && w <= h || filters.shape === 'portrait' && w >= h || filters.shape === 'square' && w !== h) return false;
    if(filters.annotated === 'manual' && !Object.keys(c.manual || {}).length) return false;
    if(filters.annotated === 'missing' && (tags.length || Object.keys(categories).length || c.summary)) return false;
    const text = [item.name,item.url,item.folder,item.rel,item.file,c.summary,...tags,...Object.values(categories).flat()].join(' ').toLowerCase();
    return String(filters.query || '').trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}
const imageSpaceState = {filters:{assets:{},local:{},generated:{}}, all:{assets:false,local:false,generated:false}, open:false, collections:[], collectionId:'', editor:null};
const imageSpaceDimensions = {environment:'环境',scene:'场景',space:'空间',subject:'主体',model:'模特',people:'人物',style:'风格',lighting:'光影',color:'色彩',composition:'构图',mood:'氛围',use_case:'用途',objects:'物体',materials:'材质',quality:'质量'};
function imageSpaceSource(){ return ['assets','local','generated'].includes(activeTab) ? activeTab : ''; }
function imageSpaceQuery(){ return activeTab === 'assets' ? assetQuery : activeTab === 'local' ? localUploadQuery : generatedAssetsState.query; }
function imageSpaceFilters(){ return {...imageSpaceState.filters[imageSpaceSource()],query:imageSpaceQuery()}; }
function imageSpaceReadFilterForm(){
    const form = root.querySelector('[data-space-form]');
    if(!form) return;
    const filters = {};
    form.querySelectorAll('[data-space-filter]').forEach(input => { if(input.value) filters[input.dataset.spaceFilter] = input.value; });
    imageSpaceState.filters[imageSpaceSource()] = filters;
}
function imageSpaceAskCollectionName(value=''){
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'image-space-dialog';
        dialog.innerHTML = `<form method="dialog"><strong>保存智能合集</strong><label>合集名称<input name="collectionName" maxlength="80" required value="${escapeAttr(value)}"></label><div class="asset-tools"><button class="asset-btn primary" value="save">保存</button><button class="asset-btn" value="cancel" formnovalidate>取消</button></div></form>`;
        dialog.addEventListener('close', () => {
            const name = dialog.returnValue === 'save' ? dialog.querySelector('input').value.trim() : null;
            dialog.remove(); resolve(name);
        }, {once:true});
        document.body.append(dialog); dialog.showModal(); dialog.querySelector('input').select();
    });
}
function imageSpaceSetQuery(value){
    if(activeTab === 'assets') assetQuery = value;
    else if(activeTab === 'local') localUploadQuery = value;
    else generatedAssetsState.query = value;
}
function imageSpaceCollectionPayload(name){
    const source = imageSpaceSource(), all = imageSpaceState.all[source];
    const filters = imageSpaceFilters();
    if(source === 'generated' && generatedAssetsState.mediaType !== 'all') filters.kind = generatedAssetsState.mediaType;
    return {name,source,library_id:source === 'assets' ? activeAssetLibraryId : '',category_id:source === 'assets' && !all ? activeAssetCategoryId : '',folder:all ? '' : source === 'local' ? activeLocalUploadFolder : source === 'generated' ? generatedAssetsState.folder : '',filters};
}
function renderImageSpaceCollections(){
    const source = imageSpaceSource();
    return `<div class="image-space-collections"><strong>智能合集</strong>${imageSpaceState.collections.filter(c => c.source === source).map(c => `<button type="button" class="tree-row ${imageSpaceState.collectionId === c.id ? 'active' : ''}" data-space-collection="${escapeAttr(c.id)}"><span class="tree-row-icon"><i data-lucide="list-filter"></i></span><span class="tree-row-name">${escapeHtml(c.name)}</span></button>`).join('') || '<p>保存常用筛选，快速找图。</p>'}</div>`;
}
function renderImageSpaceFilterBar(){
    const source = imageSpaceSource(), f = imageSpaceState.filters[source];
    const option = (value,label,current) => `<option value="${value}" ${String(current || '') === value ? 'selected' : ''}>${label}</option>`;
    const select = (key,label,values) => `<label>${label}<select data-space-filter="${key}">${values.map(([v,l]) => option(v,l,f[key])).join('')}</select></label>`;
    const available = source === 'assets' ? assetCategories().flatMap(c => c.items || []) : source === 'local' ? localAssets : generatedAssetsState.items;
    const field = (key,label) => {
        const tags = [...new Set(available.flatMap(item => key === 'tags' ? item.classification?.tags || [] : item.classification?.categories?.[key] || []))].sort();
        return `<label>${label}<input data-space-filter="${key}" list="space-${key}" value="${escapeAttr(f[key] || '')}" placeholder="不限"><datalist id="space-${key}">${tags.map(tag => `<option value="${escapeAttr(tag)}"></option>`).join('')}</datalist></label>`;
    };
    const count = Object.values(f).filter(Boolean).length;
    const collection = imageSpaceState.collections.find(c => c.id === imageSpaceState.collectionId && c.source === source);
    const moreCount = ['kind','format','min_edge','annotated','materials','style','use_case'].filter(key => f[key]).length;
    return `<div class="image-space-filter-bar"><div class="asset-tools"><button class="asset-btn" type="button" data-space-toggle aria-expanded="${imageSpaceState.open}"><i data-lucide="sliders-horizontal"></i>筛选${count ? ` · ${count}` : ''}</button>${count || imageSpaceQuery() ? '<button class="asset-btn space-quiet" type="button" data-space-clear>清除</button>' : ''}<span class="space-toolbar-spacer"></span><button class="asset-btn space-quiet" type="button" data-space-save><i data-lucide="bookmark-plus"></i>保存合集</button>${collection ? '<details class="space-collection-menu"><summary aria-label="合集操作">···</summary><div><button type="button" data-space-update>更新名称与条件</button><button type="button" data-space-delete>删除合集</button></div></details>' : ''}</div>
    ${imageSpaceState.open ? `<form class="image-space-filter-form" data-space-form>
    <div class="space-filter-fields">${field('color','色彩')}${select('shape','形状',[['','不限'],['landscape','横图'],['portrait','竖图'],['square','正方形']])}${field('tags','标签')}</div>
    <details class="space-more"><summary>更多条件${moreCount ? ` · ${moreCount}` : ''}</summary><div class="space-filter-fields">
    ${select('kind','类型',[['','不限'],['image','图片'],['video','视频'],['audio','音频'],['text','文本']])}
    ${select('format','格式',[['','不限'],['png','PNG'],['jpg,jpeg','JPG'],['webp','WebP'],['gif','GIF'],['mp4','MP4']])}
    ${select('min_edge','最短边',[['','不限'],['1000','至少 1000 px'],['2000','至少 2000 px'],['4000','至少 4000 px']])}
    ${field('materials','材质')}${field('style','风格')}${field('use_case','用途')}
    ${select('annotated','分类状态',[['','不限'],['manual','有人工修订'],['missing','尚未分类']])}</div><p class="image-space-note">多个值用逗号分隔，同一项满足任意一个。</p></details>
    <div class="space-filter-footer"><label class="image-space-scope"><input type="checkbox" data-space-all ${imageSpaceState.all[source] ? 'checked' : ''}>${source === 'assets' ? '整个资产库' : '全部文件夹'}</label><button class="asset-btn primary" type="submit">应用</button></div></form>` : ''}</div>`;
}
function renderImageSpaceClassification(item){
    const c = item.classification || {}, manual = Object.keys(c.manual || {}).length;
    return `<div class="detail-caption-card image-space-classification"><div class="detail-caption-head"><strong>分类与标签</strong><button class="asset-btn" type="button" data-space-edit="${escapeAttr(item.id)}">编辑</button></div><div class="detail-classification-body">${c.summary ? `<p>${escapeHtml(c.summary)}</p>` : ''}${(c.flat || []).map(t => `<span class="classification-chip">${escapeHtml(t.label)} · ${escapeHtml(t.tag)}</span>`).join('') || '<span class="classification-empty">暂无分类，可手动填写或使用智能分类。</span>'}<p class="image-space-note">${manual ? '人工修订已保留' : ''}</p></div></div>`;
}
function imageSpaceCurrentItem(id){ return activeTab === 'assets' ? findAssetItem(id) : activeTab === 'local' ? findLocalUpload(id) : findGeneratedAsset(id); }
function openImageSpaceEditor(item){
    const c = item.classification || {}, manual = c.manual || {};
    imageSpaceState.editor = {item,source:activeTab};
    document.getElementById('imageSpaceEditor')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'imageSpaceEditor';
    dialog.className = 'image-space-dialog';
    dialog.innerHTML = `<form method="dialog"><div class="detail-caption-head"><strong>编辑分类 · ${escapeHtml(item.name || '素材')}</strong><button class="asset-btn" value="cancel">关闭</button></div><p>你的修改会保留，重新分析时不会被覆盖。</p><label>画面说明<textarea name="summary" maxlength="240">${escapeHtml(c.summary || '')}</textarea></label><label>标签（逗号分隔，最多 20 个）<input name="tags" value="${escapeAttr((c.tags || []).join('，'))}"></label><details class="space-more"><summary>详细分类</summary><div class="image-space-editor-fields">${Object.entries(imageSpaceDimensions).map(([key,label]) => `<label>${label}${Object.hasOwn(manual.categories || {},key) ? ' · 人工' : ''}<input name="category:${key}" value="${escapeAttr((c.categories?.[key] || []).join('，'))}" placeholder="逗号分隔，最多 8 个"></label>`).join('')}</div></details><p class="image-space-editor-error" role="alert"></p><div class="asset-tools"><button class="asset-btn primary" type="button" data-space-editor-save>保存修订</button><button class="asset-btn" type="button" data-space-editor-reset ${Object.keys(manual).length ? '' : 'disabled'}>恢复为 AI 分类</button></div></form>`;
    dialog.addEventListener('click', async event => {
        const reset = event.target.closest('[data-space-editor-reset]');
        const save = event.target.closest('[data-space-editor-save]');
        if(!reset && !save) return;
        if(reset && !confirm('清除这张素材的人工修订，恢复为最近一次 AI 分类？')) return;
        const button = reset || save;
        button.disabled = true;
        try {
            let next = null;
            if(!reset){
                next = JSON.parse(JSON.stringify(manual));
                const split = value => [...new Set(value.split(/[,，、\n]+/).map(t => t.trim()).filter(Boolean))];
                const form = dialog.querySelector('form');
                const summary = form.elements.namedItem('summary').value.trim();
                if(summary !== (c.summary || '')) next.summary = summary;
                const tags = split(form.elements.namedItem('tags').value);
                if(tags.length > 20 || tags.some(t => t.length > 24)) throw new Error('标签最多 20 个，每个不超过 24 字。');
                if(JSON.stringify(tags) !== JSON.stringify(c.tags || [])) next.tags = tags;
                for(const key of Object.keys(imageSpaceDimensions)){
                    const values = split(form.elements.namedItem(`category:${key}`).value);
                    if(values.length > 8 || values.some(t => t.length > 24)) throw new Error('每个维度最多 8 个标签，每个不超过 24 字。');
                    if(JSON.stringify(values) !== JSON.stringify(c.categories?.[key] || [])){
                        next.categories ||= {};
                        next.categories[key] = values;
                    }
                }
            }
            const data = await apiJson('/api/image-space/classification',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:imageSpaceState.editor.source,id:item.id,manual:next})});
            item.classification = data.classification;
            dialog.close(); dialog.remove();
            await imageSpaceRefresh();
            setStatus('分类已保存');
        } catch(error){ dialog.querySelector('[role="alert"]').textContent = error.message || '保存失败，请重试'; button.disabled = false; }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
}
async function imageSpaceRefresh(){
    selectedAssetIds.clear(); selectedLocalUploadIds.clear(); generatedAssetsState.selectedIds.clear();
    if(activeTab === 'generated') await loadGeneratedAssets();
    else render();
}
async function handleImageSpaceClick(target){
    if(target.closest('[data-space-toggle]')){ imageSpaceState.open = !imageSpaceState.open; render(); return true; }
    if(target.closest('[data-space-clear]')){ imageSpaceState.filters[activeTab] = {}; imageSpaceSetQuery(''); imageSpaceState.collectionId = ''; if(activeTab === 'generated') generatedAssetsState.mediaType = 'all'; await imageSpaceRefresh(); return true; }
    const edit = target.closest('[data-space-edit]');
    if(edit){ const item = imageSpaceCurrentItem(edit.dataset.spaceEdit); if(item) openImageSpaceEditor(item); return true; }
    const collection = target.closest('[data-space-collection]');
    if(collection){
        const c = imageSpaceState.collections.find(c => c.id === collection.dataset.spaceCollection);
        if(!c) return true;
        if(c.source === 'assets' && (!assetLibraries().some(l => l.id === c.library_id) || c.category_id && !assetLibraries().find(l => l.id === c.library_id)?.categories?.some(cat => cat.id === c.category_id))) throw new Error('该合集的资产库或分组已被删除，请重新保存筛选条件。');
        imageSpaceState.collectionId = c.id;
        imageSpaceState.filters[activeTab] = {...c.filters}; delete imageSpaceState.filters[activeTab].query;
        imageSpaceSetQuery(c.filters.query || '');
        imageSpaceState.all[activeTab] = activeTab === 'assets' ? !c.category_id : !c.folder;
        if(activeTab === 'assets'){ activeAssetLibraryId = c.library_id; activeAssetCategoryId = c.category_id; }
        else if(activeTab === 'local') activeLocalUploadFolder = c.folder;
        else { generatedAssetsState.folder = c.folder; generatedAssetsState.mediaType = 'all'; }
        imageSpaceState.open = false;
        await imageSpaceRefresh(); return true;
    }
    const save = target.closest('[data-space-save]'), update = target.closest('[data-space-update]'), remove = target.closest('[data-space-delete]');
    if(save || update || remove){
        const current = imageSpaceState.collections.find(c => c.id === imageSpaceState.collectionId);
        if((update || remove) && !current) return true;
        let name;
        if(remove){ if(!confirm(`删除合集“${current.name}”？素材文件会保留。`)) return true; }
        else {
            imageSpaceReadFilterForm();
            name = await imageSpaceAskCollectionName(update ? current.name : '');
            if(name === null) return true;
            if(!name) throw new Error('请输入合集名称');
        }
        const data = await apiJson(`/api/image-space/collections${save ? '' : `/${encodeURIComponent(current.id)}`}`,{method:remove ? 'DELETE' : update ? 'PATCH' : 'POST',headers:{'Content-Type':'application/json'},...(remove ? {} : {body:JSON.stringify(imageSpaceCollectionPayload(name.trim()))})});
        imageSpaceState.collections = data.collections;
        imageSpaceState.collectionId = data.item?.id || '';
        await imageSpaceRefresh(); return true;
    }
    return false;
}
