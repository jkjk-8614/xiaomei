(function (root) {
    'use strict';

    const workflow = 'LTXDirectorv2-API.json';
    const limit = 10000;
    const numeric = (value, fallback) => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const frame = (value, fallback = 0) => Math.round(numeric(value, fallback));
    const duration = node => clamp(frame(node.durationFrames, 120), 1, limit);
    const fps = node => clamp(frame(node.frameRate, 24), 1, 240);
    const end = clip => clip.start + clip.length;
    const sorted = clips => [...clips].sort((a, b) => a.start - b.start);
    function mediaUrl(name) {
        const parts = String(name).split('/');
        return '/api/view?' + new URLSearchParams({ filename: parts.pop(), subfolder: parts.join('/'), type: 'input' });
    }

    function readTimeline(node, id) {
        let timeline;
        try { timeline = JSON.parse(node.ltxTimelineData || 'null'); } catch (_) {}
        const legacy = Array.isArray(node.ltxSegments) ? node.ltxSegments : [];
        const visual = Array.isArray(timeline?.segments) ? timeline.segments : legacy.filter(clip => clip && typeof clip === 'object').map(clip => ({
            ...clip, guideStrength: clip.strength ?? 1,
            imageFile: clip.imageRef?.comfy_name, imageB64: clip.imageRef?.url,
        }));
        const audio = Array.isArray(timeline?.audioSegments) ? timeline.audioSegments : [];
        const normalize = (clips, track) => clips.filter(clip => clip && typeof clip === 'object').map(clip => {
            const { imgObj, ...data } = clip;
            const type = track === 'audio' ? track : data.type === 'image' ? 'image' : 'text';
            return { ...data, id: data.id || id(), type, start: Math.max(0, frame(data.start)), length: Math.max(1, frame(data.length, 1)) };
        });
        return { ...timeline, segments: normalize(visual, 'visual'), audioSegments: normalize(audio, 'audio') };
    }

    function syncReferences(timeline, sources, node, id) {
        const linked = new Map(sources.map(source => [source.id, source]));
        timeline.segments = timeline.segments.filter(clip => !clip.canvasSourceId || linked.has(clip.canvasSourceId));
        const existing = new Map(timeline.segments.filter(clip => clip.canvasSourceId).map(clip => [clip.canvasSourceId, clip]));
        const length = Math.max(6, fps(node));
        for (const [sourceId, source] of linked) {
            const ref = source.refs[0];
            const current = existing.get(sourceId);
            if (current) {
                if (current.imageB64 !== ref.url) {
                    current.imageB64 = ref.url;
                    current.imageFile = ref.comfy_name || '';
                }
                continue;
            }
            let start = 0;
            for (const clip of sorted(timeline.segments)) {
                if (start + length <= clip.start) break;
                start = Math.max(start, end(clip));
            }
            timeline.segments.push({
                id: id(), type: 'image', start, length, prompt: source.prompt || '', guideStrength: 1,
                imageB64: ref.url, imageFile: ref.comfy_name || '', canvasSourceId: sourceId,
            });
            if (start + length > duration(node)) node.durationFrames = Math.min(limit, start + length);
        }
    }

    function buildRelay(segments, frames, globalPrompt) {
        const fallback = globalPrompt || '.';
        const clips = [];
        const lengths = [];
        const prompts = [];
        let cursor = 0;
        for (const clip of sorted(segments)) {
            const stop = Math.min(frames, end(clip));
            const start = Math.max(cursor, clip.start);
            if (stop <= start) continue;
            if (lengths.length) lengths[lengths.length - 1] += start - cursor;
            lengths.push(stop - (lengths.length ? start : 0));
            const prompt = String(clip.prompt || '').trim() || fallback;
            clips.push({ ...clip, prompt, start, length: stop - start });
            prompts.push(prompt);
            cursor = stop;
        }
        if (lengths.length) lengths[lengths.length - 1] += frames - cursor;
        else { lengths.push(frames); prompts.push(fallback); }
        return {
            clips,
            local_prompts: prompts.join(' | '),
            segment_lengths: lengths.join(','),
            guide_strength: clips.filter(clip => clip.type === 'image').map(clip => numeric(clip.guideStrength, 1).toFixed(2)).join(','),
        };
    }

    function create(host) {
        const { label } = host;
        const id = () => host.id('ltxseg');
        const views = new WeakMap();
        const active = new Map();

        function newNode({ x, y }) {
            return {
                id: host.id('ltxdir'), type: 'ltxDirector', x, y, w: 1000, h: 800,
                globalPrompt: '', durationFrames: 120, durationSeconds: 5, frameRate: 24,
                customWidth: 0, customHeight: 0, displayMode: 'seconds', useCustomAudio: false,
                imgCompression: 18, epsilon: 0.001, divisibleBy: 32, noiseSeed: 12,
                ltxTimelineData: '', ltxSelectedSegId: '', inputs: [],
            };
        }

        function imageSources(sources) {
            return sources.map(source => ({ ...source, refs: host.images(source.refs || []).filter(ref => ref.url) }))
                .filter(source => source.refs.length);
        }

        function setDuration(node, value) {
            node.durationFrames = clamp(frame(value, 120), 1, limit);
            node.durationSeconds = node.durationFrames / fps(node);
        }

        function write(node, timeline) {
            const data = JSON.stringify(timeline);
            if (node.ltxTimelineData === data) return;
            node.ltxTimelineData = data;
            host.changed();
            return true;
        }

        function sync(node, sources = host.sources(node)) {
            const timeline = readTimeline(node, id);
            const before = duration(node);
            syncReferences(timeline, imageSources(sources), node, id);
            setDuration(node, duration(node));
            const changed = write(node, timeline);
            if (before !== duration(node)) host.changed();
            const view = views.get(node);
            if (changed && view?.connected()) view.update(timeline);
            return timeline;
        }

        function updateInputs(card, node, sources) {
            const images = imageSources(sources);
            host.renderPrompts(card.querySelector('.prompt-list'), sources.filter(source => source.prompt && !source.refs?.length));
            host.renderMedia(card.querySelector('.input-list'), node, images);
            card.querySelector('.classic-ltx-linked').textContent = label('canvas.ltxLinkedImages') + ' · ' + images.length;
            sync(node, sources);
        }

        function render(node) {
            const card = element('div', 'ltx-director-body classic-ltx');
            const editor = element('div', 'ltx-director-timeline-host');
            editor.dataset.nativeTouch = '';
            const sources = host.sources(node);
            const timeline = sync(node, sources);
            views.get(node)?.stop();
            views.set(node, mountEditor(editor, node, timeline, {
                label, id, setDuration, write, changed: host.changed, upload: host.uploadFile,
                isCurrent: () => host.getNode(node.id) === node,
                refresh: () => host.refresh(node),
                report: host.mediaError,
            }));
            const actions = element('div', 'gen-run-row');
            const runButton = button(node.running ? label('canvas.ltxRunning') : label('canvas.ltxRun'), () => host.runNode(node.id), 'comfy-run ltx-run');
            runButton.disabled = Boolean(node.running);
            actions.append(runButton);
            card.append(element('div', 'prompt-list'), editor, element('div', 'classic-ltx-linked'), element('div', 'input-list'), actions);
            updateInputs(card, node, sources);
            host.addControls(card, actions, node);
            return card;
        }

        function current(nodeId, job) {
            const node = host.getNode(nodeId);
            return host.canvasId() === job.canvasId && node?.ltxRuns?.some(item => item.id === job.id) ? node : null;
        }

        async function follow(nodeId, job, options) {
            let node = current(nodeId, job);
            if (!node) return;
            try {
                if (!job.taskId) {
                    const task = await host.submit({ ...job.payload, client_request_id: job.id }, options);
                    node = current(nodeId, job);
                    if (!node) return;
                    job = node.ltxRuns.find(item => item.id === job.id);
                    if (!task.task_id) throw new Error(label('canvas.ltxFailed'));
                    job.taskId = task.task_id;
                    host.changed();
                    await host.save();
                }
                const result = await host.wait(job.taskId, options);
                node = current(nodeId, job);
                if (!node) return;
                if (result.error) throw Object.assign(new Error(result.error), { terminal: true });
                const outputs = host.outputs(result);
                if (!outputs.length) throw Object.assign(new Error(label('canvas.ltxNoOutput')), { terminal: true });
                const saved = node.ltxRuns.find(item => item.id === job.id);
                saved.run.request = host.requestMeta(result);
                host.complete(node, saved, outputs);
            } catch (error) {
                node = current(nodeId, job);
                if (node) host.fail(node, node.ltxRuns.find(item => item.id === job.id), error, options);
                if (options.cascade) throw error;
            }
        }

        function whileActive(node, work) {
            const canvasId = host.canvasId();
            const key = JSON.stringify([canvasId, node.id]);
            if (active.has(key)) return active.get(key);
            node.running = true;
            const execution = Promise.resolve().then(work).finally(() => {
                active.delete(key);
                const live = host.getNode(node.id);
                if (host.canvasId() !== canvasId || live?.type !== 'ltxDirector') return;
                live.running = false;
                host.refresh(live);
            });
            active.set(key, execution);
            host.refresh(node);
            return execution;
        }

        function run(node, options = {}) {
            const work = async () => {
                const canvasId = host.canvasId();
                const stillHere = () => host.canvasId() === canvasId && host.getNode(node.id) === node;
                const existing = !options.cascade && node.ltxRuns?.[0];
                if (existing) return follow(node.id, existing, options);
                let job;
                try {
                    const sources = host.sources(node, options.round);
                    const working = options.round ? { ...node } : node;
                    const timeline = options.round ? readTimeline(working, id) : sync(node, sources);
                    if (options.round) syncReferences(timeline, imageSources(sources), working, id);
                    const global = [node.globalPrompt, ...sources.map(source => source.prompt)].filter(Boolean).join('\n\n').trim();
                    const frames = duration(working);
                    const rate = fps(node);
                    const {
                        useCustomAudio, epsilon, displayMode, customWidth, customHeight, divisibleBy, imgCompression, noiseSeed,
                    } = node;
                    const relay = buildRelay(timeline.segments, frames, global);
                    if (!global && !timeline.segments.some(clip => clip.start < frames && (String(clip.prompt || '').trim() || clip.imageFile || clip.imageB64))) {
                        throw new Error(label('canvas.needPromptOrImage'));
                    }
                    const uploaded = new Map();
                    for (const clip of relay.clips) {
                        if (clip.type !== 'image' || clip.imageFile) continue;
                        if (!clip.imageB64) throw new Error(label('canvas.ltxImageSegNeedRef'));
                        clip.imageFile = await host.uploadRef({ url: clip.imageB64 }, workflow, options);
                        if (!stillHere()) return;
                        uploaded.set(clip.id, clip);
                    }
                    if (!options.round && uploaded.size) {
                        const latest = readTimeline(node, id);
                        for (const clip of latest.segments) {
                            const prepared = uploaded.get(clip.id);
                            if (prepared && !clip.imageFile && prepared.imageB64 === clip.imageB64) clip.imageFile = prepared.imageFile;
                        }
                        write(node, latest);
                    }
                    const { clips, ...derived } = relay;
                    const timelineData = JSON.stringify({ ...timeline, segments: clips });
                    if (!options.round) {
                        node.ltxLocalPrompts = derived.local_prompts;
                        node.ltxSegmentLengths = derived.segment_lengths;
                        node.ltxGuideStrength = derived.guide_strength;
                    }
                    job = host.start(node, {
                        prompt: global || timeline.segments.map(clip => clip.prompt).filter(Boolean).join(' | '),
                        refs: sources.flatMap(source => source.refs || []),
                        payload: {
                            prompt: global, workflow_json: workflow, type: 'ltx-director',
                            params: {
                                '46': {
                                    ...derived, global_prompt: global, duration_frames: frames, duration_seconds: frames / rate,
                                    timeline_data: timelineData, frame_rate: rate, use_custom_audio: Boolean(useCustomAudio),
                                    epsilon: numeric(epsilon, 0.001), display_mode: displayMode || 'seconds',
                                    custom_width: Math.max(0, numeric(customWidth, 0)), custom_height: Math.max(0, numeric(customHeight, 0)),
                                    resize_method: 'maintain aspect ratio', divisible_by: Math.max(1, numeric(divisibleBy, 32)),
                                    img_compression: numeric(imgCompression, 18), timeline_ui: '',
                                },
                                '94:28': { noise_seed: numeric(noiseSeed, 12) },
                            },
                        },
                    }, options);
                    if (!await host.save()) throw new Error(label('canvas.comfySavePendingFailed'));
                } catch (error) {
                    if (stillHere()) {
                        if (job) host.fail(node, job, error, options);
                        else host.report(node, error, options);
                    }
                    if (options.cascade) throw error;
                    return;
                }
                return follow(node.id, job, options);
            };
            return options.cascade ? work() : whileActive(node, work);
        }

        function resume(nodes) {
            for (const node of nodes) {
                if (node.type === 'ltxDirector' && node.ltxRuns?.length) {
                    whileActive(node, async () => {
                        for (const job of node.ltxRuns) await follow(node.id, job, { resume: true });
                    });
                }
            }
        }

        return { newNode, render, sync, updateInputs, run, resume };
    }

    function element(tag, className, text) {
        const el = root.document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    function button(caption, click, className = 'tool-btn') {
        const control = element('button', className, caption);
        control.type = 'button';
        control.addEventListener('click', click);
        return control;
    }

    function mountEditor(editor, node, initial, host) {
        const { label } = host;
        const text = key => label('canvas.ltx' + key);
        let timeline = initial;
        let playhead = 0;
        let zoom = 1;
        let zoomFrames = duration(node);
        let loop = false;
        let animation = 0;
        let audioClip = null;
        let clipboard = null;
        let drag = null;
        let uploading = false;
        let previewKey = '';
        const audio = new root.Audio();
        const settings = element('div', 'ltx-params-row');
        const toolbar = element('div', 'classic-ltx-toolbar');
        const scroller = element('div', 'classic-ltx-scroller');
        const trackArea = element('div', 'classic-ltx-tracks');
        const ruler = element('div', 'classic-ltx-ruler');
        const visual = element('div', 'classic-ltx-track classic-ltx-visual');
        const sound = element('div', 'classic-ltx-track classic-ltx-audio');
        const cursor = element('div', 'classic-ltx-playhead');
        const status = element('output', 'classic-ltx-clock');
        const detail = element('div', 'classic-ltx-detail');
        const preview = element('div', 'classic-ltx-preview');
        const inspector = element('div', 'classic-ltx-inspector');
        const advanced = element('details', 'classic-ltx-advanced');
        const menu = element('div', 'classic-ltx-menu');
        menu.setAttribute('popover', 'auto');
        const selection = () => [...timeline.segments, ...timeline.audioSegments].find(clip => clip.id === node.ltxSelectedSegId);
        const clipsFor = type => type === 'audio' ? timeline.audioSegments : timeline.segments;
        const total = () => Math.max(duration(node), zoomFrames, ...timeline.segments.map(end), ...timeline.audioSegments.map(end));
        const image = clip => clip.imageB64 || (clip.imageFile ? mediaUrl(clip.imageFile) : '');

        function number(caption, value, min, max, step, update) {
            const field = element('label', 'field');
            const input = element('input', 'setting-input');
            Object.assign(input, { type: 'number', value, min, max, step });
            input.addEventListener('change', () => {
                const next = clamp(numeric(input.value, value), min, max);
                input.value = next;
                update(next);
            });
            field.append(element('span', 'setting-title', caption), input);
            return field;
        }

        function optionNumber(container, key, caption, fallback, min, max, step = 1) {
            container.append(number(caption, numeric(node[key], fallback), min, max, step, value => {
                node[key] = step === 1 ? Math.round(value) : value;
                host.changed();
            }));
        }

        function timing() {
            const timingField = (caption, value, min, max, step, apply) => {
                const field = number(caption, value, min, max, step, next => {
                    apply(next);
                    playhead = clamp(playhead, 0, duration(node));
                    zoomFrames = duration(node);
                    host.changed();
                    timing();
                    draw();
                });
                return field;
            };
            settings.replaceChildren(
                timingField(text('DurationSec'), Number((duration(node) / fps(node)).toFixed(3)), 0.001, 10000, 0.001, next => host.setDuration(node, next * fps(node))),
                timingField(text('DurationFrames'), duration(node), 1, limit, 1, next => host.setDuration(node, next)),
                timingField(text('Fps'), fps(node), 1, 240, 1, next => { node.frameRate = frame(next); host.setDuration(node, duration(node)); }),
            );
            optionNumber(settings, 'customWidth', label('canvas.width'), 0, 0, 8192);
            optionNumber(settings, 'customHeight', label('canvas.height'), 0, 0, 8192);
        }

        function save() {
            host.write(node, timeline);
            draw();
        }

        function select(clip) {
            node.ltxSelectedSegId = clip?.id || '';
            host.changed();
            draw();
        }

        function addText(at = playhead) {
            add({ id: host.id(), type: 'text', length: fps(node), prompt: '' }, at);
        }

        function add(clip, at = playhead) {
            const track = clipsFor(clip.type);
            let start = Math.min(duration(node) - 1, Math.max(0, at));
            for (const other of sorted(track)) {
                if (start + clip.length <= other.start) break;
                if (start < end(other)) start = end(other);
            }
            if (start >= limit) return;
            clip.start = start;
            clip.length = Math.min(clip.length, limit - start);
            track.push(clip);
            if (end(clip) > duration(node)) {
                host.setDuration(node, end(clip));
                timing();
            }
            node.ltxSelectedSegId = clip.id;
            save();
        }

        function deleteSelected() {
            const clip = selection();
            if (!clip || clip.canvasSourceId) return;
            const track = clipsFor(clip.type);
            track.splice(track.indexOf(clip), 1);
            node.ltxSelectedSegId = '';
            save();
        }

        function copySelected() {
            const clip = selection();
            if (!clip) return;
            clipboard = { ...clip };
            delete clipboard.canvasSourceId;
            paste.disabled = false;
        }

        function pasteClip(at = playhead) {
            if (clipboard) add({ ...clipboard, id: host.id() }, at);
        }

        async function upload(files, at = playhead, replaceId = '') {
            if (uploading) return;
            uploading = true;
            const canvasFrameRate = fps(node);
            try {
                for (const file of files) {
                    const kind = file.type.split('/')[0];
                    if (kind !== 'image' && kind !== 'audio') continue;
                    const audioMeta = kind === 'audio' ? await inspectAudio(file, canvasFrameRate) : null;
                    const name = await host.upload(file, workflow);
                    if (!host.isCurrent()) return;
                    const latest = readTimeline(node, host.id);
                    const target = latest.segments.find(clip => clip.id === replaceId && !clip.canvasSourceId);
                    if (target) {
                        target.imageFile = name;
                        delete target.imageB64;
                        host.write(node, latest);
                        if (editor.isConnected) { timeline = latest; draw(); }
                        else host.refresh();
                        return;
                    }
                    timeline = latest;
                    const metadata = kind === 'audio'
                        ? { audioFile: name, fileName: file.name, trimStart: 0, ...audioMeta }
                        : { imageFile: name, prompt: '', guideStrength: 1 };
                    add({ id: host.id(), type: kind, length: audioMeta?.audioDurationFrames || canvasFrameRate, ...metadata }, at);
                    const added = selection();
                    if (added) at = end(added);
                    if (!editor.isConnected) host.refresh();
                }
            } catch (error) {
                if (host.isCurrent()) host.report(error);
            } finally {
                uploading = false;
            }
        }

        function picker(kind, callback) {
            const input = element('input');
            Object.assign(input, { type: 'file', accept: kind + '/*', multiple: true, hidden: true });
            input.addEventListener('change', () => { callback(Array.from(input.files)); input.value = ''; });
            toolbar.append(input);
            return input;
        }

        const images = picker('image', files => upload(files, frame(images.dataset.frame, playhead)));
        const sounds = picker('audio', files => upload(files, frame(sounds.dataset.frame, playhead)));
        function pick(input, at) {
            input.dataset.frame = at;
            input.click();
        }
        const replacement = picker('image', files => upload(Array.from(files).slice(0, 1), playhead, replacement.dataset.clipId));
        const play = button(text('Play'), togglePlayback);
        const repeat = button(text('Loop'), () => {
            loop = !loop;
            repeat.setAttribute('aria-pressed', String(loop));
        });
        repeat.setAttribute('aria-pressed', 'false');
        const copy = button(text('CopyClip'), copySelected);
        const paste = button(text('PasteClip'), () => pasteClip());
        paste.disabled = true;
        const duplicate = button(text('DuplicateClip'), () => {
            const clip = selection();
            if (clip) { copySelected(); pasteClip(end(clip)); }
        });
        const remove = button(text('DeleteClip'), deleteSelected);
        toolbar.append(
            button(text('AddText'), () => addText()),
            button(text('AddImage'), () => pick(images, playhead)), button(text('AddAudio'), () => pick(sounds, playhead)),
            play, repeat, status, copy, paste, duplicate, remove,
            button('−', () => changeZoom(-0.5)), button('+', () => changeZoom(0.5)),
        );

        const globalPrompt = element('textarea', 'setting-input');
        globalPrompt.value = node.globalPrompt || '';
        globalPrompt.placeholder = text('GlobalPrompt');
        globalPrompt.setAttribute('aria-label', text('GlobalPrompt'));
        globalPrompt.addEventListener('input', () => { node.globalPrompt = globalPrompt.value; host.changed(); });
        const mode = element('select', 'setting-input');
        for (const value of ['seconds', 'frames']) {
            const option = element('option', '', text(value === 'seconds' ? 'Seconds' : 'Frames'));
            option.value = value;
            mode.append(option);
        }
        mode.value = node.displayMode === 'frames' ? 'frames' : 'seconds';
        mode.setAttribute('aria-label', text('TimeUnits'));
        mode.addEventListener('change', () => { node.displayMode = mode.value; host.changed(); draw(); });
        const audioToggle = element('input');
        Object.assign(audioToggle, { type: 'checkbox', checked: Boolean(node.useCustomAudio) });
        audioToggle.addEventListener('change', () => { node.useCustomAudio = audioToggle.checked; host.changed(); });
        const audioLabel = element('label', 'classic-ltx-audio-toggle');
        audioLabel.append(audioToggle, text('UseAudio'));
        const advancedFields = element('div', 'ltx-params-row');
        optionNumber(advancedFields, 'noiseSeed', text('Seed'), 12, 0, Number.MAX_SAFE_INTEGER);
        optionNumber(advancedFields, 'imgCompression', text('Compression'), 18, 0, 100);
        optionNumber(advancedFields, 'epsilon', text('Epsilon'), 0.001, 0, 1, 0.0001);
        optionNumber(advancedFields, 'divisibleBy', text('DivisibleBy'), 32, 1, 256);
        advancedFields.append(mode);
        advanced.append(element('summary', '', text('Advanced')), advancedFields);

        const zoomButtons = toolbar.querySelectorAll('button');
        zoomButtons[zoomButtons.length - 2].setAttribute('aria-label', text('ZoomOut'));
        zoomButtons[zoomButtons.length - 1].setAttribute('aria-label', text('ZoomIn'));
        for (const [track, caption] of [[visual, text('VisualTrack')], [sound, text('AudioTrack')]]) {
            track.setAttribute('aria-label', caption);
            track.dataset.label = caption;
        }
        ruler.tabIndex = 0;
        ruler.setAttribute('role', 'slider');
        ruler.setAttribute('aria-label', text('Playhead'));
        ruler.setAttribute('aria-valuemin', '0');
        trackArea.append(ruler, visual, sound, cursor);
        scroller.append(trackArea);
        detail.append(preview, inspector);
        editor.append(settings, globalPrompt, toolbar, scroller, detail, audioLabel, advanced, menu);
        editor.tabIndex = 0;
        timing();
        draw();

        function changeZoom(change) {
            zoom = clamp(zoom + change, 1, 8);
            draw();
        }

        function format(value) {
            return node.displayMode === 'frames' ? String(Math.round(value)) : (value / fps(node)).toFixed(2) + 's';
        }

        function updatePreview() {
            status.value = format(playhead) + ' / ' + format(duration(node));
            ruler.setAttribute('aria-valuenow', String(Math.round(playhead)));
            ruler.setAttribute('aria-valuemax', String(total()));
            cursor.style.left = 100 * playhead / total() + '%';
            const active = sorted(timeline.segments).find(clip => clip.start <= playhead && end(clip) > playhead);
            const clip = animation ? active : selection() || active;
            const url = clip?.type === 'image' ? image(clip) : '';
            const caption = clip?.prompt || clip?.fileName || (clip ? text(clip.type === 'image' ? 'ImageClip' : clip.type === 'audio' ? 'AudioTrack' : 'TextClip') : '');
            const key = JSON.stringify([url, caption]);
            if (key !== previewKey) {
                previewKey = key;
                preview.replaceChildren();
                if (url) {
                    const thumbnail = element('img');
                    thumbnail.src = url;
                    thumbnail.alt = caption;
                    preview.append(thumbnail);
                } else if (caption) preview.append(element('span', '', caption));
            }
            const playing = animation && timeline.audioSegments.find(item => item.start <= playhead && end(item) > playhead);
            const nextAudio = playing?.audioB64 || (playing?.audioFile ? mediaUrl(playing.audioFile) : '');
            if (!nextAudio) {
                audio.pause();
                audioClip = null;
            } else if (audioClip !== playing.id) {
                audioClip = playing.id;
                audio.src = nextAudio;
                audio.currentTime = (frame(playing.trimStart) + playhead - playing.start) / fps(node);
                audio.play().catch(() => {});
            }
        }

        function draw() {
            const frames = total();
            trackArea.style.width = zoom * 100 + '%';
            ruler.replaceChildren();
            const count = Math.min(40, Math.max(4, Math.round(zoom * 8)));
            for (let index = 0; index <= count; index++) {
                const tick = element('span', 'classic-ltx-tick', format(frames * index / count));
                tick.style.left = 100 * index / count + '%';
                ruler.append(tick);
            }
            const focused = root.document.activeElement?.closest?.('.classic-ltx-clip');
            const focusedClipId = editor.contains(focused) ? focused.dataset.clipId : null;
            visual.replaceChildren(...sorted(timeline.segments).map(drawClip));
            sound.replaceChildren(...sorted(timeline.audioSegments).map(drawClip));
            if (focusedClipId) {
                [...visual.children, ...sound.children].find(el => el.dataset.clipId === focusedClipId)?.focus({ preventScroll: true });
            }
            const clip = selection();
            copy.disabled = duplicate.disabled = !clip;
            remove.disabled = !clip || Boolean(clip.canvasSourceId);
            drawInspector(clip);
            updatePreview();
        }

        function place(el, clip) {
            el.style.left = 100 * clip.start / total() + '%';
            el.style.width = 100 * clip.length / total() + '%';
        }

        function drawClip(clip) {
            const el = element('button', 'classic-ltx-clip');
            el.type = 'button';
            const name = clip.fileName || clip.prompt || text(clip.type === 'text' ? 'TextClip' : clip.type === 'image' ? 'ImageClip' : 'AudioTrack');
            el.title = name;
            el.dataset.clipId = clip.id;
            el.dataset.kind = clip.type;
            el.setAttribute('aria-label', name);
            el.setAttribute('aria-pressed', String(clip.id === node.ltxSelectedSegId));
            if (clip.color) el.style.setProperty('--ltx-clip-color', clip.color);
            if (clip.type === 'image' && image(clip)) {
                const thumb = element('img');
                thumb.src = image(clip);
                thumb.alt = '';
                el.append(thumb);
            }
            if (clip.type === 'audio' && Array.isArray(clip.waveformPeaks)) {
                const wave = element('span', 'classic-ltx-wave');
                const original = numeric(clip.audioDurationFrames, clip.length);
                const first = Math.floor(frame(clip.trimStart) / original * clip.waveformPeaks.length);
                const last = Math.ceil((frame(clip.trimStart) + clip.length) / original * clip.waveformPeaks.length);
                for (const peak of clip.waveformPeaks.slice(first, last)) {
                    const bar = element('i');
                    bar.style.height = clamp(numeric(peak, 0) * 100, 3, 100) + '%';
                    wave.append(bar);
                }
                el.append(wave);
            }
            el.append(element('span', 'classic-ltx-clip-name', name));
            for (const edge of ['left', 'right']) {
                const handle = element('span', 'classic-ltx-handle');
                handle.dataset.edge = edge;
                el.append(handle);
            }
            el.addEventListener('click', event => {
                if (!event.detail) select(clip);
            });
            place(el, clip);
            return el;
        }

        function drawInspector(clip) {
            inspector.replaceChildren();
            if (!clip) {
                inspector.append(element('span', '', text('SelectClip')));
                return;
            }
            const props = element('div', 'ltx-params-row');
            props.append(number(text('ClipStart'), clip.start, 0, limit - 1, 1, value => {
                clip.start = availableStart(clip, frame(value));
                save();
            }), number(text('ClipLength'), clip.length, 1, maxLength(clip), 1, value => {
                clip.length = frame(value);
                save();
            }));
            if (clip.type === 'audio') {
                props.append(number(text('TrimStart'), frame(clip.trimStart), 0, Math.max(0, numeric(clip.audioDurationFrames, clip.length) - clip.length), 1, value => {
                    clip.trimStart = frame(value);
                    save();
                }));
            } else {
                const prompt = element('textarea', 'setting-input');
                prompt.value = clip.prompt || '';
                prompt.placeholder = text('ClipPrompt');
                prompt.setAttribute('aria-label', text('ClipPrompt'));
                prompt.addEventListener('input', () => {
                    clip.prompt = prompt.value;
                    host.write(node, timeline);
                    const clipButton = [...visual.children].find(child => child.dataset.clipId === clip.id);
                    const name = clip.prompt || text(clip.type === 'image' ? 'ImageClip' : 'TextClip');
                    clipButton?.setAttribute('aria-label', name);
                    if (clipButton) clipButton.querySelector('.classic-ltx-clip-name').textContent = name;
                    updatePreview();
                });
                inspector.append(prompt);
                if (clip.type === 'image') {
                    props.append(number(text('Strength'), numeric(clip.guideStrength, 1), 0, 10, 0.01, value => {
                        clip.guideStrength = value;
                        save();
                    }));
                    if (!clip.canvasSourceId) props.append(button(text('ReplaceImage'), () => {
                        replacement.dataset.clipId = clip.id;
                        replacement.click();
                    }));
                    else props.append(element('span', '', text('LinkedClip')));
                }
            }
            inspector.append(props);
        }

        function availableStart(clip, requested) {
            const candidates = [];
            let cursor = 0;
            for (const other of sorted(clipsFor(clip.type))) {
                if (other === clip) continue;
                if (other.start - cursor >= clip.length) candidates.push(clamp(requested, cursor, other.start - clip.length));
                cursor = Math.max(cursor, end(other));
            }
            if (limit - cursor >= clip.length) candidates.push(clamp(requested, cursor, limit - clip.length));
            return candidates.reduce((best, value) => best == null || Math.abs(value - requested) < Math.abs(best - requested) ? value : best, null) ?? clip.start;
        }

        function maxLength(clip) {
            const remaining = clip.type === 'audio' ? numeric(clip.audioDurationFrames, clip.length) - frame(clip.trimStart) : limit;
            const next = sorted(clipsFor(clip.type)).find(other => other !== clip && other.start > clip.start);
            return Math.max(1, Math.min(remaining, (next?.start ?? limit) - clip.start));
        }

        function seek(value) {
            playhead = clamp(value, 0, total());
            if (animation) {
                stop();
                if (playhead < total()) togglePlayback();
            } else updatePreview();
        }

        function frameAt(clientX) {
            const rect = trackArea.getBoundingClientRect();
            return clamp(Math.round((clientX - rect.left) / Math.max(1, rect.width) * total()), 0, total());
        }

        trackArea.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const target = event.target.closest('[data-clip-id]');
            const clip = target && [...timeline.segments, ...timeline.audioSegments].find(item => item.id === target.dataset.clipId);
            if (!clip && !event.target.closest('.classic-ltx-ruler')) return;
            event.preventDefault();
            event.stopPropagation();
            trackArea.setPointerCapture(event.pointerId);
            if (!clip) { seek(frameAt(event.clientX)); drag = { pointer: event.pointerId }; return; }
            node.ltxSelectedSegId = clip.id;
            drag = {
                pointer: event.pointerId, clip, target, edge: event.target.dataset.edge,
                x: event.clientX, start: clip.start, length: clip.length, trim: frame(clip.trimStart),
                pixelsPerFrame: trackArea.getBoundingClientRect().width / total(),
            };
            target.setAttribute('aria-pressed', 'true');
            target.focus();
        });

        trackArea.addEventListener('pointermove', event => {
            if (drag?.pointer !== event.pointerId) return;
            if (!drag.clip) { seek(frameAt(event.clientX)); return; }
            const { clip, start, length, trim, edge, target, x, pixelsPerFrame } = drag;
            const delta = Math.round((event.clientX - x) / Math.max(0.001, pixelsPerFrame));
            if (edge === 'right') clip.length = clamp(length + delta, 1, maxLength(clip));
            else if (edge === 'left') {
                const previousEnd = clipsFor(clip.type).reduce((bound, other) => other !== clip && end(other) <= start ? Math.max(bound, end(other)) : bound, 0);
                const first = clip.type === 'audio' ? Math.max(previousEnd, start - trim) : previousEnd;
                clip.start = clamp(start + delta, first, start + length - 1);
                clip.length = start + length - clip.start;
                if (clip.type === 'audio') clip.trimStart = trim + clip.start - start;
            } else clip.start = availableStart(clip, start + delta);
            place(target, clip);
        });

        function finishDrag(event) {
            if (drag?.pointer !== event.pointerId) return;
            if (drag.clip && event.type === 'pointercancel') {
                Object.assign(drag.clip, { start: drag.start, length: drag.length });
                if (drag.clip.type === 'audio') drag.clip.trimStart = drag.trim;
            }
            const moved = Boolean(drag.clip);
            drag = null;
            if (moved) { host.changed(); save(); }
        }
        trackArea.addEventListener('pointerup', finishDrag);
        trackArea.addEventListener('pointercancel', finishDrag);

        editor.addEventListener('wheel', event => {
            event.stopPropagation();
            if (event.ctrlKey && scroller.contains(event.target)) {
                event.preventDefault();
                changeZoom(event.deltaY < 0 ? 0.5 : -0.5);
            }
        }, { passive: false });

        trackArea.addEventListener('contextmenu', event => {
            if (!event.target.closest('.classic-ltx-track')) return;
            event.preventDefault();
            event.stopPropagation();
            const clipId = event.target.closest('[data-clip-id]')?.dataset.clipId;
            const clip = [...timeline.segments, ...timeline.audioSegments].find(item => item.id === clipId);
            const at = frameAt(event.clientX);
            const isAudio = Boolean(event.target.closest('.classic-ltx-audio'));
            const canPaste = clipboard && (clipboard.type === 'audio') === isAudio;
            if (clip) select(clip);
            if (menu.matches(':popover-open')) menu.hidePopover();
            menu.replaceChildren();
            const action = (caption, callback) => menu.append(button(caption, () => { menu.hidePopover(); callback(); }));
            if (clip) {
                if (!isAudio) action(label('canvas.copyPrompt'), () => {
                    root.navigator.clipboard.writeText(clip.prompt || '').catch(host.report);
                });
                const url = clip.type === 'image' && image(clip);
                if (url) {
                    action(text('CopyImage'), async () => {
                        try {
                            const response = await root.fetch(url);
                            if (!response.ok) throw new Error(text('MediaFailed'));
                            const blob = await response.blob();
                            const bitmap = await root.createImageBitmap(blob);
                            const canvas = element('canvas');
                            Object.assign(canvas, { width: bitmap.width, height: bitmap.height });
                            canvas.getContext('2d').drawImage(bitmap, 0, 0);
                            bitmap.close();
                            const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                            await root.navigator.clipboard.write([new root.ClipboardItem({ 'image/png': png })]);
                        } catch (error) { host.report(error); }
                    });
                    action(label('canvas.download'), () => {
                        const link = element('a');
                        link.href = url;
                        link.download = clip.imageFile?.split('/').pop() || 'timeline-image';
                        link.click();
                    });
                    action(text('OpenImage'), () => root.open(url, '_blank', 'noopener'));
                }
                action(text('CopyClip'), copySelected);
                if (canPaste && !clip.canvasSourceId) action(text('ReplaceClip'), () => {
                    const track = clipsFor(clip.type);
                    track.splice(track.indexOf(clip), 1);
                    pasteClip(clip.start);
                });
                if (!clip.canvasSourceId) action(text('DeleteClip'), deleteSelected);
            } else {
                if (canPaste) action(text('PasteClip'), () => pasteClip(at));
                if (!isAudio) action(text('AddText'), () => addText(at));
                action(text(isAudio ? 'AddAudio' : 'AddImage'), () => pick(isAudio ? sounds : images, at));
            }
            menu.showPopover();
            menu.style.left = Math.max(0, Math.min(event.clientX, root.innerWidth - menu.offsetWidth)) + 'px';
            menu.style.top = Math.max(0, Math.min(event.clientY, root.innerHeight - menu.offsetHeight)) + 'px';
        });

        scroller.addEventListener('dragover', event => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.stopPropagation();
        });
        scroller.addEventListener('drop', event => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            event.stopPropagation();
            upload(Array.from(event.dataTransfer.files), frameAt(event.clientX));
        });
        editor.addEventListener('paste', event => {
            if (!event.clipboardData?.files.length) return;
            event.preventDefault();
            event.stopPropagation();
            upload(Array.from(event.clipboardData.files));
        });
        editor.addEventListener('keydown', event => {
            if (event.target.closest('input,textarea,select')) return;
            const key = event.key.toLowerCase();
            const command = event.ctrlKey || event.metaKey;
            if (key === 'delete' || key === 'backspace') deleteSelected();
            else if (command && key === 'c') copySelected();
            else if (command && key === 'v' && clipboard) pasteClip();
            else if (command && key === 'd') duplicate.click();
            else if (key === 'arrowleft' || key === 'arrowright') seek(playhead + (key === 'arrowleft' ? -1 : 1));
            else if (key === 'home' || key === 'end') seek(key === 'home' ? 0 : total());
            else if (key === ' ' && event.target.tagName !== 'BUTTON') togglePlayback();
            else return;
            event.preventDefault();
            event.stopPropagation();
        });

        function stop() {
            if (animation) root.cancelAnimationFrame(animation);
            animation = 0;
            play.textContent = text('Play');
            audio.pause();
            audioClip = null;
            updatePreview();
        }

        function togglePlayback() {
            if (animation) { stop(); return; }
            const bound = playhead < duration(node) ? duration(node) : total();
            if (playhead >= bound) playhead = 0;
            const rate = fps(node);
            let startFrame = playhead;
            let startTime = root.performance.now();
            function tick(now) {
                if (!editor.isConnected) { stop(); return; }
                playhead = startFrame + (now - startTime) / 1000 * rate;
                if (playhead >= bound) {
                    playhead = bound;
                    if (!loop) { stop(); return; }
                    startFrame = playhead = 0;
                    startTime = now;
                    audioClip = null;
                }
                updatePreview();
                animation = root.requestAnimationFrame(tick);
            }
            play.textContent = text('Pause');
            animation = root.requestAnimationFrame(tick);
            updatePreview();
        }

        return {
            connected: () => editor.isConnected,
            stop,
            update(next) {
                timeline = next;
                timing();
                draw();
            },
        };
    }

    async function inspectAudio(file, frameRate) {
        const context = new root.AudioContext();
        try {
            const buffer = await context.decodeAudioData(await file.arrayBuffer());
            const samples = buffer.getChannelData(0);
            const size = Math.max(1, Math.ceil(samples.length / 96));
            const waveformPeaks = [];
            for (let start = 0; start < samples.length; start += size) {
                let peak = 0;
                for (let index = start; index < Math.min(samples.length, start + size); index++) peak = Math.max(peak, Math.abs(samples[index]));
                waveformPeaks.push(Number(peak.toFixed(3)));
            }
            return { audioDurationFrames: Math.max(1, Math.ceil(buffer.duration * frameRate)), waveformPeaks };
        } finally {
            await context.close();
        }
    }

    root.XiaomeiClassicLTX = { create };
})(typeof window === 'undefined' ? globalThis : window);
