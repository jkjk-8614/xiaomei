(function (root) {
    'use strict';

    const modes = {
        text: { tab: 'Text', label: 'Text', workflow: 'Z-Image.json', type: 'zimage' },
        enhance: { tab: 'Enhance', label: 'Enhance', workflow: 'Z-Image-Enhance.json', type: 'enhance' },
        edit: { tab: 'Edit', label: 'Edit', workflow: 'Flux2-Klein.json', type: 'klein' },
        custom: { tab: 'Custom', label: 'Custom', type: 'workflow-custom' },
    };
    const inputKinds = ['image', 'video', 'audio'];
    const modeOf = node => Object.hasOwn(modes, node.mode) ? node.mode : 'text';

    function randomValue(field) {
        const seed = /seed|noise|随机|噪/i.test(`${field.input || ''} ${field.name || ''}`);
        const min = Number.isFinite(Number(field.min)) ? Number(field.min) : seed ? 1 : 0;
        const limit = seed ? 4294967295 : 999999;
        const max = Number(field.max) > min ? (seed ? Math.min(Number(field.max), limit) : Number(field.max)) : limit;
        if (max <= min) return min;
        const sample = min + Math.random() * (max - min);
        if (!(Number(field.step) > 0 && Number(field.step) < 1)) return Math.floor(sample);
        return Number(sample.toFixed(Math.min(8, String(field.step).split('.')[1]?.length || 2)));
    }

    function kindOf(field) {
        if (inputKinds.includes(field.type)) return field.type;
        return field.type === 'textarea' || /prompt|text|提示词|正向|负向/i.test(`${field.input || ''} ${field.name || ''}`) ? 'prompt' : 'setting';
    }

    function defaultValue(field) {
        return field.default ?? (field.type === 'boolean' ? false : ['number', 'slider'].includes(field.type) ? 0 : '');
    }

    function valueOf(node, field) {
        return Object.hasOwn(node.comfyParams || {}, field.id) ? node.comfyParams[field.id] : defaultValue(field);
    }

    function putValue(node, field, value) {
        node.comfyParams = { ...node.comfyParams, [field.id]: value };
    }

    function create(host) {
        const { label } = host;
        let catalog = [];
        const workflows = new Map();
        const active = new Map();
        const submitting = new Set();

        function setCatalog(items) {
            catalog = Array.isArray(items) ? items.filter(item => item?.name) : [];
            workflows.clear();
        }

        function nameOf(node) {
            return node.comfyWorkflow || catalog[0]?.name || '';
        }

        function newNode({ x, y }) {
            return {
                id: host.id('comfy'), type: 'comfy', x, y, w: 420, h: 460,
                mode: 'text', width: 1024, height: 1024, ratio: 'square', resolution: '1k',
                enhanceStrength: 0.5, enhanceUpscale: false, enhanceUpscaleRes: 2048,
                editModel: host.imageModel(), editUpscale: false, editUpscaleRes: 2048,
                customRatio: '', customSize: '', customRatioWidth: '', customRatioHeight: '',
                customWidth: '', customHeight: '', comfyWorkflow: '', comfyParams: {}, count: 1, inputs: [],
            };
        }

        function title(node) {
            return modeOf(node) === 'custom' && nameOf(node) || label(`canvas.comfy${modes[modeOf(node)].label}`);
        }

        function workflow(name) {
            if (!name || !catalog.some(item => item.name === name)) return Promise.resolve(null);
            const existing = workflows.get(name);
            if (existing) return existing.promise;
            const entry = {};
            entry.promise = root.fetch(`/api/workflows/${encodeURIComponent(name)}`)
                .then(response => response.ok ? response.json() : null)
                .catch(() => null)
                .then(data => { entry.data = data; return data; });
            workflows.set(name, entry);
            return entry.promise;
        }

        function workflowFields(data) {
            const fields = data?.config?.fields;
            return Array.isArray(fields) ? fields.filter(field => field && typeof field === 'object') : [];
        }

        function fieldsFor(name) {
            return workflowFields(workflows.get(name)?.data);
        }

        function element(tag, className, text) {
            const node = root.document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function options(select, choices, value) {
            for (const [key, caption] of choices) {
                const option = element('option', '', caption);
                option.value = key;
                select.append(option);
            }
            select.value = String(value);
        }

        function row(container, ...children) {
            const line = element('div', 'gen-settings-row');
            line.append(...children);
            container.append(line);
        }

        function labelled(caption, control, readout) {
            const field = element('label', 'field');
            const title = element('div', 'setting-title', caption);
            if (readout) {
                title.style.display = 'flex';
                title.style.justifyContent = 'space-between';
                title.append(readout);
            }
            field.append(title, control);
            return field;
        }

        function toggle(caption, on, change) {
            const button = element('button', `setting-check${on ? ' active' : ''}`);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(on));
            button.append(element('span', 'check-dot'), caption);
            button.addEventListener('click', change);
            return button;
        }

        function fieldControl(node, field) {
            const value = valueOf(node, field);
            const caption = field.name || field.input || field.id;
            const change = next => { putValue(node, field, next); host.changed(); };
            if (field.type === 'boolean') {
                const button = toggle(caption, Boolean(value), () => {
                    const next = !valueOf(node, field);
                    change(next);
                    button.classList.toggle('active', next);
                    button.setAttribute('aria-pressed', String(next));
                });
                button.dataset.comfyParam = field.id;
                button.dataset.comfyType = 'boolean';
                return button;
            }
            const dropdown = field.type === 'dropdown';
            const slider = field.type === 'slider';
            const input = element(dropdown ? 'select' : 'input', dropdown ? 'select-lite' : slider ? 'canvas-range' : 'setting-input');
            const numeric = slider || field.type === 'number';
            input.dataset.comfyParam = field.id;
            input.dataset.comfyType = field.type || 'text';
            if (dropdown) {
                const values = Array.isArray(field.options) && field.options.length ? field.options : [''];
                options(input, values.map(item => [item, item]), value);
            } else {
                input.type = slider ? 'range' : numeric ? 'number' : 'text';
                if (slider) {
                    input.min = field.min ?? 0;
                    input.max = field.max ?? 10;
                    input.step = field.step ?? 1;
                }
                input.value = value;
            }
            const readout = slider ? element('span', 'comfy-param-val', value) : null;
            input.addEventListener(dropdown ? 'change' : 'input', () => {
                const next = numeric ? Number(input.value) || 0 : input.value;
                if (readout) readout.textContent = next;
                change(next);
            });
            const fieldLabel = labelled(caption, input, readout);
            if (field.type !== 'number' || field.random_enabled !== true) return fieldLabel;
            const random = element('button', 'tool-btn comfy-random-btn');
            random.type = 'button';
            random.dataset.comfyRandom = field.id;
            random.append(icon('dice-5'));
            function updateRandom() {
                const on = node.comfyRandomActive?.[field.id] !== false;
                random.classList.toggle('active', on);
                random.setAttribute('aria-pressed', String(on));
                random.setAttribute('aria-label', label('canvas.comfyRandomSeed'));
            }
            random.addEventListener('click', () => {
                node.comfyRandomActive = { ...node.comfyRandomActive, [field.id]: node.comfyRandomActive?.[field.id] === false };
                updateRandom();
                host.changed();
            });
            updateRandom();
            const group = element('div', 'comfy-random-field');
            group.append(fieldLabel, random);
            return group;
        }

        function icon(name) {
            const symbol = element('i', 'w-4 h-4');
            symbol.dataset.lucide = name;
            return symbol;
        }

        function builtInSettings(container, node, mode) {
            if (mode === 'text') {
                row(container, ...['width', 'height'].map(key => {
                    const input = element('input', 'setting-input');
                    input.type = 'number';
                    input.min = input.step = '64';
                    input.dataset.field = key;
                    input.value = Number(node[key] || 1024);
                    input.addEventListener('input', () => { node[key] = Number(input.value) || 1; host.changed(); });
                    return labelled(label(`canvas.${key}`), input);
                }));
                return;
            }
            if (mode === 'enhance') {
                const slider = element('input', 'canvas-range enhance-strength-slider');
                Object.assign(slider, { type: 'range', min: '0.1', max: '1', step: '0.05', value: Number(node.enhanceStrength ?? 0.5) });
                slider.dataset.field = 'enhanceStrength';
                const readout = element('span', 'enhance-strength-val', Number(slider.value).toFixed(2));
                slider.addEventListener('input', () => {
                    node.enhanceStrength = Number(slider.value);
                    readout.textContent = node.enhanceStrength.toFixed(2);
                    host.changed();
                });
                row(container, labelled(label('studio.enhancementStrength'), slider, readout));
            }
            const key = `${mode}Upscale`;
            const resolution = `${key}Res`;
            const select = element('select', 'select-lite');
            select.dataset.field = resolution;
            options(select, [['2048', '2X (2048)'], ['4096', '4X (4096)']], node[resolution] || 2048);
            select.disabled = !node[key];
            select.addEventListener('change', () => { node[resolution] = Number(select.value); host.changed(); });
            const button = toggle(label('studio.superResolution'), Boolean(node[key]), () => {
                node[key] = !node[key];
                select.disabled = !node[key];
                button.classList.toggle('active', node[key]);
                button.setAttribute('aria-pressed', String(node[key]));
                host.changed();
            });
            button.dataset.toggleField = key;
            row(container, button, select);
        }

        function customSettings(container, node) {
            const name = nameOf(node);
            const select = element('select', 'select-lite comfy-workflow-select');
            select.dataset.field = 'comfyWorkflow';
            select.style.width = '100%';
            const choices = catalog.map(item => [item.name, item.title || item.name.replace(/\.json$/i, '')]);
            if (!choices.some(([id]) => id === name)) choices.unshift([name, name || label('canvas.comfyNoWorkflow')]);
            options(select, choices, name);
            select.addEventListener('change', () => {
                node.comfyWorkflow = select.value;
                node.comfyParams = {};
                node.comfyRandomActive = {};
                if (workflows.get(select.value)?.data === null) workflows.delete(select.value);
                host.changed();
                host.refresh(node);
            });
            row(container, select);
            const listed = catalog.some(item => item.name === name);
            const entry = workflows.get(name);
            if (!listed || entry?.data === null) {
                const message = name ? 'canvas.comfyWorkflowUnavailable' : 'canvas.comfyNoWorkflow';
                container.append(element('div', 'text-[11px] text-slate-400', label(message)));
            } else if (!entry?.data) {
                container.append(element('div', 'text-[11px] text-slate-400', label('canvas.comfyLoadingWorkflow')));
                workflow(name).then(() => {
                    if (container.isConnected && host.getNode(node.id) === node && modeOf(node) === 'custom' && nameOf(node) === name) host.refresh(node);
                });
            } else {
                const fields = fieldsFor(name).filter(field => kindOf(field) === 'setting');
                for (const field of fields) row(container, fieldControl(node, field));
                if (!fields.length) container.append(element('div', 'text-[11px] text-slate-400', label('canvas.comfyNoExtraParams')));
            }
        }

        function updateInputs(card, node, sources) {
            const mode = modeOf(node);
            const fields = fieldsFor(nameOf(node));
            const counts = inputKinds.map(kind => fields.filter(field => kindOf(field) === kind).length);
            const media = card.querySelector('.comfy-images');
            const visible = mode !== 'text' && (mode !== 'custom' || counts.some(Boolean));
            media.classList.toggle('hidden', !visible);
            host.renderPrompts(card.querySelector('.prompt-list'), sources.filter(source => source.prompt && !source.refs?.length));
            if (!visible) return;
            const heading = mode === 'custom' ? `${label('canvas.image')} ${counts[0]} · ${label('canvas.comfyVideos')} ${counts[1]} · ${label('canvas.comfyAudio')} ${counts[2]}` : label('canvas.image');
            media.firstElementChild.textContent = heading;
            const inputs = sources.map(source => ({ ...source, refs: mode === 'custom' ? source.refs : host.images(source.refs || []) }));
            host.renderMedia(media.querySelector('.input-list'), node, inputs.filter(source => source.refs?.length));
        }

        function render(node) {
            const mode = modeOf(node);
            const card = element('div', 'comfy-body');
            const tabs = element('div', 'mode-tabs');
            for (const [key, info] of Object.entries(modes)) {
                const tab = element('button', key === mode ? 'active' : '', label(`canvas.comfyMode${info.tab}`));
                tab.type = 'button';
                tab.dataset.mode = key;
                tab.addEventListener('click', () => {
                    node.mode = key;
                    if (key === 'custom' && !node.comfyWorkflow) node.comfyWorkflow = nameOf(node);
                    host.changed();
                    host.refresh(node);
                });
                tabs.append(tab);
            }
            const content = element('div', 'comfy-content');
            const media = element('div', 'comfy-images');
            media.append(element('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest'), element('div', 'input-list mt-2'));
            content.append(element('div', 'prompt-list'), media);
            const controls = element('div', 'comfy-controls');
            const settings = element('div', 'gen-settings comfy-settings');
            const actions = element('div', 'gen-run-row');
            const running = submitting.has(node.id);
            const run = element('button', `comfy-run${running ? ' running' : ''}`);
            run.type = 'button';
            run.disabled = running;
            run.append(icon('zap'), label(running ? 'canvas.comfyRunning' : 'canvas.comfyRun'));
            run.addEventListener('click', () => host.runNode(node.id));
            actions.append(run);
            controls.append(settings, actions);
            card.append(tabs, content, controls);
            if (mode === 'custom') customSettings(settings, node);
            else builtInSettings(settings, node, mode);
            updateInputs(card, node, host.sources(node));
            host.addCascadeControls(card, controls, actions, node);
            return card;
        }

        async function prepare(node, options) {
            const mode = modeOf(node);
            const info = modes[mode];
            const sources = host.sources(node, options.round);
            const prompt = sources.map(source => source.prompt).filter(Boolean).join('\n\n');
            const all = sources.flatMap(source => source.refs || []);
            const refs = host.images(all);
            const name = mode === 'custom' ? nameOf(node) : info.workflow;
            const payload = { prompt, workflow_json: name, type: info.type };
            let requestSize = null;
            let upscale = 0;
            const requireInput = (missing, key) => {
                if (missing) throw new Error(label(key));
            };
            if (mode === 'text') {
                requireInput(!prompt, 'canvas.needPrompt');
                requestSize = { width: Number(node.width || 1024), height: Number(node.height || 1024) };
                Object.assign(payload, requestSize);
            } else if (mode === 'custom') {
                const data = await workflow(name);
                if (!data) throw new Error(label('canvas.comfyWorkflowUnavailable'));
                const fields = workflowFields(data);
                const inputs = { image: refs, video: host.videos(all), audio: host.audios(all) };
                const needs = { image: 'canvas.needImage', video: 'canvas.comfyNeedVideo', audio: 'canvas.comfyNeedAudio' };
                requireInput(fields.some(field => kindOf(field) === 'prompt') && !prompt, 'canvas.needPrompt');
                for (const kind of inputKinds) requireInput(inputs[kind].length < fields.filter(field => kindOf(field) === kind).length, needs[kind]);
                const params = Object.create(null);
                const used = { image: 0, video: 0, audio: 0 };
                for (const field of fields) {
                    const kind = kindOf(field);
                    const ref = inputKinds.includes(kind) ? inputs[kind][used[kind]++] : null;
                    if (field.node == null || !field.input) continue;
                    let value;
                    if (ref) value = await host.uploadRef(ref, name, options);
                    else if (kind === 'prompt') value = prompt;
                    else {
                        if (field.type === 'number' && field.random_enabled === true && node.comfyRandomActive?.[field.id] !== false) putValue(node, field, randomValue(field));
                        value = valueOf(node, field);
                    }
                    const inputsForNode = params[field.node] ||= Object.create(null);
                    inputsForNode[field.input] = value;
                }
                payload.params = params;
            } else {
                requireInput(!refs.length, 'canvas.needImage');
                const names = [];
                for (const ref of refs.slice(0, mode === 'edit' ? 3 : 1)) names.push(await host.uploadRef(ref, name, options));
                if (mode === 'enhance') {
                    delete payload.prompt;
                    payload.params = { 15: { image: names[0] }, 204: { value: Number(node.enhanceStrength ?? 0.5) } };
                } else {
                    payload.params = {
                        168: { text: prompt }, 158: { noise_seed: Math.floor(Math.random() * 1000000) },
                        278: { image: names[0] }, 270: { image: names[1] || '' }, 292: { image: names[2] || '' },
                        313: { value: Boolean(names[1]) }, 314: { value: Boolean(names[2]) },
                    };
                }
                if (node[`${mode}Upscale`]) upscale = Number(node[`${mode}UpscaleRes`] || 2048);
            }
            const taskLabel = mode === 'custom' ? name : label(`canvas.comfy${info.label}`);
            return { payload, prompt, refs, requestSize, upscale, taskLabel, append: Boolean(options.cascade) };
        }

        function find(nodeId, id) {
            const node = host.getNode(nodeId);
            const job = Array.isArray(node?.comfyRuns) && node.comfyRuns.find(item => item?.id === id);
            return job ? { node, job } : null;
        }

        async function follow(nodeId, id, options) {
            let current = find(nodeId, id);
            while (current) {
                const { job } = current;
                if (!job.taskId) {
                    const receipt = await host.submit({ ...job.payload, client_request_id: `${id}.${job.stage}` }, options);
                    current = find(nodeId, id);
                    if (!current) return;
                    if (!receipt.task_id) throw new Error(label('canvas.comfyMissingReceipt'));
                    current.job.taskId = receipt.task_id;
                    host.changed();
                    await host.save();
                    current = find(nodeId, id);
                    if (!current) return;
                }
                const result = await host.wait(current.job.taskId, options);
                current = find(nodeId, id);
                if (!current) return;
                if (result.error) throw host.terminalError(result.error);
                const outputs = host.outputs(result);
                if (!outputs.length) throw host.terminalError(label('canvas.comfyNoResult'));
                if (!current.job.upscale) {
                    current.job.run.request ||= host.requestMeta(result);
                    host.complete(current.node, current.job, outputs);
                    return;
                }
                const source = host.outputUrl(outputs[0]);
                const image = await host.uploadRef({ url: source }, 'upscale.json', options);
                current = find(nodeId, id);
                if (!current) return;
                Object.assign(current.job, {
                    stage: 'upscale', taskId: '', upscale: 0,
                    payload: { workflow_json: 'upscale.json', type: 'enhance', params: {
                        15: { image },
                        172: { seed: Math.floor(Math.random() * 4294967295), resolution: current.job.upscale },
                    } },
                });
                current.job.run.request = host.requestMeta(result);
                host.changed();
                if (!await host.save()) throw new Error(label('canvas.comfySavePendingFailed'));
                current = find(nodeId, id);
            }
        }

        function track(nodeId, id, options) {
            if (active.has(id)) return active.get(id);
            const task = Promise.resolve().then(() => follow(nodeId, id, options)).catch(error => {
                const current = find(nodeId, id);
                if (current) host.fail(current.node, current.job, error, options);
                if (options.cascade) throw error;
            }).finally(() => active.delete(id));
            active.set(id, task);
            return task;
        }

        async function run(node, options = {}) {
            if (!options.cascade && submitting.has(node.id)) return;
            if (!options.cascade) submitting.add(node.id);
            host.refresh(node);
            let job;
            let started = false;
            try {
                const plan = await prepare(node, options);
                if (host.getNode(node.id) !== node) return;
                if (modeOf(node) === 'custom' && !node.comfyWorkflow) node.comfyWorkflow = plan.payload.workflow_json;
                job = host.start(node, plan, options);
                if (!await host.save()) throw new Error(label('canvas.comfySavePendingFailed'));
                started = true;
            } catch (error) {
                if (job) host.fail(node, job, error, options);
                else host.report(node, error, options);
                if (options.cascade) throw error;
                return;
            } finally {
                if (!options.cascade) {
                    const release = () => {
                        submitting.delete(node.id);
                        if (host.getNode(node.id)) host.refresh(node);
                    };
                    if (started) setTimeout(release, 2000);
                    else release();
                }
            }
            return track(node.id, job.id, options);
        }

        function resume(nodes) {
            for (const node of nodes) {
                if (node.type !== 'comfy') continue;
                for (const job of Array.isArray(node.comfyRuns) ? node.comfyRuns : []) {
                    if (job?.id && job.canvasId === host.canvasId() && job.run?.node?.id === node.id &&
                        (job.taskId || job.payload?.workflow_json)) track(node.id, job.id, { resume: true });
                }
            }
        }

        return { newNode, setCatalog, title, render, updateInputs, run, resume };
    }

    root.XiaomeiClassicComfy = { create, randomValue };
}(window));
