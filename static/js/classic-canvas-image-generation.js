(function (root) {
    'use strict';

    const presets = {
        square: ['1:1', '1024x1024', '2048x2048', '2880x2880'],
        portrait: ['2:3', '1024x1536', '1360x2048', '2352x3520'],
        landscape: ['3:2', '1536x1024', '2048x1360', '3520x2352'],
        portrait43: ['3:4', '1008x1344', '1536x2048', '2448x3264'],
        landscape43: ['4:3', '1344x1008', '2048x1536', '3264x2448'],
        story: ['9:16', '720x1280', '1152x2048', '2160x3840'],
        wide: ['16:9', '1280x720', '2048x1152', '3840x2160'],
        ultrawide: ['21:9', '1280x544', '2048x880', '3840x1648'],
        ultratall: ['9:21', '544x1280', '880x2048', '1648x3840'],
    };
    const tiers = ['1k', '2k', '4k'];
    const limits = [[1536, 1572864], [2048, 4194304], [3840, 8294400]];
    const qualityChoices = [['auto', 'Q auto'], ['low', 'Q low'], ['medium', 'Q med'], ['high', 'Q high']];
    const extraQuality = [['xhigh', 'Q xhigh'], ['max', 'Q max']];
    const backgrounds = ['auto', 'opaque', 'transparent'];
    const supported = new Set(['api-6789', 'comfly']);
    const normalized = model => String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    function supportsAuto(model) {
        const name = normalized(model);
        const compact = name.replaceAll('-', '');
        return /(?:^|-)gpt-image-2(?:-|$)/.test(name) || compact.startsWith('gptimage2') || compact.endsWith('gptimage2');
    }
    const advancedQuality = model => /(?:^|-)gpt-image-2-5(?:-|$)/.test(normalized(model));
    const defaultResolution = model => supportsAuto(model) ? '4k' : '1k';
    const count = value => Math.max(1, Math.min(8, Math.trunc(Number(value) || 1)));
    const sizePair = value => {
        const match = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(value || '').trim());
        return match ? { width: match[1], height: match[2] } : null;
    };

    function preferredRatio(width, height) {
        const target = width / height;
        let best = { width: 1, height: 1, cost: Infinity };
        for (let denominator = 1; denominator <= 21; denominator++) {
            for (let numerator = 1; numerator <= 21; numerator++) {
                const cost = Math.abs(numerator / denominator / target - 1) + 0.0008 * Math.max(numerator, denominator);
                if (cost < best.cost) best = { width: numerator, height: denominator, cost };
            }
        }
        return best;
    }

    function resolutionOf(node, model = node.model) {
        const saved = node.resolution;
        if (supportsAuto(model)) {
            if (node._apiResolutionUserSet !== true && (!saved || saved === '1k' || saved === 'auto')) return '4k';
        } else if (saved === 'auto') return '1k';
        return [...tiers, 'auto', 'custom'].includes(saved) ? saved : defaultResolution(model);
    }

    function constrainedSize(size) {
        const pair = sizePair(size);
        if (!pair) return size;
        const edge = 3840, ceiling = 8294400, floor = 655360;
        let w = Number(pair.width), h = Number(pair.height);
        if (!(w > 0 && h > 0)) return '';
        if (w > 3 * h) w = 3 * h;
        if (h > 3 * w) h = 3 * w;
        const scale = Math.min(1, edge / Math.max(w, h), Math.sqrt(ceiling / (w * h)));
        w = Math.max(16, Math.floor(w * scale / 16) * 16);
        h = Math.max(16, Math.floor(h * scale / 16) * 16);
        if (w * h < floor) {
            const grow = Math.sqrt(floor / (w * h));
            w = Math.ceil(w * grow / 16) * 16;
            h = Math.ceil(h * grow / 16) * 16;
        }
        if (w > 3 * h) w = 3 * h;
        if (h > 3 * w) h = 3 * w;
        while (w * h > ceiling || Math.max(w, h) > edge) {
            if (w >= h) w -= 16;
            else h -= 16;
        }
        return w + 'x' + h;
    }

    function dimensions(ratio, resolution, customRatio, customSize) {
        if (resolution === 'auto') return 'auto';
        if (resolution === 'custom') {
            const pair = sizePair(customSize);
            const valid = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
            return pair && valid(pair.width) && valid(pair.height) ? Number(pair.width) + 'x' + Number(pair.height) : '';
        }
        const step = Math.max(0, tiers.indexOf(resolution));
        if (ratio === 'source' || ratio === 'custom') {
            const [left, right = 1] = String(customRatio || '').split(':').map(Number);
            const aspect = left / right;
            if (aspect > 0 && Number.isFinite(aspect)) {
                const [edge, pixels] = limits[step];
                const width = aspect >= 1 ? edge : Math.min(edge * aspect, Math.sqrt(pixels * aspect));
                const height = aspect < 1 ? edge : Math.min(edge / aspect, Math.sqrt(pixels / aspect));
                return Math.max(64, Math.floor(width / 16) * 16) + 'x' + Math.max(64, Math.floor(height / 16) * 16);
            }
        }
        return (presets[ratio] || presets.square)[step + 1];
    }

    function exceedsFourK(width, height) {
        const pairs = Object.values(presets).map(values => sizePair(values[3]));
        const distance = pair => Math.abs(Math.log((width / height) / (pair.width / pair.height)));
        const closest = pairs.reduce((best, pair) => distance(pair) < distance(best) ? pair : best);
        return width > Number(closest.width) || height > Number(closest.height);
    }

    function quality(value, model) {
        const option = String(value || '').trim().toLowerCase();
        return [...qualityChoices.slice(1), ...(advancedQuality(model) ? extraQuality : [])].some(([id]) => id === option) ? option : '';
    }

    function element(tag, cls, caption) {
        const el = root.document.createElement(tag);
        if (cls) el.className = cls;
        if (caption != null) el.textContent = caption;
        return el;
    }

    function button(cls, label, click, symbol) {
        const el = element('button', cls, label);
        el.type = 'button';
        if (symbol) {
            const icon = element('i', 'w-4 h-4');
            icon.dataset.lucide = symbol;
            el.prepend(icon);
        }
        el.addEventListener('click', event => {
            event.stopPropagation();
            click();
        });
        return el;
    }

    function choices(control, entries, value) {
        control.replaceChildren(...entries.map(([id, title, disabled]) => {
            const option = element('option', '', title);
            option.value = id;
            option.disabled = Boolean(disabled);
            return option;
        }));
        control.value = value;
    }

    function create(host) {
        let catalog = [];
        const views = new WeakMap();
        const preparing = new WeakMap();
        const label = key => host.label('canvas.' + key);
        function setProviders(items) {
            catalog = items.filter(item => item?.enabled !== false && supported.has(item?.id))
                .map(item => ({ ...item, models: [...new Set((item.image_models || []).map(name => String(name || '').trim()).filter(Boolean))] }))
                .filter(item => item.models.length);
        }

        function selection(node = {}) {
            const id = node.apiProvider || catalog[0]?.id || '';
            const provider = catalog.find(item => item.id === id);
            const saved = node.model;
            let model = saved || provider?.models[0] || '';
            if (saved && provider && !provider.models.includes(saved)) {
                if (saved === 'nano') model = provider.models.find(item => /nano/i.test(item)) || saved;
                if (saved === 'gpt') model = provider.models.find(item => !/nano/i.test(item)) || saved;
            }
            return { id, provider, model };
        }

        function newNode({ x, y }) {
            const { id, model } = selection();
            return { id: host.id('gen'), type: 'generator', x, y, apiProvider: id, model, ratio: 'square',
                resolution: defaultResolution(model), inputs: [] };
        }

        function migrate(node) {
            if (node.type === 'msgen') {
                const { id, model } = selection();
                Object.assign(node, { type: 'generator', apiProvider: id, model, ratio: node.msRatio || 'square', resolution: node.msResolution || '1k' });
            }
            if (node.type === 'generator' && Number(node.w) === 418) node.w = 380;
        }

        async function sizeFor(node, refs, model = node.model) {
            let ratio = node.customRatio || (node.customRatioWidth && node.customRatioHeight
                ? node.customRatioWidth + ':' + node.customRatioHeight : '');
            const fixed = node.customSize || (node.customWidth && node.customHeight
                ? node.customWidth + 'x' + node.customHeight : '');
            if (node.ratio === 'source' && refs[0]?.url) {
                try {
                    const size = await host.dimensions(refs[0].url);
                    const fit = preferredRatio(size.width, size.height);
                    ratio = fit.width + ':' + fit.height;
                } catch (_) {}
            }
            const value = dimensions(node.ratio, resolutionOf(node, model), ratio, fixed);
            return supportsAuto(model) ? constrainedSize(value) : value;
        }

        async function run(node, options = {}) {
            if (!options.cascade && preparing.has(node)) return;
            const token = {};
            if (!options.cascade) preparing.set(node, token);
            const release = () => { if (preparing.get(node) === token) preparing.delete(node); };
            const state = { ...node };
            try {
                const { id, provider, model } = selection(state);
                if (!provider?.models.includes(model)) throw new Error(label('imageChooseConfigured'));
                if (!provider.has_key) throw new Error(label('imageMissingKey').replace('{provider}', provider.name || provider.id));
                const sources = host.sources(node, options.round);
                const text = sources.map(source => source.prompt).filter(Boolean).join('\n\n');
                const refs = host.images(sources.flatMap(source => source.refs || []));
                if (!text && !refs.length) throw new Error(label('needPromptOrImage'));
                const size = await sizeFor(state, refs, model);
                if (!size) throw new Error(label('imageCustomSizeRequired'));
                if (!host.current(node)) return;
                const prompt = text || 'Edit the reference images.';
                const payload = { prompt, provider_id: id, model, size, reference_images: refs };
                const selectedQuality = quality(state.quality, model);
                if (selectedQuality) payload.quality = selectedQuality;
                if (advancedQuality(model)) payload.background = backgrounds.includes(state.background) ? state.background : 'auto';
                const snapshot = { ...state, apiProvider: id, model, resolution: resolutionOf(state, model) };
                const execution = host.batch(node, payload, host.snapshot(snapshot, prompt, refs), refs, options, 460);
                release();
                return await execution;
            } catch (error) {
                if (options.cascade) throw error;
                if (host.current(node)) host.message(error.message, label('apiFailed'));
            } finally {
                release();
            }
        }

        function updateInputs(card, node, sources = host.sources(node)) {
            host.renderPrompts(card.querySelector('.prompt-list'), sources.filter(source => source.prompt && !source.refs?.length));
            const images = sources.map(source => ({ ...source, refs: host.images(source.refs || []) }))
                .filter(source => source.refs.length);
            host.renderImages(card.querySelector('.input-list'), node, images);
            views.get(card)?.reference(host.images(images.flatMap(source => source.refs))[0]?.url || '');
        }

        function render(node) {
            const card = element('div', 'generator-body classic-image-generator');
            const inputs = element('div', 'input-list');
            const controls = element('div', 'gen-settings');
            const providers = element('div', 'gen-settings-row');
            const settings = element('div', 'gen-settings-row api-size-row');
            const ratioRow = element('div', 'gen-settings-row custom-ratio-row');
            const sizeRow = element('div', 'gen-settings-row custom-size-row');
            let reference = '';
            let revision = 0;
            let request = 0;
            const save = () => { revision++; host.changed(); };
            const text = (key, cls, change) => {
                const el = element('select', 'select-lite ' + cls);
                el.setAttribute('aria-label', label(key));
                el.addEventListener('change', () => { change(el.value); save(); sync(); });
                return el;
            };
            const platform = text('provider', 'provider-select', id => {
                const target = catalog.find(item => item.id === id);
                if (!target) return;
                node.apiProvider = id;
                if (!target.models.includes(node.model)) node.model = target.models[0];
                node._apiResolutionUserSet = false;
                node.resolution = defaultResolution(node.model);
            });
            const model = text('imageModel', 'model-select', name => {
                node.apiProvider = selection(node).id;
                node.model = name;
                if (node.resolution !== 'custom') node.resolution = defaultResolution(name);
                node._apiResolutionUserSet = false;
            });
            providers.append(platform, model);

            const resolution = text('imageResolution', 'resolution compact-select', value => {
                node.resolution = value;
                node._apiResolutionUserSet = true;
                if (value === 'custom') node.ratio = '';
                else {
                    node.ratio ||= 'square';
                    Object.assign(node, { customSize: '', customWidth: '', customHeight: '' });
                }
            });
            resolution.dataset.field = 'resolution';
            const ratio = text('imageRatio', 'ratio compact-select', value => {
                node.ratio = value;
                if (value !== 'custom') Object.assign(node, { customRatio: '', customRatioWidth: '', customRatioHeight: '' });
            });
            ratio.dataset.field = 'ratio';
            const qualityControl = text('imageQuality', 'quality-select', value => { node.quality = value; });
            const background = text('imageBackground', 'background-select', value => { node.background = value; });

            const countRow = element('div', 'gen-count-row');
            const stepper = element('div', 'gen-stepper');
            const number = element('input', 'gen-count-input');
            Object.assign(number, { type: 'text', inputMode: 'numeric', pattern: '[0-9]*', value: String(count(node.count)) });
            number.setAttribute('aria-label', label('imageCount'));
            function changeCount(value, reflect) {
                node.count = count(value);
                if (reflect) number.value = node.count;
                save();
            }
            number.addEventListener('input', () => { if (number.value) changeCount(number.value, false); });
            number.addEventListener('blur', () => { number.value = count(node.count); });
            for (const [step, key, icon] of [[-1, 'imageFewer', 'chevron-left'], [1, 'imageMore', 'chevron-right']]) {
                const control = button('gen-step-btn', '', () => changeCount(count(node.count) + step, true), icon);
                control.dataset.step = step;
                control.setAttribute('aria-label', label(key));
                if (step > 0) stepper.append(number);
                stepper.append(control);
            }
            countRow.append(stepper);
            settings.append(resolution, ratio, qualityControl, background, countRow);

            function numberField(row, key, cls, placeholder, min, step, write) {
                const field = element('label', 'field');
                const input = element('input', 'setting-input ' + cls);
                Object.assign(input, { type: 'number', min, step, placeholder });
                input.addEventListener('input', () => { write(input.value); save(); });
                field.append(element('span', 'setting-title', label(key)), input);
                row.append(field);
                return input;
            }

            function setParts(kind, first, second) {
                if (kind === 'ratio') {
                    node.customRatioWidth = first;
                    node.customRatioHeight = second;
                    node.customRatio = first && second ? first + ':' + second : '';
                } else {
                    node.customWidth = first;
                    node.customHeight = second;
                    node.customSize = first && second ? first + 'x' + second : '';
                }
            }

            const rw = numberField(ratioRow, 'ratioWidth', 'custom-ratio-w-input', '4', 1, 1, value => setParts('ratio', value, rh.value));
            const rh = numberField(ratioRow, 'ratioHeight', 'custom-ratio-h-input', '3', 1, 1, value => setParts('ratio', rw.value, value));
            const w = numberField(sizeRow, 'width', 'custom-w-input', 'Auto', 64, 64, value => setParts('size', value, h.value));
            const h = numberField(sizeRow, 'height', 'custom-h-input', 'Auto', 64, 64, value => setParts('size', w.value, value));
            const fit = button('secondary-btn fit-size-btn', label('fitImageSize'), async () => {
                const url = reference;
                const version = revision;
                if (!url) return;
                try {
                    const size = await host.dimensions(url);
                    if (!card.isConnected || url !== reference || version !== revision) return;
                    setParts('size', size.width, size.height);
                    node.resolution = 'custom';
                    node._apiResolutionUserSet = true;
                    node.ratio = '';
                    save();
                    sync();
                } catch (_) {
                    if (card.isConnected) host.message(label('imageReadFailed'), label('apiFailed'));
                }
            });
            sizeRow.append(fit);
            controls.append(providers, settings, ratioRow, sizeRow);

            async function showReferenceRatio() {
                const turn = ++request;
                if (!reference || node.ratio !== 'source') return;
                try {
                    const size = await host.dimensions(reference);
                    if (turn !== request || node.ratio !== 'source') return;
                    const parts = preferredRatio(size.width, size.height);
                    rw.value = parts.width;
                    rh.value = parts.height;
                } catch (_) {}
            }

            function sync() {
                const active = selection(node);
                const available = catalog.map(item => [item.id, item.name || item.id]);
                const modelNames = (active.provider?.models || []).map(name => [name, name]);
                if (!active.provider) available.unshift([active.id, active.id ? active.id + ' · ' + label('imageUnavailable') : label('noApiProviders')]);
                if (!active.provider?.models.includes(active.model)) modelNames.unshift([active.model, active.model ? active.model + ' · ' + label('imageUnavailable') : label('noImageModelsHint')]);
                choices(platform, available, active.id);
                choices(model, modelNames, active.model);

                const value = resolutionOf(node, active.model);
                choices(resolution, [['auto', label('imageAutomatic'), !supportsAuto(active.model)], ...tiers.map(id => [id, id.toUpperCase()]), ['custom', label('custom')]], value);
                choices(ratio, [...Object.entries(presets).map(([key, entries]) => [key, entries[0]]), ['source', label('adaptiveRatio')], ['custom', label('custom')]], node.ratio || 'square');
                choices(qualityControl, [...qualityChoices, ...(advancedQuality(active.model) ? extraQuality : [])], quality(node.quality, active.model) || 'auto');
                choices(background, backgrounds.map(id => [id, label('imageBackground') + ' ' + id]), backgrounds.includes(node.background) ? node.background : 'auto');
                background.style.display = advancedQuality(active.model) ? '' : 'none';
                ratio.disabled = value === 'custom' || value === 'auto';
                ratioRow.style.display = value !== 'auto' && ['custom', 'source'].includes(node.ratio) ? 'flex' : 'none';
                sizeRow.style.display = value === 'custom' ? 'flex' : 'none';
                rw.disabled = rh.disabled = node.ratio === 'source';
                const [savedWidth, savedHeight] = String(node.customRatio || '').split(':');
                const custom = sizePair(node.customSize);
                rw.value = node.customRatioWidth || savedWidth || '';
                rh.value = node.customRatioHeight || savedHeight || '';
                w.value = node.customWidth || custom?.width || '';
                h.value = node.customHeight || custom?.height || '';
                showReferenceRatio();
            }

            views.set(card, { reference(url) {
                const previous = reference;
                reference = url;
                fit.disabled = !reference;
                if (previous !== reference) {
                    if (node.ratio === 'source') rw.value = rh.value = '';
                    showReferenceRatio();
                }
            } });
            const actions = element('div', 'gen-run-row');
            const busy = node.running || host.cascadeBusy(node.id);
            const go = button('gen-btn' + (busy ? ' running' : ''), label(busy ? 'generating' : 'apiGenerate'), () => host.runNode(node.id), 'zap');
            go.disabled = Boolean(busy);
            actions.append(go);
            card.append(element('div', 'prompt-list mb-3'), element('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2', label('images')), inputs, controls, actions);
            sync();
            updateInputs(card, node);
            host.addControls(card, actions, node);
            return card;
        }

        return { setProviders, selection, newNode, migrate, sizeFor, run, render, updateInputs };
    }

    root.XiaomeiClassicImageGeneration = { create, defaultResolution, resolutionOf, sizePair, quality, count, exceedsFourK };
})(window);
