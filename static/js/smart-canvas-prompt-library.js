(function (root) {
    'use strict';

    const apiRoot = '/api/prompt-libraries';
    const presetsKey = 'smart_canvas_prompt_presets_v1';
    const groupsKey = 'smart_canvas_prompt_template_groups_v1';
    const defaults = { view: 'View', storyboard: 'Storyboard', character: 'Character', product: 'Product', lighting: 'Lighting', custom: 'Mine' };
    const array = value => Array.isArray(value) ? value : [];
    const savedList = key => {
        try { return array(JSON.parse(root.localStorage.getItem(key))); }
        catch { return []; }
    };
    const localCategory = id => !id || id === 'mine' ? 'custom' : id;
    const idPath = (collection, id) => collection + '/' + encodeURIComponent(id);
    const parameters = item => Object.entries(item.params || {}).map(([key, value]) => key + ': ' + value).join('\n');

    function appliedText(item, mode) {
        const positive = String(item.positive).trim();
        if (mode !== 'full' || !item.builtin) return positive;
        const negative = String(item.negative || '').trim();
        const params = parameters(item);
        return [positive, negative && 'Negative prompt:\n' + negative, params && 'Params:\n' + params].filter(Boolean).join('\n\n');
    }

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const panel = get('promptTemplatePanel');
        const search = get('promptTemplateSearch');
        const select = get('promptTemplateLibrarySelect');
        const nav = get('promptTemplateCats');
        const body = get('promptTemplateBody');
        const composerButton = get('composerTemplateBtn');
        const label = name => host.label('smart.tpl' + name);
        const common = name => host.label('common.' + name);
        const systemFallback = { id: 'system', name: '系统提示词库', readonly: true, items: [] };
        let libraries = [];
        let presets = [];
        let localGroups = [];
        const removedFallbackGroups = new Set();
        let libraryId = 'system';
        let category = 'all';
        let selectedId = '';
        let preferredId = '';
        let editing = null;
        let managing = false;
        let target;
        let viewRevision = 0;
        let catalogRevision = 0;
        let busy = false;

        function loadLocal() {
            presets = savedList(presetsKey).filter(item => item?.id && typeof item.text === 'string');
            localGroups = savedList(groupsKey).filter(group => group?.id && group.name);
        }

        function activeLibrary() {
            return libraries.find(library => library.id === libraryId) || libraries[0] || systemFallback;
        }

        function acceptCatalog(data) {
            const received = data?.library?.libraries;
            if (!Array.isArray(received)) return;
            libraries = received.filter(library => library?.id);
            libraryId = activeLibrary().id;
        }

        async function request(path, method = 'GET', fields, fallback = '请求失败') {
            const options = { method };
            if (fields) {
                options.headers = { 'Content-Type': 'application/json' };
                options.body = JSON.stringify(fields);
            }
            const response = await root.fetch(path, options);
            if (!response.ok) throw new Error(await root.XiaomeiApiErrors.read(response, fallback));
            return response.json();
        }

        async function refresh() {
            if (busy) return;
            const revision = ++catalogRevision;
            let data;
            try {
                data = await request(apiRoot);
                if (!array(data?.library?.libraries).length) data = null;
            } catch {}
            if (!data) {
                try {
                    const legacy = await request('/api/smart-canvas/prompt-templates');
                    data = { library: { libraries: [{ ...systemFallback, items: array(legacy.templates) }] } };
                } catch {}
            }
            if (revision !== catalogRevision || !data) return;
            acceptCatalog(data);
            render();
        }

        function groupsFor(library) {
            const groups = new Map();
            for (const group of array(library.categories)) {
                if (group?.id && group.name) groups.set(group.id, group);
            }
            if (library.id !== 'system') return groups;
            if (!groups.size) {
                for (const [id, suffix] of Object.entries(defaults)) {
                    if (!removedFallbackGroups.has(id)) groups.set(id, { id, name: label('Cat' + suffix) });
                }
            }
            for (const group of localGroups) {
                const id = localCategory(group.id);
                if (!groups.has(id) || !array(library.categories).length) groups.set(id, { ...group, id, local: true });
            }
            if (!groups.has('custom') && presets.some(item => localCategory(item.category) === 'custom')) {
                groups.set('custom', { id: 'custom', name: label('CatMine') });
            }
            return groups;
        }

        function records(library) {
            const items = array(library.items).filter(item => item?.id && item.positive)
                .map(item => ({ ...item, builtin: library.id === 'system', library }));
            if (library.id !== 'system') return items;
            for (const preset of presets) {
                items.push({
                    id: 'mine:' + preset.id,
                    name: preset.name || host.label('smart.promptPresetUnnamed'),
                    category: localCategory(preset.category),
                    positive: preset.text,
                    scene: '我的提示词预设',
                    preset,
                    library
                });
            }
            return items;
        }

        function visibleRecords(items) {
            const query = search.value.trim().toLowerCase();
            return items.filter(item => (category === 'all' || item.category === category)
                && (!query || [item.name, item.name_en, item.scene, item.scene_en, item.positive, item.negative].join(' ').toLowerCase().includes(query)));
        }

        function localized(item, field) {
            return (host.english() && item[field + '_en']) || item[field] || '';
        }

        function groupName(groups, id) {
            const suffix = id === 'mine' ? 'Mine' : defaults[id];
            return groups.get(id)?.name || (suffix && typeof suffix === 'string' ? label('Cat' + suffix) : id || '');
        }

        function element(tag, cls, content) {
            const el = doc.createElement(tag);
            if (cls) el.className = cls;
            if (content != null) el.textContent = content;
            return el;
        }

        function box(cls, ...children) {
            const el = element('div', cls);
            el.append(...children);
            return el;
        }

        function button(action, text, { value = '', cls, icon, title, disabled = false } = {}) {
            const control = element('button', cls);
            control.type = 'button';
            control.setAttribute('data-template-' + action, value);
            control.disabled = disabled;
            if (title) {
                control.title = title;
                control.setAttribute('aria-label', title);
            }
            if (icon) {
                const glyph = element('i');
                glyph.dataset.lucide = icon;
                control.append(glyph);
            }
            if (text) control.append(element('span', '', text));
            return control;
        }

        function categoryTab(id, name, count, row = false) {
            const tab = button('cat', name, { value: id, cls: row ? 'group-name' : '' });
            tab.classList.toggle('active', id === category);
            tab.setAttribute('aria-pressed', String(id === category));
            tab.append(element('small', '', count));
            return tab;
        }

        function navigation(library, groups, items) {
            const counts = new Map();
            for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
            const tab = (group, row) => categoryTab(group.id, group.name, counts.get(group.id) || 0, row);
            if (!managing) {
                const tabs = box('prompt-template-tabs', categoryTab('all', label('All'), items.length));
                for (const group of groups.values()) tabs.append(tab(group));
                return box('prompt-template-nav', tabs, button('group-edit', label('ManageGroups'), { cls: 'prompt-template-manage-groups', icon: 'settings-2' }));
            }

            const canAdd = !library.readonly || library.id === 'system';
            const heading = box('prompt-template-group-title',
                box('', element('strong', '', label('GroupManage')), element('span', '', label('GroupHint'))),
                box('prompt-template-group-tools',
                    button('cat-new', label('Add'), { icon: 'plus', disabled: !canAdd }),
                    button('group-edit', label('Done'), { cls: 'primary', icon: 'check' })));
            const rows = box('prompt-template-group-list');
            for (const group of groups.values()) {
                const locked = library.readonly && library.id !== 'system';
                rows.append(box('prompt-template-group-row has-delete', tab(group, true),
                    button('cat-edit', '', { value: group.id, cls: 'group-tool', icon: 'pencil', title: label('Rename'), disabled: locked }),
                    button('cat-delete', '', { value: group.id, cls: 'group-tool danger', icon: 'trash-2', title: common('delete'), disabled: locked })));
            }
            return box('prompt-template-group-panel', heading, rows);
        }

        function paintList(library, groups, items, selected) {
            const list = box('prompt-template-list', box('prompt-template-list-tools',
                button('save-current', label('SaveCurrent'), { icon: 'bookmark-plus', disabled: library.readonly }),
                button('new', label('NewTemplate'), { icon: 'file-plus-2', disabled: library.readonly })));
            if (!items.length) list.append(element('div', 'prompt-template-list-empty', label('NoMatches')));
            for (const item of items) {
                const card = button('id', '', { value: item.id, cls: 'prompt-template-card' });
                card.classList.toggle('active', item === selected);
                card.setAttribute('aria-pressed', String(item === selected));
                const heading = element('span', 'prompt-template-card-top');
                heading.append(element('span', 'prompt-template-name', localized(item, 'name')),
                    element('span', 'prompt-template-source', label(item.builtin ? 'Builtin' : 'Mine')));
                const scene = root.XiaomeiPromptPresentation.description(localized(item, 'scene'), item.positive);
                card.append(heading, element('span', 'prompt-template-scene', scene || item.positive),
                    element('span', 'prompt-template-tag', groupName(groups, item.category || 'custom')));
                list.append(card);
            }
            return list;
        }

        function option(value, text) {
            const option = element('option', '', text);
            option.value = value;
            return option;
        }

        function editFields(groups) {
            const fields = box('prompt-template-edit-fields');
            const name = element('input');
            const categorySelect = element('select');
            const content = element('textarea');
            const drafts = { name, category: categorySelect, text: content };
            for (const group of groups.values()) categorySelect.append(option(group.id, group.name));
            if (!groups.has(editing.category)) categorySelect.append(option(editing.category, groupName(groups, editing.category)));
            for (const [key, caption] of [['name', 'Name'], ['category', 'Group'], ['text', 'Content']]) {
                const field = drafts[key];
                field.id = 'smart-template-edit-' + key;
                field.setAttribute('data-template-edit-' + key, '');
                field.value = editing[key];
                field.disabled = busy;
                if (key !== 'category') field.placeholder = label(caption);
                field.addEventListener('input', () => { if (editing) editing[key] = field.value; });
                const title = element('label', '', label(caption));
                title.htmlFor = field.id;
                fields.append(title, field);
            }
            return fields;
        }

        function detail(groups, item) {
            if (!item) return box('prompt-template-detail', element('div', 'prompt-template-empty', label('PickOrCreate')));
            const editable = item.preset || !item.library.readonly;
            const head = box('prompt-template-detail-head', box('',
                element('strong', '', localized(item, 'name')),
                element('span', '', groupName(groups, item.category) + ' · ' + label(item.builtin ? 'BuiltinTemplate' : 'MineTemplate'))));
            if (editing) {
                return box('prompt-template-detail', head, editFields(groups), box('prompt-template-actions',
                    button('edit-cancel', common('cancel'), { icon: 'x' }),
                    button('delete', common('delete'), { cls: 'danger', icon: 'trash-2' }),
                    button('edit-save', common('save'), { cls: 'primary', icon: 'save' })));
            }
            head.append(box('prompt-template-icon-actions',
                button('edit', common('edit'), { icon: 'pencil', title: label('EditTemplate'), disabled: !editable }),
                button('delete', common('delete'), { cls: 'danger', icon: 'trash-2', title: label('DeleteTemplate'), disabled: !editable })));
            const sections = box('prompt-template-preview-content');
            for (const [key, text] of [['Positive', item.positive], ['Negative', item.negative], ['Params', parameters(item)]]) {
                if (text || key === 'Positive') sections.append(box('prompt-template-section', element('label', '', label(key)), element('p', '', text)));
            }
            return box('prompt-template-detail', head, sections, box('prompt-template-actions',
                button('apply', label('ApplyPositive'), { value: 'positive', icon: 'corner-down-left' }),
                button('apply', label('ApplyFull'), { value: 'full', cls: 'primary', icon: 'wand-sparkles' })));
        }

        const scrollAreas = ['.prompt-template-tabs', '.prompt-template-list', '.prompt-template-preview-content'];

        function render({ resetScroll = false } = {}) {
            if (!target) return;
            const scroll = resetScroll ? [] : scrollAreas.map(selector => {
                const area = panel.querySelector(selector);
                return area ? [area.scrollLeft, area.scrollTop] : null;
            });
            const library = activeLibrary();
            const groups = groupsFor(library);
            if (category !== 'all' && !groups.has(category)) category = 'all';
            const items = records(library);
            const shown = visibleRecords(items);
            const preferred = shown.find(item => item.id === preferredId);
            if (preferred) preferredId = '';
            const current = preferred || shown.find(item => item.id === selectedId) || shown[0];
            selectedId = current?.id || '';
            if (editing && (editing.id !== selectedId || editing.libraryId !== library.id)) editing = null;
            select.replaceChildren(...libraries.map(item => option(item.id, item.name || '提示词库')));
            select.value = library.id;
            nav.replaceChildren(navigation(library, groups, items));
            body.replaceChildren(paintList(library, groups, shown, current), detail(groups, current));
            if (resetScroll) panel.scrollTop = 0;
            scroll.forEach((position, index) => {
                if (position) panel.querySelector(scrollAreas[index])?.scrollTo(...position);
            });
            host.icons();
        }

        function itemInView() {
            return visibleRecords(records(activeLibrary())).find(item => item.id === selectedId);
        }

        function setDraft(item) {
            editing = {
                id: item.id,
                libraryId: item.library.id,
                name: item.preset ? item.preset.name || '' : item.name || '',
                category: item.category || 'custom',
                text: item.positive
            };
        }

        function edit(item) {
            if (!item || (!item.preset && item.library.readonly)) return;
            setDraft(item);
            render();
        }

        function writeLocal(key, items) {
            try {
                root.localStorage.setItem(key, JSON.stringify(items));
                return true;
            } catch {
                host.notice('保存失败');
                return false;
            }
        }

        function lock(value) {
            busy = value;
            panel.setAttribute('aria-busy', String(value));
            for (const field of body.querySelectorAll('.prompt-template-edit-fields input, .prompt-template-edit-fields select, .prompt-template-edit-fields textarea')) {
                field.disabled = value;
            }
        }

        async function mutate(path, method, fields, fallback, updated) {
            if (busy) return;
            const view = viewRevision;
            ++catalogRevision;
            lock(true);
            let repaint = false;
            let resetScroll = false;
            try {
                const data = await request(apiRoot + path, method, fields, fallback);
                acceptCatalog(data);
                if (view === viewRevision) resetScroll = Boolean(updated(data));
                repaint = true;
            } catch (error) {
                host.notice(error.message || fallback);
            } finally {
                lock(false);
                if (repaint) render({ resetScroll });
            }
        }

        function createItem(useCurrent) {
            const library = activeLibrary();
            if (library.readonly) return;
            const text = useCurrent ? host.sourceText(target).trim() : '新提示词';
            if (!text) {
                host.notice(host.label('smart.promptPresetEmpty'));
                return;
            }
            const name = useCurrent
                ? (text.split(/\r?\n/, 1)[0] || host.label('smart.promptPresetDefault')).slice(0, 28)
                : label('NewTemplateName');
            const group = category === 'all' ? 'custom' : category;
            mutate('/items', 'POST', { library_id: library.id, name, category: group, positive: text, scene: '我的提示词预设' },
                useCurrent ? '保存失败' : '创建失败', data => {
                    selectedId = data.item?.id || '';
                    category = data.item?.category || group;
                    search.value = '';
                    if (selectedId) {
                        const record = records(activeLibrary()).find(item => item.id === selectedId);
                        if (record) setDraft(record);
                    }
                    return true;
                });
        }

        function saveItem(item) {
            if (!editing || !item) return;
            const name = editing.name.trim();
            const text = editing.text.trim();
            if (!name || !text) {
                host.notice(label('Required'));
                return;
            }
            const fields = { name, category: editing.category, positive: text };
            if (item.preset) {
                const { id } = item.preset;
                const next = presets.map(preset => preset.id === id ? { ...preset, name, category: fields.category, text, updatedAt: Date.now() } : preset);
                if (!writeLocal(presetsKey, next)) return;
                presets = next;
                editing = null;
                host.presetChanged(id, text);
                render();
                return;
            }
            if (item.library.readonly) return;
            mutate(idPath('/items', item.id), 'PATCH', {
                ...fields, library_id: item.library.id, scene: item.scene || '', negative: item.negative || ''
            }, '保存失败', data => {
                editing = null;
                selectedId = data.item?.id || item.id;
            });
        }

        function removeItem(item) {
            if (!item) return;
            if (item.preset) {
                const { id } = item.preset;
                const next = presets.filter(preset => preset.id !== id);
                if (!writeLocal(presetsKey, next)) return;
                presets = next;
                editing = null;
                host.presetChanged(id);
                render({ resetScroll: true });
                return;
            }
            if (item.library.readonly) return;
            const query = new URLSearchParams({ library_id: item.library.id });
            mutate(idPath('/items', item.id) + '?' + query, 'DELETE', null, '删除失败', () => {
                editing = null;
                selectedId = '';
                return true;
            });
        }

        function editGroup(id) {
            const library = activeLibrary();
            const group = groupsFor(library).get(id);
            if (id && !group) return;
            const caption = group ? label('GroupNamePrompt') : label('NewGroupPrompt');
            const name = String(root.prompt(caption, group?.name || label('NewGroupDefault')) || '').trim().slice(0, 24);
            if (!name) return;
            if (group?.local || library.readonly) {
                if (library.id !== 'system') return;
                const key = id || host.id('tpl_group');
                const next = [...localGroups.filter(entry => localCategory(entry.id) !== key), { id: key, name }];
                if (!writeLocal(groupsKey, next)) return;
                localGroups = next;
                removedFallbackGroups.delete(key);
                if (!id) category = key;
                render({ resetScroll: !id });
                return;
            }
            mutate(id ? idPath('/categories', id) : '/categories', id ? 'PATCH' : 'POST',
                { library_id: library.id, name }, id ? '重命名失败' : '新增分组失败', data => {
                    if (!id) category = data.category?.id || 'all';
                    return !id;
                });
        }

        function removeGroup(id) {
            const library = activeLibrary();
            const group = groupsFor(library).get(id);
            if (!group || !root.confirm(label('DeleteGroupConfirm'))) return;
            if (group.local || library.readonly) {
                if (library.id !== 'system') return;
                const next = localGroups.filter(entry => localCategory(entry.id) !== id);
                if (!writeLocal(groupsKey, next)) return;
                localGroups = next;
                removedFallbackGroups.add(id);
                const remaining = presets.map(preset => localCategory(preset.category) === id ? { ...preset, category: 'mine' } : preset);
                if (writeLocal(presetsKey, remaining)) presets = remaining;
                if (category === id) category = 'all';
                render({ resetScroll: true });
                return;
            }
            mutate(idPath('/categories', id), 'DELETE', null, '删除失败', () => {
                if (category === id) category = 'all';
                return true;
            });
        }

        function syncButton() {
            const active = target?.kind === 'composer';
            composerButton?.classList.toggle('active', active);
            composerButton?.setAttribute('aria-pressed', String(active));
        }

        function show(kind, nodeId = '', itemId = '') {
            ++viewRevision;
            if (target?.kind !== kind || target?.nodeId !== nodeId) editing = null;
            target = { kind, nodeId };
            preferredId = String(itemId || '');
            if (preferredId.startsWith('mine:') && activeLibrary().id !== 'system') {
                libraryId = 'system';
                category = 'all';
            }
            if (panel.parentElement !== host.shell) host.shell.append(panel);
            panel.dataset.target = kind;
            panel.dataset.nodeId = nodeId;
            panel.classList.add('open');
            syncButton();
            render();
            host.opened(target);
            search.focus({ preventScroll: true });
            refresh();
        }

        function close() {
            if (!target) return;
            ++viewRevision;
            target = null;
            editing = null;
            preferredId = '';
            panel.classList.remove('open');
            syncButton();
            host.redraw();
        }

        function isOpen(kind, nodeId) {
            return target?.kind === kind && (nodeId === undefined || target.nodeId === nodeId);
        }

        function apply(mode) {
            const item = itemInView();
            if (!item || !host.apply(target, item, appliedText(item, mode))) return;
            close();
            host.save();
        }

        function resetSelection() {
            selectedId = '';
            preferredId = '';
            editing = null;
        }

        const commands = {
            apply,
            'save-current': () => createItem(true),
            new: () => createItem(false),
            id(id) {
                preferredId = '';
                selectedId = id;
                editing = null;
                render();
            },
            edit: () => edit(itemInView()),
            delete: () => removeItem(itemInView()),
            'edit-save': () => saveItem(itemInView()),
            'edit-cancel'() {
                editing = null;
                render();
            },
            cat(id) {
                category = id;
                resetSelection();
                render({ resetScroll: true });
            },
            'group-edit'() {
                managing = !managing;
                render({ resetScroll: true });
            },
            'cat-new': () => editGroup(),
            'cat-edit': editGroup,
            'cat-delete': removeGroup
        };

        for (const type of ['pointerdown', 'mousedown', 'wheel']) {
            panel.addEventListener(type, event => event.stopPropagation(), { passive: true });
        }
        panel.addEventListener('click', event => {
            event.stopPropagation();
            if (busy || !target) return;
            const button = event.target.closest('button');
            const attribute = button?.getAttributeNames().find(name => name.startsWith('data-template-'));
            const action = attribute?.slice('data-template-'.length);
            if (action && Object.hasOwn(commands, action)) commands[action](button.getAttribute(attribute));
        });
        search.addEventListener('input', () => {
            preferredId = '';
            render({ resetScroll: true });
        });
        select.addEventListener('change', () => {
            ++viewRevision;
            libraryId = select.value;
            category = 'all';
            resetSelection();
            render({ resetScroll: true });
            refresh();
        });
        get('promptTemplateClose')?.addEventListener('click', close);
        composerButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (isOpen('composer')) close();
            else show('composer', host.composerNodeId());
        });

        return {
            loadLocal, refresh, render, show, close, isOpen,
            nodeId: () => target && target.kind !== 'composer' ? target.nodeId : ''
        };
    }

    root.XiaomeiSmartPromptLibrary = { create };
})(window);
