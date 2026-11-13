(function (global) {
    'use strict';

    const unassigned = '__unassigned__';
    const localPrefix = '/api/storage-files/local/';
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    function relativeFile(url) {
        try {
            const parsed = new URL(url || '', global.location.href);
            if (parsed.origin !== global.location.origin && !loopback.has(parsed.hostname)) return '';
            if (parsed.pathname.startsWith(localPrefix)) {
                return decodeURIComponent(parsed.pathname.slice(localPrefix.length)).replace(/\\/g, '/').toLowerCase();
            }
        } catch (_) { /* Older records may contain invalid addresses. */ }
        return '';
    }
    function create({source, canvasSource, folderAt, branch, mediaTree, projectTree, matches,
        kind, label, size, date, thumbnail, favorite, classification, annotation}) {
        const doc = global.document.createElement('template').content.ownerDocument;
        let priorFiles, priorCanvases, cache;

        function index() {
            const files = source();
            const data = canvasSource();
            if (cache && files === priorFiles && data === priorCanvases) return cache;
            const projects = new Map(data.projects.map(project => [project.id, {...project, count:0}]));
            const canvases = new Map(data.canvases.map(canvas => [canvas.id, {...canvas, project:canvas.project || 'default', count:0}]));
            const filesByPath = new Map();
            for (const asset of data.items) {
                const path = relativeFile(asset.url);
                if (!path) continue;
                const canvasId = asset.canvas_id || '';
                const canvas = canvases.get(canvasId);
                const projectId = canvas?.project || asset.project || 'default';
                const title = canvas?.title || asset.canvas_title || '';
                if (!projects.has(projectId)) projects.set(projectId, {
                    id:projectId, name:projectId === 'default' ? '默认项目' : '项目 ' + projectId.slice(0, 8), count:0,
                });
                if (!filesByPath.has(path)) filesByPath.set(path, new Map());
                filesByPath.get(path).set(JSON.stringify([projectId, canvasId]), {projectId, canvasId, title});
            }
            const byId = new Map();
            const refs = new Map();
            const counts = {image:0, video:0, audio:0};
            let withoutProject = 0;
            for (const item of files) {
                byId.set(item.id, item);
                const type = kind(item);
                if (type in counts) counts[type]++;
                const links = [...(filesByPath.get(relativeFile(item.url))?.values() || [])];
                refs.set(item.id, links);
                if (!links.length) withoutProject++;
                for (const id of new Set(links.map(link => link.projectId))) projects.get(id).count++;
                for (const id of new Set(links.map(link => link.canvasId))) {
                    const canvas = canvases.get(id);
                    if (canvas) canvas.count++;
                }
            }
            priorFiles = files;
            priorCanvases = data;
            cache = {projects, canvases, byId, refs, counts, withoutProject};
            return cache;
        }
        function items(model, favoritesOnly = false) {
            const {refs} = index();
            const filters = {...model.filters, query:model.query};
            return source().filter(item => {
                if (favoritesOnly && !favorite(item)) return false;
                if (!model.allFolders && model.folder && item.folder !== model.folder) return false;
                if (model.type !== 'all' && kind(item) !== model.type) return false;
                const links = refs.get(item.id);
                if (model.project === unassigned && links.length) return false;
                if (model.project && model.project !== unassigned && !links.some(link =>
                    link.projectId === model.project && (!model.canvas || link.canvasId === model.canvas))) return false;
                return matches(item, filters);
            });
        }
        function scope(model) {
            const {projects, canvases} = index();
            const project = projects.get(model.project);
            if (model.project === unassigned) return {project:unassigned, canvas:''};
            return {project:project?.id || '', canvas:project && canvases.get(model.canvas)?.project === project.id ? model.canvas : ''};
        }
        const projectName = id => index().projects.get(id)?.name || '未归属项目';
        const folderName = (tree, path) => folderAt(tree, path)?.name || path.split('/').at(-1);
        function title(model) {
            if (model.project === unassigned) return '未归属项目';
            if (model.project) return index().canvases.get(model.canvas)?.title || projectName(model.project);
            return folderName(model.tree, model.folder) || '本地上传';
        }

        function element(tag, classes, value) {
            const node = doc.createElement(tag);
            if (classes) node.className = classes;
            if (value != null) node.textContent = value;
            return node;
        }
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function button(action, glyph, {value = '', classes = 'asset-btn', text, title, aria, disabled = false} = {}) {
            const node = element('button', classes);
            node.type = 'button';
            node.setAttribute('data-localup-' + action, value);
            node.disabled = disabled;
            if (title) node.title = title;
            if (aria) node.setAttribute('aria-label', aria);
            if (glyph) node.append(icon(glyph));
            if (text) node.append(element('span', '', text));
            return node;
        }
        function markup(container, html) {
            if (!html) return;
            const fragment = element('template');
            fragment.innerHTML = html;
            container.append(fragment.content);
        }
        function heading(panel, caption, subtitle) {
            const head = element('div', 'panel-head');
            const label = element('div', 'panel-title');
            label.append(element('strong', '', caption), element('span', '', subtitle));
            head.append(label);
            panel.append(head);
            return head;
        }
        function treeRow(action, value, name, glyph, count, classes, indent = false) {
            const row = button(action, '', {value, classes:'tree-row ' + classes});
            const emblem = element('span', 'tree-row-icon');
            emblem.append(icon(glyph));
            if (indent) row.append(element('span', 'tree-elbow'));
            row.append(emblem, element('span', 'tree-row-name', name), element('span', 'tree-row-count', count));
            return row;
        }
        function folderBranch(folder, model, depth = 0) {
            const path = folder.path || '';
            const name = folder.name || '文件夹';
            const active = !model.project && path === model.folder;
            const ancestor = !active && model.folder && (!path || model.folder.startsWith(path + '/'));
            const state = active ? ' active' : ancestor ? ' contains-active' : '';
            const row = treeRow('folder', path, name, active ? 'folder-open' : depth ? 'folder' : 'upload-cloud',
                Number(folder.count || 0), (depth ? 'tree-child' : 'tree-parent') + state, depth > 0);
            if (path) {
                row.draggable = true;
                row.title = '拖动可调整同级文件夹顺序';
            }
            const children = (folder.children || []).map(child => folderBranch(child, model, depth + 1)).join('');
            return branch('local:folder:' + path, name, row.outerHTML, children);
        }
        function navigation(model) {
            const total = source().length;
            const {projects, canvases, counts, withoutProject} = index();
            const panel = element('aside', 'asset-panel asset-nav');
            const head = heading(panel, '本地素材', '资产管理 / 本地素材');
            markup(head, model.folderEditor);
            const controls = element('div', 'panel-actions compact-actions');
            controls.hidden = Boolean(model.folderEditor);
            controls.append(button('folder-new', 'folder-plus', {classes:'asset-icon-btn', title:'新建文件夹'}),
                button('folder-rename', 'pencil', {classes:'asset-icon-btn', title:'重命名文件夹', disabled:!model.folder}),
                button('folder-delete', 'trash-2', {classes:'asset-icon-btn danger', title:'移入回收站', aria:'移入回收站', disabled:!model.folder}));
            head.append(controls);
            const scroll = element('div', 'nav-scroll');
            const tree = element('div', 'nav-tree');
            const stars = treeRow('fav-filter', '', '我的收藏', 'star', model.favoriteCount,
                model.favoritesOnly ? 'tree-parent active contains-active' : 'tree-parent');
            stars.title = '收藏的本地素材';
            tree.append(stars);
            function caption(text) {
                const row = element('div', 'generated-projects-toggle');
                row.append(element('span', '', text));
                tree.append(row);
            }
            caption('按类型');
            markup(tree, mediaTree('local', [['all','全部本地素材','images',total], ['image','图片','image',counts.image],
                ['video','视频','video',counts.video], ['audio','音频','file-audio',counts.audio]], model.type));
            caption('按项目');
            markup(tree, projectTree('local', [{id:'',name:'全部本地素材',count:total}, ...projects.values(),
                {id:unassigned,name:'未归属项目',count:withoutProject}], [...canvases.values()], model.project, model.canvas));
            markup(tree, folderBranch(model.tree || {path:'',name:'全部上传',count:total}, model));
            markup(tree, model.collections);
            scroll.append(tree, element('div', 'nav-hint', '选择图片、视频或音频即可上传。拖动素材到文件夹可移动；拖动文件夹可调整同级顺序。'));
            panel.append(scroll);
            return panel;
        }
        function toolbar(model, count, total) {
            const bar = element('div', 'content-toolbar');
            const caption = element('div', 'content-heading');
            caption.append(element('strong', '', model.favoritesOnly ? '我的收藏 · 本地素材' : title(model)),
                element('span', '', model.favoritesOnly ? '收藏的 ' + count + ' 个本地素材' : count + ' / ' + total + ' 个素材'));
            const controls = element('div', 'asset-tools');
            const search = element('label', 'asset-search-wrap');
            const input = element('input', 'asset-search');
            input.id = 'localUploadSearch';
            input.type = 'search';
            input.defaultValue = model.query;
            input.placeholder = '搜索本地上传';
            search.append(icon('search'), input);
            controls.append(search, button('upload', 'upload', {classes:'asset-btn primary', text:'上传文件'}),
                button('refresh', 'refresh-cw', {text:'刷新'}),
                button('manage', 'list-checks', {classes:model.managing ? 'asset-btn primary' : 'asset-btn',
                    text:model.managing ? '完成管理' : '批量管理', disabled:!total}));
            bar.append(caption, controls);
            return bar;
        }
        function manage(model, visibleCount) {
            const count = model.selection.size;
            const images = model.imageCount;
            const tools = element('div', 'manage-tools local-manage-tools');
            const group = element('div', 'manage-group manage-select-group');
            const actions = element('div', 'asset-tools local-manage-actions');
            for (const [action, glyph, text, enabled] of [
                ['select-all','check-square','全选',visibleCount], ['clear','square','清空',count],
                ['download-selected','download','下载',count], ['canvas-selected','clipboard-paste','复制到画布',count],
                ['cut-selected','scissors','剪切/移动',count], ['move-selected','folder-input','移动',count],
                ['import-selected','folder-input','加入图片资产库',images], ['delete-selected','trash-2','删除',count],
            ]) {
                actions.append(button(action, glyph, {text, disabled:!enabled, classes:action === 'delete-selected' ? 'asset-btn danger' : 'asset-btn'}));
            }
            group.append(element('span', 'manage-group-title', '管理'),
                element('span', 'manage-summary', '已选 ' + count + ' 个，其中 ' + images + ' 张图片'), actions);
            const ai = element('div', 'manage-group manage-ai-group');
            ai.append(element('span', 'manage-group-title', 'AI 处理'));
            markup(ai, model.annotationToolbar);
            ai.append(button('background-selected', 'eraser', {text:'去背景', disabled:!images || model.removingBackground}));
            tools.append(group, ai);
            return tools;
        }
        function uploadCard() {
            const node = button('upload', '', {classes:'upload-grid-card'});
            node.id = 'localUploadDrop';
            const thumb = element('span', 'upload-thumb');
            thumb.append(icon('upload-cloud'));
            const body = element('span', 'upload-body');
            body.append(element('strong', '', '上传本地素材'), element('small', '', '拖入文件或点击上传'));
            node.append(thumb, body);
            return node;
        }
        function card(item, model) {
            const picked = model.selection.has(item.id);
            const node = element('article', 'asset-card' + (model.selected === item.id ? ' active' : '') + (picked ? ' selected' : ''));
            node.dataset.localupCard = item.id;
            node.draggable = true;
            node.title = '拖动到左侧文件夹可移动';
            const check = element('input', 'asset-card-check');
            check.type = 'checkbox';
            check.dataset.localupCheck = item.id;
            check.defaultChecked = picked;
            const media = element('div', 'asset-thumb');
            markup(media, thumbnail(item));
            const star = favorite(item);
            const starLabel = star ? '取消收藏' : '收藏';
            const body = element('div', 'asset-card-body');
            const name = element('div', 'asset-card-name', item.name || '本地素材');
            name.title = item.name || '';
            name.dataset.localupRename = item.id;
            const withCaption = kind(item) === 'image' && String(item.caption || '').trim();
            const links = index().refs.get(item.id);
            const location = links.length ? [...new Set(links.map(link => projectName(link.projectId)))].join('、') : item.folder || '根目录';
            const place = element('div', 'asset-card-meta', location);
            place.title = location;
            const actions = element('div', 'asset-card-actions');
            actions.append(button('preview', 'maximize-2', {value:item.id, classes:'', text:'预览'}),
                button('download', 'download', {value:item.id, classes:'', text:'下载'}));
            body.append(name, element('div', 'asset-card-meta', label(item) + ' · ' + size(item.size) + (withCaption ? ' · 有提示词' : '')), place, actions);
            if (!model.managing) body.append(button('move-one', 'folder-input', {value:item.id, classes:'local-asset-move-button', text:'移动'}));
            node.append(check, media, button('favorite', 'star', {value:item.id, title:starLabel, aria:starLabel,
                classes:'asset-card-quick asset-card-fav' + (star ? ' is-fav' : '')}), body);
            return node;
        }
        function content(model, rows) {
            const total = source().length;
            const panel = element('section', model.managing ? 'asset-panel asset-content manage-on' : 'asset-panel asset-content');
            panel.append(toolbar(model, rows.length, total));
            markup(panel, model.filterBar);
            panel.append(manage(model, rows.length));
            markup(panel, model.clipboard);
            const scroll = element('div', 'content-scroll');
            const gallery = element('div', 'asset-grid');
            if (!model.favoritesOnly) gallery.append(uploadCard());
            for (const item of rows) gallery.append(card(item, model));
            if (!rows.length) gallery.append(element('div', 'empty-state', model.favoritesOnly
                ? '还没有收藏的本地素材。点击素材卡片右上角的 ⭐ 即可收藏。' : '当前文件夹还没有内容，可点击上传。'));
            scroll.append(gallery);
            panel.append(scroll);
            return panel;
        }
        function detail(item) {
            const panel = element('aside', 'asset-panel asset-detail');
            const head = heading(panel, '素材预览', item ? label(item) : '选择一个素材查看详情');
            const scroll = element('div', 'detail-scroll');
            panel.append(scroll);
            if (!item) {
                const empty = element('div', 'detail-empty');
                empty.append(icon('image'), element('span', '', '暂无可预览素材'));
                scroll.append(empty);
                return panel;
            }
            const type = kind(item);
            const tools = element('div', 'panel-actions');
            for (const [action, glyph, name] of [['rename','pencil','重命名'], ['move-one','folder-input','移动到文件夹'],
                ['download','download','下载'], ['copy','link','复制链接']]) {
                tools.append(button(action, glyph, {value:item.id, classes:'asset-icon-btn', title:name, aria:action === 'move-one' ? name : ''}));
            }
            if (type === 'image') tools.append(button('background-one', 'eraser', {value:item.id, classes:'asset-icon-btn', title:'去背景'}));
            tools.append(button('delete-one', 'trash-2', {value:item.id, classes:'asset-icon-btn danger', title:'删除'}));
            head.append(tools);
            const media = element('div', 'detail-media');
            if (type === 'audio') {
                const audio = element('audio');
                audio.controls = true;
                audio.preload = 'metadata';
                audio.src = item.url;
                media.append(audio);
            } else {
                const preview = button('preview', '', {value:item.id, classes:'detail-media-frame detail-media-zoomable', title:'点击放大预览'});
                markup(preview, thumbnail(item));
                media.append(preview);
            }
            const body = element('div', 'detail-body');
            const input = element('input', 'detail-name-input');
            input.type = 'text';
            input.title = '直接修改名称';
            input.dataset.localupInlineName = item.id;
            input.defaultValue = item.name || '本地素材';
            const grid = element('div', 'detail-meta-grid');
            for (const [name, value] of [['类型', label(item)], ['大小', size(item.size)],
                ['上传时间', date(Number(item.created_at || 0) * 1000)], ['来源', '本地上传']]) {
                const field = element('div', 'detail-meta');
                field.append(element('span', '', name), element('strong', '', value));
                grid.append(field);
            }
            body.append(input, grid, element('div', 'detail-url', item.url || ''));
            if (type === 'image') {
                markup(body, classification(item));
                markup(body, annotation(item));
            }
            const links = index().refs.get(item.id);
            if (links?.length) {
                const references = element('div', 'detail-caption-card');
                const header = element('div', 'detail-caption-head');
                header.append(element('strong', '', '关联画布'));
                const chips = element('div', 'detail-classification-body');
                const labels = new Set(links.map(link => [projectName(link.projectId), link.title].filter(Boolean).join(' · ')));
                for (const text of labels) chips.append(element('span', 'classification-chip', text));
                references.append(header, chips);
                body.append(references);
            }
            scroll.append(media, body);
            return panel;
        }
        return {
            items, scope, title,
            find: id => index().byId.get(id) || null,
            render: (model, rows, selected) => navigation(model).outerHTML + content(model, rows).outerHTML + detail(selected).outerHTML,
            detail: item => detail(item).innerHTML,
        };
    }
    global.XiaomeiAssetManagerLocalView = {create};
}(window));
