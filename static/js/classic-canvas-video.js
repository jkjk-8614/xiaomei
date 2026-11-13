(function (root) {
    'use strict';

    const aspects = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'keep_ratio', 'adaptive'];
    const resolutions = ['', '480p', '720p', '1080p', '780P'];
    const flags = [
        ['enhancePrompt', 'videoEnhancePrompt', 'enhance_prompt'],
        ['enableUpsample', 'videoUpsample', 'enable_upsample'],
        ['watermark', 'videoWatermark', 'watermark'],
        ['cameraFixed', 'videoCameraFixed', 'camerafixed'],
        ['generateAudio', 'videoGenerateAudio', 'generate_audio'],
        ['multimodal', 'videoMultimodal', 'multimodal'],
        ['useFrameRoles', 'videoFirstLastFrames'],
    ];
    const referenceKinds = ['image', 'video', 'audio'];
    const { isRemote: remote, storeLink, withoutManualLinks, replaceReference } = root.XiaomeiCanvasMediaLinks;
    const seconds = value => Math.max(1, Math.min(60, Math.round(Number(value) || 5)));
    const manualUrl = node => (Array.isArray(node.manualVideoUrls) ? node.manualVideoUrls : []).find(Boolean) || '';
    const links = node => Array.isArray(node.tempShLinks) ? node.tempShLinks : [];
    const publicUrl = (node, url) => links(node).find(item => item?.source === url && item.url)?.url || url;

    function element(tag, classes, caption) {
        const el = root.document.createElement(tag);
        if (classes) el.className = classes;
        if (caption != null) el.textContent = caption;
        return el;
    }

    function icon(name, size = 'w-4 h-4') {
        const el = element('i', size);
        el.dataset.lucide = name;
        return el;
    }

    function button(caption, classes, action, symbol) {
        const el = element('button', classes);
        el.type = 'button';
        if (symbol) el.append(icon(symbol));
        el.append(element('span', '', caption));
        el.addEventListener('click', event => {
            event.stopPropagation();
            action();
        });
        return el;
    }

    function select(classes, caption, choices, value) {
        const el = element('select', 'select-lite ' + classes);
        el.setAttribute('aria-label', caption);
        el.replaceChildren(...choices.map(([id, name]) => {
            const option = element('option', '', name);
            option.value = id;
            return option;
        }));
        el.value = value;
        return el;
    }

    function field(caption, input) {
        const el = element('label', 'field');
        el.style.flex = '1';
        el.append(element('span', 'setting-title', caption), input);
        return el;
    }

    function create(host) {
        const label = key => host.label('canvas.' + key);
        let providers = [];
        const running = new Map();
        const uploading = new Set();

        function setProviders(items) {
            providers = items
                .filter(provider => provider?.id && provider.enabled !== false && provider.id !== 'modelscope' && Array.isArray(provider.video_models))
                .map(provider => ({ id: provider.id, name: provider.name || provider.id,
                    models: [...new Set(provider.video_models.filter(model => typeof model === 'string' && model.trim()))] }))
                .filter(provider => provider.models.length);
        }

        function selection(node) {
            const id = node.apiProvider || providers[0]?.id || '';
            const provider = providers.find(item => item.id === id);
            const model = node.model || provider?.models[0] || '';
            return { id, provider, model };
        }

        function newNode({ x, y }) {
            const { id, model } = selection({});
            return {
                id: host.id('vid'), type: 'video', x, y, apiProvider: id, model,
                duration: 5, aspectRatio: '16:9', resolution: '', tempShLinks: [], inputs: [],
                ...Object.fromEntries(flags.map(([key]) => [key, false])),
            };
        }

        const keyFor = node => JSON.stringify([host.canvasId(), node.id]);

        function allReferences(sources) {
            return sources.flatMap(source => source.refs || [])
                .filter(ref => ref?.url && referenceKinds.includes(host.mediaKind(ref)));
        }

        function requestFor(node, sources, id, model) {
            const refs = allReferences(sources).map(ref => replaceReference(ref, publicUrl(node, ref.url)));
            const images = host.images(refs).map((ref, index) => {
                if (!node.useFrameRoles || index > 1) return ref;
                return { ...ref, role: index === 0 ? 'first_frame' : 'last_frame' };
            });
            const urls = kind => refs.filter(ref => host.mediaKind(ref) === kind).map(ref => ref.url);
            return {
                provider_id: id, model, prompt: sources.map(source => source.prompt).filter(Boolean).join('\n\n'),
                duration: seconds(node.duration), aspect_ratio: node.aspectRatio || '16:9', resolution: node.resolution || '',
                images, videos: manualUrl(node) ? [manualUrl(node)] : urls('video'), audios: urls('audio'),
                ...Object.fromEntries(flags.filter(([, , field]) => field).map(([key, , field]) => [field, Boolean(node[key])])),
            };
        }

        function run(node, options = {}) {
            const key = keyFor(node);
            if (!options.cascade && running.has(key)) return running.get(key);
            const documentId = host.canvasId();
            const live = () => host.canvasId() === documentId && host.getNode(node.id);
            let entry;
            const execution = Promise.resolve().then(async () => {
                try {
                    const { id, provider, model } = selection(node);
                    const request = requestFor(node, host.sources(node, options.round), id, model);
                    if (!request.prompt.trim()) throw new Error(label('videoNeedsPrompt'));
                    if (!provider?.models.includes(model)) throw new Error(label('videoChooseConfigured'));
                    node.apiProvider = id;
                    node.model = model;
                    entry = host.begin(node, request.prompt, request.images, options);
                    const result = await host.submit(request, options);
                    const current = live();
                    if (!current) return;
                    const outputs = host.outputs(result);
                    if (!outputs.length) throw new Error(label('videoFailed'));
                    host.complete(current, entry, outputs, result, options);
                } catch (error) {
                    const current = live();
                    if (current) host.fail(current, entry, error, options);
                    if (options.cascade) throw error;
                }
            }).finally(() => {
                if (options.cascade) return;
                running.delete(key);
                const current = live();
                if (current) {
                    current.running = false;
                    host.refresh([current.id]);
                }
            });
            if (!options.cascade) {
                running.set(key, execution);
                node.running = true;
            }
            return execution;
        }

        function imageAndVideo(node) {
            return allReferences(host.sources(node)).filter(ref => host.mediaKind(ref) !== 'audio');
        }

        function setManual(node) {
            const refs = imageAndVideo(node);
            const preferred = refs.find(ref => !remote(ref.url)) || refs[0];
            const existing = manualUrl(node) || refs.map(ref => publicUrl(node, ref.url)).find((url, index) => url !== refs[index].url)
                || preferred?.url || '';
            const text = root.prompt(label('videoManualPrompt'), remote(existing) ? existing : '');
            if (text == null) return;
            const url = text.trim();
            if (url && !remote(url)) {
                host.message(label('videoInvalidUrl'), label('videoManualUrl'));
                return;
            }
            node.manualVideoUrls = url ? [url] : [];
            node.tempShLinks = withoutManualLinks(node.tempShLinks);
            if (url && preferred) node.tempShLinks.push({ source: preferred.url, url, manual: true });
            host.changed();
            host.refresh([node.id, preferred?.nodeId]);
            host.message(label(url ? 'videoUrlSaved' : 'videoUrlCleared'), label('videoManualUrl'));
        }

        async function upload(node) {
            const key = keyFor(node);
            if (uploading.has(key)) return;
            const refs = imageAndVideo(node).filter(ref => !remote(ref.url));
            if (!refs.length) {
                host.message(label('videoNoLocalMedia'), label('videoCloud'));
                return;
            }
            const documentId = host.canvasId();
            const live = () => host.canvasId() === documentId && host.getNode(node.id);
            const uploaded = new Map();
            uploading.add(key);
            host.refresh([node.id]);
            try {
                for (const ref of refs) {
                    let receipt = uploaded.get(ref.url);
                    if (!receipt) {
                        receipt = await host.upload(ref.url);
                        if (!receipt?.url || !remote(receipt.url)) throw new Error(label('videoCloudNoLink'));
                        uploaded.set(ref.url, receipt);
                    }
                    const current = live();
                    if (!current) return;
                    current.tempShLinks = storeLink(current.tempShLinks,
                        { source: ref.url, url: receipt.url, expires: receipt.expires || '3 days', kind: host.mediaKind(ref) });
                    host.replaceReference(ref, receipt.url);
                    host.changed();
                }
                const copied = await host.copy(uploaded.values().next().value.url);
                const message = label(copied ? 'videoCloudUploaded' : 'videoCloudUploadComplete');
                if (live()) host.message(message.replace('{count}', uploaded.size), label('videoCloud'));
            } catch (error) {
                if (live()) host.message(error.message || label('videoCloudFailed'), label('videoCloud'));
            } finally {
                uploading.delete(key);
                if (live()) host.refresh([node.id, ...refs.map(ref => ref.nodeId)]);
            }
        }

        function updateInputs(card, node, sources) {
            host.renderPrompts(card.querySelector('.prompt-list'), sources.filter(source => source.prompt && !source.refs?.length));
            const list = card.querySelector('.video-img-list');
            const media = sources.map(source => {
                const refs = allReferences([source]);
                return refs.length ? { ...source, refs } : null;
            }).filter(Boolean);
            if (!media.length) {
                list.replaceChildren(element('div', 'text-[11px] text-gray-300 py-2', label('groupEmpty')));
                return;
            }
            let imageIndex = 0;
            list.replaceChildren(...media.map((source, index) => {
                const ref = source.refs[0];
                const kind = host.mediaKind(ref);
                const item = element('div', 'input-item video-input-item');
                const thumbnail = element('div', 'video-input-thumb');
                thumbnail.append(element('span', 'input-index', index + 1));
                if (kind === 'audio') {
                    const badge = element('div', 'video-input-audio');
                    badge.append(icon('file-audio', 'w-6 h-6'), element('span', '', source.label));
                    thumbnail.append(badge);
                } else {
                    thumbnail.insertAdjacentHTML('beforeend', host.preview(source.preview || ref.url, kind));
                }
                const mediaLabel = kind === 'image' ? label('image') : host.mediaLabel(kind);
                thumbnail.append(element('span', 'input-label', mediaLabel + (index + 1)));
                item.append(thumbnail);
                if (kind === 'image') {
                    const role = ['videoRoleFirstFrame', 'videoRoleLastFrame'][imageIndex++];
                    if (node.useFrameRoles && role) item.append(element('div', 'video-frame-label', label(role)));
                }
                host.bindInputDrag(item, node, source.id);
                return item;
            }));
            host.icons();
        }

        function render(node) {
            const card = element('div', 'generator-body classic-video');
            const busy = uploading.has(keyFor(node));
            const heading = element('div', 'video-input-head');
            const mediaActions = element('div', 'video-input-actions');
            const manual = button(label('videoManualUrl'), 'tool-btn', () => setManual(node), 'link');
            manual.dataset.videoManualUrl = '';
            const uploadButton = button(label(busy ? 'videoCloudUploading' : 'videoCloud'), 'tool-btn', () => upload(node), 'upload-cloud');
            uploadButton.dataset.videoTempSh = '';
            uploadButton.disabled = busy;
            mediaActions.append(manual, uploadButton);
            heading.append(element('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest', label('videoMedia')), mediaActions);

            const settings = element('div', 'gen-settings');
            const catalogRow = element('div', 'gen-settings-row');
            function drawCatalog() {
                const { id, provider, model } = selection(node);
                const available = providers.map(item => [item.id, item.name]);
                if (id && !provider) available.unshift([id, id + ' · ' + label('videoUnavailable')]);
                if (!available.length) available.push(['', label('provider')]);
                const platform = select('video-provider', label('provider'), available, id);
                const options = (provider?.models || []).map(name => [name, name]);
                if (model && !provider?.models.includes(model)) options.unshift([model, model + ' · ' + label('videoUnavailable')]);
                if (!options.length) options.push(['', label('noModelsHint')]);
                const models = select('video-model', label('videoModel'), options, model);
                platform.style.flex = '1';
                models.style.flex = '2';
                platform.addEventListener('change', () => {
                    const next = providers.find(item => item.id === platform.value);
                    if (!next) return;
                    node.apiProvider = next.id;
                    node.model = next.models.includes(node.model) ? node.model : next.models[0];
                    host.changed();
                    drawCatalog();
                });
                models.addEventListener('change', () => {
                    node.apiProvider = id;
                    node.model = models.value;
                    host.changed();
                });
                catalogRow.replaceChildren(platform, models);
            }
            drawCatalog();

            const timing = element('div', 'gen-settings-row');
            const duration = element('input', 'setting-input video-duration');
            Object.assign(duration, { type: 'number', min: 1, max: 60, step: 1, value: seconds(node.duration) });
            duration.addEventListener('input', () => {
                if (!duration.value) return;
                node.duration = seconds(duration.value);
                host.changed();
            });
            duration.addEventListener('blur', () => { duration.value = seconds(node.duration); });
            const aspect = select('video-aspect compact-select', label('videoAspect'),
                [...new Set([...(node.aspectRatio ? [node.aspectRatio] : []), ...aspects])].map(value => [value, value]),
                node.aspectRatio || '16:9');
            const size = select('video-resolution compact-select', label('videoResolution'),
                [...new Set([...resolutions, ...(node.resolution ? [node.resolution] : [])])].map(value => [value, value || label('videoAuto')]),
                node.resolution || '');
            for (const [input, property] of [[aspect, 'aspectRatio'], [size, 'resolution']]) {
                input.addEventListener('change', () => {
                    node[property] = input.value;
                    host.changed();
                });
            }
            timing.append(field(label('videoDuration'), duration), field(label('videoAspect'), aspect), field(label('videoResolution'), size));

            const toggles = element('div', 'gen-settings-row');
            toggles.style.flexWrap = 'wrap';
            for (const [name, key] of flags) {
                const toggle = button(label(key), 'setting-check' + (node[name] ? ' active' : ''), () => {
                    node[name] = !node[name];
                    if (node[name] && name === 'multimodal') node.useFrameRoles = false;
                    if (node[name] && name === 'useFrameRoles') node.multimodal = false;
                    host.changed();
                    host.refresh([node.id]);
                });
                toggle.prepend(element('span', 'check-dot'));
                toggle.dataset.videoToggle = name;
                toggle.setAttribute('aria-pressed', String(Boolean(node[name])));
                toggles.append(toggle);
            }
            settings.append(catalogRow, timing, toggles);

            const actions = element('div', 'gen-run-row');
            const active = node.running || running.has(keyFor(node));
            const launch = button(label(active ? 'generating' : 'videoGenerate'), 'gen-btn' + (active ? ' running' : ''),
                () => host.runNode(node.id), 'clapperboard');
            launch.disabled = Boolean(active);
            actions.append(launch);
            card.append(element('div', 'prompt-list mb-3'), heading, element('div', 'input-list video-img-list'), settings, actions);
            updateInputs(card, node, host.sources(node));
            host.addControls(card, actions, node);
            return card;
        }

        return { setProviders, newNode, run, render, updateInputs };
    }

    root.XiaomeiClassicVideo = { create };
})(typeof window === 'undefined' ? globalThis : window);
