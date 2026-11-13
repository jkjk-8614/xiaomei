(function (root) {
    'use strict';

    const instructionDefault = 58;
    const clampInstruction = value => Math.max(40, Math.min(400, Math.round(value)));
    function instructionHeight(node) {
        const value = Number(node?.llmInstructionHeight);
        return Number.isFinite(value) ? clampInstruction(value) : instructionDefault;
    }

    function create(host) {
        const document = host.world.ownerDocument;
        const label = host.label;
        let resize;

        function element(tag, className, ...children) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            node.append(...children);
            return node;
        }
        function icon(name) {
            const node = element('i');
            node.dataset.lucide = name;
            return node;
        }
        function button(className, name, caption) {
            const control = element('button', className, icon(name), element('span', '', caption));
            control.type = 'button';
            return control;
        }
        function textField(className, value, placeholder) {
            const field = element('textarea', 'prompt-node-control ' + className, value || '');
            field.placeholder = placeholder;
            return field;
        }
        function selectField(className, title, options) {
            const select = element('select', 'prompt-node-control ' + className);
            select.setAttribute('aria-label', title);
            select.innerHTML = options;
            return select;
        }
        const cardElement = id => host.world.querySelector(`.image-node[data-id="${root.CSS.escape(id)}"]`);

        function tools(node) {
            const base = 'prompt-node-pill prompt-node-control ';
            const template = button(base + 'prompt-preset-edit' + (host.templateOpen(node.id) ? ' active' : ''), 'library', '模板库');
            const skills = button(base + 'agent-skill-library' + (node.skillLibraryOpen ? ' active' : ''), 'archive', 'Skill 库');
            skills.setAttribute('aria-pressed', String(Boolean(node.skillLibraryOpen)));
            const install = button(base + 'agent-skill-install', 'folder-down', '安装 Skill');
            install.title = '选择包含 SKILL.md 的完整文件夹';
            const folder = element('input', 'agent-skill-folder');
            folder.type = 'file';
            folder.multiple = folder.hidden = true;
            for (const attribute of ['webkitdirectory', 'directory']) folder.setAttribute(attribute, '');
            const llm = button('prompt-node-pill prompt-llm-toggle' + (node.llmEnabled ? ' active' : ''), 'sparkles', 'LLM');
            const row = element('div', 'prompt-node-tools', template, skills, install, folder, llm);
            if (node.llmEnabled) {
                const enabled = node.llmSystemEnabled;
                row.append(button(base + 'prompt-system-toggle' + (enabled ? ' active' : ''),
                    enabled ? 'toggle-right' : 'toggle-left', label('smart.promptSystemLabel')));
            }
            const find = button(base + 'prompt-find-toggle', 'search', label('smart.promptFind'));
            find.title = label('smart.promptFindOpen');
            find.setAttribute('aria-pressed', 'false');
            row.append(find);
            const wrapper = element('div', 'prompt-node-tools-wrap', row);
            wrapper.insertAdjacentHTML('beforeend', host.skillsLibrary(node));
            return wrapper;
        }

        function appendLlmInput(card, node) {
            if (node.llmSystemEnabled) {
                const field = textField('prompt-llm-system', String(node.llmSystemPrompt || '').trim(), label('smart.promptLlmSystemPlaceholder'));
                card.append(element('label', 'prompt-node-field prompt-node-system-field',
                    element('span', '', label('smart.promptSystemLabel')), field));
            }
            const upstream = host.upstream(node);
            if (upstream.length) {
                const list = element('div', 'prompt-node-upstream-list');
                upstream.forEach((text, index) => list.append(element('div', 'prompt-node-segment',
                    element('span', '', String(index + 1)), element('p', '', text))));
                card.append(element('div', 'prompt-node-upstream',
                    element('div', 'prompt-node-section-title', label('smart.promptUpstreamText')), list));
            }
            const title = label('smart.promptInstructionLabel');
            const instruction = textField('prompt-llm-instruction', node.llmInstruction, label('smart.promptLlmInstructionPlaceholder'));
            instruction.style.height = instructionHeight(node) + 'px';
            instruction.setAttribute('aria-label', title);
            const handle = element('div', 'prompt-llm-instruction-resize prompt-node-control', element('span'));
            handle.dataset.llmInstructionResize = '1';
            handle.title = '拖动调整高度';
            card.append(element('div', 'prompt-node-field prompt-node-instruction-field',
                element('span', '', title), element('div', 'prompt-llm-instruction-wrap', instruction, handle)));
        }

        function refreshRunControls(card, node) {
            const panel = card.querySelector('.prompt-node-llm');
            if (!panel) return;
            const waiting = host.waiting(node.id);
            const status = waiting ? ['running', '等待上游节点完成']
                : node.running ? ['running', '正在运行，结果将写入输出提示词']
                : node.promptRunError ? ['error', '运行失败：' + node.promptRunError]
                : node.promptRunAt ? ['done', '已运行，结果已写入输出提示词'] : null;
            let message = panel.querySelector('.prompt-node-run-status');
            if (status) {
                if (!message) {
                    message = element('div');
                    panel.prepend(message);
                }
                message.className = 'prompt-node-run-status ' + status[0];
                if (message.textContent !== status[1]) message.textContent = status[1];
            } else {
                message?.remove();
            }
            const control = panel.querySelector('.prompt-node-run');
            const busy = waiting || host.busy(node);
            control.disabled = busy;
            const glyph = busy ? 'loader-2' : 'play';
            if (control.dataset.promptRunIcon !== glyph) {
                control.firstElementChild.replaceWith(icon(glyph));
                control.dataset.promptRunIcon = glyph;
            }
            const caption = waiting ? '等待上游' : label(node.running ? 'common.running' : 'common.run');
            if (control.lastElementChild.textContent !== caption) control.lastElementChild.textContent = caption;
        }

        function markup(node) {
            node.llmSystemEnabled = node.llmSystemEnabled === true;
            if (node.llmEnabled) host.prepare(node);
            const pick = element('button', 'node-reference-picker-entry', '从画布选择');
            pick.type = 'button';
            pick.dataset.referencePickerNode = node.id;
            const heading = element('div', 'prompt-node-top', icon('text-cursor-input'),
                element('span', '', label('smart.promptNodeTitle')), pick);
            const card = element('div', 'prompt-node-card', heading, tools(node));
            card.insertAdjacentHTML('beforeend', host.skillsChips(node) + host.thumbnails(node));
            if (node.llmEnabled) appendLlmInput(card, node);
            const output = textField('prompt-node-text', node.text, label('smart.promptPlaceholderNode'));
            output.readOnly = host.readOnly();
            card.append(element('div', 'prompt-node-field prompt-node-output-field',
                element('span', '', label('smart.promptOutputLabel')), element('div', 'prompt-text-find-host', output)));
            if (node.llmEnabled) {
                const run = button('prompt-node-run prompt-node-control', 'play', label('common.run'));
                run.dataset.promptRunIcon = 'play';
                card.append(element('div', 'prompt-node-llm', element('div', 'prompt-node-footer',
                    selectField('prompt-llm-provider', 'API 平台', host.providerOptions(node.llmProvider)),
                    selectField('prompt-llm-model', '模型', host.modelOptions(node.llmModel, node.llmProvider)),
                    run)));
                refreshRunControls(card, node);
            }
            return card.outerHTML;
        }

        function syncOutput(node) {
            const field = cardElement(node.id)?.querySelector('.prompt-node-text');
            if (field && field.value !== node.text) {
                const { selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft } = field;
                field.value = node.text;
                if (field === document.activeElement) field.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
                field.scrollTop = scrollTop;
                field.scrollLeft = scrollLeft;
            }
            host.outputEdited(node);
        }

        function beginResize(node, event) {
            if (event.button !== 0 || !host.lock(node.id)) return;
            event.preventDefault();
            event.stopPropagation();
            const startRect = host.rect(node);
            resize = {
                id: node.id, scope: host.scope(), startY: event.clientY,
                instruction: instructionHeight(node), height: host.layout(node).height,
                startRect, pushTargets: host.pushTargets(node, startRect),
            };
            document.body.classList.add('smart-node-resize', 'smart-llm-instr-resize');
            host.capture();
        }
        function moveResize(event) {
            if (!resize) return false;
            const node = host.scope() === resize.scope && host.node(resize.id);
            if (!node) {
                finishResize();
                return true;
            }
            const height = clampInstruction(resize.instruction + (event.clientY - resize.startY) / host.scale());
            node.llmInstructionHeight = height;
            node.h = Math.max(host.expandedHeight(node), resize.height + height - resize.instruction);
            node.w = Math.max(Number(node.w) || 0, 316);
            node.scale = 1;
            const field = cardElement(node.id)?.querySelector('.prompt-llm-instruction');
            if (field) field.style.height = height + 'px';
            host.pushResize(resize, node);
            return true;
        }
        function finishResize() {
            if (!resize) return;
            const start = resize;
            resize = null;
            document.body.classList.remove('smart-node-resize', 'smart-llm-instr-resize');
            const sameCanvas = host.scope() === start.scope;
            const node = sameCanvas && host.node(start.id);
            if (node && instructionHeight(node) !== start.instruction) host.commit();
            else host.discard();
            if (sameCanvas) host.unlock(start.id);
            if (node) {
                host.paint();
                host.save();
            }
        }

        function bind(card, node) {
            host.bindSkills(card, node);
            host.bindFind(card, node);
            const stop = event => event.stopPropagation();
            for (const control of card.querySelectorAll('.agent-node-control,.prompt-node-control,.prompt-node-pill')) {
                for (const type of ['mousedown', 'click', 'dblclick']) control.addEventListener(type, stop);
            }
            const bindInput = (selector, property, edited) => {
                const field = card.querySelector(selector);
                if (!field) return;
                host.scrollText(field);
                field.oninput = () => {
                    node[property] = field.value;
                    edited?.(node);
                    host.save();
                };
            };
            bindInput('.prompt-node-text', 'text', host.outputEdited);
            bindInput('.prompt-llm-system', 'llmSystemPrompt');
            bindInput('.prompt-llm-instruction', 'llmInstruction', node => { node.promptInstructionInitialized = true; });
            card.querySelector('.prompt-node-text')?.addEventListener('keydown', event => {
                if (event.key === 'Escape' && host.findOpen(node.id)) {
                    event.preventDefault();
                    stop(event);
                    host.closeFind();
                }
            });

            const click = (selector, action) => {
                const control = card.querySelector(selector);
                if (control) control.onclick = event => {
                    event.preventDefault();
                    stop(event);
                    action();
                };
            };
            const paintAndSave = () => {
                host.paint();
                host.save();
            };
            click('.prompt-preset-edit', () => host.showTemplate(node));
            click('.prompt-node-run', () => host.run(node.id));
            click('.prompt-llm-toggle', () => {
                node.llmEnabled = !node.llmEnabled;
                if (node.llmEnabled) {
                    host.prepare(node);
                    node.llmProvider = host.resolveProvider(node.llmProvider || '');
                    node.llmModel = host.resolveModel(node.llmModel || '', node.llmProvider);
                    node.h = Math.max(Number(node.h) || 0, host.expandedHeight(node));
                } else {
                    node.h = host.minHeight(node);
                }
                node.w = Math.max(Number(node.w) || 0, node.llmEnabled ? 430 : 316);
                paintAndSave();
            });
            click('.prompt-system-toggle', () => {
                const previous = Number(node.h) || 0;
                node.llmSystemEnabled = !node.llmSystemEnabled;
                if (node.llmSystemEnabled) node.h = Math.max(previous, host.expandedHeight(node));
                else if (previous <= 364) node.h = host.expandedHeight(node);
                paintAndSave();
            });
            const provider = card.querySelector('.prompt-llm-provider');
            if (provider) provider.onchange = event => {
                stop(event);
                node.llmProvider = host.resolveProvider(provider.value);
                node.llmModel = host.resolveModel('', node.llmProvider);
                paintAndSave();
            };
            const model = card.querySelector('.prompt-llm-model');
            if (model) model.onchange = event => {
                stop(event);
                node.llmModel = model.value;
                host.save();
            };
            card.querySelector('[data-llm-instruction-resize]')?.addEventListener('mousedown', event => beginResize(node, event));
        }

        return { markup, bind, refreshRunControls, syncOutput, moveResize, finishResize, resizing: () => Boolean(resize) };
    }

    root.XiaomeiSmartPromptNode = { create, instructionHeight, instructionDefault };
})(window);
