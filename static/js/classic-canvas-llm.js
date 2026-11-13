(function (root) {
    'use strict';

    const systemDefault = 'You are a helpful assistant.';
    const promptDefault = 'You are a helpful assistant. Rewrite the input into a concise image prompt.';
    const paneMinimum = 70;
    const history = node => Array.isArray(node.messages) ? node.messages : [];
    const height = (value, fallback) => Math.max(paneMinimum, Number(value) || fallback);

    function element(tag, classes, value) {
        const el = root.document.createElement(tag);
        if (classes) el.className = classes;
        if (value != null) el.textContent = value;
        return el;
    }

    function button(classes, caption, action, symbol) {
        const el = element('button', classes);
        el.type = 'button';
        if (symbol) {
            const icon = element('i', 'w-4 h-4');
            icon.dataset.lucide = symbol;
            el.append(icon);
        }
        if (caption) el.append(caption);
        el.addEventListener('click', event => {
            event.stopPropagation();
            action();
        });
        return el;
    }

    function dropdown(classes, caption, choices, selected, update) {
        const select = element('select', 'select-lite ' + classes);
        select.setAttribute('aria-label', caption);
        for (const [id, title] of choices) {
            const option = element('option', '', title);
            option.value = id;
            select.append(option);
        }
        select.value = selected;
        select.addEventListener('change', () => update(select.value));
        return select;
    }

    function isolateScroll(el) {
        el.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        return el;
    }

    function create(host) {
        const label = key => host.label('canvas.' + key);
        const active = new Map();
        let catalog = [];
        const keyFor = node => JSON.stringify([host.canvasId(), node.id]);

        function setProviders(providers) {
            catalog = providers.filter(item => item?.id && item.enabled !== false
                && !/modelscope/i.test(item.id + ' ' + (item.name || '')) && Array.isArray(item.chat_models))
                .map(item => ({
                    id: item.id, title: item.name || item.id,
                    models: [...new Set(item.chat_models.filter(value => typeof value === 'string' && value.trim()))],
                })).filter(item => item.models.length);
        }

        function selection(node) {
            const id = node.llmProvider || catalog[0]?.id || '';
            const provider = catalog.find(item => item.id === id);
            return { id, provider, model: node.model || provider?.models[0] || '' };
        }

        function newNode({ x, y }) {
            const { id, model } = selection({});
            return {
                id: host.id('llm'), type: 'llm', x, y, llmProvider: id, model, mode: 'node',
                systemPrompt: promptDefault, chatInput: '', messages: [], outputText: '',
                llmInputHeight: 110, llmOutputHeight: 150,
            };
        }

        function commit(node, patch, repaint = false) {
            Object.assign(node, patch);
            host.changed();
            if (repaint) host.refresh(node.id);
        }

        function run(node, options = {}) {
            const chat = options.chat === true;
            const key = keyFor(node);
            if (!options.cascade && active.has(key)) return active.get(key).promise;
            const previous = history(node).slice();
            const documentId = host.canvasId();
            const live = () => {
                const current = host.getNode(node.id);
                return host.canvasId() === documentId && current?.type === 'llm' ? current : null;
            };
            const input = host.input(node, options.round);
            const draft = String(node.chatInput || '');
            const message = chat ? draft.trim() : input.text || node.userInput || '';
            const { id, provider, model } = selection(node);
            const pending = { draft, message: chat ? message : '' };
            const promise = Promise.resolve().then(async () => {
                let sent = false;
                try {
                    if (!String(message).trim()) {
                        if (chat) return;
                        throw new Error(label('needPromptToLLM'));
                    }
                    if (!provider?.models.includes(model)) throw new Error(label('llmChooseConfigured'));
                    Object.assign(node, { llmProvider: id, model });
                    if (!options.cascade) {
                        node.running = true;
                        host.refresh(node.id);
                    }
                    sent = true;
                    const result = await host.submit({
                        message, model, provider: id, system_prompt: node.systemPrompt || systemDefault,
                        messages: chat ? previous : [], images: input.images, videos: input.videos,
                    }, options);
                    const current = live();
                    if (!current) return;
                    const output = typeof result?.text === 'string' ? result.text : '';
                    if (chat) {
                        current.messages = [...history(current), { role: 'user', content: message }, { role: 'assistant', content: output }];
                        if (current.chatInput === draft) current.chatInput = '';
                    }
                    if (options.round) options.round.text.set(current.id, output);
                    current.outputText = output;
                    current.runStatus = 'done';
                    current.runError = '';
                    host.changed();
                    host.refreshConsumers();
                } catch (error) {
                    const current = live();
                    if (current && !host.isAbort(error)) {
                        if (chat && sent && !current.chatInput) current.chatInput = message;
                        current.runStatus = 'failed';
                        current.runError = error.message || label('llmFailed');
                        if (chat && sent) host.changed();
                        if (!options.cascade) host.message(current.runError, label('llmFailed'));
                    }
                    if (options.cascade) throw error;
                }
            }).finally(() => {
                if (!options.cascade) active.delete(key);
                const current = live();
                if (current) {
                    if (!options.cascade) current.running = false;
                    host.refresh(current.id);
                }
            });
            if (!options.cascade) active.set(key, Object.assign(pending, { promise }));
            return promise;
        }

        function copyControl(classes, value) {
            const control = button(classes, '', async () => {
                const text = value();
                if (text && await host.copy(text)) {
                    control.classList.add('copied');
                    root.setTimeout(() => control.classList.remove('copied'), 1500);
                }
            }, 'copy');
            control.title = label('llmCopy');
            control.setAttribute('aria-label', control.title);
            return control;
        }

        function composeText(classes, value, name, onInput) {
            const field = isolateScroll(element('textarea', classes));
            field.value = value || '';
            field.placeholder = name;
            field.setAttribute('aria-label', name);
            if (onInput) field.addEventListener('input', () => onInput(field.value));
            return field;
        }

        function installResize(handle, node, input, output) {
            let drag;
            const update = (target, total) => {
                const inputHeight = Math.round(Math.max(paneMinimum, Math.min(total - paneMinimum, target)));
                const outputHeight = total - inputHeight;
                node.llmInputHeight = inputHeight;
                node.llmOutputHeight = outputHeight;
                for (const [el, pixels] of [[input, inputHeight], [output, outputHeight]]) {
                    el.style.height = pixels + 'px';
                    el.style.flex = '0 0 ' + pixels + 'px';
                }
            };
            update(height(node.llmInputHeight, 110), height(node.llmInputHeight, 110) + height(node.llmOutputHeight, 150));
            handle.title = label('resizePanes');
            handle.setAttribute('aria-label', handle.title);
            handle.setAttribute('role', 'separator');
            handle.dataset.nativeTouch = '';
            handle.tabIndex = 0;
            handle.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                drag = { id: event.pointerId, y: event.clientY, start: node.llmInputHeight, total: node.llmInputHeight + node.llmOutputHeight };
                handle.setPointerCapture(event.pointerId);
            });
            handle.addEventListener('pointermove', event => {
                if (drag?.id === event.pointerId) update(drag.start + (event.clientY - drag.y) / host.scale(), drag.total);
            });
            handle.addEventListener('lostpointercapture', () => {
                if (!drag) return;
                drag = undefined;
                host.changed();
            });
            handle.addEventListener('keydown', event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                event.stopPropagation();
                update(node.llmInputHeight + (event.key === 'ArrowUp' ? -10 : 10), node.llmInputHeight + node.llmOutputHeight);
                host.changed();
            });
        }

        function nodePane(node, input, busy) {
            const pane = element('div', 'llm-node-pane');
            const inputLabel = element('div', 'llm-pane-label llm-input-label', label(input.text ? 'llmConnectedInput' : 'llmInput'));
            const editor = composeText('llm-input-area llm-input-output', input.text || node.userInput, label('llmInputHint'), value => commit(node, { userInput: value }));
            editor.readOnly = Boolean(input.text);
            const resizer = element('div', 'llm-pane-resizer');
            const output = element('div', 'llm-output-wrap');
            const result = isolateScroll(element('div', 'llm-output llm-result-output', node.outputText || label('llmOutputEmpty')));
            output.append(copyControl('llm-copy-btn llm-output-copy', () => node.outputText), result);
            installResize(resizer, node, editor, output);
            const actions = element('div', 'gen-run-row mt-2');
            const launch = button('llm-run' + (busy ? ' running' : ''), label(busy ? 'running' : 'llmRun'), () => host.runNode(node.id), 'play');
            launch.disabled = busy;
            actions.append(launch);
            pane.append(inputLabel, editor, resizer, element('div', 'llm-pane-label', label('llmOutput')), output, actions);
            host.addControls(pane, actions, node);
            return pane;
        }

        function chatPane(node, busy) {
            const pane = element('div', 'llm-chat-pane');
            const log = isolateScroll(element('div', 'llm-chat-log'));
            const messages = history(node).slice();
            const pending = node.running && active.get(keyFor(node));
            if (pending?.message) messages.push({ role: 'user', content: pending.message });
            if (!messages.length) log.append(element('div', 'text-[11px] text-gray-300', label('startChat')));
            messages.forEach((item, index) => {
                const bubble = element('div', 'llm-bubble ' + (item?.role === 'user' ? 'user' : 'assistant'), item?.content || '');
                bubble.dataset.msgIdx = index;
                if (item?.role === 'assistant') bubble.append(copyControl('llm-bubble-copy', () => item.content));
                log.append(bubble);
            });
            const draft = pending?.message && node.chatInput === pending.draft ? '' : node.chatInput;
            const entry = composeText('llm-chat-input mt-2', draft, label('chatInput'), value => commit(node, { chatInput: value }));
            entry.rows = 2;
            const send = () => run(node, { chat: true });
            entry.addEventListener('keydown', event => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                event.stopPropagation();
                if (!busy) send();
            });
            const launch = button('llm-run mt-2', label(busy ? 'sending' : 'llmSend'), send, 'send');
            launch.disabled = busy;
            pane.append(log, entry, launch);
            return pane;
        }

        function updateInput(card, node, input = host.input(node)) {
            const badge = card.querySelector('.classic-llm-media');
            badge.hidden = !input.images.length && !input.videos.length;
            badge.lastElementChild.textContent = label('llmConnectedMedia')
                .replace('{images}', input.images.length).replace('{videos}', input.videos.length);
            const editor = card.querySelector('.llm-input-output');
            if (!editor) return;
            const caption = card.querySelector('.llm-input-label');
            editor.readOnly = Boolean(input.text);
            caption.textContent = label(input.text ? 'llmConnectedInput' : 'llmInput');
            const value = input.text || node.userInput || '';
            if (editor.value !== value) editor.value = value;
        }

        function render(node) {
            const card = element('div', 'llm-body classic-llm');
            const header = element('div', 'llm-row');
            const { id, provider, model } = selection(node);
            const platformOptions = catalog.map(item => [item.id, item.title]);
            const modelOptions = (provider?.models || []).map(item => [item, item]);
            const unavailable = label('llmUnavailable');
            if (!provider) platformOptions.unshift([id, id ? id + ' · ' + unavailable : label('provider')]);
            if (!provider?.models.includes(model)) modelOptions.unshift([model, model ? model + ' · ' + unavailable : label('noModelsHint')]);
            const platform = dropdown('llm-provider-select', label('provider'), platformOptions, id, next => {
                const choice = catalog.find(item => item.id === next);
                if (choice) commit(node, { llmProvider: next, model: choice.models[0] }, true);
            });
            platform.style.flex = '1';
            const models = dropdown('llm-model', label('llmModel'), modelOptions, model, next => commit(node, { llmProvider: id, model: next }));
            const tabs = element('div', 'llm-mode');
            const chat = node.mode === 'chat';
            for (const [mode, name, selected] of [['node', 'nodeMode', !chat], ['chat', 'chatMode', chat]]) {
                const control = button(selected ? 'active' : '', label(name), () => commit(node, { mode }, true));
                control.dataset.mode = mode;
                control.setAttribute('aria-pressed', String(selected));
                tabs.append(control);
            }
            const system = button('llm-sys-toggle' + (node.showSystem ? ' active' : ''), label('llmSystem'), () => commit(node, { showSystem: !node.showSystem }, true));
            header.append(platform, models, tabs, system);
            card.append(header);

            const input = host.input(node);
            const badge = element('div', 'classic-llm-media');
            const mediaIcon = element('i', 'w-3 h-3');
            mediaIcon.dataset.lucide = input.videos.length && !input.images.length ? 'video' : 'image';
            badge.append(mediaIcon, element('span'));
            card.append(badge);
            if (node.showSystem) card.append(composeText('llm-system', node.systemPrompt, label('systemPrompt'), value => commit(node, { systemPrompt: value })));
            const busy = Boolean(node.running || active.has(keyFor(node)) || host.isCascadeBusy(node.id));
            card.append(chat ? chatPane(node, busy) : nodePane(node, input, busy));
            updateInput(card, node, input);
            return card;
        }

        return { setProviders, newNode, render, updateInput, run };
    }

    root.XiaomeiClassicLLM = { create };
})(window);
