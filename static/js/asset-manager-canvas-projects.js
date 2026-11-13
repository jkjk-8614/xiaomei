(function (global) {
    'use strict';

    const sortOptions = new Map([
        ['canvas_asc', '画布名称'], ['updated_desc', '最近更新'], ['updated_asc', '最早更新'],
        ['name_asc', '资产名称'], ['kind', '类型'],
    ]);
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    const time = item => Number(item.canvas_updated_at || item.created_at || 0);
    const icons = { image: 'image', video: 'play', audio: 'file-audio', text: 'file-text' };

    function create({ source, thumbnail, kind, label, date, branch }) {
        const dom = global.document.createElement('template').content.ownerDocument;
        let previous;
        let index;

        function catalog() {
            const data = source();
            if (data === previous && index) return index;
            previous = data;
            const projects = new Map();
            const canvases = new Map();
            function project(id) {
                if (!projects.has(id)) projects.set(id, {
                    id, name: id === 'default' ? '默认项目' : '项目 ' + id.slice(0, 8),
                    order: Number.MAX_SAFE_INTEGER, canvases: [], items: [],
                });
                return projects.get(id);
            }
            for (const record of data.projects || []) {
                if (record?.id) projects.set(record.id, { ...record, canvases: [], items: [] });
            }
            for (const canvas of data.canvases || []) {
                if (canvas?.kind !== 'smart' || !canvas.id || canvases.has(canvas.id)) continue;
                const owner = project(canvas.project || 'default');
                const entry = { ...canvas, owner, urls: new Set(), items: [] };
                canvases.set(canvas.id, entry);
                owner.canvases.push(entry);
            }
            const urlsWithoutCanvas = new Set();
            for (const item of data.items || []) {
                if (!item?.url || item.canvas_kind !== 'smart') continue;
                const canvas = canvases.get(item.canvas_id);
                const owner = canvas?.owner || project(item.project || 'default');
                const identity = JSON.stringify([owner.id, item.canvas_id || '', item.url]);
                const seen = canvas?.urls || urlsWithoutCanvas;
                if (seen.has(identity)) continue;
                seen.add(identity);
                canvas?.items.push(item);
                owner.items.push(item);
            }
            const ordered = [...projects.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
            for (const entry of ordered) entry.canvases.sort((a, b) => collator.compare(a.title || '', b.title || ''));
            index = { projects, ordered, canvases };
            return index;
        }
        function defaultProject() {
            const list = catalog().ordered;
            return list.find(project => project.canvases.length)?.id || list[0]?.id || 'default';
        }
        function projectById(id) { return catalog().projects.get(id); }
        function scoped(projectId, canvasId) {
            const owner = projectById(projectId);
            if (!canvasId) return owner?.items || [];
            const canvas = catalog().canvases.get(canvasId);
            return canvas && canvas.owner === owner ? canvas.items : [];
        }
        function assets(model) {
            const { projectId, canvasId, sort } = model;
            const text = model.query.trim().toLowerCase();
            const projectName = projectById(projectId)?.name || '';
            const items = scoped(projectId, canvasId).filter(item => !text || [
                item.name, item.url, item.canvas_title, item.node_title, item.node_type, projectName, label(item), '智能画布',
            ].join(' ').toLowerCase().includes(text));
            const compare = {
                canvas_asc: (a, b) => collator.compare(a.canvas_title || '', b.canvas_title || '')
                    || String(a.canvas_id || '').localeCompare(String(b.canvas_id || ''), 'zh-Hans-CN') || time(b) - time(a),
                updated_asc: (a, b) => time(a) - time(b),
                name_asc: (a, b) => collator.compare(a.name || '', b.name || ''),
                kind: (a, b) => label(a).localeCompare(label(b), 'zh-Hans-CN') || time(b) - time(a),
                updated_desc: (a, b) => time(b) - time(a),
            };
            return items.sort(compare[sort] || compare.canvas_asc);
        }

        function element(tag, classes, text) {
            const node = dom.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        }
        function icon(symbol) {
            const node = element('i');
            node.dataset.lucide = symbol;
            return node;
        }
        function button(hook, symbol, { text, classes = 'asset-btn', title, value = '', disabled = false } = {}) {
            const node = element('button', classes);
            node.type = 'button';
            node.setAttribute('data-canvas-asset-' + hook, value);
            node.disabled = disabled;
            if (title) node.title = title;
            if (symbol) node.append(icon(symbol));
            if (text) node.append(element('span', '', text));
            return node;
        }
        function appendThumbnail(container, item) {
            const fragment = dom.createElement('template');
            fragment.innerHTML = thumbnail(item);
            container.append(fragment.content);
        }
        function treeRow(hook, name, id, count, classes, symbol, projectId) {
            const row = button(hook, '', { value: id, classes });
            if (projectId) {
                row.dataset.canvasAssetCanvasProject = projectId;
                row.append(element('span', 'tree-elbow'));
            }
            const glyph = element('span', 'tree-row-icon');
            glyph.append(icon(symbol));
            const text = element('span', 'tree-row-name', name);
            text.title = name;
            row.append(glyph, text, element('span', 'tree-row-count', count));
            return row;
        }
        function navigation(projectId, canvasId) {
            return catalog().ordered.map(project => {
                const name = project.name || '未命名项目';
                const active = project.id === projectId ? (canvasId ? ' contains-active' : ' active') : '';
                const row = treeRow('project', name, project.id, project.items.length, 'tree-row tree-parent' + active, 'folder');
                const children = project.canvases.map(canvas => treeRow('canvas', canvas.title || '未命名画布',
                    canvas.id, canvas.items.length, 'tree-row tree-child' + (project.id === projectId && canvas.id === canvasId ? ' active' : ''),
                    'sparkles', project.id).outerHTML).join('');
                return branch('generated:project:' + project.id, name, row.outerHTML,
                    children || '<div class="tree-empty">暂无画布</div>');
            }).join('');
        }
        function card(item, model) {
            const active = model.selectedId === item.id;
            const node = element('article', active ? 'asset-card canvas-asset-card active' : 'asset-card canvas-asset-card');
            node.dataset.canvasAssetCard = item.id;
            const check = element('input', 'asset-card-check');
            check.type = 'checkbox';
            check.dataset.canvasAssetCheck = item.id;
            check.defaultChecked = model.selection.has(item.id);
            const preview = element('div', 'asset-thumb canvas-asset-thumb');
            appendThumbnail(preview, item);
            const type = kind(item);
            const badge = element('span', 'asset-kind-badge ' + type);
            badge.title = label(item);
            badge.append(icon(icons[type] || icons.image));
            preview.append(badge);
            const body = element('div', 'asset-card-body');
            const name = element('div', 'asset-card-name', item.name || 'canvas asset');
            name.title = item.name || '';
            body.append(name, element('div', 'asset-card-meta', label(item) + ' · ' + (item.canvas_title || '未命名画布')));
            node.append(check, preview, body);
            return node;
        }
        function gallery(items, model) {
            const grid = element('div', 'asset-grid');
            if (!items.length) {
                grid.append(element('div', 'empty-state', '当前项目没有可下载的画布资产。可以点击“刷新资源”，或在画布中生成/导入图片、视频、音频后再查看。'));
                return grid;
            }
            if (model.sort !== 'canvas_asc') {
                for (const item of items) grid.append(card(item, model));
                return grid;
            }
            const groups = new Map();
            for (const item of items) {
                const key = item.canvas_id || item.canvas_title || '';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            }
            for (const entries of groups.values()) {
                const first = entries[0];
                const title = first.canvas_title || '未命名画布';
                const group = element('section', 'canvas-asset-group');
                const header = element('div', 'canvas-asset-group-head');
                const caption = element('div');
                const titleNode = element('strong', '', title);
                titleNode.title = title;
                caption.append(titleNode, element('span', '', '智能画布 / ' + date(time(first))));
                header.append(caption, element('small', '', entries.length + ' 个资产'));
                const cards = element('div', 'canvas-asset-group-grid');
                for (const item of entries) cards.append(card(item, model));
                group.append(header, cards);
                grid.append(group);
            }
            return grid;
        }
        function toolbar(model, items) {
            const owner = projectById(model.projectId);
            const canvas = catalog().canvases.get(model.canvasId);
            const bar = element('div', 'content-toolbar');
            const heading = element('div', 'content-heading');
            const projectName = owner?.name || '默认项目';
            const scope = canvas ? projectName : (owner?.canvases.length || 0) + ' 个画布';
            const sortLabel = model.sort === 'name_asc' ? '名称 A-Z' : sortOptions.get(model.sort);
            heading.append(element('strong', '', canvas?.title || projectName),
                element('span', '', '生成素材 / ' + scope + ' / ' + items.length + ' 个资产 / ' + sortLabel));
            const controls = element('div', 'asset-tools');
            const search = element('label', 'asset-search-wrap');
            const query = element('input', 'asset-search');
            query.id = 'canvasAssetSearch';
            query.type = 'search';
            query.defaultValue = model.query;
            query.placeholder = '搜索画布资产';
            search.append(icon('search'), query);
            const sort = element('select', 'manage-select canvas-sort-select');
            sort.id = 'canvasAssetSort';
            sort.title = '排序方法';
            for (const [value, text] of sortOptions) {
                const option = element('option', '', text);
                option.value = value;
                option.defaultSelected = model.sort === value;
                sort.append(option);
            }
            controls.append(button('refresh', 'refresh-cw', { text: '刷新资源', title: '重新读取画布中的图片、视频、音频资源' }),
                search, sort, button('manage', 'list-checks', { text: model.managing ? '完成管理' : '批量管理',
                    classes: model.managing ? 'asset-btn primary' : 'asset-btn', disabled: !owner?.items.length }));
            bar.append(heading, controls);
            return bar;
        }
        function content(model, items) {
            const area = element('section', model.managing ? 'asset-panel asset-content manage-on' : 'asset-panel asset-content');
            const tools = element('div', 'manage-tools');
            const buttons = element('div', 'asset-tools');
            buttons.append(button('select-all', 'check-square', { text: '全选', disabled: !items.length }),
                button('clear-selection', 'square', { text: '清空', disabled: !model.selection.size }),
                button('download-selected', 'download', { text: '下载所选', classes: 'asset-btn primary', disabled: !model.selection.size }));
            tools.append(element('span', '', '已选择 ' + model.selection.size + ' 个画布资产，支持拖拽框选或逐个勾选。'), buttons);
            const scroll = element('div', 'content-scroll');
            scroll.append(gallery(items, model));
            area.append(toolbar(model, items), tools, scroll);
            return area.outerHTML;
        }
        function detail(item, projectId) {
            const header = element('div', 'panel-head');
            const title = element('div', 'panel-title');
            title.append(element('strong', '', '画布资产详情'), element('span', '', item ? label(item) : '选择一个画布资产查看详情'));
            header.append(title);
            const scroll = element('div', 'detail-scroll');
            if (!item) {
                const empty = element('div', 'detail-empty');
                empty.append(icon('layout-dashboard'), element('span', '', '暂无画布资产'));
                scroll.append(empty);
                return header.outerHTML + scroll.outerHTML;
            }
            const commands = element('div', 'panel-actions');
            const type = kind(item);
            const video = type === 'video';
            const previewable = type === 'image' || video;
            const value = item.id;
            if (previewable) commands.append(button('preview', video ? 'play' : 'maximize-2', {
                value, title: video ? '预览视频' : '放大预览', classes: 'asset-icon-btn',
            }));
            commands.append(button('open', 'external-link', { value, title: '打开链接', classes: 'asset-icon-btn' }),
                button('copy', 'copy', { value, title: '复制链接', classes: 'asset-icon-btn' }),
                button('download', 'download', { value, text: '下载', classes: 'asset-btn primary' }));
            header.append(commands);
            const media = element('div', 'detail-media');
            const frame = previewable ? button('preview', '', { value, classes: 'detail-media-frame detail-media-zoomable',
                title: video ? '点击预览视频' : '点击放大预览' }) : element('div', 'detail-media-frame');
            appendThumbnail(frame, item);
            media.append(frame);
            const body = element('div', 'detail-body');
            const fields = element('div', 'detail-meta-grid');
            for (const [caption, text, tooltip] of [
                ['类型', label(item)], ['所属项目', projectById(projectId)?.name || '未命名项目'],
                ['来源画布', item.canvas_title || '未命名画布', item.canvas_title || ''],
                ['更新时间', date(time(item))], ['来源节点', item.node_title || item.node_type || '节点', item.node_title || item.node_type || ''],
                ['节点类型', item.node_type || '-'],
            ]) {
                const cell = element('div', 'detail-meta');
                const fieldValue = element('strong', '', text);
                if (tooltip != null) fieldValue.title = tooltip;
                cell.append(element('span', '', caption), fieldValue);
                fields.append(cell);
            }
            body.append(element('div', 'detail-name', item.name || '画布资产'), fields, element('div', 'detail-url', item.url));
            scroll.append(media, body);
            return header.outerHTML + scroll.outerHTML;
        }
        return {
            assets, scoped, defaultProject, projectById, navigation, content, detail,
            validCanvas: (id, owner) => catalog().canvases.get(id)?.owner.id === owner,
            sort: value => sortOptions.has(value) ? value : 'canvas_asc',
        };
    }

    global.XiaomeiAssetCanvasProjects = { create };
}(window));
