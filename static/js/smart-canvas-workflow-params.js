(function (root) {
    'use strict';

    const rhKinds = [
        ['model', '模型 API', 'box'],
        ['app', 'AI 应用', 'sparkles'],
        ['workflow', '工作流', 'workflow'],
    ];
    const machines = [['default', '24G'], ['plus', '48G'], ['ultra', '84G']];
    const mediaIcons = new Map([['image', 'image'], ['video', 'film'], ['audio', 'volume-2']]);
    const rhPopover = 'rh-picker-popover';
    const { keyOf, fieldKind, choices } = root.XiaomeiRunningHubInputs;

    function create(host) {
        const { label, rh, comfy } = host;
        const document = host.container.ownerDocument.createElement('template').content.ownerDocument;

        function element(tag, classes, text) {
            const node = document.createElement(tag);
            if (classes) node.className = classes;
            if (text != null) node.textContent = text;
            return node;
        }

        function icon(name, classes) {
            const node = element('i', classes);
            node.dataset.lucide = name;
            return node;
        }

        function button(classes, ...children) {
            const node = element('button', classes);
            node.type = 'button';
            node.append(...children);
            return node;
        }

        function option(text, data, active, symbol) {
            const node = button('direct-option');
            node.classList.toggle('active', active);
            Object.assign(node.dataset, data);
            if (symbol) node.append(icon(symbol));
            node.append(element('span', '', text));
            return node;
        }

        function settingOptions(key, choices, current) {
            return choices.map(([value, text]) => option(text, { smartParam: key, smartValue: value }, value === current));
        }

        function picker({ classes, title, trigger, options, popover = '', list = '' }) {
            const control = element('div', `smart-control ${classes}`);
            const content = element('div', `smart-popover compact-popover ${popover}`.trim());
            const rows = element('div', `model-list ${list}`.trim());
            rows.append(...options);
            content.append(element('div', 'smart-popover-title', title), rows);
            control.append(button('smart-pill', ...trigger), content);
            return control;
        }

        function check(text, data, active) {
            const node = button('setting-check', element('span', 'check-box'), element('span', '', text));
            node.classList.toggle('active', active);
            Object.assign(node.dataset, data);
            return node;
        }

        function input(type, data, value, limits = {}) {
            const node = element('input');
            node.type = type;
            Object.assign(node.dataset, data);
            for (const key of ['min', 'max', 'step']) {
                if (limits[key] != null) node.setAttribute(key, limits[key]);
            }
            node.defaultValue = value ?? '';
            return node;
        }

        function fieldRow(text, control, { random, textField }) {
            const classes = random ? 'num-with-dice' : textField ? 'num-compact rh-text-param' : 'num-compact';
            const row = element('div', classes);
            row.title = text;
            row.append(element('span', 'num-label', text), control);
            if (random) {
                const dice = button('dice-btn', icon('dice-5'));
                Object.assign(dice.dataset, random.data);
                dice.classList.toggle('active', random.active);
                dice.title = label(random.active ? 'smart.diceOn' : 'smart.diceOff');
                row.append(dice);
            }
            return row;
        }

        function rhDropdown(key, title, selected, choices) {
            const control = picker({
                classes: 'rh-dropdown-control', title, popover: `${rhPopover} rh-param-popover`, list: 'rh-param-list',
                trigger: [element('span', 'sub', selected || choices[0] || title), icon('chevron-down', 'pill-caret')],
                options: choices.map(choice => option(choice, { rhPick: key, rhValue: choice }, choice === String(selected))),
            });
            control.title = title;
            return control;
        }

        function slider(field, key, text, value) {
            const min = Number.isFinite(Number(field.min)) ? Number(field.min) : 0;
            const candidateMax = Number(field.max);
            const candidateStep = Number(field.step);
            const max = Number.isFinite(candidateMax) && candidateMax > min ? candidateMax : 1;
            const step = Number.isFinite(candidateStep) && candidateStep > 0 ? candidateStep : 0.01;
            const number = Number.isFinite(Number(value)) ? Number(value) : min;
            const control = element('div', 'smart-control rh-slider-control');
            control.title = text;
            const content = element('div', `smart-popover compact-popover ${rhPopover} rh-param-popover rh-slider-popover`);
            const title = element('div', 'smart-popover-title');
            title.append(element('span', '', text), element('span', 'rh-slider-value', number));
            const range = input('range', { rhParam: key, rhType: 'slider' }, number, { min, max, step });
            range.className = 'smart-range rh-slider-input';
            content.append(title, range);
            control.append(button('smart-pill', element('span', 'sub', text), element('span', 'rh-slider-pill-value', number)), content);
            return control;
        }

        function rhField(field, kind) {
            const key = keyOf(field.nodeId, field.fieldName);
            const text = field.label || field.fieldName || 'Field';
            const value = rh.value(field);
            if (kind === 'boolean') return check(text, { rhBool: key }, String(value).toLowerCase() === 'true');
            if (kind === 'slider') return slider(field, key, text, value);
            const options = choices(field);
            if (options.length) return rhDropdown(key, text, value, options);
            const numeric = kind === 'number';
            const random = numeric && rh.canRandomize(field) ? { data: { rhRandom: key }, active: rh.randomActive(key) } : null;
            return fieldRow(text, input(numeric ? 'number' : 'text', { rhParam: key }, value), { random, textField: !numeric });
        }

        function rhSelector(ref) {
            const title = label('smart.rhConfig');
            const options = [];
            for (const [kind, text, symbol] of rhKinds) {
                const entries = rh.entries(kind);
                if (!entries.length) continue;
                const header = element('div', 'model-list-label rh-list-label', text);
                header.append(element('span', 'count', entries.length));
                options.push(header);
                for (const entry of entries) {
                    const id = rh.entryId(entry, kind);
                    const row = option(rh.entryLabel(entry, kind), { smartParam: 'rhConfigKey', smartValue: rh.entryKey(kind, id) },
                        ref.kind === kind && ref.id === id, symbol);
                    row.classList.add('rh-entry-option');
                    options.push(row);
                }
            }
            const selected = ref.entry ? rh.entryLabel(ref.entry, ref.kind) : rh.entryLabel({ id: ref.id }, ref.kind);
            return picker({
                classes: 'rh-config-control', title, options, popover: rhPopover, list: 'rh-config-list',
                trigger: [icon('workflow'), element('span', 'sub', selected), icon('chevron-down', 'pill-caret')],
            });
        }

        function rhChoice(classes, name, symbol, key, choices, current) {
            return picker({
                classes, title: label(name), options: settingOptions(key, choices, current), popover: rhPopover,
                trigger: [icon(symbol), element('span', '', choices.find(([value]) => value === current)[1]), icon('chevron-down', 'pill-caret')],
            });
        }

        function renderRunningHub(settings, ref, fields) {
            settings.rhPayment = settings.rhPayment === 'wallet' ? 'wallet' : 'free';
            settings.rhParams ||= {};
            settings.rhRandomActive ||= {};
            const fragment = document.createDocumentFragment();
            if (!ref) {
                fragment.append(element('div', 'muted-note', label('smart.rhNeedConfig')));
            } else if (ref.kind === 'model') {
                const sizeAndCount = element('template');
                sizeAndCount.innerHTML = rh.modelControls();
                fragment.append(rhSelector(ref), sizeAndCount.content);
            } else {
                const machine = String(settings.rhInstanceType || '').toLowerCase();
                settings.rhInstanceType = machines.some(([id]) => id === machine) ? machine : 'default';
                const payment = [['free', label('smart.rhFreeKey')], ['wallet', label('smart.rhWalletKey')]];
                fragment.append(
                    rhSelector(ref),
                    rhChoice('rh-payment-control', 'smart.rhKey', 'key-round', 'rhPayment', payment, settings.rhPayment),
                    rhChoice('rh-machine-control', 'smart.rhMachine', 'cpu', 'rhInstanceType', machines, settings.rhInstanceType)
                );
                let media = 0;
                let prompts = 0;
                const controls = [];
                for (const field of fields) {
                    const kind = fieldKind(field);
                    if (mediaIcons.has(kind)) media++;
                    else if (kind === 'prompt') prompts++;
                    else controls.push(rhField(field, kind));
                }
                fragment.append(element('div', 'rh-mini-summary', `${media} 素材 · ${prompts} 提示词`));
                if (fields.length) fragment.append(...controls);
                else fragment.append(element('div', 'muted-note', label('smart.rhNeedFields')));
            }
            host.container.replaceChildren(fragment);
        }

        function comfyLabel(tag, classes, text, symbol, caption) {
            const row = element(tag, `comfy-node-field ${classes}`.trim());
            const title = element(tag === 'div' ? 'div' : 'span', 'comfy-node-field-label');
            const name = element('span');
            name.append(icon(symbol), text);
            title.append(name, element('small', '', caption));
            row.append(title);
            return row;
        }

        function comfyFieldMarkup(node, field) {
            const id = String(field?.id || '').trim();
            if (!id) return '';
            const text = comfy.fieldLabel(field);
            const kind = comfy.kind(field);
            if (mediaIcons.has(kind)) {
                const required = field.required === true;
                const row = comfyLabel('div', 'comfy-node-media-field', text, mediaIcons.get(kind), required ? '需要连接' : '可选输入');
                row.classList.toggle('required', required);
                const slot = element('template');
                slot.innerHTML = comfy.mediaSlot(node, field, kind);
                row.append(slot.content);
                return row.outerHTML;
            }

            const value = comfy.value(node, field);
            const data = { comfyNodeParam: id };
            if (kind === 'prompt' || field.type === 'textarea') {
                const row = comfyLabel('label', 'comfy-node-prompt-field', text, 'text-quote', '主要参数');
                const prompt = element('textarea', '', value);
                const savedHeight = Number(node.comfyFieldHeights?.[id]);
                prompt.style.height = `${Number.isFinite(savedHeight) ? Math.max(96, Math.round(savedHeight)) : 128}px`;
                prompt.placeholder = text;
                Object.assign(prompt.dataset, data);
                row.append(prompt);
                return row.outerHTML;
            }
            if (field.type === 'boolean') {
                const row = comfyLabel('label', 'comfy-node-toggle-field', text, 'toggle-right', '开关');
                const check = element('input');
                check.type = 'checkbox';
                check.defaultChecked = comfy.checked(value);
                check.dataset.comfyNodeBool = id;
                const visual = element('span', 'comfy-node-switch');
                visual.setAttribute('aria-hidden', 'true');
                visual.append(element('span'));
                row.append(check, visual);
                return row.outerHTML;
            }
            if (field.type === 'dropdown') {
                const row = comfyLabel('label', 'comfy-node-select-field', text, 'list-filter', '选项');
                const select = element('select');
                Object.assign(select.dataset, data);
                for (const choice of Array.isArray(field.options) ? field.options : []) {
                    const item = element('option', '', comfy.optionLabel(field, choice));
                    item.value = choice;
                    item.defaultSelected = String(choice) === String(value);
                    select.append(item);
                }
                if (!select.length) {
                    const empty = element('option', '', '暂无选项');
                    empty.value = '';
                    select.append(empty);
                }
                row.append(select);
                return row.outerHTML;
            }

            const numeric = field.type === 'number' || field.type === 'slider';
            const caption = field.type === 'slider' ? '滑块' : numeric ? '数值' : '文本';
            const row = comfyLabel('label', numeric ? 'comfy-node-number-field' : '', text, numeric ? 'sliders-horizontal' : 'type', caption);
            const controls = element('span', 'comfy-node-input-wrap');
            controls.append(input(numeric ? 'number' : 'text', data, value, field));
            if (numeric && comfy.canRandomize(field)) {
                const active = comfy.randomActive(node, id);
                const dice = button('comfy-node-dice', icon('dice-5'));
                dice.classList.toggle('active', active);
                dice.dataset.comfyNodeRandom = id;
                dice.title = active ? '自动随机：每次运行更换数值，点击固定' : '固定数值：点击开启每次运行随机';
                dice.setAttribute('aria-label', `${text}：${dice.title}`);
                dice.setAttribute('aria-pressed', String(active));
                controls.append(dice);
            }
            row.append(controls);
            return row.outerHTML;
        }

        return { renderRunningHub, comfyFieldMarkup };
    }

    root.XiaomeiSmartWorkflowParams = { create };
})(globalThis);
