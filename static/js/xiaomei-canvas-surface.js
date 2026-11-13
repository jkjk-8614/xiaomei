/* Classic canvas menus, node frames and ports. */
(function (root) {
    'use strict';

    var SOURCE_OUT_TYPES = ['image', 'prompt', 'loop', 'group', 'promptGroup', 'llm', 'output'];
    var CREATE_ITEMS = [
        ['image', 'image-plus', 'canvas.imageCard', '上传节点'],
        ['prompt', 'text-cursor-input', 'canvas.prompt', '提示词'],
        ['loop', 'repeat-2', 'canvas.loopNode', '循环节点'],
        ['llm', 'message-square-text', 'canvas.llmNode', 'LLM 节点'],
        ['generator', 'wand-sparkles', 'canvas.apiGenerate', 'API生成'],
        ['video', 'clapperboard', 'canvas.videoGenerateNode', '视频生成'],
        ['rh', 'workflow', 'canvas.rhGenerate', 'RH生成'],
        ['output', 'circle-dot', '', 'Output']
    ];
    var STATUS_LABELS = { queued: '排队中', running: '运行中', done: '完成', failed: '失败' };
    var FRAME_TITLES = {
        image: 'Image',
        prompt: 'Prompt',
        promptGroup: 'Prompts',
        group: 'Group',
        output: 'Output',
        llm: 'LLM',
        comfy: 'ComfyUI',
        rh: 'RunningHub'
    };

    function doc() {
        return root.document;
    }

    function el(tag, className) {
        var node = doc().createElement(tag);
        if (className) node.className = className;
        return node;
    }

    function icon(name, className) {
        var node = el('i', className || 'w-4 h-4');
        node.dataset.lucide = name;
        return node;
    }

    function menuButton(item) {
        var button = el('button', 'menu-btn');
        button.type = 'button';
        if (item.disabled) button.disabled = true;
        if (item.title) button.title = item.title;
        Object.keys(item.dataset || {}).forEach(function (key) {
            button.dataset[key] = item.dataset[key];
        });
        if (item.icon) button.append(icon(item.icon, item.iconClass));
        var label = el('span');
        label.textContent = item.label || '';
        if (item.i18n) label.dataset.i18n = item.i18n;
        button.append(label);
        if (item.onClick) button.addEventListener('click', item.onClick);
        return button;
    }

    function paintMenu(host, sections) {
        host.replaceChildren();
        (sections || []).forEach(function (section) {
            if (section.title) {
                var title = el('div', 'menu-section-title');
                title.textContent = section.title;
                host.append(title);
            }
            var bucket = host;
            if (section.grid) {
                bucket = el('div', 'node-port-menu-grid');
                host.append(bucket);
            }
            (section.items || []).forEach(function (item) {
                bucket.append(menuButton(item));
            });
            if (section.divider) host.append(el('div', 'menu-divider'));
        });
        return host;
    }

    function pinMenu(host, x, y) {
        host.style.left = x + 'px';
        host.style.top = y + 'px';
        return host;
    }

    function choice(type, label, iconName) {
        return { type: type, label: label, icon: iconName };
    }

    function linkChoices(node, kind, catalog) {
        if (!node) return [];
        var label = catalog.label;
        var generators = catalog.generatorTypes || [];
        if (kind === 'out') {
            if (SOURCE_OUT_TYPES.indexOf(node.type) < 0) return [];
            var outgoing = [
                choice('generator', label('canvas.apiGenerate'), 'wand-sparkles'),
                choice('comfy', label('canvas.comfyGenerate'), 'workflow'),
                choice('rh', label('canvas.rhGenerate'), 'workflow'),
                choice('ltxDirector', label('canvas.ltxDirector'), 'film'),
                choice('video', label('canvas.videoGenerateNode'), 'clapperboard')
            ];
            if (node.type !== 'output') outgoing.push(choice('llm', 'LLM', 'message-square-text'));
            return outgoing;
        }
        if (generators.indexOf(node.type) < 0 && node.type !== 'llm') return [];
        return [
            choice('image', label('canvas.imageCard'), 'image-plus'),
            choice('prompt', label('canvas.prompt'), 'text-cursor-input'),
            choice('loop', label('canvas.loopNode'), 'repeat-2'),
            choice('group', label('canvas.group'), 'group'),
            choice('llm', 'LLM', 'message-square-text')
        ];
    }

    function outputChoices(node, catalog) {
        var rows = [choice('output', 'Output', 'circle-dot')];
        if ((catalog.imageOutputTypes || []).indexOf(node.type) >= 0) {
            rows.push(
                choice('generator', catalog.label('canvas.apiGenerate'), 'wand-sparkles'),
                choice('comfy', catalog.label('canvas.comfyGenerate'), 'workflow'),
                choice('ltxDirector', catalog.label('canvas.ltxDirector'), 'film'),
                choice('video', catalog.label('canvas.videoGenerateNode'), 'clapperboard')
            );
        }
        return rows;
    }

    function shortenGeneration(label) {
        return String(label || '').replace('生成', '');
    }

    function choiceItem(option, kind, onPick) {
        return {
            icon: option.icon,
            iconClass: '',
            label: shortenGeneration(option.label),
            title: option.label,
            dataset: { linkCreate: option.type, linkKind: kind },
            onClick: function (event) {
                event.stopPropagation();
                onPick(option.type, kind);
            }
        };
    }

    function fillClassicCreateMenu(host, label, onPick) {
        paintMenu(host, [{
            items: CREATE_ITEMS.map(function (item) {
                return {
                    icon: item[1],
                    label: item[2] ? label(item[2]) : item[3],
                    i18n: item[2],
                    dataset: {},
                    onClick: function (event) {
                        event.stopPropagation();
                        onPick(item[0]);
                    }
                };
            })
        }]);
        return host;
    }

    function statusBadge(status) {
        if (!status) return null;
        var badge = el('span', 'node-run-status ' + status.state);
        badge.append(el('span', 'dot'));
        var words = STATUS_LABELS[status.state] || '';
        if (status.index) words += ' ' + status.index;
        badge.append(doc().createTextNode(words));
        return badge;
    }

    function frameTitle(node, catalog) {
        if (catalog.titleFor) {
            var custom = catalog.titleFor(node);
            if (custom) return custom;
        }
        if (node.type === 'loop') return catalog.label('canvas.loopNode');
        if (node.type === 'ltxDirector') return catalog.label('canvas.ltxDirector');
        if (node.type === 'video') return catalog.label('canvas.videoGenerateNode');
        if (node.type === 'generator' || node.type === 'msgen') return catalog.label('canvas.apiGenerate');
        return FRAME_TITLES[node.type] || catalog.label('canvas.apiGenerate');
    }

    function mountClassicFrame(node, options) {
        var size = options.size || {};
        var fixed = Boolean(node.h || size.h);
        var classes = ['node', node.type + '-node'];
        if (node.url) classes.push('has-image');
        if (fixed) classes.push('sized');
        if (options.selected) classes.push('selected');
        var card = el('div', classes.join(' '));
        if (root.XiaomeiViewportKernel) root.XiaomeiViewportKernel.writeRawOrigin(card, node.x, node.y);
        card.style.width = (node.w || size.w) + 'px';
        if (node.h || size.h) card.style.height = (node.h || size.h) + 'px';
        card.dataset.id = node.id;
        if (options.onSelect) card.addEventListener('click', options.onSelect);
        if (options.onContext) card.addEventListener('contextmenu', options.onContext);
        var head = el('div', 'node-head');
        var title = el('span', 'node-title');
        title.textContent = options.title || frameTitle(node, options.catalog || { label: function (key) { return key; } });
        var tools = el('div');
        tools.style.display = 'flex';
        tools.style.alignItems = 'center';
        tools.style.gap = '8px';
        var badge = statusBadge(options.status);
        if (badge) tools.append(badge);
        var remove = el('button', 'text-gray-300 hover:text-red-500');
        remove.type = 'button';
        remove.append(icon('x', 'w-4 h-4'));
        remove.addEventListener('click', function (event) {
            if (options.onDelete) options.onDelete(event);
        });
        tools.append(remove);
        head.append(title, tools);
        card.append(head);
        var body = el('div', 'node-body');
        return { root: card, body: body };
    }

    function portDot(kind, title) {
        var port = el('div', 'port ' + kind);
        port.title = title || '';
        return port;
    }

    function attachClassicPorts(card, spec) {
        if (spec.input) card.append(portDot('in', spec.inputTitle));
        if (spec.output) card.append(portDot('out', spec.outputTitle));
        var handle = el('div', 'resize-handle');
        handle.title = spec.resizeTitle || '';
        card.append(handle);
        return card;
    }

    root.XiaomeiCanvasSurface = {
        linkChoices: linkChoices,
        outputChoices: outputChoices,
        paintMenu: paintMenu,
        pinMenu: pinMenu,
        fillClassicCreateMenu: fillClassicCreateMenu,
        frameTitle: frameTitle,
        mountClassicFrame: mountClassicFrame,
        attachClassicPorts: attachClassicPorts,
        statusLabels: STATUS_LABELS
    };
})(typeof window !== 'undefined' ? window : globalThis);
