(function (global) {
    'use strict';

    const preferencesKey = 'asset_manager_local_caption_settings_v1';
    const defaultCaption = '描述图片';
    const storageFiles = { url: '/api/storage-files/', list: 'items', result: 'rel', identify: item => item.rel };
    const sources = {
        library: { url: '/api/asset-library/items/', list: 'ids', result: 'id', identify: item => item.id },
        local: { url: '/api/local-assets/', list: 'names', result: 'name', identify: item => item.file || item.id },
        upload: storageFiles,
        generated: storageFiles,
    };
    const promptInputs = { localCaptionPrompt: 'captionPrompt', localClassifyPrompt: 'classifyPrompt' };
    const controls = {
        local: { prefix: 'localup', input: 'localUploadCaptionEdit',
            placeholder: '暂无反推提示词，可以批量反推后自动写入，也可以在这里手动编辑。' },
        storage: { prefix: 'space-file', input: 'storageFileCaptionEdit', placeholder: '可反推提示词，也可以手动填写。' },
    };

    function readPreferences() {
        const defaults = { provider: '', model: '', captionPrompt: defaultCaption, classifyPrompt: '' };
        try {
            const saved = JSON.parse(global.localStorage.getItem(preferencesKey) || '{}');
            for (const field of Object.keys(defaults)) {
                if (typeof saved?.[field] === 'string') defaults[field] = saved[field];
            }
        } catch (_) {}
        return defaults;
    }

    function create(host) {
        const { request, notice, redraw } = host;
        const document = global.document.createElement('template').content.ownerDocument;
        const settings = readPreferences();
        const drafts = new Map();
        const manualWrites = new Map();
        const manualOverrides = new Set();
        const listingReads = new Set();
        const active = { files: '', library: '' };
        let expanded = false;

        function persist() {
            try {
                global.localStorage.setItem(preferencesKey, JSON.stringify({
                    ...settings, captionPrompt: settings.captionPrompt || defaultCaption,
                }));
            } catch (_) {}
        }
        function captionSettings() {
            return { caption: settings.captionPrompt, classHint: settings.classifyPrompt };
        }
        function saveCaptionSettings(changes) {
            if ('caption' in changes) settings.captionPrompt = changes.caption;
            if ('classHint' in changes) settings.classifyPrompt = changes.classHint;
            persist();
        }
        function connection() {
            const available = host.providers().filter(item =>
                item?.id && item.enabled !== false && Array.isArray(item.chat_models) && item.chat_models.some(Boolean));
            const provider = available.find(item => item.id === settings.provider) || available[0];
            const models = (provider?.chat_models || []).filter(Boolean);
            const model = models.includes(settings.model) ? settings.model : models[0];
            return { available, provider: provider?.id || '', models, model: model || '' };
        }
        function change(control) {
            if (control.id === 'localCaptionProvider') {
                settings.provider = control.value;
                settings.model = '';
                settings.model = connection().model;
            } else if (control.id === 'localCaptionModel') {
                settings.provider = connection().provider;
                settings.model = control.value;
            } else return;
            persist();
            redraw();
        }
        function input(control) {
            const field = promptInputs[control.id];
            if (field) {
                settings[field] = control.value;
                persist();
            }
            if (control.dataset.annotationDraft) drafts.set(control.dataset.annotationDraft, { text: control.value });
        }
        function toggle() {
            expanded = !expanded;
            redraw();
        }

        function tag(name, classes, label) {
            const node = document.createElement(name);
            if (classes) node.className = classes;
            if (label != null) node.textContent = label;
            return node;
        }
        function action(hook, glyph, { label, value = '', primary = false, title, disabled } = {}) {
            const node = tag('button', label ? (primary ? 'asset-btn primary' : 'asset-btn') : 'asset-icon-btn');
            node.type = 'button';
            node.setAttribute('data-' + hook, value);
            node.disabled = Boolean(disabled);
            const icon = tag('i');
            icon.dataset.lucide = glyph;
            node.append(icon);
            if (label) node.append(tag('span', '', label));
            if (title) node.title = title;
            return node;
        }
        function select(id, title, choices, selected, empty) {
            const node = tag('select', 'manage-select');
            node.id = id;
            node.title = title;
            node.disabled = choices.length === 0;
            for (const [value, label] of choices.length ? choices : [['', empty]]) {
                const option = tag('option', '', label);
                option.value = value;
                option.defaultSelected = value === selected;
                node.append(option);
            }
            return node;
        }
        function toolbar(count, kind) {
            const { available, provider, models, model } = connection();
            const section = tag('div', 'local-caption-tools');
            const row = tag('div', 'local-caption-main-row');
            const prompt = tag('input', 'local-caption-prompt-input');
            prompt.id = 'localCaptionPrompt';
            prompt.type = 'text';
            prompt.placeholder = defaultCaption;
            prompt.defaultValue = settings.captionPrompt || defaultCaption;
            const disabled = !count || !model || Boolean(active.files);
            const classifying = active.files === 'classify';
            const captioning = active.files === 'caption';
            row.append(
                select('localCaptionProvider', '平台', available.map(item => [item.id, item.name || item.id]), provider, '暂无聊天平台'),
                select('localCaptionModel', '模型', models.map(name => [name, name]), model, '暂无模型'),
                prompt,
                action(kind === 'local' ? 'local-classify-run' : 'space-file-classify', classifying ? 'loader-2' : 'tags',
                    { label: classifying ? '分类中' : '智能分类', disabled }),
                action(kind === 'local' ? 'local-caption-run' : 'space-file-caption', captioning ? 'loader-2' : 'wand-sparkles',
                    { label: captioning ? '反推中' : '提示词反推', disabled, primary: true }),
                action('local-classify-toggle', expanded ? 'chevron-up' : 'sliders-horizontal', { title: '智能分类要求' }),
            );
            section.append(row);
            if (expanded) {
                const hint = tag('textarea', 'local-classify-prompt-input', settings.classifyPrompt);
                hint.id = 'localClassifyPrompt';
                hint.placeholder = '默认已内置室内/室外、空间、主体、光影、模特、风格、色彩等分类。这里可以追加你的分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。';
                section.append(hint);
            }
            return section.outerHTML;
        }
        function identity(kind, item) {
            return JSON.stringify([kind, sources[kind].identify(item), item.url || '']);
        }
        async function readFiles(kind, load) {
            const read = { kind, changes: new Map() };
            listingReads.add(read);
            try {
                const data = await load();
                for (const item of Array.isArray(data.items) ? data.items : []) {
                    const change = read.changes.get(identity(kind, item));
                    if (!change) continue;
                    const { classification, ...caption } = change.patch;
                    Object.assign(item, caption);
                    if (classification && manualClassificationMatches(change.original, item, classification)) {
                        item.classification = classification;
                    }
                }
                return data;
            } finally {
                listingReads.delete(read);
            }
        }
        function applyResult(kind, original, current, patch) {
            if (current) Object.assign(current, patch);
            for (const read of listingReads) {
                if (read.kind !== kind) continue;
                const key = identity(kind, original);
                const earlier = read.changes.get(key);
                read.changes.set(key, {
                    original: patch.classification ? original : earlier?.original || original,
                    patch: { ...earlier?.patch, ...patch },
                });
            }
        }
        function detail(kind, item) {
            if (!host.isImage(item)) return '';
            const local = kind === 'local';
            const { prefix, input, placeholder } = controls[local ? 'local' : 'storage'];
            const key = identity(kind, item);
            const card = tag('div', 'detail-caption-card');
            const head = tag('div', 'detail-caption-head');
            const buttons = tag('div', 'detail-caption-actions');
            const captioning = local && active.files === 'caption';
            buttons.append(
                action(prefix + '-caption-one', captioning ? 'loader-2' : 'wand-sparkles',
                    { value: item.id, label: captioning ? '反推中' : '反推', disabled: active.files }),
                action(prefix + '-caption-copy', 'copy', { value: item.id, label: '复制' }),
                action(prefix + '-caption-save', 'save',
                    { value: item.id, label: '保存', primary: true, disabled: manualWrites.has(key) }),
            );
            head.append(tag('strong', '', '反推提示词'), buttons);
            const textarea = tag('textarea', 'detail-caption-textarea', drafts.get(key)?.text ?? item.caption ?? '');
            textarea.id = input;
            textarea.placeholder = placeholder;
            textarea.dataset.annotationDraft = key;
            card.append(head, textarea);
            return card.outerHTML;
        }

        function send(path, method, body) {
            return request(path, {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
        }
        function address(kind, libraryId) {
            if (kind === 'library') return { library_id: libraryId };
            return kind === 'local' ? {} : { kind };
        }
        function recordsFor(scope, originals) {
            const identify = sources[scope.kind].identify;
            const originalsByRef = new Map(originals.map(item => [identify(item), item]));
            const byRef = new Map();
            for (const record of host.records(scope)) {
                const ref = identify(record);
                const original = originalsByRef.get(ref);
                if (original && record.url === original.url) byRef.set(ref, record);
            }
            return byRef;
        }
        function captionFields(result) {
            const patch = {};
            if (typeof result.caption === 'string') patch.caption = result.caption;
            if (result.caption_file) patch.caption_file = result.caption_file;
            return patch;
        }
        function manualClassificationMatches(original, item, classification) {
            if (!item) return true;
            const manual = JSON.stringify(item.classification?.manual || {});
            return manual === JSON.stringify(original.classification?.manual || {})
                || manual === JSON.stringify(classification.manual || {});
        }
        function report(kind, operation, done, failures, single) {
            const caption = operation === 'caption';
            const label = caption ? '反推' : '分类';
            if (failures.length) {
                if (single && kind === 'local') notice(failures[0]);
                else notice(label + '完成 ' + done + ' 张，' + failures.length + ' 张失败：' + failures[0]);
            } else if (caption) {
                notice(single && kind === 'local' ? '已反推并保存当前图片提示词' : '已反推并保存 ' + done + ' 张图片提示词');
            } else if (kind === 'library' || kind === 'local') {
                notice('处理完成 ' + done + ' 张' + (kind === 'library' ? '资产图片' : '图片'));
            } else notice('已分类 ' + done + ' 张图片');
        }
        async function run(kind, operation, items, { libraryId, single = false } = {}) {
            const source = sources[kind];
            const slot = kind === 'library' ? 'library' : 'files';
            if (active[slot]) return;
            const images = [...new Map(items.filter(item => item && source.identify(item) && host.isImage(item))
                .map(item => [source.identify(item), { ...item }])).values()];
            if (!images.length) return;
            const { provider, model } = connection();
            if (!provider || !model) {
                notice('请先在 API 设置中配置可用的聊天/视觉模型');
                return;
            }
            const scope = { kind, libraryId };
            const caption = operation === 'caption';
            const prompt = caption ? settings.captionPrompt.trim() || defaultCaption : settings.classifyPrompt.trim();
            const size = caption ? 100 : 80;
            const failed = caption ? '反推失败' : '分类失败';
            const failures = [];
            let done = 0;
            active[slot] = operation;
            redraw();
            const medium = kind === 'library' ? '资产图片' : kind === 'local' ? '本地图片' : '图片';
            if (single && kind === 'local') notice('正在反推「' + (images[0].name || '本地图片') + '」的提示词...');
            else notice((caption ? '正在反推 ' : '正在智能分类 ') + images.length + ' 张' + medium + (caption ? '的提示词...' : '...'));
            try {
                for (let offset = 0; offset < images.length; offset += size) {
                    const remaining = images.slice(offset, offset + size);
                    if (caption) await Promise.all(remaining.map(item => manualWrites.get(identity(kind, item))?.catch(() => {})));
                    const batch = caption ? remaining.filter(item => {
                        const key = identity(kind, item);
                        if (!manualOverrides.has(key)) return true;
                        failures.push('分析期间提示词已修改。请刷新后重试。');
                        return false;
                    }) : remaining;
                    if (!batch.length) continue;
                    let data;
                    try {
                        data = await send(source.url + operation, 'POST', {
                            ...address(kind, libraryId), [source.list]: batch.map(source.identify), provider, model, prompt,
                        });
                    } catch (error) {
                        if (!done && !failures.length) throw error;
                        failures.push(...batch.concat(images.slice(offset + size)).map(() => error.message || failed));
                        break;
                    }
                    if (caption) await Promise.all(batch.map(item => manualWrites.get(identity(kind, item))?.catch(() => {})));
                    const live = recordsFor(scope, batch);
                    const rows = Array.isArray(data.items) ? data.items : [];
                    const results = new Map(rows.map(row => [row[source.result], row]));
                    for (const original of batch) {
                        const ref = source.identify(original);
                        const result = results.get(ref);
                        if (!result?.ok) {
                            failures.push(result?.error || failed);
                            continue;
                        }
                        done++;
                        const item = live.get(ref);
                        if (caption) {
                            const key = identity(kind, original);
                            if (!manualOverrides.has(key)) {
                                applyResult(kind, original, item, captionFields(result));
                            }
                        } else if (result.classification && manualClassificationMatches(original, item, result.classification)) {
                            applyResult(kind, original, item, { classification: result.classification });
                        }
                    }
                }
                if (done) await host.refreshFiltered(scope, operation);
                report(kind, operation, done, failures, single);
            } catch (error) {
                notice(error.message || failed);
            } finally {
                if (caption) manualOverrides.clear();
                active[slot] = '';
                redraw();
            }
        }
        async function copy(kind, item) {
            if (!item || !host.isImage(item)) return;
            const text = drafts.get(identity(kind, item))?.text ?? item.caption ?? '';
            if (!text.trim()) {
                notice('当前图片暂无可复制的提示词');
                return;
            }
            const copied = await host.copy(text);
            notice(copied ? '已复制提示词' : kind === 'local' ? '复制失败，请手动复制' : '复制失败');
        }
        async function save(kind, item) {
            if (!item || !host.isImage(item)) return;
            const key = identity(kind, item);
            if (manualWrites.has(key)) return;
            const draft = drafts.get(key);
            const caption = draft?.text ?? item.caption ?? '';
            const source = sources[kind];
            const ref = source.identify(item);
            const pending = send(source.url + 'caption', 'PATCH', { ...address(kind), [source.result]: ref, caption });
            manualWrites.set(key, pending);
            redraw();
            try {
                const result = await pending;
                const live = recordsFor({ kind }, [item]).get(ref);
                applyResult(kind, item, live, captionFields(result));
                if (active.files === 'caption') manualOverrides.add(key);
                if (drafts.get(key) === draft) drafts.delete(key);
                notice(kind === 'local' ? '已保存反推提示词' : '提示词已保存');
            } catch (error) {
                notice(error.message || '保存提示词失败');
            } finally {
                manualWrites.delete(key);
                redraw();
            }
        }

        return {
            captionSettings, saveCaptionSettings, change, input, toggle, toolbar, detail, readFiles,
            run, copy, save, classifyingLibrary: () => active.library === 'classify',
        };
    }

    global.XiaomeiAssetManagerAnnotations = { create };
}(window));
