(function (root) {
    'use strict';

    function create(host) {
        function distinct(items) {
            const aliases = new Map();
            const refs = [];
            for (const [index, item] of (items || []).entries()) {
                if (!item?.url) continue;
                const asset = item.asset_ref_id || item.assetRefId;
                const keys = ['url|' + item.url];
                if (asset) keys.push('asset|' + asset);
                keys.push('material|' + host.materialKey(item));

                let ref = keys.map(key => aliases.get(key)).find(Boolean);
                if (!ref) {
                    const number = refs.length + 1;
                    const imageIndex = Number(item.imageIndex);
                    ref = {
                        ...item,
                        name: item.name || '图' + number,
                        role: item.role || 'image_' + number,
                        imageIndex: Number.isFinite(imageIndex) ? imageIndex : index
                    };
                    refs.push(ref);
                } else {
                    for (const [field, value] of Object.entries(item)) {
                        if (ref[field] == null || ref[field] === '') ref[field] = value;
                    }
                    ref.asset_uris = { ...ref.asset_uris, ...item.asset_uris };
                    if (item.referenceId) ref.referenceId = item.referenceId;
                    if (item.sourceImageId) {
                        ref.sourceImageId = item.sourceImageId;
                        ref.sourceMissing = Boolean(item.sourceMissing);
                    }
                }
                for (const key of keys) aliases.set(key, ref);
            }
            return refs;
        }

        function ordered(node, items) {
            const refs = distinct(items);
            if (refs.length < 2 || !Array.isArray(node?.inputRefOrder)) return refs;
            const order = node.inputRefOrder.map(value => String(value || '')).filter(Boolean);
            if (order.length < 2) return refs;
            const position = new Map();
            for (const key of order) {
                if (!position.has(key)) position.set(key, position.size);
            }
            return refs.map(ref => ({
                ref,
                rank: position.get('ref|' + host.materialKey(ref)) ?? position.get(host.inputKey(ref)) ?? position.size
            })).sort((left, right) => left.rank - right.rank).map(item => item.ref);
        }

        const allowed = (node, items) => items.filter(item => item?.url && !host.blocked(node, item));

        function defaults(node, consume, context) {
            if (!node) return [];
            if (node.type === 'smart-agent') return host.agentOutput(node);
            if (host.isRender(node)) return allowed(node, host.renderInputs(node, context));

            const source = node.smartEditSource;
            if (source?.sourceUrl) {
                const original = {
                    url: source.sourceUrl,
                    name: '智能改图原图',
                    kind: 'image',
                    nodeId: source.nodeId,
                    imageIndex: source.imageIndex,
                    width: source.width,
                    height: source.height
                };
                return allowed(node, [original, ...host.manual(node)]);
            }

            const workflow = host.usesWorkflow(node, context);
            const images = workflow
                ? host.workflowImages(node, consume, context)
                : [...host.self(node, consume, context), ...host.inputImages(node, consume, context)];
            return ordered(node, allowed(node, [...images, ...host.manual(node)]));
        }

        function stable(node, consume, context) {
            if (!node) return [];
            if (node.type === 'smart-agent') return host.agentInputs(node);
            const current = defaults(node, consume, context);
            const snapshot = allowed(node, Array.isArray(node.runInputRefs) ? node.runInputRefs : []);
            if (current.length) {
                return ordered(node, [...current, ...snapshot.filter(ref => ref.nodeId && ref.nodeId === node.id)]);
            }
            // Older snapshots may contain passthrough images from an Agent now in text mode.
            if (host.workflowNodes(node).some(input => input?.type === 'smart-agent')) return current;
            return ordered(node, snapshot);
        }

        function rerun(node, consume, context) {
            if (!node) return [];
            const linked = allowed(node, host.inputImages(node, consume, context));
            const chosen = [...linked, ...host.manual(node)];
            return distinct(chosen.length ? chosen : defaults(node, consume, context));
        }

        function visible(node, current, mentioned) {
            return ordered(node, allowed(node, [...current, ...mentioned]));
        }

        function mentionCandidates(items) {
            const seen = new Set();
            const candidates = [];
            for (const item of items) {
                if (!item?.url || seen.has(item.url)) continue;
                seen.add(item.url);
                candidates.push({
                    ...item,
                    mentionId: 'mention_' + candidates.length + '_' + Math.random().toString(36).slice(2, 7),
                    alias: item.name || '图片' + (candidates.length + 1)
                });
            }
            return candidates;
        }

        return { distinct, ordered, defaults, stable, rerun, visible, mentionCandidates };
    }

    root.XiaomeiSmartGenerationReferences = { create };
})(window);
