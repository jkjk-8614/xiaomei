(function (root) {
    'use strict';

    const templateCategories = [
        ['view', '视角'], ['storyboard', '分镜'], ['character', '角色'],
        ['product', '产品'], ['lighting', '光影'], ['custom', '我的'],
    ];
    const names = {
        asset: { heading: '资产层级', hint: '先选库，再选分组', add: '新建资产库', addIcon: 'plus',
            search: '搜索素材', favorites: '收藏的素材' },
        workflow: { heading: '工作流层级', hint: '独立管理工作流分组', add: '新建工作流分组', addIcon: 'folder-plus',
            search: '搜索工作流', favorites: '收藏的工作流' },
        prompt: { heading: '提示词模板库', hint: '可创建多个提示词模板库', add: '新建提示词模板库', addIcon: 'plus',
            search: '搜索名称、说明或正文' },
    };

    function templateGroups(library) {
        const saved = Array.isArray(library?.categories) ? library.categories.filter(group => group?.id) : [];
        if (saved.length || (library && library.id !== 'system')) return saved;
        return templateCategories.map(([id, name]) => ({ id, name }));
    }

    function createView(container) {
        const document = container.ownerDocument.createElement('template').content.ownerDocument;
        const element = (tag, classes, text) => {
            const node = document.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        };
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function button({ hook, label, glyph, classes, disabled, title, value = '' }) {
            const node = element('button', classes);
            node.type = 'button';
            node.setAttribute('data-' + hook, value);
            if (glyph) node.append(icon(glyph));
            if (label) node.append(element('span', '', label));
            if (disabled) node.disabled = true;
            if (title) node.title = title;
            return node;
        }
        function markup(html) {
            const template = element('template');
            template.innerHTML = html || '';
            return template.content;
        }
        function row({ hook, value, text, count, glyph, child, active, expanded, attrs = {} }) {
            const node = button({ hook, value, classes: child ? 'tree-row tree-child' : 'tree-row tree-parent' });
            node.classList.toggle('active', Boolean(active));
            node.classList.toggle('contains-active', Boolean(expanded));
            if (child) node.append(element('span', 'tree-elbow'));
            const badge = element('span', 'tree-row-icon');
            badge.append(icon(glyph));
            node.append(badge, element('span', 'tree-row-name', text), element('span', 'tree-row-count', count));
            for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
            return node;
        }
        function editor(edit, inputId, saveAttr, cancelAttr, position, pending = false) {
            const classes = position === 'head' ? 'head-inline-edit' : 'tree-inline-edit ' + position + '-actions';
            const area = element('div', classes);
            const input = element('input');
            input.id = inputId;
            input.type = 'text';
            input.defaultValue = edit.value || '';
            input.placeholder = edit.label || '名称';
            input.disabled = pending;
            area.append(input,
                button({ hook: saveAttr.slice(5), glyph: 'check', label: '保存', classes: 'primary', disabled: pending,
                    title: position === 'head' ? '保存' : '' }),
                button({ hook: cancelAttr.slice(5), glyph: 'x', label: '取消', title: position === 'head' ? '取消' : '' }));
            return area;
        }
        function treeEditor(type, edit, position, pending) {
            return editor(edit, type + 'TreeEditInput', `data-${type}-tree-edit-save`, `data-${type}-tree-edit-cancel`, position, pending);
        }
        function editsRow(model, position) {
            const edit = model.edit;
            if (!edit || edit.position !== position || edit.libraryId !== model.libraryId) return false;
            return position === 'library' || edit.categoryId === model.categoryId;
        }
        function treeActions(model, position) {
            const { type, pending, libraryId, categoryId, confirmation } = model;
            if (editsRow(model, position)) return treeEditor(type, model.edit, position, pending);
            const child = position === 'child';
            const bar = element('div', `tree-action-bar ${position}-actions`);
            const entity = child ? 'cat' : 'lib';
            const target = child ? categoryId : libraryId;
            const key = child ? `${type}-cat:${libraryId}:${target}` : `${type}-lib:${target}`;
            if (type === 'asset' || (type === 'prompt' && !child)) {
                bar.append(button({ hook: type + '-cat-new', glyph: 'folder-plus', label: '新分组' }));
            }
            bar.append(button({ hook: `${type}-${entity}-rename`, glyph: 'pencil', label: '重命名' }));
            if (type !== 'prompt' || child || libraryId !== 'system') {
                const armed = confirmation === key;
                bar.append(button({ hook: `${type}-${entity}-delete`, glyph: 'trash-2',
                    label: armed ? '确认删除' : child ? '删除' : '删除库',
                    classes: armed ? 'danger detail-confirm' : 'danger' }));
            }
            return bar;
        }
        function groupBranch(model, library) {
            const { type, libraryId, categoryId, focus } = model;
            const isTemplate = type === 'prompt';
            const expanded = library.id === libraryId;
            const parentActive = expanded && focus === 'library';
            const categories = isTemplate ? templateGroups(library)
                : (library.categories || []).filter(group => (group.type || 'image') === 'image');
            const items = library.items || [];
            const branch = element('div', expanded ? 'tree-branch expanded' : 'tree-branch');
            const counts = new Map();
            if (isTemplate) {
                for (const item of items) {
                    const id = item.category || 'custom';
                    counts.set(id, (counts.get(id) || 0) + 1);
                }
            }
            branch.append(row({
                hook: type + '-lib', value: library.id,
                glyph: isTemplate ? (library.id === 'system' ? 'sparkles' : 'book-open') : expanded ? 'folder-open' : 'folder',
                text: library.name || (isTemplate ? '提示词模板库' : '资产库'),
                count: isTemplate ? items.length : categories.reduce((sum, group) => sum + (group.items || []).length, 0),
                expanded, active: parentActive,
            }));
            if (parentActive) branch.append(treeActions(model, 'library'));
            const children = element('div', 'tree-children');
            if (isTemplate) {
                children.append(row({
                    hook: 'prompt-cat', value: 'all', text: '全部提示词', count: items.length, glyph: 'layout-list', child: true,
                    active: expanded && categoryId === 'all' && focus === 'category', attrs: { 'data-prompt-cat-lib': library.id },
                }));
            } else if (!categories.length) {
                children.append(element('div', 'tree-empty', '暂无分组'));
            }
            for (const category of categories) {
                const active = expanded && category.id === categoryId && focus === 'category';
                const count = isTemplate ? counts.get(category.id) || 0 : (category.items || []).length;
                const child = row({
                    hook: type + '-cat', value: category.id, glyph: isTemplate ? 'tag' : 'image', child: true,
                    text: category.name || (isTemplate ? (templateCategories.find(([id]) => id === category.id)?.[1] || category.id) : '分组'),
                    count, active,
                    attrs: { [`data-${type}-cat-lib`]: library.id },
                });
                if (!isTemplate) {
                    child.classList.add('asset-category-draggable');
                    child.draggable = true;
                    child.title = `拖到本地素材，移动此分组中的 ${count} 个素材`;
                }
                children.append(child);
                if (active) children.append(treeActions(model, 'child'));
            }
            branch.append(children);
            return branch;
        }
        function workflowBranch(model) {
            const branch = element('div', 'tree-branch expanded');
            const categories = model.categories;
            branch.append(row({ hook: 'workflow-root', text: '工作流库', glyph: 'folder-open', expanded: true,
                count: categories.reduce((total, category) => total + (category.items || []).length, 0) }));
            const children = element('div', 'tree-children');
            if (!categories.length) children.append(element('div', 'tree-empty', '暂无工作流分组'));
            for (const category of categories) {
                const libraryId = category.__libraryId || '';
                const active = category.id === model.categoryId && libraryId === model.libraryId;
                children.append(row({
                    hook: 'workflow-cat', value: category.id, text: category.name || '工作流',
                    count: (category.items || []).length, glyph: 'workflow', child: true, active,
                    attrs: { 'data-workflow-cat-lib': libraryId },
                }));
                if (active) children.append(treeActions(model, 'child'));
            }
            branch.append(children);
            return branch;
        }
        function navigation(model, labels) {
            const { type, edit, pending } = model;
            const nav = element('aside', 'asset-panel asset-nav');
            const head = element('div', 'panel-head');
            const title = element('div', 'panel-title');
            title.append(element('strong', '', labels.heading), element('span', '', labels.hint));
            const tools = element('div', 'panel-actions compact-actions');
            if (type === 'asset') tools.append(button({ hook: 'upload-disk-view', classes: 'asset-btn', glyph: 'upload', label: '上传目录' }));
            if (edit?.position === 'head') tools.append(treeEditor(type, edit, 'head', pending));
            else tools.append(button({ hook: type + (type === 'workflow' ? '-cat-new' : '-lib-new'),
                classes: 'asset-icon-btn', glyph: labels.addIcon, title: labels.add }));
            head.append(title, tools);
            const scroll = element('div', 'nav-scroll');
            const tree = element('div', 'nav-tree');
            if (labels.favorites) {
                tree.append(row({ hook: type + '-fav-filter', text: '我的收藏', count: model.favoriteCount,
                    glyph: 'star', active: model.favorites, expanded: model.favorites, attrs: { title: labels.favorites } }));
            }
            if (type === 'workflow') tree.append(workflowBranch(model));
            else for (const library of model.libraries) tree.append(groupBranch(model, library));
            if (model.collections) tree.append(markup(model.collections));
            scroll.append(tree);
            nav.append(head, scroll);
            return nav;
        }
        function toolbar(model, labels) {
            const bar = element('div', 'content-toolbar');
            const heading = element('div', 'content-heading');
            heading.append(element('strong', '', model.title), element('span', '', model.subtitle));
            const tools = element('div', 'asset-tools');
            const search = element('label', 'asset-search-wrap');
            const input = element('input', 'asset-search');
            input.id = model.type + 'Search';
            input.type = 'search';
            input.defaultValue = model.query;
            input.placeholder = labels.search;
            search.append(icon('search'), input);
            tools.append(search);
            if (model.type === 'asset') tools.append(button({ hook: 'asset-upload', classes: 'asset-btn primary',
                glyph: 'upload-cloud', label: '上传文件' }));
            if (model.type === 'prompt') tools.append(button({ hook: 'prompt-new', classes: 'asset-btn primary',
                glyph: 'file-plus-2', label: '新增', disabled: model.readonly }));
            tools.append(button({ hook: model.type + '-manage', classes: model.managing ? 'asset-btn primary' : 'asset-btn',
                glyph: 'list-checks', label: model.managing ? '完成管理' : '批量管理' }));
            bar.append(heading, tools);
            return bar;
        }
        function manageTools(model) {
            const { type, selectionCount, readonly } = model;
            const body = element('div', 'manage-tools');
            const controls = element('div', 'asset-tools');
            const add = (verb, glyph, label, disabled, danger = false, armed = false) => controls.append(button({
                hook: type + '-' + verb, glyph, label, disabled,
                classes: 'asset-btn' + (danger ? ' danger' : '') + (armed ? ' detail-confirm' : ''),
            }));
            add('select-all', 'check-square', '全选', !model.itemCount || readonly);
            add('clear-selection', 'square', '清空', !selectionCount);
            const empty = !selectionCount;
            if (type === 'asset') {
                add('cut-selected', 'scissors', '剪切', empty);
                add('copy-selected', 'copy', '复制', empty);
                add('download-selected', 'download', '下载所选', empty);
                add('copy-to-canvas', 'clipboard-paste', '复制到画布', empty);
                add('delete-selected', 'trash-2', '移入回收站', empty, true);
                const group = element('div', 'manage-group manage-select-group');
                group.append(element('span', 'manage-group-title', '管理'),
                    element('span', 'manage-summary', `已选 ${selectionCount} 个，其中 ${model.imageCount} 张图片`), controls);
                const ai = element('div', 'manage-group manage-ai-group');
                ai.append(element('span', 'manage-group-title', 'AI 处理'),
                    button({ hook: 'asset-classify-selected', classes: 'asset-btn', glyph: model.classifying ? 'loader-2' : 'tags',
                        label: model.classifying ? '分类中' : '智能分类', disabled: !model.imageCount || model.classifying }),
                    button({ hook: 'asset-background-remove-selected', classes: 'asset-btn', glyph: model.removingBackground ? 'loader-2' : 'eraser',
                        label: model.removingBackground ? '抠图中' : '去背景', disabled: !model.imageCount || model.removingBackground }));
                body.append(group, ai);
            } else if (type === 'workflow') {
                add('export-selected', 'download', '导出所选', empty);
                add('export-desktop-selected', 'folder-down', '导出所选到桌面', empty);
                add('delete-selected', 'trash-2', '移入回收站', empty, true);
                body.append(element('span', '', `已选择 ${selectionCount} 个工作流。`), controls);
            } else {
                add('delete-selected', 'trash-2', model.confirmDelete ? '确认删除' : '删除所选', readonly || empty, true, model.confirmDelete);
                body.append(element('span', '', `已选择 ${selectionCount} 条提示词，支持拖拽框选或逐个勾选。`), controls);
            }
            return body;
        }
        function render(model) {
            const content = element('section', model.managing ? 'asset-panel asset-content manage-on' : 'asset-panel asset-content');
            const labels = names[model.type];
            const scroll = element('div', 'content-scroll');
            if (model.type === 'prompt' && !model.itemCount) {
                scroll.append(element('div', 'empty-state', model.empty));
            } else {
                const list = element('div', model.type === 'prompt' ? 'prompt-list' : 'asset-grid');
                list.append(markup(model.upload), markup(model.cards));
                if (!model.itemCount) list.append(element('div', 'empty-state', model.empty));
                scroll.append(list);
            }
            content.append(toolbar(model, labels), markup(model.filters), markup(model.clipboard), manageTools(model), scroll);
            const detail = element('aside', 'asset-panel asset-detail');
            detail.append(markup(model.detail));
            const nodes = [navigation(model, labels), content, detail];
            if (model.type === 'asset') {
                const menu = element('div', 'asset-context-menu');
                menu.id = 'assetContextMenu';
                menu.hidden = true;
                menu.setAttribute('role', 'menu');
                menu.setAttribute('aria-label', '素材操作');
                const remove = button({ hook: 'asset-context-background-remove', glyph: 'eraser', label: '去背景并生成透明底' });
                remove.setAttribute('role', 'menuitem');
                menu.append(remove);
                nodes.push(menu);
            }
            container.replaceChildren(...nodes);
        }
        return {
            render,
            headEditor: (edit, inputId, saveAttr, cancelAttr) => editor(edit, inputId, saveAttr, cancelAttr, 'head', edit.pending).outerHTML,
        };
    }

    function createWriter(request) {
        const queues = new Map();
        const saving = new WeakSet();
        const deletions = new Set();

        function enqueue(endpoint, send) {
            const result = (queues.get(endpoint) || Promise.resolve()).then(send);
            const tail = result.catch(() => {});
            queues.set(endpoint, tail);
            void tail.then(() => { if (queues.get(endpoint) === tail) queues.delete(endpoint); });
            return result;
        }

        const endpointFor = type => type === 'prompt' ? '/api/prompt-libraries' : '/api/asset-library';
        function entryPath(endpoint, entity, id) {
            if (entity === 'category') return endpoint + '/categories' + (id ? '/' + encodeURIComponent(id) : '');
            const base = endpoint === '/api/asset-library' ? endpoint + '/libraries' : endpoint;
            return id ? base + '/' + encodeURIComponent(id) : base;
        }

        function save(type, edit) {
            if (saving.has(edit)) return null;
            const [entity, operation] = edit.kind.split('-');
            const creating = operation === 'new';
            const { libraryId, categoryId } = edit;
            const endpoint = endpointFor(type);
            const entryId = entity === 'category' ? categoryId : libraryId;
            const path = entryPath(endpoint, entity, creating ? '' : entryId);
            const body = { name: edit.value.trim() };
            if (entity === 'category') {
                body.library_id = libraryId;
                if (creating && type !== 'prompt') body.type = type === 'asset' ? 'image' : 'workflow';
            }
            saving.add(edit);
            return enqueue(endpoint, () => request(path, {
                method: creating ? 'POST' : 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })).finally(() => saving.delete(edit));
        }

        function remove(type, entity, libraryId, categoryId) {
            const endpoint = endpointFor(type);
            const category = entity === 'category';
            const path = entryPath(endpoint, entity, category ? categoryId : libraryId);
            const url = category ? path + '?' + new URLSearchParams({ library_id: libraryId }) : path;
            if (deletions.has(url)) return null;
            deletions.add(url);
            return enqueue(endpoint, () => request(url, { method: 'DELETE' })).finally(() => deletions.delete(url));
        }

        return { save, remove, pending: edit => Boolean(edit && saving.has(edit)) };
    }

    root.XiaomeiAssetManagerCatalogs = { createView, createWriter, templateGroups };
}(window));
