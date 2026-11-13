(function (root) {
    'use strict';

    const groupsKey = 'canvas_prompt_template_groups_v1';
    const overridesKey = 'canvas_prompt_template_overrides';
    const names = { view: 'View', storyboard: 'Storyboard', character: 'Character', product: 'Product', lighting: 'Lighting', custom: 'Mine' };
    const category = value => ['mine', 'my', 'personal'].includes(value) ? 'custom' : value || 'custom';

    function storage(key, fallback) {
        try { return JSON.parse(root.localStorage.getItem(key) || 'null') ?? fallback; }
        catch (_) { return fallback; }
    }

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const modal = get('promptTemplateModal');
        const panel = get('promptTemplatePanel');
        const search = get('promptTemplateSearch');
        const select = get('promptTemplateLibrarySelect');
        const cats = get('promptTemplateCats');
        const body = get('promptTemplateBody');
        const notice = get('promptTemplateNotice');
        const label = key => host.label('smart.tpl' + key);
        const message = key => host.label('canvas.promptLibrary' + key);
        const isOpen = () => modal.classList.contains('open');
        const identity = item => item.library.id + '\u0000' + item.id;
        const editable = library => library && !library.readonly;
        const localized = (item, field) => (host.english() && item[field + '_en']) || item[field] || '';
        let libraries = [];
        let libraryId = 'system';
        let filter = 'all';
        let current = '';
        let target;
        let editing = false;
        let managing = false;
        let busy = false;
        let openVersion = 0;
        let localGroups = [];
        let legacy = {};

        function report(text) {
            notice.textContent = text;
            notice.hidden = false;
            host.status(text);
        }

        function active() {
            return libraries.find(lib => lib.id === libraryId) || libraries[0];
        }

        function groups(library) {
            const all = new Map();
            const server = Array.isArray(library?.categories) ? library.categories : [];
            const defaults = library?.id === 'system' && !server.length
                ? Object.entries(names).map(([id, key]) => ({ id, name: label('Cat' + key) })) : [];
            for (const group of [...defaults, ...server]) {
                if (group?.id && group.name) all.set(group.id, group);
            }
            if (library?.id === 'system') {
                for (const group of localGroups) {
                    if (group?.id && group.name) all.set(category(group.id), { id: category(group.id), name: group.name, local: !all.has(category(group.id)) });
                }
            }
            return all;
        }

        function records() {
            const activeLibrary = active();
            const source = activeLibrary?.id === 'system' ? [activeLibrary, ...libraries.filter(lib => lib !== activeLibrary)] : [activeLibrary];
            const hidden = new Set(Array.isArray(legacy.hiddenBuiltinIds) ? legacy.hiddenBuiltinIds : []);
            return source.flatMap(library => (library?.items || []).filter(item => item?.id && item.positive
                && (library.id !== 'system' || !hidden.has(item.id))).map(item => ({
                    ...item, ...(library.id === 'system' && legacy.editedBuiltins?.[item.id]),
                    id: item.id, library,
                })));
        }

        function groupName(item) {
            const key = category(item.category);
            return groups(item.library).get(key)?.name || (names[key] ? label('Cat' + names[key]) : key);
        }

        function el(tag, cls, text) {
            const node = doc.createElement(tag);
            if (cls) node.className = cls;
            if (text != null) node.textContent = text;
            return node;
        }

        function button(title, action, { cls, icon, disabled = false, hint } = {}) {
            const node = el('button', cls);
            node.type = 'button';
            node.disabled = disabled;
            if (hint) { node.title = hint; node.setAttribute('aria-label', hint); }
            if (icon) {
                const glyph = el('i');
                glyph.dataset.lucide = icon;
                node.append(glyph);
            }
            if (title) node.append(el('span', '', title));
            node.addEventListener('click', action);
            return node;
        }

        function changeFilter(next) {
            filter = next;
            current = '';
            editing = false;
            render();
        }

        function tabs(counts) {
            const lib = active();
            const nav = el('div', managing ? 'prompt-template-group-panel' : 'prompt-template-nav');
            const items = el('div', managing ? 'prompt-template-group-list' : 'prompt-template-tabs');
            const toggle = () => { managing = !managing; render(); };
            if (managing) {
                const head = el('div', 'prompt-template-group-title');
                const copy = el('div');
                copy.append(el('strong', '', label('GroupManage')), el('span', '', label('GroupHint')));
                const tools = el('div', 'prompt-template-group-tools');
                tools.append(button(label('Add'), () => editGroup(), { icon: 'plus', disabled: busy }),
                    button(label('Done'), toggle, { cls: 'primary', icon: 'check' }));
                head.append(copy, tools);
                nav.append(head);
            }
            const choices = [...groups(lib).values()];
            if (!managing) choices.unshift({ id: 'all', name: label('All') });
            for (const group of choices) {
                const name = button(group.name, () => changeFilter(group.id), {
                    cls: (managing ? 'group-name ' : '') + (filter === group.id ? 'active' : ''),
                });
                name.dataset.templateCat = group.id;
                name.append(el('small', '', counts.get(group.id) || 0));
                if (managing) {
                    const row = el('div', 'prompt-template-group-row has-delete');
                    row.append(name,
                        button('', () => editGroup(group), { cls: 'group-tool', icon: 'pencil', disabled: busy, hint: label('Rename') }),
                        button('', () => removeGroup(group), { cls: 'group-tool danger', icon: 'trash-2', disabled: busy, hint: host.label('common.delete') }));
                    items.append(row);
                } else items.append(name);
            }
            nav.append(items);
            if (!managing) nav.append(button(label('ManageGroups'), toggle, {
                cls: 'prompt-template-manage-groups', icon: 'settings-2', disabled: !editable(lib),
            }));
            return nav;
        }

        function card(item) {
            const node = button('', () => { current = identity(item); editing = false; render(); },
                { cls: 'prompt-template-card' + (identity(item) === current ? ' active' : '') });
            node.dataset.templateId = item.id;
            const head = el('span', 'prompt-template-card-top');
            head.append(el('span', 'prompt-template-name', localized(item, 'name')),
                el('span', 'prompt-template-source', label(item.library.id === 'system' ? 'Builtin' : 'Mine')));
            const scene = root.XiaomeiPromptPresentation.description(localized(item, 'scene'), item.positive);
            node.append(head, el('span', 'prompt-template-scene', scene || item.positive),
                el('span', 'prompt-template-tag', groupName(item)));
            return node;
        }

        function fields(item) {
            const area = el('div', 'prompt-template-edit-fields');
            const name = el('input');
            const groupsSelect = el('select');
            const positive = el('textarea');
            name.dataset.templateEditName = '';
            positive.dataset.templateEditText = '';
            groupsSelect.dataset.templateEditCategory = '';
            name.value = localized(item, 'name');
            positive.value = item.positive;
            const choices = groups(item.library);
            const selected = category(item.category);
            if (!choices.has(selected)) choices.set(selected, { id: selected, name: groupName(item) });
            groupsSelect.append(...[...choices.values()].map(group => new Option(group.name, group.id)));
            groupsSelect.value = selected;
            area.append(el('label', '', label('Name')), name, el('label', '', label('Group')), groupsSelect,
                el('label', '', label('Content')), positive);
            return { area, read: () => ({ name: name.value.trim(), category: groupsSelect.value, positive: positive.value.trim() }) };
        }

        const params = item => Object.entries(item.params || {}).map(([key, value]) => key + ': ' + value).join('\n');

        function detail(item) {
            const view = el('div', 'prompt-template-detail');
            if (!item) {
                view.append(el('div', 'prompt-template-empty', label('PickOrCreate')));
                return view;
            }
            const head = el('div', 'prompt-template-detail-head');
            const heading = el('div');
            heading.append(el('strong', '', localized(item, 'name')), el('span', '', groupName(item) + ' · '
                + label(item.library.id === 'system' ? 'BuiltinTemplate' : 'MineTemplate')));
            head.append(heading);
            const writable = editable(item.library);
            const removeButton = () => button(host.label('common.delete'), () => removeItem(item),
                { cls: 'danger', icon: 'trash-2', disabled: !writable || busy });
            const actions = el('div', 'prompt-template-actions');
            view.append(head);
            if (editing && writable) {
                const edit = fields(item);
                view.append(edit.area);
                actions.append(button(host.label('common.cancel'), () => { editing = false; render(); }, { icon: 'x' }),
                    removeButton(), button(host.label('common.save'), () => saveItem(item, edit.read()),
                        { cls: 'primary', icon: 'save', disabled: busy }));
            } else {
                const tools = el('div', 'prompt-template-icon-actions');
                tools.append(button(host.label('common.edit'), () => { editing = true; render(); },
                    { icon: 'pencil', disabled: !writable || busy }), removeButton());
                head.append(tools);
                const preview = el('div', 'prompt-template-preview-content');
                for (const [key, value] of [['Positive', item.positive], ['Negative', item.negative], ['Params', params(item)]]) {
                    if (!value) continue;
                    const section = el('div', 'prompt-template-section');
                    section.append(el('label', '', label(key)), el('p', '', value));
                    preview.append(section);
                }
                view.append(preview);
                const apply = full => {
                    const content = [item.positive.trim()];
                    if (full && item.negative) content.push('Negative prompt:\n' + item.negative.trim());
                    if (full && params(item)) content.push('Params:\n' + params(item));
                    const node = target;
                    close();
                    if (node && host.node(node.id) === node) host.apply(node, content.join('\n\n'));
                };
                const positive = button(label('ApplyPositive'), () => apply(false), { icon: 'corner-down-left' });
                const full = button(label('ApplyFull'), () => apply(true), { cls: 'primary', icon: 'wand-sparkles' });
                positive.dataset.templateApply = 'positive';
                full.dataset.templateApply = 'full';
                actions.append(positive, full);
            }
            view.append(actions);
            return view;
        }

        function render() {
            const lib = active();
            const query = search.value.trim().toLowerCase();
            const all = records();
            const visible = all.filter(item => (filter === 'all' || category(item.category) === filter)
                && (!query || [item.name, item.name_en, item.scene, item.scene_en, item.positive, item.negative, item.library.name]
                    .join(' ').toLowerCase().includes(query)));
            const item = visible.find(entry => identity(entry) === current) || visible[0];
            if (item && identity(item) !== current) editing = false;
            current = item ? identity(item) : '';
            const counts = new Map([['all', all.length]]);
            for (const entry of all) {
                const key = category(entry.category);
                counts.set(key, (counts.get(key) || 0) + 1);
            }
            const scrollable = ['.prompt-template-tabs', '.prompt-template-list', '.prompt-template-preview-content'];
            const scroll = scrollable.map(selector => {
                const node = panel.querySelector(selector);
                return [node?.scrollLeft || 0, node?.scrollTop || 0];
            });
            select.replaceChildren(...libraries.map(library => new Option(library.name, library.id)));
            if (lib) select.value = lib.id;
            cats.replaceChildren(tabs(counts));
            const list = el('div', 'prompt-template-list');
            const tools = el('div', 'prompt-template-list-tools');
            tools.append(button(label('SaveCurrent'), () => createItem(true), { icon: 'bookmark-plus', disabled: !editable(lib) || busy }),
                button(label('NewTemplate'), () => createItem(false), { icon: 'file-plus-2', disabled: !editable(lib) || busy }));
            list.append(tools);
            if (visible.length) list.append(...visible.map(card));
            else list.append(el('div', 'prompt-template-list-empty', label('NoMatches')));
            body.replaceChildren(list, detail(item));
            scrollable.forEach((selector, index) => panel.querySelector(selector)?.scrollTo(...scroll[index]));
            host.icons();
        }

        async function api(path, method = 'GET', value) {
            const response = await root.fetch('/api/prompt-libraries' + path, value ? {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
            } : { method });
            if (!response.ok) throw new Error(await host.responseError(response, message('Failed')));
            return response.json();
        }

        function adopt(data) {
            if (Array.isArray(data?.library?.libraries)) libraries = data.library.libraries;
        }

        async function mutate(path, method, value, done) {
            if (busy) return;
            const version = openVersion;
            busy = true;
            notice.hidden = true;
            let changed = false;
            try {
                const data = await api(path, method, value);
                adopt(data);
                if (openVersion === version) {
                    done(data);
                    changed = true;
                }
            } catch (error) {
                report(error.message || message('Failed'));
            } finally {
                busy = false;
                if (changed && isOpen() && openVersion === version) render();
            }
        }

        function createItem(fromNode) {
            const lib = active();
            if (!editable(lib)) return;
            const positive = fromNode ? String(target?.text || '').trim() : message('NewText');
            if (!positive) { report(message('EmptyNode')); return; }
            const name = fromNode ? positive.split(/\r?\n/, 1)[0].slice(0, 28) : message('NewTemplate');
            const key = filter === 'all' ? 'custom' : filter;
            mutate('/items', 'POST', { library_id: lib.id, name, category: key, positive, scene: message('PresetScene') }, data => {
                if (!data.item || active()?.id !== lib.id) return;
                search.value = '';
                current = identity({ ...data.item, library: lib });
                filter = category(data.item.category);
                editing = true;
            });
        }

        function saveItem(item, fields) {
            if (!editable(item.library)) return;
            if (!fields.name || !fields.positive) { report(label('Required')); return; }
            mutate('/items/' + encodeURIComponent(item.id), 'PATCH', {
                ...fields, library_id: item.library.id, scene: item.scene || '', negative: item.negative || '',
            }, () => {
                if (item.library.id === 'system' && Object.hasOwn(legacy.editedBuiltins || {}, item.id)) {
                    delete legacy.editedBuiltins[item.id];
                    root.localStorage.setItem(overridesKey, JSON.stringify(legacy));
                }
                if (current === identity(item)) { filter = category(fields.category); editing = false; }
            });
        }

        function removeItem(item) {
            if (!editable(item.library) || !root.confirm(message('ConfirmDelete').replace('{name}', () => item.name))) return;
            const query = new URLSearchParams({ library_id: item.library.id });
            mutate('/items/' + encodeURIComponent(item.id) + '?' + query, 'DELETE', null, () => {
                if (current === identity(item)) { current = ''; editing = false; }
            });
        }

        function removeLocalGroup(id) {
            localGroups = localGroups.filter(group => category(group?.id) !== id);
            root.localStorage.setItem(groupsKey, JSON.stringify(localGroups));
        }

        function editGroup(group) {
            const lib = active();
            if (!editable(lib)) return;
            const name = root.prompt(label(group ? 'GroupNamePrompt' : 'NewGroupPrompt'), group?.name || label('NewGroupDefault'))?.trim().slice(0, 24);
            if (!name) return;
            if (group?.local) {
                removeLocalGroup(group.id);
                localGroups.push({ id: group.id, name });
                root.localStorage.setItem(groupsKey, JSON.stringify(localGroups));
                render();
                return;
            }
            mutate(group ? '/categories/' + encodeURIComponent(group.id) : '/categories', group ? 'PATCH' : 'POST',
                { library_id: lib.id, name }, data => {
                    if (group && lib.id === 'system') removeLocalGroup(group.id);
                    if (data.category?.id && active()?.id === lib.id) filter = data.category.id;
                });
        }

        function removeGroup(group) {
            const lib = active();
            if (!editable(lib) || !root.confirm(label('DeleteGroupConfirm'))) return;
            const done = () => {
                if (lib.id === 'system') removeLocalGroup(group.id);
                if (filter === group.id && active()?.id === lib.id) filter = 'all';
            };
            if (group.local) { done(); render(); }
            else mutate('/categories/' + encodeURIComponent(group.id), 'DELETE', null, done);
        }

        function syncButtons() {
            for (const button of doc.querySelectorAll('[data-prompt-template-open]')) {
                const pressed = isOpen() && button.dataset.promptTemplateNodeId === target?.id;
                button.classList.toggle('active', pressed);
                button.setAttribute('aria-pressed', String(pressed));
            }
        }

        async function open(id) {
            const node = host.node(id);
            if (node?.type !== 'prompt') return;
            const version = ++openVersion;
            target = node;
            search.value = '';
            notice.hidden = true;
            editing = false;
            managing = false;
            const saved = storage(groupsKey, []);
            localGroups = Array.isArray(saved) ? saved : [];
            legacy = storage(overridesKey, {});
            try {
                const data = await api('');
                if (version !== openVersion || host.node(id) !== node) return;
                adopt(data);
            } catch (error) { report(error.message || message('Failed')); }
            if (version !== openVersion || host.node(id) !== node) return;
            if (!libraries.some(lib => lib.id === libraryId)) {
                libraryId = libraries.some(lib => lib.id === 'system') ? 'system' : libraries[0]?.id;
                filter = 'all';
            }
            modal.classList.add('open');
            render();
            syncButtons();
            search.focus();
        }

        function close() {
            openVersion++;
            modal.classList.remove('open');
            target = null;
            editing = false;
            syncButtons();
        }

        search.addEventListener('input', () => { editing = false; render(); });
        select.addEventListener('change', () => {
            libraryId = select.value;
            managing = false;
            changeFilter('all');
        });
        get('promptTemplateClose').addEventListener('click', close);
        modal.addEventListener('click', event => { if (event.target === modal) close(); });
        panel.addEventListener('wheel', event => event.stopPropagation());
        return { open, close, isOpen, active: id => isOpen() && id === target?.id };
    }

    root.XiaomeiClassicPromptTemplates = { create };
})(window);
