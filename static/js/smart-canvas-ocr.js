(function (root) {
    'use strict';

    const preferenceKey = 'xiaomei_ocr_model_v1';
    const emptyHint = '选择平台和识字模型后，点击识别文字';
    const cliProtocols = new Set(['codex', 'gemini-cli']);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const edited = item => item.replacement.trim() !== '' && item.replacement.trim() !== item.text.trim();

    function recognitionPreference() {
        try {
            const saved = JSON.parse(root.localStorage.getItem(preferenceKey));
            return { provider_id: saved?.provider_id || saved?.provider || '', model: saved?.model || '' };
        } catch (_) {
            return { provider_id: '', model: '' };
        }
    }

    function regionBox(item) {
        if (!item) return null;
        const [left, top, width, height] = [item.x, item.y, item.width, item.height].map(Number);
        if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        const x = clamp(left, 0, 1);
        const y = clamp(top, 0, 1);
        const w = clamp(left + width, 0, 1) - x;
        const h = clamp(top + height, 0, 1) - y;
        return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
    }

    function resultItems(items) {
        if (!Array.isArray(items)) return [];
        return items.flatMap(item => {
            const box = regionBox(item);
            if (!box || typeof item.text !== 'string' || !item.text.trim()) return [];
            return [{ ...item, ...box, replacement: '', source_boxes: Array.isArray(item.source_boxes)
                ? item.source_boxes.flatMap(line => {
                    const bounds = regionBox(line);
                    return bounds ? [{ ...line, ...bounds }] : [];
                }) : [] }];
        });
    }

    function pixelRegions(items, width, height) {
        return items.filter(edited).map(item => {
            const x = Math.min(width - 1, Math.round(item.x * width));
            const y = Math.min(height - 1, Math.round(item.y * height));
            const w = clamp(Math.round(item.width * width), 1, width - x);
            const h = clamp(Math.round(item.height * height), 1, height - y);
            return { x, y, w, h, text: item.text, replacement: item.replacement };
        });
    }

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const { image, modal } = host;
        const panel = modal.querySelector('.image-edit-panel');
        const tools = get('imageOcrTools');
        const list = get('ocrTextList');
        const status = get('ocrStatus');
        const empty = get('ocrEmptyState');
        const count = get('ocrCountLabel');
        const name = get('ocrWorkspaceName');
        const modelSettings = get('ocrModelSettings');
        const modelToggle = get('ocrModelToggle');
        const providerSelect = get('ocrRecognitionProviderSelect');
        const visionSelect = get('ocrRecognitionModelSelect');
        const editSelect = get('ocrModelSelect');
        const modelHint = get('ocrModelHint');
        const visionHint = modelSettings.querySelector('p.ocr-model-hint');
        const recognizeButton = get('ocrRecognizeBtn');
        const recognizeLabel = recognizeButton.querySelector('span');
        const generateButton = get('ocrGenerateBtn');
        const imageLayer = get('ocrRegionLayer');
        const nodeLayer = doc.createElement('div');
        nodeLayer.className = 'ocr-node-region-layer';
        nodeLayer.setAttribute('aria-label', imageLayer.getAttribute('aria-label'));

        let entries = [];
        let active = -1;
        let revision = 0;
        let job = null;
        let submission = null;
        let gesture = null;
        let layoutFrame = 0;
        let visionChoice = null;
        let editChoice = null;
        let imageModels = [];

        function toggleModels(open = modelSettings.hidden) {
            modelSettings.hidden = !open;
            modelToggle.setAttribute('aria-expanded', String(open));
        }

        function fillSelect(select, choices, value) {
            select.replaceChildren(...choices.map(([key, label]) => new root.Option(label, key)));
            select.value = value;
        }

        function syncVisionChoices() {
            visionChoice ??= recognitionPreference();
            const providers = host.providers().filter(provider => {
                const protocol = String(provider.protocol || '').toLowerCase();
                return provider.enabled !== false && !['runninghub', 'jimeng'].includes(protocol)
                    && (cliProtocols.has(protocol) || provider.has_key !== false);
            });
            const provider = providers.find(entry => entry.id === visionChoice.provider_id);
            const models = [...new Set(provider?.chat_models || [])].filter(Boolean);
            const model = models.includes(visionChoice.model) ? visionChoice.model : '';
            fillSelect(providerSelect, [['', providers.length ? '请选择 API 平台' : '暂无可用平台'],
                ...providers.map(entry => [entry.id, entry.name || entry.id])], provider?.id || '');
            fillSelect(visionSelect, [['', !provider ? '请先选择 API 平台' : models.length ? '请选择识字模型' : '该平台暂无识字模型'],
                ...models.map(value => [value, value])], model);
            providerSelect.disabled = Boolean(job) || !providers.length;
            visionSelect.disabled = Boolean(job) || !models.length;
            const choice = model ? { provider_id: provider.id, model } : null;
            recognizeButton.disabled = !job && (!choice || Boolean(submission));
            visionHint.textContent = cliProtocols.has(String(provider?.protocol || '').toLowerCase())
                ? '当前 CLI 平台为代理式识别（先启动代理再读图），通常需要 1-3 分钟；选 OpenAI 兼容平台的视觉模型更快。'
                : '请选择支持图片输入的 API 或 CLI 模型。CLI 使用已有登录状态识字。';
            return choice;
        }

        function saveVisionChoice(model) {
            visionChoice = { provider_id: providerSelect.value, model };
            try { root.localStorage.setItem(preferenceKey, JSON.stringify(visionChoice)); } catch (_) {}
            syncVisionChoices();
        }

        function syncModels() {
            const { choices, preferred } = host.editModels();
            imageModels = choices;
            const matches = (item, selection) => selection && item.provider_id === selection.provider_id && item.model === selection.model;
            const selected = Math.max(0, choices.findIndex(item => matches(item, editChoice || preferred)));
            fillSelect(editSelect, choices.map((item, index) => [String(index), item.label]), String(selected));
            modelHint.textContent = choices[selected]?.model ? '模型列表来自当前 API 设置，可随平台配置更新' : '将沿用当前节点的画布模型';
            syncVisionChoices();
        }

        function syncActions() {
            const busy = Boolean(job);
            const totalEdited = entries.filter(edited).length;
            count.textContent = '识别 ' + entries.length + ' 组 · 已改 ' + totalEdited + ' 组';
            empty.hidden = entries.length > 0;
            generateButton.disabled = busy || Boolean(submission) || !totalEdited;
            tools.classList.toggle('is-busy', busy);
            if (busy) list.setAttribute('aria-busy', 'true');
            else list.removeAttribute('aria-busy');
            recognizeLabel.textContent = busy ? '取消识别' : '识别文字';
        }

        function setPosition(region, item) {
            Object.assign(region.style, { left: item.x * 100 + '%', top: item.y * 100 + '%',
                width: item.width * 100 + '%', height: item.height * 100 + '%' });
        }

        function paintRegions() {
            for (const layer of [imageLayer, nodeLayer]) {
                Array.from(layer.children).forEach((region, index) => {
                    const item = entries[index];
                    if (!item) return;
                    region.classList.toggle('is-active', active === index);
                    region.classList.toggle('is-edited', edited(item));
                    setPosition(region, item);
                });
            }
            Array.from(list.children).forEach((row, index) => row.classList.toggle('is-active', index === active));
        }

        function selectRegion(index, focus) {
            active = index;
            paintRegions();
            if (!focus) return;
            const field = list.children[index]?.querySelector('textarea');
            field?.focus({ preventScroll: true });
            field?.scrollIntoView({ block: 'nearest' });
        }

        function finishDrag(event) {
            if (!gesture || (event && (event.pointerId !== gesture.id || event.currentTarget !== gesture.region))) return;
            const { region, id } = gesture;
            gesture = null;
            if (region.hasPointerCapture(id)) region.releasePointerCapture(id);
        }

        function startDrag(event, item, index, layer) {
            if (event.button !== 0 || gesture || !host.active()) return;
            const bounds = layer.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            event.preventDefault();
            event.stopPropagation();
            const region = event.currentTarget;
            region.dataset.ocrDragged = 'false';
            region.setPointerCapture(event.pointerId);
            selectRegion(index, false);
            gesture = { id: event.pointerId, region, item, original: { ...item }, bounds,
                x: event.clientX, y: event.clientY, resize: Boolean(event.target.closest('[data-ocr-resize]')) };
        }

        function dragRegion(event) {
            if (gesture?.id !== event.pointerId || gesture.region !== event.currentTarget) return;
            const { region, item, original, bounds, x, y, resize } = gesture;
            const dx = event.clientX - x, dy = event.clientY - y;
            if (Math.abs(dx) + Math.abs(dy) < 3 && region.dataset.ocrDragged !== 'true') return;
            event.stopPropagation();
            region.dataset.ocrDragged = 'true';
            if (resize) {
                const maxW = 1 - original.x, maxH = 1 - original.y;
                item.width = clamp(original.width + dx / bounds.width, Math.min(maxW, 4 / (image.naturalWidth || 1000)), maxW);
                item.height = clamp(original.height + dy / bounds.height, Math.min(maxH, 4 / (image.naturalHeight || 1000)), maxH);
            } else {
                item.x = clamp(original.x + dx / bounds.width, 0, 1 - original.width);
                item.y = clamp(original.y + dy / bounds.height, 0, 1 - original.height);
            }
            const sx = item.width / original.width, sy = item.height / original.height;
            item.source_boxes = original.source_boxes.map(box => ({ ...box,
                x: item.x + (box.x - original.x) * sx, y: item.y + (box.y - original.y) * sy,
                width: box.width * sx, height: box.height * sy }));
            revision++;
            paintRegions();
        }

        function element(tag, className, text) {
            const el = doc.createElement(tag);
            if (className) el.className = className;
            if (text !== undefined) el.textContent = text;
            return el;
        }

        function makeRegion(item, index, layer) {
            const button = element('button', 'ocr-region');
            button.type = 'button';
            button.dataset.ocrRegion = index;
            button.dataset.nativeTouch = '';
            button.setAttribute('aria-label', '选择第 ' + (index + 1) + ' 组文字');
            button.title = '拖动调整位置，拖右下角调整大小';
            const handle = element('span', 'ocr-region-resize');
            handle.dataset.ocrResize = '';
            button.append(element('span', 'ocr-region-label', index + 1), handle);
            button.addEventListener('pointerdown', event => startDrag(event, item, index, layer));
            button.addEventListener('pointermove', dragRegion);
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, finishDrag);
            button.addEventListener('click', event => {
                event.stopPropagation();
                if (button.dataset.ocrDragged !== 'true' || !event.detail) selectRegion(index, true);
            });
            return button;
        }

        function makeRow(item, index) {
            const row = element('div', 'ocr-text-row');
            const label = element('label', 'ocr-row-field');
            const field = element('textarea');
            field.value = item.replacement || item.text;
            field.rows = field.value.includes('\n') || field.value.length > 22 ? 2 : 1;
            field.dataset.ocrReplacement = index;
            field.dataset.ocrOriginal = item.text;
            field.dataset.ocrEdited = String(edited(item));
            field.setAttribute('aria-label', '第 ' + (index + 1) + ' 组文字');
            field.addEventListener('focus', () => selectRegion(index, false));
            field.addEventListener('input', () => {
                item.replacement = field.value.trim() === item.text.trim() ? '' : field.value;
                field.dataset.ocrEdited = String(edited(item));
                revision++;
                syncActions();
                paintRegions();
            });
            label.append(field);
            const remove = element('button');
            remove.type = 'button';
            remove.dataset.ocrDelete = index;
            remove.title = '删除第 ' + (index + 1) + ' 组文字';
            remove.setAttribute('aria-label', remove.title);
            const icon = element('i');
            icon.dataset.lucide = 'trash-2';
            remove.append(icon);
            remove.addEventListener('click', () => {
                entries.splice(index, 1);
                active = active === index ? -1 : active > index ? active - 1 : active;
                revision++;
                render();
            });
            row.append(element('span', 'ocr-row-index', String(index + 1).padStart(2, '0')), label, remove);
            return row;
        }

        function render() {
            finishDrag();
            list.replaceChildren(...entries.map(makeRow));
            for (const layer of [imageLayer, nodeLayer]) {
                layer.replaceChildren(...entries.map((item, index) => makeRegion(item, index, layer)));
            }
            paintRegions();
            syncActions();
            if (entries.length) host.icons();
        }

        function position() {
            layoutFrame = 0;
            if (!host.active()) return;
            const { node, target } = host.anchor();
            if (!node) {
                nodeLayer.remove();
                return;
            }
            if (target && target !== nodeLayer.parentNode) target.append(nodeLayer);
            else if (!target) nodeLayer.remove();
            const box = node.getBoundingClientRect();
            const zoom = Math.max(0.1, parseFloat(root.getComputedStyle(modal).zoom) || 1);
            const gap = 12;
            const width = Math.min(360, Math.max(1, root.innerWidth - 2 * gap));
            const height = Math.min(650, Math.max(1, root.innerHeight - 2 * gap));
            const right = box.right + gap;
            const left = box.left - width - gap;
            const beside = right + width > root.innerWidth - gap && left >= gap ? left : right;
            Object.assign(panel.style, {
                width: width / zoom + 'px',
                height: height / zoom + 'px',
                left: Math.round(clamp(beside, gap, root.innerWidth - width - gap) / zoom) + 'px',
                top: Math.round(clamp(box.top - 18, gap, root.innerHeight - height - gap) / zoom) + 'px',
            });
        }

        function schedule() {
            if (!layoutFrame && host.active()) layoutFrame = root.requestAnimationFrame(position);
        }

        function finishRecognition(request, cancel = false) {
            if (request !== job) return;
            job = null;
            root.clearInterval(request.timer);
            if (cancel) request.controller.abort();
            syncVisionChoices();
            syncActions();
        }

        async function recognize() {
            if (job) {
                finishRecognition(job, true);
                status.textContent = '已取消识别';
                return;
            }
            if (!host.active() || submission) return;
            const model = syncVisionChoices();
            if (!model) {
                status.textContent = '请选择 API 平台和识字模型；暂无模型时请在 API 设置中配置';
                toggleModels(true);
                return;
            }
            const session = host.session();
            if (!session || !host.ready()) {
                status.textContent = '图片尚未加载，请稍后点击识别文字';
                return;
            }
            const controller = new root.AbortController();
            const started = Date.now();
            const request = { controller, timer: 0 };
            const current = () => job === request && host.active() && session.current();
            const elapsed = () => '正在使用 ' + model.model + ' 识别文字…（已等待 ' + Math.round((Date.now() - started) / 1000) + ' 秒';
            job = request;
            status.textContent = elapsed() + '）';
            request.timer = root.setInterval(() => {
                if (current()) status.textContent = elapsed() + '，CLI 平台可能需要 1-3 分钟）';
                else if (job === request) finishRecognition(request, true);
            }, 1000);
            syncVisionChoices();
            syncActions();
            try {
                const source = root.XiaomeiImageEditGeometry.flatten(image, []);
                const data = source.canvas.toDataURL('image/png');
                const result = await root.XiaomeiImageTaskClient.requestJson('/api/image-ocr', {
                    method: 'POST', payload: { data, filename: 'canvas-ocr.png', provider: model.provider_id, model: model.model },
                    requestInit: { signal: controller.signal },
                    fallbackMessage: 'OCR 请求失败',
                });
                if (!current()) return;
                entries = resultItems(result.items);
                active = entries.length ? 0 : -1;
                status.textContent = entries.length ? '识别到 ' + entries.length + ' 组文字，直接修改右侧内容即可' : '没有识别到可编辑文字';
                render();
                schedule();
            } catch (error) {
                if (current()) status.textContent = error?.message || 'OCR 识别失败';
            } finally {
                finishRecognition(request);
            }
        }

        async function generate() {
            if (!host.active() || job || submission || !host.ready()) return;
            const session = host.session();
            if (!session) return;
            const width = image.naturalWidth, height = image.naturalHeight;
            const regions = pixelRegions(entries, width, height);
            if (!regions.length) return;
            const model = imageModels[Number(editSelect.value)];
            const request = { revision };
            const current = () => submission === request && request.revision === revision && host.active() && session.current();
            submission = request;
            syncVisionChoices();
            syncActions();
            try {
                const mask = root.XiaomeiImageEditGeometry.surface(width, height);
                mask.context.fillStyle = '#fff';
                for (const { x, y, w, h } of regions) mask.context.fillRect(x, y, w, h);
                const blob = await root.XiaomeiImageEditGeometry.png(mask.canvas);
                if (!current()) return;
                const file = await host.upload(blob, 'ocr_text_regions_mask.png');
                if (!current()) return;
                const lines = regions.map(({ x, y, w, h, text, replacement }) =>
                    '在像素区域 ' + x + ',' + y + ',' + w + '×' + h + '，将“' + text + '”替换为“' + replacement + '”，保持原字体、字号、颜色、位置、排版和背景不变。');
                const prompt = ['编辑图1中的文字。图2是需要先抹除再重绘的原文字区域白色遮罩：', ...lines,
                    '先自然抹除图2白色区域内的原文字，再绘制替换文字。除文字替换外不要修改任何内容。'].join('\n');
                await host.publish(session, { file, width, height, model, prompt });
            } catch (error) {
                if (current()) host.error('OCR 改字失败：' + (error?.message || '请重试'));
            } finally {
                if (submission === request) {
                    submission = null;
                    syncVisionChoices();
                    syncActions();
                }
            }
        }

        function leave() {
            finishDrag();
            if (job) {
                finishRecognition(job, true);
                status.textContent = emptyHint;
            }
            submission = null;
            nodeLayer.remove();
            root.cancelAnimationFrame(layoutFrame);
            layoutFrame = 0;
            for (const property of ['left', 'top', 'width', 'height']) panel.style.removeProperty(property);
        }

        function reset() {
            leave();
            entries = [];
            active = -1;
            revision++;
            status.textContent = emptyHint;
            render();
        }

        function open() {
            const current = host.session()?.image;
            name.textContent = String(current?.name || current?.filename || 'image.png').trim() || 'image.png';
            toggleModels(true);
            syncModels();
            syncActions();
            schedule();
        }

        providerSelect.addEventListener('change', () => saveVisionChoice(''));
        visionSelect.addEventListener('change', () => saveVisionChoice(visionSelect.value));
        editSelect.addEventListener('change', () => {
            editChoice = imageModels[Number(editSelect.value)];
            revision++;
            modelHint.textContent = editChoice?.model ? '模型列表来自当前 API 设置，可随平台配置更新' : '将沿用当前节点的画布模型';
        });
        modelToggle.addEventListener('click', () => toggleModels());
        recognizeButton.addEventListener('click', recognize);
        generateButton.addEventListener('click', generate);
        return { open, leave, reset, schedule, syncModels, generate };
    }

    root.XiaomeiSmartCanvasOcr = { create };
})(window);
