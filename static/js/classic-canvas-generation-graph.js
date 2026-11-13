(function (root) {
    'use strict';

    const directFields = ['items', 'outputs', 'videos', 'audios', 'texts', 'files', 'images', 'urls', 'data', 'result', 'output', 'url'];
    const nestedFields = ['outputs', 'videos', 'images', 'urls', 'data', 'result'];
    const urlFields = ['url', 'path', 'src', 'uri', 'output', 'output_url', 'outputUrl', 'video', 'video_url',
        'videoUrl', 'mp4_url', 'mp4Url', 'download_url', 'downloadUrl', 'preview_url', 'previewUrl'];
    const acceptsMixedOutput = new Set(['rh', 'ltxDirector', 'video', 'comfy']);

    function create(host) {
        const { urlOf, kindOf, nameOf } = host;
        const incoming = id => host.edges().filter(edge => edge.to === id).map(edge => host.node(edge.from)).filter(Boolean);
        const outgoing = id => host.edges().filter(edge => edge.from === id).map(edge => host.node(edge.to)).filter(Boolean);
        const outputNodes = id => outgoing(id).filter(node => node.type === 'output');
        const members = node => (node.items || []).map(host.node).filter(Boolean);
        const groupPrompts = node => members(node).map(member => member.text).filter(Boolean);
        const textFor = (node, round) => round?.text.get(node.id) ?? node.outputText;
        const mediaFor = (node, round, fallback) => round?.media.get(node.id) ?? fallback ?? [];

        function cardRef(node) {
            const kind = host.cardKind(node);
            return { url: node.url, kind, name: node.name || kind, role: node.role || '' };
        }

        function references(node, round, isOutput) {
            const refs = [];
            const list = mediaFor(node, round, isOutput ? node.images : node.generatedOutputs);
            for (const [index, item] of list.entries()) {
                const url = urlOf(item);
                if (!url) continue;
                const kind = kindOf(item);
                if (!isOutput && !acceptsMixedOutput.has(node.type) && kind !== 'image') continue;
                const ref = { url, kind, name: nameOf(url) || (isOutput ? 'output' : node.type || 'generated') + '-' + (index + 1) };
                if (isOutput) Object.assign(ref, { nodeId: node.id, outputIndex: index });
                refs.push(ref);
            }
            return refs;
        }

        function media(node, round) {
            switch (node?.type) {
                case 'image': return node.url ? [cardRef(node)] : [];
                case 'group': return members(node).filter(item => item.type === 'image' && item.url).map(cardRef);
                case 'output': return references(node, round, true);
                default: return node && host.isGenerator(node) ? references(node, round, false) : [];
            }
        }

        function llmInput(node, round) {
            const prompts = [];
            const images = [];
            const videos = [];
            for (const source of incoming(node.id)) {
                switch (source.type) {
                    case 'prompt': prompts.push(source.text); break;
                    case 'promptGroup': prompts.push(...groupPrompts(source)); break;
                    case 'loop': prompts.push(host.loopPrompt(source, round)); break;
                    case 'llm': prompts.push(textFor(source, round)); break;
                    case 'image':
                    case 'group':
                    case 'output': {
                        const refs = media(source, round);
                        for (const [kind, urls] of [['image', images], ['video', videos]]) {
                            const matches = refs.filter(ref => ref.kind === kind);
                            const selected = source.type === 'output' ? matches.slice(-1) : matches;
                            urls.push(...selected.map(ref => ref.url));
                        }
                        break;
                    }
                }
            }
            return { text: prompts.filter(Boolean).join('\n\n'), images, videos };
        }

        function textSource(id, type, label, prompt, fields) {
            return { id, type, label, prompt, refs: [], ...fields };
        }

        function mediaSource(id, type, label, ref, fields) {
            return { id, type, label, prompt: '', preview: ref.url, refs: [ref], ...fields };
        }

        function groupSources(group) {
            const list = [];
            const prompts = [];
            for (const member of members(group)) {
                if (member.type === 'prompt' && member.text) prompts.push(member.text);
                if (member.type !== 'image' || !member.url) continue;
                const ref = cardRef(member);
                list.push(mediaSource(group.id + ':' + member.id, 'group-' + ref.kind, ref.name, ref, {
                    groupId: group.id, imageId: member.id,
                }));
            }
            if (prompts.length) {
                const text = prompts.join('\n\n');
                list.push(textSource(group.id + ':prompts', 'groupPrompt', text.slice(0, 32), text, { groupId: group.id }));
            }
            return list;
        }

        function loopSources(node, round) {
            const prompt = host.loopPrompt(node, round);
            const refs = host.loopImages(node, round);
            if (!refs.length) {
                const label = host.label('canvas.loopNode') + ' ' + root.XiaomeiClassicLoop.count(node) + 'x';
                return [textSource(node.id, 'loop', label, prompt)];
            }
            const start = Math.max(1, Number(round?.index || node.loopStart || 1) || 1);
            return refs.map((ref, offset) => {
                const n = start + offset;
                return mediaSource(node.id + ':image:' + n + ':' + ref.url, 'loopImage', host.format('canvas.loopImageLabel', { n }), ref,
                    { prompt: offset ? '' : prompt });
            });
        }

        function sourcesFor(node, round) {
            switch (node.type) {
                case 'output': {
                    const items = mediaFor(node, round, node.images);
                    const outputIndex = items.findLastIndex(item => urlOf(item));
                    if (outputIndex < 0) return [];
                    const item = items[outputIndex];
                    const ref = { url: urlOf(item), name: 'output.png', kind: kindOf(item), nodeId: node.id, outputIndex };
                    return [mediaSource(node.id, 'outputImage', '上游输出', ref)];
                }
                case 'image': {
                    if (!node.url) return [];
                    const ref = cardRef(node);
                    return [mediaSource(node.id, ref.kind, ref.name, ref)];
                }
                case 'group': return groupSources(node);
                case 'prompt': return [textSource(node.id, 'prompt', (node.text || '提示词').slice(0, 32), node.text || '')];
                case 'loop': return loopSources(node, round);
                case 'promptGroup': {
                    const prompts = groupPrompts(node);
                    return [textSource(node.id, 'promptGroup', '提示词 ' + prompts.length + ' 个', prompts.join('\n\n'))];
                }
                case 'llm': {
                    const text = (node.mode || 'node') === 'node' && textFor(node, round);
                    return text ? [textSource(node.id, 'llm', text.slice(0, 32), text)] : [];
                }
                default:
                    return media(node, round).map((ref, index) => mediaSource(
                        node.id + ':generated:' + index + ':' + ref.url, 'generatedImage', '上游生成 ' + (index + 1), ref));
            }
        }

        function sources(node, round) {
            const byId = new Map();
            for (const source of incoming(node.id).flatMap(parent => sourcesFor(parent, round))) {
                if (!byId.has(source.id)) byId.set(source.id, source);
            }
            const ids = (Array.isArray(node.inputs) ? node.inputs : []).filter(id => byId.has(id));
            const saved = new Set(ids);
            for (const id of byId.keys()) if (!saved.has(id)) ids.push(id);
            if (!round) node.inputs = ids;
            return ids.map(id => byId.get(id));
        }

        function reorder(node, moved, target) {
            if (!moved || moved === target) return false;
            const ordered = sources(node);
            const media = ordered.filter(item => item.refs.length).map(item => item.id);
            const from = media.indexOf(moved);
            const to = media.indexOf(target);
            if (from < 0 || to < 0) return false;
            media.splice(from, 1);
            media.splice(to, 0, moved);
            node.inputs = media.concat(ordered.filter(item => !item.refs.length).map(item => item.id));
            return true;
        }

        function mapInputOrder(nodes, identify) {
            const exact = new Map();
            const prefixes = [];
            for (const node of nodes) {
                const copy = identify(node.id);
                exact.set(node.id, copy);
                if (node.type === 'group') {
                    exact.set(node.id + ':prompts', copy + ':prompts');
                    for (const member of node.items || []) {
                        const next = identify(member);
                        if (next) exact.set(node.id + ':' + member, copy + ':' + next);
                    }
                }
                const suffix = node.type === 'loop' ? ':image:' : host.isGenerator(node) ? ':generated:' : '';
                if (suffix) prefixes.push({ before: node.id + suffix, after: copy + suffix });
            }
            prefixes.sort((a, b) => b.before.length - a.before.length);
            return key => {
                if (exact.has(key)) return exact.get(key);
                const prefix = typeof key === 'string' && prefixes.find(({ before }) => key.startsWith(before));
                return prefix ? prefix.after + key.slice(prefix.before.length) : key;
            };
        }

        function output(node, dx = 460) {
            if (!node) return null;
            const downstream = outgoing(node.id);
            const existing = downstream.find(target => target.type === 'output');
            if (existing) return existing;
            if (downstream.some(host.isGenerator)) return null;
            const created = { id: host.id('out'), type: 'output', x: node.x + dx, y: node.y, images: [] };
            host.appendNode(created);
            host.edges().push({ id: host.id('c'), from: node.id, to: created.id });
            return created;
        }

        function sendOutput(target, items) {
            const present = new Set((target.images || []).map(urlOf));
            const next = items.filter(item => urlOf(item) && !present.has(urlOf(item)));
            if (next.length) host.appendMedia(target, next);
            return next.length > 0;
        }

        function relayLatest(from, to) {
            const source = host.node(from);
            const target = host.node(to);
            if (!source || target?.type !== 'output' || !host.isGenerator(source)) return false;
            const latest = source.generatedOutputs?.findLast(item => urlOf(item));
            return latest ? sendOutput(target, [latest]) : false;
        }

        function relay(node, items) {
            if (!node || !host.isGenerator(node) || !items?.length) return;
            for (const target of outputNodes(node.id)) sendOutput(target, items);
        }

        function storeOutputs(node, outputs, append = false) {
            if (!node) return;
            const previous = append ? node.generatedOutputs || [] : [];
            const seen = append ? new Set(previous.map(urlOf)) : null;
            const videoOutput = node.type === 'video';
            const inferVideo = node.type === 'rh' || node.type === 'ltxDirector';
            const added = [];
            for (const item of outputs || []) {
                const url = urlOf(item);
                if (!url || seen?.has(url)) continue;
                const kind = videoOutput || (inferVideo && host.videoUrl(url)) ? 'video' : kindOf(item);
                if (kind !== 'image' && !acceptsMixedOutput.has(node.type)) continue;
                added.push(kind === 'image' ? url : { url, kind });
                seen?.add(url);
            }
            node.generatedOutputs = previous.concat(added);
            relay(node, added);
        }

        function resultMedia(result) {
            const known = new Set();
            const items = [];

            function emit(item) {
                const url = urlOf(item);
                if (!url || known.has(url)) return;
                known.add(url);
                items.push(item);
            }

            function read(value) {
                if (!value) return;
                if (typeof value === 'string') {
                    emit(value);
                } else if (Array.isArray(value)) {
                    for (const item of value) read(item);
                } else if (typeof value === 'object') {
                    const url = value.url || value.path || value.src || value.uri;
                    if (url) emit({ url, kind: value.kind || value.type || value.mediaKind || '', name: value.name || value.filename || '' });
                    for (const field of nestedFields) read(value[field]);
                    for (const field of urlFields) read(value[field]);
                }
            }

            for (const field of directFields) read(result?.[field]);
            return items;
        }

        return { incoming, groupPrompts, media, llmInput, sources, reorder, mapInputOrder, output, outputNodes, relayLatest, storeOutputs, resultMedia };
    }

    root.XiaomeiClassicGenerationGraph = { create };
})(window);
