(function (root) {
    'use strict';

    const mediaKinds = new Set(['image', 'video', 'audio']);
    const kinds = ['model', 'app', 'workflow'];
    const dimensions = {
        square: '1:1', portrait: '2:3', landscape: '3:2', portrait43: '3:4', landscape43: '4:3',
        story: '9:16', wide: '16:9', ultrawide: '21:9', ultratall: '9:21',
    };
    const { fieldKind, keyOf, choices: fieldChoices, defaultValue, orderedFields, bindFields, pruneInputs, uploadUrl } = root.XiaomeiRunningHubInputs;
    const fieldKey = field => keyOf(field.nodeId, field.fieldName);
    const entryKey = ref => `${ref.kind}:${ref.id}`;
    const wallet = node => node.rhPayment === 'wallet';
    const list = value => Array.isArray(value) ? value : [];
    const count = value => Math.max(1, Math.min(8, Number(value) || 1));

    function create(host) {
        function newNode({ x, y }) {
            return {
                id: host.id('rh'), type: 'rh', x, y, w: 430, h: 0,
                rhMode: 'app', rhPayment: 'free', webappId: '', workflowId: '', instanceType: '',
                rhAppInfo: null, rhWorkflowInfo: null, rhParams: {}, inputs: [], running: false,
            };
        }

        const { label } = host;
        let provider;
        let entries = [];
        const details = new Map();
        const starting = new Set();
        const tracking = new Map();

        function setProvider(next) {
            provider = next;
            details.clear();
            entries = [
                ...new Set(list(next?.image_models).map(value => String(value || '').trim()).filter(Boolean)),
            ].map(id => ({ kind: 'model', id, title: id, config: {} }));
            for (const [kind, configs] of [['app', next?.rh_apps], ['workflow', next?.rh_workflows]]) {
                for (const config of list(configs)) {
                    if (!config || config.enabled === false || config.hidden === true) continue;
                    const id = String((kind === 'app' ? config.appId : config.workflowId) || config.id || '').trim();
                    if (!id) continue;
                    entries.push({ kind, id, title: config.title || config.name || id, config });
                }
            }
        }

        function selection(node) {
            const stored = /^(model|workflow|app):(.+)$/.exec(String(node.rhConfigKey || '').trim());
            if (stored) return entries.find(ref => entryKey(ref) === stored[0]) || { kind: stored[1], id: stored[2], title: stored[2] };
            const ids = { model: node.rhModel || node.model, workflow: node.workflowId, app: node.webappId };
            const kind = [node.rhMode, 'workflow', 'app', 'model'].find(item => kinds.includes(item) && ids[item]);
            const id = String(ids[kind] || '').trim();
            return id ? entries.find(ref => ref.kind === kind && ref.id === id) || { kind, id, title: id } : entries[0];
        }

        function select(node, ref) {
            node.rhConfigKey = entryKey(ref);
            node.rhMode = ref.kind;
            if (ref.kind === 'model') {
                node.rhModel = node.model = ref.id;
                node.apiProvider = 'runninghub';
                node.resolution ||= host.defaultResolution(ref.id);
                node.ratio ||= 'square';
                node.quality ||= 'auto';
            } else if (ref.kind === 'app') node.webappId = ref.id;
            else node.workflowId = ref.id;
        }

        function request(path, options, body) {
            const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
            return host.fetch(path, init, options).then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) throw new Error(data.detail || data.error || label('canvas.rhFailed'));
                return data;
            });
        }

        function workflow(ref) {
            if (ref?.kind !== 'workflow') return Promise.resolve(null);
            const cached = details.get(ref.id);
            if (cached) return cached.promise;
            const entry = {};
            entry.promise = request(`/api/runninghub/workflows/${encodeURIComponent(ref.id)}`, {})
                .then(data => data.workflow || null, () => null)
                .then(data => { entry.data = data; return data; });
            details.set(ref.id, entry);
            return entry.promise;
        }

        function fieldsFor(node, ref, saved = details.get(ref?.id)?.data) {
            if (!ref || ref.kind === 'model') return [];
            const configured = list(ref.config?.fields);
            const legacy = ref.kind === 'app' ? node.rhAppInfo : node.rhWorkflowInfo;
            const savedFields = list(saved?.fields);
            return orderedFields(configured.length ? configured : savedFields.length ? savedFields : legacy?.nodeInfoList);
        }

        function inputs(node, sources = host.sources(node)) {
            const refs = sources.flatMap(source => source.refs || []).filter(ref => ref?.url);
            return {
                sources, refs, image: host.images(refs),
                video: refs.filter(ref => host.mediaKind(ref) === 'video'), audio: refs.filter(ref => host.mediaKind(ref) === 'audio'),
                prompt: sources.map(source => source.prompt).filter(Boolean).join('\n\n'),
            };
        }

        function valueOf(node, field, kind, media) {
            const key = fieldKey(field);
            if (kind === 'number' && field.random_enabled === true && node.rhRandomActive?.[key] !== false && node.rhRandomValues?.[key] !== undefined) {
                return node.rhRandomValues[key];
            }
            const saved = node.rhParams?.[key]?.value;
            return saved ?? (kind === 'prompt' && media.prompt ? media.prompt : defaultValue(field));
        }

        function el(tag, classes, value) {
            const element = root.document.createElement(tag);
            if (classes) element.className = classes;
            if (value !== undefined) element.textContent = value;
            return element;
        }

        function dropdown(choices, current, classes = 'select-lite') {
            const control = el('select', classes);
            for (const [value, title] of choices) {
                const option = el('option', '', title);
                option.value = value;
                control.append(option);
            }
            control.value = String(current ?? '');
            return control;
        }

        function fieldLabel(title, control, classes = 'field') {
            const field = el('label', classes);
            field.append(el('div', 'setting-title', title), control);
            return field;
        }

        function controlFor(node, field, kind, media) {
            const key = fieldKey(field);
            const choices = fieldChoices(field, true);
            const value = valueOf(node, field, kind, media);
            const caption = field.label || field.fieldName;
            function save(next) {
                node.rhParams = { ...node.rhParams, [key]: { ...node.rhParams?.[key], value: next } };
                host.changed();
            }
            if (kind === 'boolean') {
                const control = el('button', 'setting-check');
                control.type = 'button';
                control.dataset.rhParam = key;
                control.dataset.rhType = kind;
                control.append(el('span', 'check-dot'), caption);
                let on = String(value).toLowerCase() === 'true';
                function update() {
                    control.classList.toggle('active', on);
                    control.setAttribute('aria-pressed', String(on));
                }
                update();
                control.addEventListener('click', () => { on = !on; update(); save(String(on)); });
                return control;
            }
            const slider = kind === 'slider';
            const useChoices = choices.length && kind !== 'prompt' && !slider;
            const control = useChoices ? dropdown(choices.map(item => [item, item]), value, 'select-lite rh-param-input') :
                el(kind === 'prompt' ? 'textarea' : 'input', slider ? 'canvas-range rh-param-input' : 'setting-input rh-param-input');
            control.dataset.rhParam = key;
            if (kind === 'prompt') control.dataset.rhRole = 'prompt';
            else control.dataset.rhType = useChoices ? 'select' : kind;
            if (!useChoices) {
                if (kind !== 'prompt') control.type = slider ? 'range' : kind === 'number' ? 'number' : 'text';
                if (slider) {
                    control.min = Number.isFinite(Number(field.min)) ? field.min : 0;
                    control.max = Number(field.max) > Number(control.min) ? field.max : 1;
                    control.step = Number(field.step) > 0 ? field.step : 0.01;
                }
                control.value = value;
            }
            const wrapper = fieldLabel(caption, control, kind === 'prompt' ? 'field rh-prompt-field' : 'field');
            const readout = slider ? el('span', 'rh-param-val', control.value) : null;
            if (readout) wrapper.firstElementChild.append(readout);
            control.addEventListener(useChoices ? 'change' : 'input', () => {
                if (readout) readout.textContent = control.value;
                save(control.value);
            });
            if (useChoices || kind !== 'number' || field.random_enabled !== true) return wrapper;
            const random = el('button', 'tool-btn comfy-random-btn');
            random.type = 'button';
            random.dataset.rhRandom = key;
            const icon = el('i', 'w-4 h-4');
            icon.dataset.lucide = 'dice-5';
            random.append(icon);
            function update() {
                const enabled = node.rhRandomActive?.[key] !== false;
                control.disabled = enabled;
                random.classList.toggle('active', enabled);
                random.setAttribute('aria-label', label('canvas.comfyRandomSeed'));
                random.setAttribute('aria-pressed', String(enabled));
            }
            update();
            random.addEventListener('click', () => {
                node.rhRandomActive = { ...node.rhRandomActive, [key]: node.rhRandomActive?.[key] === false };
                update();
                host.changed();
            });
            const group = el('div', 'comfy-random-field');
            group.append(wrapper, random);
            return group;
        }

        function modelSettings(node, model) {
            const section = el('div', 'gen-settings rh-model-settings');
            const sizes = el('div', 'gen-settings-row api-size-row');
            const ratioRow = el('div', 'gen-settings-row custom-ratio-row');
            const sizeRow = el('div', 'gen-settings-row custom-size-row');
            function syncVisibility() {
                ratioRow.style.display = node.ratio === 'custom' ? '' : 'none';
                sizeRow.style.display = node.resolution === 'custom' ? '' : 'none';
            }
            const customs = String(node.customRatio || '').split(':');
            const fixed = host.parseSize(node.customSize);
            node.customRatioWidth ||= customs[1] ? customs[0] : '';
            node.customRatioHeight ||= customs[1] || '';
            node.customWidth ||= fixed?.width || '';
            node.customHeight ||= fixed?.height || '';
            function normalizeSize() {
                const size = { ...node, model };
                host.normalizeSize(size);
                node.resolution = size.resolution;
            }
            normalizeSize();
            const choices = {
                resolution: [['auto', label('canvas.rhAuto')], ['1k', '1K'], ['2k', '2K'], ['4k', '4K'], ['custom', label('canvas.custom')]],
                ratio: [...Object.entries(dimensions), ['source', label('canvas.adaptiveRatio')], ['custom', label('canvas.custom')]],
                quality: [['auto', 'Q auto'], ['low', 'Q low'], ['medium', 'Q med'], ['high', 'Q high']],
            };
            const defaults = { resolution: host.defaultResolution(model), ratio: 'square', quality: 'auto' };
            for (const [key, options] of Object.entries(choices)) {
                const control = dropdown(options, node[key] || defaults[key], `select-lite ${key === 'quality' ? 'quality-select' : `${key} compact-select`}`);
                control.dataset.rhModelField = key;
                control.addEventListener('change', () => {
                    node[key] = control.value || defaults[key];
                    if (key === 'resolution') node._apiResolutionUserSet = true;
                    normalizeSize();
                    control.value = node[key];
                    syncVisibility();
                    host.changed();
                });
                sizes.append(control);
            }
            function numeric(key, minimum, initial, change, classes) {
                const control = el('input', `setting-input ${classes}`);
                Object.assign(control, { type: 'number', min: minimum, step: minimum, value: initial });
                control.dataset.rhModelField = key;
                control.addEventListener('input', () => { change(control.value); host.changed(); });
                return control;
            }
            const quantity = numeric('count', 1, count(node.count), value => { node.count = count(value); }, 'rh-model-count-input');
            quantity.max = '8';
            quantity.style.width = '64px';
            sizes.append(quantity);
            for (const [key, name, row, min, classes] of [
                ['customRatioWidth', 'ratioWidth', ratioRow, 1, 'custom-ratio-w-input'],
                ['customRatioHeight', 'ratioHeight', ratioRow, 1, 'custom-ratio-h-input'],
                ['customWidth', 'width', sizeRow, 64, 'custom-w-input'],
                ['customHeight', 'height', sizeRow, 64, 'custom-h-input'],
            ]) {
                row.append(fieldLabel(label(`canvas.${name}`), numeric(key, min, node[key], value => {
                    node[key] = value;
                    node.customRatio = node.customRatioWidth && node.customRatioHeight ? `${node.customRatioWidth}:${node.customRatioHeight}` : '';
                    node.customSize = node.customWidth && node.customHeight ? `${node.customWidth}x${node.customHeight}` : '';
                }, classes)));
            }
            syncVisibility();
            section.append(sizes, ratioRow, sizeRow);
            return section;
        }

        function refreshInputs(card, node, sources) {
            const ref = selection(node);
            const media = inputs(node, sources);
            const fields = fieldsFor(node, ref);
            const prompts = card.querySelector('.rh-prompt-list');
            const settings = card.querySelector('.rh-param-list');
            const listNode = card.querySelector('.rh-input-list');
            const focused = root.document.activeElement;
            if (!prompts.contains(focused)) {
                prompts.replaceChildren();
                if (ref?.kind === 'model') host.renderPrompts(prompts, media.sources.filter(source => source.prompt && !source.refs?.length));
                else for (const field of fields.filter(field => fieldKind(field) === 'prompt')) prompts.append(controlFor(node, field, 'prompt', media));
            }
            listNode.replaceChildren();
            for (const [index, item] of media.refs.entries()) {
                const row = el('div', 'input-item rh-input-item');
                row.append(el('span', 'input-index', index + 1));
                row.insertAdjacentHTML('beforeend', host.preview(item));
                row.append(el('span', 'input-label', host.mediaLabel(item)));
                listNode.append(row);
            }
            if (!media.refs.length) listNode.append(el('div', 'text-[11px] text-gray-300 py-2', label('canvas.groupEmpty')));
            if (settings.contains(focused)) return;
            settings.replaceChildren();
            for (const field of fields) {
                const kind = fieldKind(field);
                if (mediaKinds.has(kind) || kind === 'prompt') continue;
                const value = valueOf(node, field, kind, media);
                const wide = kind === 'text' && (String(field.label || field.fieldName).length > 18 || String(value).length > 28);
                const row = el('div', `gen-settings-row rh-param-row${wide ? ' wide' : ''}`);
                row.append(controlFor(node, field, kind, media));
                settings.append(row);
            }
            if (!settings.children.length && ref?.kind !== 'model') settings.append(el('div', 'rh-empty', label(ref?.config ? 'canvas.rhSavedFieldsMissing' : 'canvas.rhConfigUnavailable')));
            card.querySelector('.rh-param-head span:last-child').textContent = fields.length;
        }

        function render(node) {
            const ref = selection(node);
            const card = el('div', 'rh-body');
            const top = el('div', 'rh-top');
            const entry = el('select', 'select-lite rh-entry-select');
            const groups = { model: 'canvas.rhModeModel', app: 'canvas.rhModeApp', workflow: 'canvas.rhModeWorkflow' };
            if (!ref?.config) {
                const unavailable = el('option', '', ref?.title || label('canvas.rhConfigUnavailable'));
                unavailable.value = ref ? entryKey(ref) : '';
                entry.append(unavailable);
            }
            for (const [kind, title] of Object.entries(groups)) {
                const options = entries.filter(item => item.kind === kind);
                if (!options.length) continue;
                const group = el('optgroup');
                group.label = label(title);
                for (const item of options) {
                    const option = el('option', '', item.title);
                    option.value = entryKey(item);
                    group.append(option);
                }
                entry.append(group);
            }
            entry.value = ref ? entryKey(ref) : '';
            entry.addEventListener('change', () => {
                const next = entries.find(item => entryKey(item) === entry.value);
                if (!next) return;
                select(node, next);
                node.rhParams = {};
                node.rhRandomValues = {};
                host.changed();
                host.refresh(node);
            });
            top.append(fieldLabel(label('canvas.rhConfig'), entry, 'field rh-webapp-field'));
            if (ref?.kind !== 'model') {
                const payment = dropdown([
                    ['free', label(provider?.has_key ? 'canvas.rhFreeKey' : 'canvas.rhFreeKeyMissing')],
                    ['wallet', label(provider?.has_wallet_key ? 'canvas.rhWalletKey' : 'canvas.rhWalletKeyMissing')],
                ], wallet(node) ? 'wallet' : 'free', 'select-lite rh-payment-select');
                const machine = dropdown([['', '24G'], ['plus', '48G']], node.instanceType === 'plus' ? 'plus' : '', 'select-lite rh-machine-select');
                payment.addEventListener('change', () => { node.rhPayment = payment.value; host.changed(); });
                machine.addEventListener('change', () => { node.instanceType = machine.value; host.changed(); });
                top.append(fieldLabel('Key', payment, 'field rh-payment-field'), fieldLabel(label('canvas.rhInstanceType'), machine, 'field rh-machine-field'));
            }
            const media = el('div', 'rh-media-section');
            media.append(el('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2', label('canvas.rhInputs')), el('div', 'input-list rh-input-list'));
            const head = el('div', 'rh-param-head');
            head.append(el('span', '', label(ref?.kind === 'workflow' ? 'canvas.rhWorkflowParams' : 'canvas.rhParams')), el('span'));
            const actions = el('div', 'gen-run-row');
            const busy = starting.has(node.id) || node.running || list(node.rhRuns).length;
            const button = el('button', `gen-btn rh-run${busy ? ' running' : ''}`, label(busy ? 'canvas.rhRunning' : 'canvas.rhRun'));
            button.type = 'button';
            button.disabled = Boolean(busy);
            button.addEventListener('click', () => host.runNode(node.id));
            actions.append(button);
            card.append(top, el('div', 'rh-prompt-list'), media);
            if (ref?.kind === 'model') card.append(modelSettings(node, ref.id));
            card.append(head, el('div', 'rh-param-list'), actions);
            refreshInputs(card, node, host.sources(node));
            host.addControls(card, actions, node);
            if (ref?.kind === 'workflow' && ref.config && !list(ref.config.fields).length && details.get(ref.id)?.data === undefined) {
                workflow(ref).then(() => {
                    if (card.isConnected && selection(node)?.id === ref.id) refreshInputs(card, node, host.sources(node));
                    host.icons();
                });
            }
            return card;
        }

        async function cloudRequest(node, ref, media, options) {
            let saved = await workflow(ref);
            let fields = fieldsFor(node, ref, saved);
            let recoveredMode = '';
            if (!fields.length) {
                const query = new URLSearchParams({ kind: ref.kind, entryId: ref.id, useWallet: wallet(node) ? '1' : '0' });
                const metadata = (await request(`/api/runninghub/entry-fields?${query}`, options)).entry;
                if (metadata) {
                    saved = metadata;
                    fields = orderedFields(metadata.fields);
                    recoveredMode = metadata.optionalImageMode;
                }
            }
            if (!fields.length) throw new Error(label('canvas.rhSavedFieldsMissing'));
            const workflowMode = ref.kind === 'workflow';
            const config = ref.config || {};
            const imageMode = recoveredMode || config.optionalImageMode || saved?.optionalImageMode || node.rhWorkflowInfo?.optionalImageMode;
            const prune = workflowMode && (imageMode || 'prune-workflow') === 'prune-workflow';
            const missing = [];
            const inputs = [];
            const randomValues = Object.create(null);
            for (const { field, kind, key, isMedia, linked } of bindFields(fields, media)) {
                const setting = node.rhParams?.[key];
                if (workflowMode && field.sourceFromUpstream === false && !isMedia) continue;
                let value = valueOf(node, field, kind, media);
                if (isMedia) {
                    if (prune && kind === 'image' && field.required === true && !linked) {
                        throw new Error(`${label('canvas.rhRequiredImage')} ${field.label || field.fieldName}`);
                    }
                    if (workflowMode && kind === 'image' && field.required !== true && !linked) {
                        if (prune) missing.push(field);
                        continue;
                    }
                    if (setting?.sourceFromUpstream !== false) value = linked || value;
                } else if (kind === 'number' && field.random_enabled === true && node.rhRandomActive?.[key] !== false) {
                    value = host.random({ ...field, name: field.label || field.fieldName, input: field.fieldName });
                    randomValues[key] = value;
                }
                if (['number', 'slider'].includes(kind) && String(value).trim() && Number.isFinite(Number(value))) value = Number(value);
                inputs.push({ field, isMedia, value });
            }
            const useWallet = wallet(node);
            const nodeInfoList = [];
            for (const { field, isMedia, value } of inputs) {
                let uploaded = value;
                const url = isMedia && uploadUrl(value);
                if (url) {
                    const receipt = await request('/api/runninghub/upload-asset', options, { url, useWallet });
                    uploaded = receipt.data?.fileName || value;
                }
                nodeInfoList.push({ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: uploaded });
            }
            const body = { nodeInfoList, useWallet };
            if (workflowMode) {
                body.workflowId = ref.id;
                const source = [saved?.workflowJson, config.workflowJson, config.raw?.workflowJson, config.raw?.prompt, node.rhWorkflowInfo?.workflowJson]
                    .find(value => value && typeof value === 'object' && Object.keys(value).length);
                if (source && missing.length) body.workflow = pruneInputs(source, missing);
                if (node.instanceType) body.instanceType = node.instanceType;
            } else Object.assign(body, { webappId: ref.id, instanceType: node.instanceType || '' });
            const route = workflowMode ? '/api/runninghub/workflow-submit' : '/api/runninghub/submit';
            return { route, body, useWallet, randomValues };
        }

        function follow(nodeId, job, options) {
            if (tracking.has(job.id)) return tracking.get(job.id);
            const task = (async () => {
                try {
                    const query = new URLSearchParams({ taskId: job.taskId, useWallet: job.useWallet ? '1' : '0' });
                    for (let attempt = 0; attempt < 720; attempt += 1) {
                        const current = host.getNode(nodeId);
                        if (!list(current?.rhRuns).some(item => item?.id === job.id)) return;
                        const data = await request(`/api/runninghub/query?${query}`, options);
                        const result = data.data || data;
                        if (result.status === 'FAILED') throw Object.assign(new Error(result.failReason || label('canvas.rhFailed')), { terminal: true });
                        if (result.status === 'SUCCESS') {
                            const outputs = list(result.urls);
                            if (!outputs.length) throw Object.assign(new Error(label('canvas.rhOutputsEmpty')), { terminal: true });
                            host.complete(nodeId, job, outputs);
                            return;
                        }
                        await host.sleep(2500);
                    }
                    throw new Error(label('canvas.rhTimeout'));
                } catch (error) {
                    host.fail(nodeId, job, error, options);
                    if (options.cascade) throw error;
                }
            })().finally(() => tracking.delete(job.id));
            tracking.set(job.id, task);
            return task;
        }

        async function run(node, options = {}) {
            if (!options.cascade && (starting.has(node.id) || node.running || list(node.rhRuns).length)) return;
            const ref = selection(node);
            if (!ref || (ref.kind === 'model' && !ref.config)) {
                const error = new Error(label('canvas.rhConfigUnavailable'));
                host.report(node, error, options);
                if (options.cascade) throw error;
                return;
            }
            const lockSubmission = !options.cascade && ref.kind !== 'model';
            if (lockSubmission) starting.add(node.id);
            host.refresh(node);
            let job;
            try {
                const media = inputs(node, host.sources(node, options.round));
                if (ref.kind === 'model') {
                    select(node, ref);
                    if (!media.prompt && !media.image.length) throw new Error(label('canvas.needPromptOrImage'));
                    await host.runModel(node, ref.id, media, options);
                    return;
                }
                const { route, body, useWallet, randomValues } = await cloudRequest({ ...node }, ref, media, options);
                const currentRef = selection(node);
                if (host.getNode(node.id) !== node || !currentRef || entryKey(currentRef) !== entryKey(ref)) return;
                select(node, ref);
                node.rhRandomValues = randomValues;
                const accepted = await request(route, options, body);
                const taskId = accepted.data?.taskId || accepted.taskId;
                if (!taskId) throw new Error(label('canvas.rhNoTaskId'));
                const current = host.getNode(node.id);
                if (!current) return;
                job = host.accept(current, ref, taskId, useWallet, media, options);
                await host.save();
            } catch (error) {
                host.report(node, error, options);
                if (options.cascade) throw error;
            } finally {
                if (lockSubmission) starting.delete(node.id);
                host.refresh(node);
            }
            if (job) return follow(node.id, job, options);
        }

        function resume(nodes) {
            for (const node of nodes) {
                if (node.type !== 'rh') continue;
                for (const job of list(node.rhRuns)) {
                    if (job?.taskId && job.canvasId === host.canvasId() && job.run?.node?.id === node.id) follow(node.id, job, { resume: true });
                }
            }
        }

        return { newNode, setProvider, render, refreshInputs, run, resume };
    }

    root.XiaomeiClassicRunningHub = { create };
}(window));
