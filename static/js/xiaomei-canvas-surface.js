/* Xiaomei classic-canvas surface.
   Menus, node frames, ports, and generation forms are built here from
   descriptors. Coordinate writes go through XiaomeiViewportKernel.
   Provider option lists stay with the page because they come from the
   saved platform catalog. */
(function (root) {
    'use strict';

    var SOURCE_OUT_TYPES = ['image', 'prompt', 'loop', 'group', 'promptGroup', 'llm', 'output'];
    var RESOLUTION_STEPS = [
        ['auto', '自动'],
        ['1k', '1K'],
        ['2k', '2K'],
        ['4k', '4K']
    ];
    var RATIO_STEPS = [
        ['square', '1:1'],
        ['portrait', '2:3'],
        ['landscape', '3:2'],
        ['portrait43', '3:4'],
        ['landscape43', '4:3'],
        ['story', '9:16'],
        ['wide', '16:9'],
        ['ultrawide', '21:9'],
        ['ultratall', '9:21']
    ];
    var QUALITY_STEPS = [
        ['auto', 'Q auto'],
        ['low', 'Q low'],
        ['medium', 'Q med'],
        ['high', 'Q high']
    ];
    var BACKGROUND_STEPS = [
        ['auto', '背景 auto'],
        ['opaque', '背景 opaque'],
        ['transparent', '背景 transparent']
    ];
    var VIDEO_ASPECTS = [
        ['16:9', '16:9'],
        ['9:16', '9:16'],
        ['1:1', '1:1'],
        ['4:3', '4:3'],
        ['3:4', '3:4'],
        ['21:9', '21:9'],
        ['9:21', '9:21'],
        ['keep_ratio', 'keep'],
        ['adaptive', 'adapt']
    ];
    var VIDEO_RESOLUTIONS = [
        ['', 'Auto'],
        ['480p', '480p'],
        ['720p', '720p'],
        ['1080p', '1080p'],
        ['780P', '780P']
    ];
    var VIDEO_TOGGLES = [
        ['enhancePrompt', 'canvas.videoEnhancePrompt'],
        ['enableUpsample', 'canvas.videoUpsample'],
        ['watermark', 'canvas.videoWatermark'],
        ['cameraFixed', 'canvas.videoCameraFixed'],
        ['generateAudio', 'canvas.videoGenerateAudio'],
        ['multimodal', 'canvas.videoMultimodal'],
        ['useFrameRoles', 'canvas.videoFirstLastFrames']
    ];
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

    function optionList(pairs) {
        return (pairs || []).map(function (pair) {
            return { value: pair[0], label: pair[1] };
        });
    }

    function fillSelect(select, options, html) {
        if (html != null) {
            select.innerHTML = html;
            return select;
        }
        (options || []).forEach(function (option) {
            var node = el('option');
            node.value = option.value;
            node.textContent = option.label;
            select.append(node);
        });
        return select;
    }

    function selectBox(className, options, html, attrs) {
        var select = el('select', className);
        Object.keys(attrs || {}).forEach(function (key) {
            if (attrs[key] != null && attrs[key] !== '') select.setAttribute(key, attrs[key]);
        });
        return fillSelect(select, options, html);
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

    function numberField(className, value, placeholder, min, step) {
        var input = el('input', 'setting-input ' + className);
        input.type = 'number';
        input.min = String(min);
        input.step = String(step);
        input.value = value == null ? '' : String(value);
        input.placeholder = placeholder || '';
        return input;
    }

    function fieldRow(className, hidden) {
        var row = el('div', 'gen-settings-row' + (className ? ' ' + className : ''));
        if (hidden) row.style.display = 'none';
        return row;
    }

    function appendMarkup(parent, html) {
        if (!html) return;
        var holder = el('template');
        holder.innerHTML = html;
        parent.append.apply(parent, holder.content.childNodes);
    }

    function countStepper(count) {
        var row = el('div', 'gen-count-row');
        var stepper = el('div', 'gen-stepper');
        var down = el('button', 'gen-step-btn');
        down.type = 'button';
        down.dataset.step = '-1';
        down.append(icon('chevron-left', 'w-3.5 h-3.5'));
        var input = el('input', 'gen-count-input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.pattern = '[0-9]*';
        input.value = String(Math.max(1, Math.min(8, Number(count) || 1)));
        var up = el('button', 'gen-step-btn');
        up.type = 'button';
        up.dataset.step = '1';
        up.append(icon('chevron-right', 'w-3.5 h-3.5'));
        stepper.append(down, input, up);
        row.append(stepper);
        return row;
    }

    function mountImageGeneration(wrap, spec) {
        var prompts = el('div', 'prompt-list mb-3');
        var heading = el('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2');
        heading.textContent = spec.imagesLabel;
        var inputs = el('div', 'input-list');
        var settings = el('div', 'gen-settings');
        var providers = fieldRow();
        providers.append(
            selectBox('select-lite provider-select', null, spec.providerOptionsHtml),
            selectBox('select-lite model-select', null, spec.modelOptionsHtml)
        );
        var sizes = fieldRow('api-size-row');
        var resolution = optionList(RESOLUTION_STEPS);
        resolution.push({ value: 'custom', label: spec.customLabel });
        var ratios = optionList(RATIO_STEPS);
        ratios.push({ value: 'source', label: spec.adaptiveLabel });
        ratios.push({ value: 'custom', label: spec.customLabel });
        sizes.append(
            selectBox('select-lite resolution compact-select', resolution, null, { 'data-field': 'resolution' }),
            selectBox('select-lite ratio compact-select', ratios, null, { 'data-field': 'ratio' }),
            selectBox('select-lite quality-select', optionList(QUALITY_STEPS)),
            selectBox('select-lite background-select', optionList(BACKGROUND_STEPS)),
            countStepper(spec.count)
        );
        sizes.querySelector('.background-select').style.display = 'none';
        var ratioRow = fieldRow('custom-ratio-row', true);
        ratioRow.append(
            labeled(spec.ratioWidthLabel, numberField('custom-ratio-w-input', spec.ratioWidth, '4', 1, 1)),
            labeled(spec.ratioHeightLabel, numberField('custom-ratio-h-input', spec.ratioHeight, '3', 1, 1))
        );
        var sizeRow = fieldRow('custom-size-row', true);
        var fit = el('button', 'secondary-btn fit-size-btn');
        fit.type = 'button';
        fit.textContent = spec.fitLabel;
        fit.style.height = '32px';
        fit.style.alignSelf = 'flex-end';
        fit.style.padding = '0 10px';
        fit.style.fontSize = '11px';
        sizeRow.append(
            labeled(spec.widthLabel, numberField('custom-w-input', spec.customWidth, 'Auto', 64, 64)),
            labeled(spec.heightLabel, numberField('custom-h-input', spec.customHeight, 'Auto', 64, 64)),
            fit
        );
        settings.append(providers, sizes, ratioRow, sizeRow);
        var runRow = el('div', 'gen-run-row');
        runRow.append(runButton(spec.running, 'zap', spec.runLabel));
        appendMarkup(runRow, spec.cascadeHtml);
        wrap.replaceChildren(prompts, heading, inputs, settings, runRow);
        appendMarkup(wrap, spec.retryHtml);
        return wrap;
    }

    function labeled(title, control) {
        var label = el('label', 'field');
        var heading = el('div', 'setting-title');
        heading.textContent = title;
        label.append(heading, control);
        return label;
    }

    function runButton(running, iconName, label) {
        var button = el('button', 'gen-btn' + (running ? ' running' : ''));
        button.type = 'button';
        if (running) button.disabled = true;
        button.append(icon(iconName, 'w-4 h-4'));
        button.append(doc().createTextNode(label));
        return button;
    }

    function mountVideoGeneration(wrap, spec) {
        var prompts = el('div', 'prompt-list mb-3');
        var head = el('div', 'video-input-head');
        var media = el('div', 'text-[10px] font-bold text-gray-400 uppercase tracking-widest');
        media.textContent = 'Media';
        var actions = el('div', 'video-input-actions');
        var manual = el('button', 'tool-btn');
        manual.type = 'button';
        manual.dataset.videoManualUrl = '';
        manual.title = '手动输入视频 URL';
        manual.append(icon('link', 'w-4 h-4'), el('span'));
        manual.lastChild.textContent = '输入网址';
        var upload = el('button', 'tool-btn');
        upload.type = 'button';
        upload.dataset.videoTempSh = '';
        upload.title = '上传当前输入视频到云端直链';
        if (spec.uploading) upload.disabled = true;
        upload.append(icon('upload-cloud', 'w-4 h-4'), el('span'));
        upload.lastChild.textContent = spec.uploading ? '上传中...' : '上传云端';
        actions.append(manual, upload);
        head.append(media, actions);
        var inputs = el('div', 'input-list video-img-list');
        var settings = el('div', 'gen-settings');
        var providers = fieldRow();
        var provider = selectBox('select-lite video-provider', null, spec.providerOptionsHtml);
        var model = selectBox('select-lite video-model', null, spec.modelOptionsHtml);
        provider.style.flex = '1';
        model.style.flex = '2';
        providers.append(provider, model);
        var timing = fieldRow();
        var duration = numberField('video-duration', spec.duration || 5, '', 1, 1);
        duration.max = '60';
        duration.className = 'setting-input video-duration';
        var aspect = selectBox('select-lite video-aspect compact-select', optionList(VIDEO_ASPECTS));
        var resolution = selectBox('select-lite video-resolution compact-select', optionList(VIDEO_RESOLUTIONS));
        timing.append(
            labeled(spec.durationLabel, duration),
            labeled(spec.aspectLabel, aspect),
            labeled(spec.resolutionLabel, resolution)
        );
        timing.querySelectorAll('.field').forEach(function (field) { field.style.flex = '1'; });
        var toggles = fieldRow();
        toggles.style.flexWrap = 'wrap';
        VIDEO_TOGGLES.forEach(function (toggle) {
            var button = el('button', 'setting-check' + (spec.flags && spec.flags[toggle[0]] ? ' active' : ''));
            button.type = 'button';
            button.dataset.videoToggle = toggle[0];
            button.append(el('span', 'check-dot'));
            button.append(doc().createTextNode(spec.label(toggle[1])));
            toggles.append(button);
        });
        settings.append(providers, timing, toggles);
        var runRow = el('div', 'gen-run-row');
        runRow.append(runButton(spec.running, 'clapperboard', spec.runLabel));
        appendMarkup(runRow, spec.cascadeHtml);
        wrap.replaceChildren(prompts, head, inputs, settings, runRow);
        appendMarkup(wrap, spec.retryHtml);
        return wrap;
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
        mountImageGeneration: mountImageGeneration,
        mountVideoGeneration: mountVideoGeneration,
        statusLabels: STATUS_LABELS
    };
})(typeof window !== 'undefined' ? window : globalThis);
