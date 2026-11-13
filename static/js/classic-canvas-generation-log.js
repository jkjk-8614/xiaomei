(function (root) {
    'use strict';

    const workflowLabels = {
        'z-image.json': 'comfyText',
        'z-image-enhance.json': 'comfyEnhance',
        'upscale.json': 'comfyEnhance',
        'flux2-klein.json': 'comfyEdit',
    };

    function duration(ms) {
        const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return minutes ? minutes + 'm ' + String(rest).padStart(2, '0') + 's' : rest + 's';
    }

    function snapshot(node, prompt, refs = []) {
        const { comfyRuns, rhRuns, ltxRuns, running, runStatus, runError, inputs, ...settings } = node || {};
        return {
            nodeType: settings.type || '',
            node: JSON.parse(JSON.stringify(settings)),
            prompt: prompt || '',
            refs: (refs || []).filter(ref => ref?.url).map(({ url, name }) => ({ url, name: name || 'image' })),
        };
    }

    function requestMeta(result = {}) {
        const { raw, params } = result;
        const payload = Array.isArray(raw?.data) ? raw.data[0] : raw?.data;
        return {
            task_id: result.task_id || raw?.task_id || payload?.task_id || '',
            request_id: result.request_id || result.id || raw?.id || '',
            provider_id: result.provider_id || params?.provider_id || '',
            backend: result.backend || '',
            prompt_id: result.prompt_id || '',
            workflow_json: result.workflow_json || '',
            seed: result.seed || '',
        };
    }

    function element(tag, className, text) {
        const node = root.document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function create(host) {
        const { modal, list, trigger } = host;
        const label = key => host.label('canvas.' + key);

        function describeRun(run) {
            const type = run?.nodeType;
            const { apiProvider, model } = run?.node || {};
            const task = run?.taskLabel;
            switch (type) {
                case 'generator':
                case 'video': {
                    const image = type === 'generator';
                    const provider = host.providers().find(item => item.id === apiProvider);
                    return { platform: provider?.name || apiProvider || (image ? 'API' : 'Video'),
                        model: task || model || (image ? 'API Image' : 'Video') };
                }
                case 'comfy':
                    return { platform: 'ComfyUI', model: task || host.comfyTitle(run.node || {}) };
                case 'ltxDirector':
                    return { platform: 'ComfyUI', model: task || label('ltxDirector') };
                case 'msgen':
                    return { platform: apiProvider || '', model: task || model || '' };
                default:
                    return { platform: type || 'Generate', model: task || type || 'Generate' };
            }
        }

        function record({ run, outputs = [], runMs = 0, error = '' }) {
            const canvas = host.canvas();
            if (!canvas) return;
            const items = (outputs || []).filter(Boolean);
            const entry = {
                id: host.id('log'),
                createdAt: Date.now(),
                status: error ? 'failed' : 'success',
                ...describeRun(run),
                nodeType: run?.nodeType || '',
                request: run?.request || {},
                prompt: run?.prompt || '',
                outputs: items,
                refs: run?.refs || [],
                runMs: Number(runMs || 0),
                error: error ? String(error) : '',
            };
            const previous = Array.isArray(canvas.logs) ? canvas.logs : [];
            canvas.logs = [entry, ...previous.slice(0, 499)];
            if (!error && items.some(host.outputUrl)) root.XiaomeiGenerationChime.play();
        }

        function copyLine(className, value, placeholder = '') {
            const text = String(value || '');
            const initial = text || placeholder;
            const line = element('div', className, initial);
            line.title = initial;
            let restore;
            line.onclick = async () => {
                const copied = await host.copy(text);
                if (!line.isConnected) return;
                root.clearTimeout(restore);
                line.textContent = label(copied ? 'copied' : 'copyFailed');
                line.classList.toggle('copied', copied);
                restore = root.setTimeout(() => {
                    line.textContent = initial;
                    line.classList.remove('copied');
                }, 900);
            };
            return line;
        }

        function thumbnails(outputs) {
            const strip = element('div', 'log-thumbs');
            for (const item of outputs.slice(0, 8)) {
                const url = host.outputUrl(item);
                if (!url) continue;
                if (!host.missing(url)) {
                    strip.insertAdjacentHTML('beforeend', host.thumbnail(item, url));
                    continue;
                }
                const missing = element('div', 'missing-asset compact');
                missing.dataset.url = url;
                const icon = element('i', 'w-4 h-4');
                icon.dataset.lucide = 'image-off';
                missing.append(icon);
                strip.append(missing);
            }
            return strip;
        }

        function renderEntry(log, locale) {
            const failed = log.status === 'failed';
            const request = log.request || {};
            const workflow = request.workflow_json || request.workflow || '';
            const taskId = request.task_id || request.taskId || request.prompt_id || request.promptId;
            const id = taskId || request.request_id || request.requestId || request.id;
            const outputs = Array.isArray(log.outputs) ? log.outputs : [];
            let model = log.model || '-';
            if (log.platform === 'ComfyUI' && workflow) {
                const key = workflowLabels[String(workflow).toLowerCase()];
                model = typeof key === 'string' ? label(key) : workflow;
            }
            const row = element('div', failed ? 'log-item failed' : 'log-item');
            const main = element('div', 'log-main');
            const tags = element('div', 'log-meta');
            tags.append(element('span', 'log-chip ' + (failed ? 'status-failed' : 'status-ok'), label(failed ? 'failed' : 'success')));
            for (const value of [log.platform || '-', model, duration(log.runMs)]) {
                tags.append(element('span', 'log-chip', value));
            }
            const metadata = element('div', 'log-subline');
            const values = [
                new Date(log.createdAt || Date.now()).toLocaleString(locale),
                host.format('canvas.logOutputCount', { count: outputs.length }),
                id ? 'ID ' + id : '',
                workflow || request.backend || request.provider_id || request.providerId,
            ];
            for (const value of values.filter(Boolean)) {
                const part = element('span', '', value);
                part.title = value;
                metadata.append(part);
            }
            main.append(tags, metadata);
            if (log.error) main.append(copyLine('log-error', log.error));
            main.append(copyLine('log-prompt', log.prompt, label('noPromptMeta')));
            row.append(main, thumbnails(outputs));
            return row;
        }

        function render() {
            const logs = host.canvas()?.logs;
            const locale = host.english() ? 'en-US' : 'zh-CN';
            const rows = Array.isArray(logs) ? logs.filter(Boolean).map(log => renderEntry(log, locale)) : [];
            list.replaceChildren(...(rows.length ? rows : [element('div', 'log-empty', label('noLogs'))]));
            host.bindThumbnails(list);
            host.icons();
        }

        function close() { modal.classList.remove('open'); }

        trigger.addEventListener('click', () => {
            modal.classList.add('open');
            render();
        });
        modal.addEventListener('click', event => {
            if (event.target === modal || event.target.closest('[data-log-close]')) close();
        });
        list.addEventListener('click', event => {
            const media = event.target.closest('.log-thumbs [data-url]');
            if (media) host.openMedia(media.dataset.url);
        });

        return { record, isOpen: () => modal.classList.contains('open') };
    }

    root.XiaomeiClassicGenerationLog = { create, duration, snapshot, requestMeta };
})(window);
