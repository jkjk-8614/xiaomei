(function () {
    'use strict';

    const fields = Object.freeze({image: 'image_models', video: 'video_models', chat: 'chat_models'});
    const categories = Object.keys(fields);
    const modelId = value => typeof value === 'string' ? value.trim() : '';

    function catalog(data, context) {
        const ids = [...new Set((Array.isArray(data?.all) ? data.all : []).map(modelId).filter(Boolean))];
        return {
            context, ids,
            note: String(data?.message || ''),
            groups: new Map(Object.entries(data?.model_groups || {}).filter(([, group]) => Array.isArray(group))),
            labels: new Map(Object.entries(data?.model_names || {}).filter(([, label]) => typeof label === 'string')),
            suggestions: Object.fromEntries(categories.map(kind => [
                kind, new Set((Array.isArray(data?.[fields[kind]]) ? data[fields[kind]] : []).map(modelId)),
            ])),
        };
    }

    function selection(catalog, provider, describe) {
        const saved = Object.fromEntries(categories.map(kind => [
            kind, new Set((provider[fields[kind]] || []).map(modelId)),
        ]));
        const rows = catalog.ids.map(id => {
            const configured = categories.find(kind => saved[kind].has(id));
            const suggested = ['image', 'video'].find(kind => catalog.suggestions[kind].has(id));
            return {id, kind: configured || suggested || 'chat', checked: Boolean(configured), ...describe(id)};
        });
        return {catalog, rows};
    }

    function readSelection(session, provider, requiresOpenAi) {
        const lists = {image: [], chat: [], video: []};
        const labels = [], protocols = [];
        const previous = provider.model_protocols || {};
        for (const row of session.rows) {
            if (!row.checked) continue;
            lists[row.kind].push(row.id);
            if (row.label && row.label !== row.id) labels.push([row.id, row.label]);
            if (row.kind === 'video') continue;
            const id = row.id.toLowerCase();
            if (id.startsWith('nano-banana') || (id.startsWith('gemini-') && id.includes('image'))) {
                protocols.push([row.id, requiresOpenAi ? 'openai' : 'gemini']);
            } else if (Object.hasOwn(previous, row.id) && ['openai', 'gemini'].includes(previous[row.id])) {
                protocols.push([row.id, previous[row.id]]);
            }
        }
        const available = new Set(session.catalog.ids);
        const previousIds = new Set(categories.flatMap(kind => (provider[fields[kind]] || []).map(modelId).filter(Boolean)));
        let removed = 0;
        for (const id of previousIds) {
            if (!available.has(id)) removed++;
        }
        return {
            lists, removed,
            model_names: Object.fromEntries(labels),
            model_protocols: Object.fromEntries(protocols),
        };
    }

    function editModel(provider, kind, index, value) {
        const models = provider[fields[kind]];
        if (!Array.isArray(models) || index < 0 || index >= models.length) return false;
        const before = modelId(models[index]);
        const next = modelId(value);
        provider.model_selection_managed = true;
        if (value === undefined) models.splice(index, 1);
        else models[index] = value;
        if (!before || before === next) return true;

        const stillUsed = categories.some(category => provider[fields[category]]?.some(id => modelId(id) === before));
        for (const field of ['model_protocols', 'model_names']) {
            const source = provider[field];
            if (!source || !Object.hasOwn(source, before)) continue;
            const metadata = new Map(Object.entries(source));
            const previous = metadata.get(before);
            if (!stillUsed) metadata.delete(before);
            if (next && previous && (field !== 'model_names' || previous !== next)) metadata.set(next, previous);
            provider[field] = Object.fromEntries(metadata);
        }
        return true;
    }

    function setProtocol(provider, kind, index, value) {
        const id = modelId(provider[fields[kind]]?.[index]);
        if (!id) return false;
        const protocols = new Map(Object.entries(provider.model_protocols || {}));
        const protocol = modelId(value).toLowerCase();
        if (['openai', 'gemini'].includes(protocol)) protocols.set(id, protocol);
        else protocols.delete(id);
        provider.model_protocols = Object.fromEntries(protocols);
        return true;
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function picker(dialog, actions) {
        const filter = dialog.querySelector('#pickerFilter');
        const list = dialog.querySelector('#pickerList');
        const tabs = [...dialog.querySelectorAll('.picker-cat-tab')];
        const count = dialog.querySelector('#pickerCount');
        const note = dialog.querySelector('#pickerSourceNote');
        const selectAll = dialog.querySelector('#pickerSelectAllBtn');
        const summary = {
            image: [dialog.querySelector('#sumImage'), '生图'],
            chat: [dialog.querySelector('#sumChat'), 'LLM'],
            video: [dialog.querySelector('#sumVideo'), '视频'],
        };
        const unselected = dialog.querySelector('#sumUnsel');
        let session, returnFocus, tab;
        let visible = [];

        function updateCounts() {
            const selected = {all: 0, image: 0, chat: 0, video: 0};
            const totals = {all: session.rows.length, image: 0, chat: 0, video: 0};
            for (const row of session.rows) {
                totals[row.kind]++;
                if (row.checked) {
                    selected[row.kind]++;
                    selected.all++;
                }
            }
            for (const button of tabs) {
                const kind = button.dataset.cat;
                button.querySelector('.cat-count').textContent = selected[kind] + '/' + totals[kind];
            }
            for (const [kind, [node, label]] of Object.entries(summary)) {
                node.textContent = label + ' ' + selected[kind];
                node.classList.toggle('picker-sum-chip-empty', selected[kind] === 0);
            }
            unselected.textContent = '未选 ' + (totals.all - selected.all);
            selectAll.disabled = visible.every(({row}) => row.checked);
        }

        function setChecked(entry, checked) {
            entry.row.checked = checked;
            entry.checkbox.checked = checked;
            entry.node.classList.toggle('has-sel', checked);
        }

        function rowElement(row, index) {
            const node = element('label', 'picker-row');
            const checkbox = element('input', 'picker-checkbox');
            checkbox.type = 'checkbox';
            checkbox.dataset.pickerIndex = index;
            const different = row.label && row.label !== row.id;
            checkbox.setAttribute('aria-label', different ? row.label + ' (' + row.id + ')' : row.id);
            const badge = element('span', 'picker-model-badge', row.badge);
            badge.setAttribute('aria-hidden', 'true');
            const name = element('span', 'picker-model-name');
            name.title = row.id;
            name.append(element('span', 'picker-model-label', row.label || row.id));
            if (different) name.append(element('span', 'picker-model-id', row.id));
            node.append(checkbox, badge, name);
            const groups = session.catalog.groups.get(row.id)?.filter(Boolean).join(' / ');
            if (groups) {
                const tag = element('span', 'picker-model-group', groups + ' · 其他分组');
                tag.title = '该模型来自上游站点的其他分组，调用前请确认 Key 已获得对应授权';
                node.append(tag);
            }
            const entry = {row, node, checkbox};
            setChecked(entry, row.checked);
            checkbox.addEventListener('change', () => {
                setChecked(entry, checkbox.checked);
                updateCounts();
            });
            return entry;
        }

        function render() {
            if (!session) return;
            const query = filter.value.toLowerCase();
            const rows = session.rows.filter(row => (tab === 'all' || row.kind === tab)
                && (row.id.toLowerCase().includes(query) || row.label.toLowerCase().includes(query)));
            rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
            visible = rows.map(rowElement);
            const content = document.createDocumentFragment();
            for (const entry of visible) content.append(entry.node);
            if (!visible.length) content.append(element('div', 'picker-empty', '无匹配'));
            list.replaceChildren(content);
            count.textContent = '共 ' + session.rows.length + ' 个模型 · 当前显示 ' + visible.length + ' 个';
            updateCounts();
        }

        function activate(kind) {
            tab = kind;
            for (const button of tabs) {
                const active = button.dataset.cat === tab;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', String(active));
            }
            render();
        }

        const close = () => dialog.close();
        for (const button of tabs) button.addEventListener('click', () => activate(button.dataset.cat));
        for (const button of dialog.querySelectorAll('[data-close-model-picker]')) button.addEventListener('click', close);
        dialog.querySelector('[data-apply-model-picker]').addEventListener('click', actions.apply);
        filter.addEventListener('input', render);
        selectAll.addEventListener('click', () => {
            for (const entry of visible) setChecked(entry, true);
            updateCounts();
        });
        dialog.addEventListener('close', () => {
            const target = returnFocus;
            returnFocus = null;
            session = null;
            const restore = () => { if (!dialog.open && target?.isConnected && !target.disabled) target.focus(); };
            Promise.resolve(actions.pendingSave()).then(restore, restore);
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const {left, right, top, bottom} = dialog.getBoundingClientRect();
            if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) close();
        });
        dialog.addEventListener('keydown', event => {
            if (event.key !== 'Tab') return;
            const controls = [...dialog.querySelectorAll('button, input')]
                .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        });
        return {
            open(next, focus) {
                if (!dialog.open) returnFocus = focus;
                session = next;
                note.textContent = next.catalog.note;
                note.hidden = !next.catalog.note;
                activate('all');
                if (!dialog.open) dialog.showModal();
                filter.focus();
            },
            close,
            current: () => session,
        };
    }

    function editor(list, entries, actions, labels) {
        if (!entries.length) {
            list.replaceChildren(element('div', 'empty', labels.empty));
            return;
        }
        const rows = entries.map(({id, label, protocol}, index) => {
            const row = element('div', 'model-row');
            const field = element('div', 'model-id-field');
            if (label && label !== id) field.append(element('div', 'model-display-name', label));
            const input = element('input');
            input.value = id;
            input.setAttribute('aria-label', labels.id);
            input.addEventListener('input', () => actions.rename(index, input.value));
            field.append(input);
            row.append(field);
            if (protocol !== null) {
                row.classList.add('has-protocol');
                const select = element('select', 'model-protocol-select');
                select.title = labels.protocol;
                for (const [value, text] of [['', labels.defaultProtocol], ['openai', 'OpenAI'], ['gemini', 'Gemini']]) {
                    const option = element('option', '', text);
                    option.value = value;
                    select.append(option);
                }
                select.value = ['openai', 'gemini'].includes(protocol) ? protocol : '';
                select.addEventListener('change', () => actions.protocol(index, select.value));
                row.append(select);
            }
            const remove = element('button', 'icon-btn');
            remove.type = 'button';
            remove.title = labels.remove;
            const icon = element('i', 'w-4 h-4');
            icon.dataset.lucide = 'trash-2';
            icon.setAttribute('aria-hidden', 'true');
            remove.append(icon);
            remove.addEventListener('click', () => actions.remove(index));
            row.append(remove);
            return row;
        });
        list.replaceChildren(...rows);
    }

    window.ApiSettingsModels = {catalog, selection, readSelection, editModel, setProtocol, picker, editor, fields};
})();
