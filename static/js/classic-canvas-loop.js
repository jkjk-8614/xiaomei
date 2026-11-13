(function (root) {
    'use strict';

    const tokens = [
        ['《计数》', '[计数]', '[Count]', 'counterToken'],
        ['《总数》', '[总数]', '[Total]', 'totalToken'],
        ['《进度》', '[进度]', '[Progress]', 'progressToken'],
    ];

    function bounded(value, max, fallback = 1) {
        const number = Math.trunc(Number(value));
        return Number.isFinite(number) && number !== 0 ? Math.max(1, Math.min(max, number)) : fallback;
    }

    const count = node => bounded(node?.count, 100);
    const start = node => bounded(node?.loopStart, 9999);
    const batch = node => bounded(node?.imageBatchSize, 100);
    const mode = node => node?.mode === 'parallel' ? 'parallel' : 'serial';

    function rounds(node) {
        if (!node) return [null];
        const total = count(node);
        const first = start(node);
        const stride = node.imageInput ? batch(node) : 1;
        const end = first + (total - 1) * stride;
        return Array.from({ length: total }, (_, ordinal) => ({
            ordinal: ordinal + 1, index: first + ordinal * stride, total: end,
            text: new Map(), media: new Map(),
        }));
    }

    async function dispatch(queue, concurrency, run) {
        const failures = [];
        let offset = 0;
        async function worker() {
            while (!failures.length && offset < queue.length) {
                const round = queue[offset++];
                try {
                    await run(round);
                } catch (error) {
                    failures.push(error);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        return { failures, remaining: queue.slice(offset) };
    }

    function element(tag, classes, caption) {
        const el = root.document.createElement(tag);
        if (classes) el.className = classes;
        if (caption != null) el.textContent = caption;
        return el;
    }

    function button(classes, caption, click, icon) {
        const el = element('button', classes);
        el.type = 'button';
        if (icon) {
            const image = element('i', 'w-3.5 h-3.5');
            image.dataset.lucide = icon;
            el.append(image);
        }
        el.append(element('span', '', caption));
        el.addEventListener('click', event => { event.stopPropagation(); click(); });
        return el;
    }

    function create(host) {
        const label = key => host.label('canvas.' + key);
        const format = (key, values) => host.format('canvas.' + key, values);
        const clean = value => String(value || '').trim();

        function newNode({ x, y }) {
            return {
                id: host.id('loop'), type: 'loop', x, y, count: 3, mode: 'serial',
                showPrompt: false, imageInput: false, loopStart: 1, imageBatchSize: 1, variablePrompt: '',
            };
        }

        function promptItems(node, round, visited) {
            return host.incoming(node.id).flatMap(source => {
                switch (source.type) {
                    case 'prompt': return [source.text];
                    case 'promptGroup': return host.groupPrompts(source);
                    case 'loop': return [prompt(source, round, visited)];
                    case 'llm': return [round?.text.get(source.id) ?? source.outputText];
                    default: return [];
                }
            }).map(clean).filter(Boolean);
        }

        function prompt(node, round, visited = new Set()) {
            if (!node?.showPrompt || visited.has(node.id)) return '';
            visited.add(node.id);
            const items = promptItems(node, round, visited);
            visited.delete(node.id);
            const index = round?.index ?? start(node);
            const total = round?.total ?? count(node);
            const values = [index, total, index + '/' + total];
            let result = items.length ? items[(index - 1) % items.length] : clean(node.variablePrompt);
            tokens.forEach(([canonical, chinese, english], at) => {
                for (const key of [canonical, chinese, english]) result = result.replaceAll(key, String(values[at]));
            });
            return result;
        }

        function images(node, round) {
            if (!node.imageInput) return [];
            const first = (round?.index ?? start(node)) - 1;
            return host.incoming(node.id).flatMap(source => host.media(source, round))
                .filter(ref => ref.kind === 'image' && ref.url).slice(first, first + batch(node));
        }

        function numberField(classes, name, value, max, change) {
            const labelEl = element('label', 'loop-count-label', name);
            const input = element('input', 'loop-count-input' + (classes ? ' ' + classes : ''));
            Object.assign(input, { type: 'number', min: 1, max, step: 1, value });
            input.setAttribute('aria-label', name);
            input.addEventListener('input', () => {
                if (input.value !== '') change(bounded(input.value, max));
            });
            input.addEventListener('change', () => {
                input.value = bounded(input.value, max);
                change(Number(input.value));
            });
            return { label: labelEl, input };
        }

        function chip(token) {
            const entry = tokens.find(item => item[0] === token);
            const tag = element('span', 'loop-token-chip');
            tag.contentEditable = 'false';
            tag.dataset.token = token;
            const remove = button('', '×', () => {
                const editor = tag.parentElement.closest('.loop-variable-editor');
                tag.remove();
                editor.dispatchEvent(new root.Event('input', { bubbles: true }));
            });
            remove.title = host.label('common.delete');
            remove.setAttribute('aria-label', remove.title);
            tag.append(element('span', '', label(entry[3])), remove);
            return tag;
        }

        function readPrompt(editor) {
            function read(parent) {
                let result = '';
                for (const child of parent.childNodes) {
                    if (child.nodeType === root.Node.TEXT_NODE) result += child.nodeValue;
                    else if (child.nodeType === root.Node.ELEMENT_NODE) {
                        if (child.matches('.loop-token-chip')) result += child.dataset.token;
                        else if (child.tagName === 'BR') result += '\n';
                        else {
                            if (/^(DIV|P)$/.test(child.tagName) && result && !result.endsWith('\n')) result += '\n';
                            result += read(child);
                        }
                    }
                }
                return result;
            }
            return read(editor).replace(/\u00a0/g, ' ');
        }

        function insertAtCursor(editor, ...children) {
            editor.focus();
            const selection = root.getSelection();
            if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
                editor.append(...children);
                return;
            }
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const fragment = root.document.createDocumentFragment();
            fragment.append(...children);
            range.insertNode(fragment);
            range.setStartAfter(children.at(-1));
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        function togglePanel(node, key) {
            node[key] = !node[key];
            const panels = Number(Boolean(node.showPrompt)) + Number(Boolean(node.imageInput));
            node.w = Math.max(336, Number(node.w) || 0);
            if (!panels) delete node.h;
            else node.h = panels === 2 ? 390 : node.showPrompt ? 330 : 320;
            host.panelsChanged(node);
        }

        function render(node) {
            const card = element('div', 'loop-body classic-loop');
            const controls = element('div', 'loop-count-row');
            const row = element('div', 'loop-run-row');
            const countGroup = element('div', 'loop-count-group');
            const target = host.target(node.id);
            const cascade = element('div', 'gen-run-row');
            let runButton;
            let imageHint;
            const starts = [];
            const runText = () => format('loopRun', { nodes: host.orderSize(target) || 1, count: count(node) });
            const changed = () => {
                host.changed();
                host.refreshConsumers();
            };
            const counter = numberField('', label('loopCount'), count(node), 100, value => {
                node.count = value;
                if (runButton && !host.active(target)) runButton.lastElementChild.textContent = runText();
                host.refreshTarget(target);
                changed();
            });
            countGroup.append(counter.label, counter.input);
            const modes = element('div', 'seg loop-mode');
            for (const [name, text] of [['serial', 'loopSerial'], ['parallel', 'loopParallel']]) {
                const option = button(name === mode(node) ? 'active' : '', label(text), () => {
                    node.mode = name;
                    host.changed();
                    host.refresh(node.id);
                });
                option.dataset.loopMode = name;
                option.setAttribute('aria-pressed', String(name === mode(node)));
                modes.append(option);
            }
            row.append(countGroup, modes);
            const toggles = element('div', 'loop-toggle-row');
            for (const [key, classes, text, icon] of [
                ['imageInput', 'loop-image-toggle', 'loopImageToggle', 'image'],
                ['showPrompt', 'loop-prompt-toggle', 'loopPromptToggle', 'text-cursor-input'],
            ]) {
                const toggle = button('loop-toggle ' + classes + (node[key] ? ' active' : ''), label(text), () => togglePanel(node, key), icon);
                toggle.setAttribute('aria-pressed', String(Boolean(node[key])));
                toggles.append(toggle);
            }
            controls.append(row, toggles);
            card.append(controls);

            function updateHint() {
                if (!imageHint) return;
                const size = images(node).length;
                imageHint.textContent = size ? format('loopImageWillOutput', { n: size }) : label('loopImageEmpty');
            }

            function startField(className, key) {
                const field = numberField(className, label(key), start(node), 9999, value => {
                    node.loopStart = value;
                    for (const input of starts) if (input !== field.input) input.value = value;
                    updateHint();
                    changed();
                });
                starts.push(field.input);
                return field;
            }

            if (node.imageInput) {
                const panel = element('div', 'loop-image-panel');
                const fields = element('div', 'loop-image-row');
                const first = startField('loop-image-start-input', 'loopImageStart');
                const size = numberField('loop-batch-input', label('loopBatchSize'), batch(node), 100, value => {
                    node.imageBatchSize = value;
                    updateHint();
                    changed();
                });
                imageHint = element('div', 'loop-image-hint loop-image-hint-only');
                updateHint();
                fields.append(first.label, first.input, size.label, size.input);
                panel.append(fields, imageHint);
                card.append(panel);
            }

            if (node.showPrompt) {
                const panel = element('div', 'loop-prompt-panel');
                const field = element('div', 'loop-field');
                const total = promptItems(node, null, new Set([node.id])).length;
                const editor = element('div', 'loop-variable-editor');
                editor.contentEditable = String(!total);
                editor.dataset.placeholder = label('loopVariablePlaceholder');
                editor.setAttribute('role', 'textbox');
                editor.setAttribute('aria-multiline', 'true');
                editor.setAttribute('aria-label', label('loopVariablePrompt'));
                editor.setAttribute('aria-readonly', String(Boolean(total)));
                for (const part of String(node.variablePrompt || '').split(/(《计数》|《总数》|《进度》)/)) {
                    if (part) editor.append(tokens.some(item => item[0] === part) ? chip(part) : root.document.createTextNode(part));
                }
                const storePrompt = () => { node.variablePrompt = readPrompt(editor); changed(); };
                editor.addEventListener('input', storePrompt);
                editor.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
                editor.addEventListener('paste', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    const text = event.clipboardData?.getData('text/plain');
                    if (text) { insertAtCursor(editor, root.document.createTextNode(text)); storePrompt(); }
                });
                field.append(editor);
                panel.append(field);
                if (total) {
                    panel.classList.add('has-upstream');
                    editor.classList.add('is-disabled');
                    panel.append(element('div', 'loop-prompt-hint', format('loopUpstreamPrompts', { n: total })));
                }
                const toolbar = element('div', 'loop-start-row');
                const addCounter = button('loop-token-btn loop-counter-token-btn', label('counterToken'), () => {
                    insertAtCursor(editor, chip('《计数》'), root.document.createTextNode(' '));
                    storePrompt();
                });
                addCounter.dataset.token = '《计数》';
                addCounter.disabled = Boolean(total);
                const first = startField('loop-start-input', 'loopStart');
                toolbar.append(addCounter, first.label, first.input);
                panel.append(toolbar);
                card.append(panel);
            }

            if (target) {
                const running = host.active(target);
                const stopping = host.stopping(target);
                runButton = button('gen-cascade-btn' + (running ? ' gen-cascade-stop' : ''),
                    running ? label(stopping ? 'cascadeStopping' : 'cascadeStop') : runText(),
                    () => running ? host.stop(target) : host.run(target), running ? 'square' : 'play-circle');
                runButton.dataset[running ? 'loopCascadeStop' : 'loopCascade'] = target;
                runButton.disabled = stopping;
                cascade.append(runButton);
                card.append(cascade);
            }
            return card;
        }

        return { newNode, prompt, images, render };
    }

    root.XiaomeiClassicLoop = { create, count, mode, rounds, dispatch };
})(typeof window === 'undefined' ? globalThis : window);
