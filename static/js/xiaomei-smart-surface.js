/* Xiaomei smart-canvas card shell.
   Class tokens, ports, and the outer card are assembled here. The page
   still supplies body, toolbar, and title fragments because those belong
   to node types that are not part of this shell. */
(function (root) {
    'use strict';

    var CLASS_ORDER = [
        ['textStack', 'collapsed-text-stack-node'],
        ['fidelity', 'product-fidelity-smart-node'],
        ['video', 'video-smart-node'],
        ['aiRender', 'ai-render-smart-node'],
        ['replica', 'replica-smart-node'],
        ['comfy', 'comfy-workflow-smart-node'],
        ['drawing', 'drawing-board-node'],
        ['table', 'smart-table-node'],
        ['timeline', 'smart-timeline-node'],
        ['empty', 'empty-node'],
        ['upload', 'upload-node'],
        ['paint', 'painting-node'],
        ['detailPaint', 'smart-detail-paint-node'],
        ['detailStitch', 'smart-detail-stitch-node'],
        ['failed', 'node-failed'],
        ['group', 'group-node'],
        ['collapsedImage', 'collapsed-stack-node'],
        ['collapsedPrompt', 'collapsed-prompt-node'],
        ['history', 'history-group-node'],
        ['prompt', 'prompt-smart-node'],
        ['agent', 'agent-smart-node'],
        ['loop', 'loop-smart-node'],
        ['compare', 'smart-compare-node'],
        ['color', 'color-smart-node'],
        ['smartGroup', 'smart-group-node'],
        ['compact', 'smart-group-member-node'],
        ['locked', 'collab-locked-by-other'],
        ['selected', 'selected'],
        ['dragging', 'dragging'],
        ['running', 'node-running'],
        ['pending', 'node-pending']
    ];

    function escapeAttr(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
        });
    }

    function cardClass(flags) {
        var tokens = ['image-node'];
        CLASS_ORDER.forEach(function (entry) {
            if (flags && flags[entry[0]]) tokens.push(entry[1]);
        });
        return tokens.join(' ');
    }

    function cardStyle(parts) {
        var chunks = [parts.origin || ''];
        if (chunks[0] && chunks[0].slice(-1) !== ';') chunks[0] += ';';
        if (parts.memberColor) chunks.push('--member-color:' + parts.memberColor + ';');
        if (parts.clearChrome) {
            chunks.push('background:transparent!important;border-color:transparent!important;box-shadow:none!important;backdrop-filter:none!important;');
        }
        chunks.push('width:' + parts.width + 'px;height:' + parts.height + 'px');
        return chunks.join('');
    }

    function inputPort(port) {
        var slot = port.slot ? ' data-input-slot="' + escapeAttr(port.slot) + '"' : '';
        var aria = port.aria ? ' aria-label="' + escapeAttr(port.aria) + '"' : '';
        var style = port.style ? ' style="' + escapeAttr(port.style) + '"' : '';
        var extra = port.extraClass ? ' ' + port.extraClass : '';
        var label = port.label
            ? '<span class="' + escapeAttr(port.labelClass || '') + '">' + escapeAttr(port.label) + '</span>'
            : '';
        return '<div class="node-port port-in' + extra + '" data-port="in"' + slot + ' title="' + escapeAttr(port.title || '') + '"' + aria + style + '>' + label + '</div>';
    }

    function outputPort(spec) {
        if (!spec || spec.compare) return '';
        var style = spec.outStyle ? ' style="' + escapeAttr(spec.outStyle) + '"' : '';
        return '<div class="node-port port-out" data-port="out" title="按住加号拖动连接"' + style + '></div>';
    }

    function primaryPorts(spec) {
        if (spec.suppress) return '';
        if (spec.replica) return spec.replicaHtml || '';
        if (spec.aiRender) {
            return [
                inputPort({ extraClass: 'ai-render-input-port', slot: 'white', title: '连接白模', aria: '白模' }),
                inputPort({ extraClass: 'ai-render-input-port', slot: 'style', title: '连接风格参考', aria: '风格' }),
                inputPort({ extraClass: 'ai-render-input-port', slot: 'product', title: '连接产品参考', aria: '产品' })
            ].join('');
        }
        if (spec.color) {
            return [
                inputPort({ extraClass: 'color-input-port', slot: 'target', title: '连接待修复图片', label: '待修复', labelClass: 'color-input-label' }),
                inputPort({ extraClass: 'color-input-port', slot: 'reference', title: '连接参考图片', label: '参考', labelClass: 'color-input-label' })
            ].join('');
        }
        if (spec.loopPaired) {
            return inputPort({
                extraClass: 'batch-image-input-port',
                slot: 'product',
                title: '连接产品图，保持产品外观',
                aria: '连接产品图'
            });
        }
        return inputPort({ title: '连接输入' });
    }

    function extraPorts(spec) {
        if (!spec) return '';
        var parts = [];
        if (spec.loopPaired) {
            parts.push(inputPort({
                extraClass: 'batch-image-input-port',
                slot: 'reference',
                title: '连接参考图，只借风格与配色',
                aria: '连接参考图'
            }));
            parts.push(inputPort({
                extraClass: 'batch-text-input-port',
                slot: 'text',
                title: '连接提示词或文本',
                aria: '连接提示词或文本'
            }));
        }
        if (spec.sku) {
            parts.push(inputPort({
                extraClass: 'batch-image-input-port',
                slot: 'template',
                title: '连接统一 SKU 模板，替换为本款产品',
                aria: '连接统一 SKU 模板'
            }));
            parts.push(inputPort({
                extraClass: 'batch-image-input-port',
                slot: 'gift',
                title: '连接赠品图片或图片组，不单独建立 SKU',
                aria: '连接赠品图'
            }));
        }
        return parts.join('');
    }

    function portsHtml(spec) {
        return primaryPorts(spec) + extraPorts(spec) + outputPort(spec);
    }

    function headHtml(spec) {
        return '<div class="node-head"><div class="node-title">' + (spec.titleHtml || '') + '</div><div class="node-actions">' + (spec.deleteHtml || '') + '</div></div>';
    }

    function floatingDelete(spec) {
        if (!spec.floatingDelete) return '';
        return '<div class="floating-node-actions"><button class="mini-x node-delete" type="button" title="' + escapeAttr(spec.deleteTitle || '') + '"><i data-lucide="trash-2"></i></button></div>';
    }

    function resizeHandle(spec) {
        if (!spec.resize) return '';
        var title = spec.resizeTitle ? ' title="' + escapeAttr(spec.resizeTitle) + '"' : '';
        return '<div class="node-resize-handle" data-resize="1"' + title + '></div>';
    }

    function cardHtml(spec) {
        var blocks = [
            spec.detailHtml || '',
            spec.stitchHtml || '',
            spec.runBorderHtml || '',
            headHtml(spec),
            spec.collabHtml || '',
            floatingDelete(spec),
            spec.toolbarHtml || '',
            spec.groupToolbarHtml || '',
            '<div class="node-body">' + (spec.bodyHtml || '') + '</div>',
            spec.reviewHtml || '',
            spec.grab ? '<div class="smart-group-member-grab" title="拖动分组"></div>' : '',
            '<div class="node-hint">' + (spec.hintHtml || '') + '</div>',
            resizeHandle(spec),
            portsHtml(spec.ports || {})
        ];
        return '<div class="' + escapeAttr(spec.className || 'image-node') + '" data-id="' + escapeAttr(spec.id || '') + '" style="' + escapeAttr(spec.style || '') + '">' + blocks.join('') + '</div>';
    }

    root.XiaomeiSmartSurface = {
        cardClass: cardClass,
        cardStyle: cardStyle,
        portsHtml: portsHtml,
        cardHtml: cardHtml
    };
})(typeof window !== 'undefined' ? window : globalThis);
