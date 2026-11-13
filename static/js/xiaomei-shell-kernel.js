/* Xiaomei shell kernel.
   Asset selection, settings records, and preview math.
   This is the only asset and shell path. Query parameters, stored flags,
   request headers, and setActive do not select another implementation. */
(function (root) {
    'use strict';

    var VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'];
    var AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
    var FILTER_VIDEO = VIDEO_EXT.concat(['flv']);
    var SCALE_OPTIONS = ['auto', '60', '65', '70', '75', '80', '85', '90', '95', '100', '115', '125', '140'];
    var PROTOCOLS = ['openai', 'apimart', 'gemini', 'volcengine', 'runninghub', 'jimeng', 'codex', 'gemini-cli'];
    var CLI = {jimeng: true, codex: true, 'gemini-cli': true};
    var IMAGE_MODES = {openai: true, 'openai-json': true, 'openai-video-proxy': true, 'openai-responses': true};
    var EDIT_ROUTES = {general: true, auto: true, chat: true};
    var HOST_ALIASES = [
        ['soonstudio.ai', 'soon'],
        ['scnet.cn', 'scnet'],
        ['openrouter.ai', 'openrouter'],
        ['qianwenaiapi.com', 'qwen']
    ];
    var LOCKED = [
        {id: 'exellome', name: 'exellome', host: 'new.exellome.online', protocol: 'apimart', mode: 'openai-video-proxy'},
        {id: 'fhl', name: 'fhl', host: 'www.fhl.mom', protocol: 'openai', mode: 'openai'}
    ];
    var CLI_SEEDS = {
        jimeng: {
            image: '5.0|4.7|4.6|4.5|4.1|4.0|3.1|3.0',
            video: 'seedance2.0fast_vip|seedance2.0_vip',
            dropImage: { 'jimeng-image-2k': true, 'jimeng-image-4k': true },
            dropVideo: { 'jimeng-video-720p': true, 'jimeng-video-1080p': true }
        },
        codex: {
            image: 'gpt-image-2',
            chat: 'gpt-6-astra|gpt-5.6-terra|gpt-5.6-sol|gpt-5.6-luna|gpt-5.5',
            block: { '$imagegen': true, auto: true }
        },
        'gemini-cli': { image: 'auto', chat: 'auto' }
    };
    var ACCENT_MOVES = { '#3b82f6': '#0e7490', '#2563eb': '#0e7490' };
    var APPEARANCE = { font: 'system', fontSize: 'normal', accent: '#0e7490', eyeCare: false, skin: 'minimal' };
    var SKINS = { dark: true, soft: true, warm: true, minimal: true };
    var FONTS = { system: true, sans: true, rounded: true, serif: true };
    var FONT_SIZES = { small: true, normal: true, large: true, xlarge: true };
    var FILTER_DIMENSIONS = ['color', 'materials', 'style', 'use_case', 'tags'];

    function markDocument() {
        var doc = root.document;
        if (!doc || !doc.documentElement) return;
        doc.documentElement.setAttribute('data-xm-assets', 'next');
    }

    function isActive() { return true; }

    function setActive() {
        markDocument();
        return true;
    }

    function toggleMember(set, id) {
        if (!set || !id) return false;
        var present = set.has(id);
        if (present) set.delete(id);
        else set.add(id);
        return !present;
    }

    function bulkChoice(ids, selected, id) {
        var next = (selected || []).slice();
        var at = next.indexOf(id);
        if (at >= 0) next.splice(at, 1);
        else if (id) next.push(id);
        return next;
    }

    function bulkAll(ids, selected) {
        var pool = ids || [];
        var chosen = selected || [];
        if (pool.length && chosen.length === pool.length) return [];
        return pool.slice();
    }

    function historyDeleteBody(timestamp) {
        return { timestamp: timestamp };
    }

    function assetBatch(kind, fields) {
        var src = fields || {};
        var ids = (src.ids || []).slice();
        if (kind === 'delete') {
            var body = { library_id: src.libraryId || '', ids: ids };
            if (src.preserveReferenced) body.preserve_referenced = true;
            if (src.removeEmptyCategoryId) body.remove_empty_category_id = src.removeEmptyCategoryId;
            return body;
        }
        if (kind === 'move') {
            return {
                library_id: src.libraryId || '',
                target_library_id: src.targetLibraryId || '',
                target_category_id: src.targetCategoryId || '',
                ids: ids
            };
        }
        if (kind === 'copy') {
            return {
                library_id: src.libraryId || '',
                category_id: src.categoryId || '',
                items: (src.items || []).map(function (item) {
                    return { url: item.url, name: item.name || 'asset' };
                }).filter(function (item) { return item.url; })
            };
        }
        if (kind === 'save') {
            return {
                library_id: src.libraryId || '',
                category_id: src.categoryId || '',
                url: src.url || '',
                name: src.name || ''
            };
        }
        return {
            folder: src.folder || '',
            folder_parent: src.folderParent || '',
            folder_name: src.folderName || '',
            items: (src.items || []).map(function (item) {
                return { url: item.url, name: item.name || '' };
            }).filter(function (item) { return item.url; })
        };
    }

    function extensionOf(value) {
        var text = String(value || '').split('?')[0].split('#')[0];
        var dot = text.lastIndexOf('.');
        return dot >= 0 ? text.slice(dot + 1).toLowerCase() : '';
    }

    function mediaKind(item) {
        if (!item) return 'image';
        if (item.kind === 'workflow' || item.type === 'workflow') return 'workflow';
        if (item.kind === 'video' || item.type === 'video') return 'video';
        if (item.kind === 'audio' || item.type === 'audio') return 'audio';
        var ext = extensionOf(item.url || item.name || '');
        var nameExt = extensionOf(item.name || '');
        function has(list, value) { return list.indexOf(value) >= 0; }
        if (has(VIDEO_EXT, ext) || has(VIDEO_EXT, nameExt)) return 'video';
        if (has(AUDIO_EXT, ext) || has(AUDIO_EXT, nameExt)) return 'audio';
        if (ext === 'json' || ext === 'zip' || nameExt === 'json' || nameExt === 'zip') return 'workflow';
        return 'image';
    }

    function folderRows(tree, items) {
        var rows = [];
        function walk(node) {
            if (!node) return;
            var id = node.id || node.path || '__root__';
            var rootNode = id === '__root__';
            var pool = rootNode ? (items || []) : (node.items || []);
            rows.push({
                id: id,
                name: node.name || (node.path ? String(node.path).split('/').pop() : '全部上传'),
                type: 'image',
                items: pool.filter(function (item) { return mediaKind(item) === 'image'; }),
                readonly: true,
                source: 'local'
            });
            (node.children || []).forEach(walk);
        }
        walk(tree || { id: '__root__', name: '全部上传', items: items || [], children: [] });
        return rows;
    }

    function matches(item, filters) {
        var record = item || {};
        var rules = filters || {};
        var classification = record.classification || {};
        var categories = classification.categories || {};
        var tags = classification.tags || [];
        var ext = extensionOf(record.url || record.name || '');
        var known = ['image', 'video', 'audio', 'text'];
        var kind = known.indexOf(record.kind) >= 0 ? record.kind : (FILTER_VIDEO.indexOf(ext) >= 0 ? 'video' : (AUDIO_EXT.indexOf(ext) >= 0 ? 'audio' : 'image'));
        if (rules.kind && rules.kind !== kind) return false;
        if (rules.format && String(rules.format).toLowerCase().split(',').indexOf(ext) < 0) return false;
        for (var i = 0; i < FILTER_DIMENSIONS.length; i++) {
            var dimension = FILTER_DIMENSIONS[i];
            var wanted = String(rules[dimension] || '').split(/[,，、\n]+/).map(function (tag) { return tag.trim().toLowerCase(); }).filter(Boolean);
            var actual = (dimension === 'tags' ? tags : (categories[dimension] || [])).map(function (tag) { return String(tag).toLowerCase(); });
            if (wanted.length && !wanted.some(function (tag) { return actual.indexOf(tag) >= 0; })) return false;
        }
        var width = Number(record.width || record.natural_w || 0);
        var height = Number(record.height || record.natural_h || 0);
        if ((rules.shape || Number(rules.min_edge)) && !(width && height)) return false;
        if (Number(rules.min_edge) && Math.min(width, height) < Number(rules.min_edge)) return false;
        if (rules.shape === 'landscape' && width <= height) return false;
        if (rules.shape === 'portrait' && width >= height) return false;
        if (rules.shape === 'square' && width !== height) return false;
        var manual = classification.manual || {};
        if (rules.annotated === 'manual' && !Object.keys(manual).length) return false;
        if (rules.annotated === 'missing' && (tags.length || Object.keys(categories).length || classification.summary)) return false;
        var text = [record.name, record.url, record.folder, record.rel, record.file, classification.summary].concat(tags, Object.keys(categories).reduce(function (all, key) {
            return all.concat(categories[key] || []);
        }, [])).join(' ').toLowerCase();
        return String(rules.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).every(function (word) { return text.indexOf(word) >= 0; });
    }

    function previewWheel(state, point, deltaY, limits) {
        var current = state || { zoom: 1, panX: 0, panY: 0 };
        var minZoom = limits && limits.min || 1;
        var maxZoom = limits && limits.max || 6;
        var zoom = Number(current.zoom) || 1;
        var beforeX = (point.x - current.panX) / zoom;
        var beforeY = (point.y - current.panY) / zoom;
        var nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom * (deltaY > 0 ? 0.9 : 1.1)));
        if (nextZoom <= 1.001) return { zoom: nextZoom, panX: 0, panY: 0 };
        return {
            zoom: nextZoom,
            panX: point.x - beforeX * nextZoom,
            panY: point.y - beforeY * nextZoom
        };
    }

    function resolveAppearance(stored, themeName) {
        var next = Object.assign({}, APPEARANCE, stored || {});
        if (!SKINS[next.skin]) next.skin = themeName === 'dark' ? 'dark' : (next.eyeCare ? 'soft' : 'minimal');
        if (ACCENT_MOVES[next.accent]) next.accent = ACCENT_MOVES[next.accent];
        if (!FONTS[next.font]) next.font = APPEARANCE.font;
        if (!FONT_SIZES[next.fontSize]) next.fontSize = APPEARANCE.fontSize;
        next.eyeCare = next.skin === 'soft';
        return next;
    }

    function scaleMode(mode) {
        return SCALE_OPTIONS.indexOf(mode) >= 0 ? mode : 'auto';
    }

    function autoScale(metrics) {
        var box = metrics || {};
        var dpr = Math.max(1, Number(box.dpr || 1));
        var width = Math.max(320, Number(box.width || 0));
        var height = Math.max(320, Number(box.height || 0));
        var compact = Math.min(width / 1500, height / 940);
        if (compact < 1) return Math.max(0.68, Math.min(1, compact));
        var longEdge = Math.max(Number(box.screenLong || 0), width, height);
        if (dpr >= 1.35) return 1;
        if (longEdge >= 3600) return 1.22;
        if (longEdge >= 3000) return 1.16;
        if (longEdge >= 2500 && dpr <= 1.15) return 1.1;
        return 1;
    }

    function scaleValue(mode, metrics, externalValue) {
        var next = scaleMode(mode);
        var value = next === 'auto' && Number.isFinite(externalValue) ? externalValue : (next === 'auto' ? autoScale(metrics) : Number(next) / 100);
        return Math.max(0.58, Math.min(1.4, value));
    }

    function compactId(value) {
        return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-').slice(0, 40);
    }

    function hostSeed(baseUrl) {
        try {
            var url = new URL(String(baseUrl || '').trim());
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            var host = url.hostname.toLowerCase();
            for (var i = 0; i < HOST_ALIASES.length; i++) {
                var domain = HOST_ALIASES[i][0];
                if (host === domain || host.slice(-domain.length - 1) === '.' + domain) return HOST_ALIASES[i][1];
            }
            return compactId(host.replace(/^(?:(?:api\d*|www)\.)+/, '') + (url.port ? '-' + url.port : ''));
        } catch (error) {
            return '';
        }
    }

    function freshId(item, peers) {
        if (!item._idDraft) return String(item.id || '');
        var base = hostSeed(item.base_url);
        if (!base) {
            var fromName = compactId(item.name);
            base = fromName === 'api' ? '' : fromName;
        }
        if (base.length < 2) base = String(item.id || '');
        var candidate = base;
        var serial = 2;
        var keyOf = function (value) { return String(value || '').replace(/-/g, '_').toLowerCase(); };
        while (peers.some(function (other) { return other !== item && keyOf(other.id) === keyOf(candidate); })) {
            var tail = '-' + serial++;
            candidate = base.slice(0, Math.max(0, 40 - tail.length)) + tail;
        }
        return candidate;
    }

    function distinct(values) {
        var seen = new Set();
        var out = [];
        (values || []).forEach(function (value) {
            var text = String(value || '').trim();
            if (!text || seen.has(text)) return;
            seen.add(text);
            out.push(text);
        });
        return out;
    }

    function splitSeed(text) {
        return String(text || '').split('|').filter(Boolean);
    }

    function lockedRule(item) {
        var id = String(item.id || '').trim().toLowerCase();
        var name = String(item.name || '').trim().toLowerCase();
        var base = String(item.base_url || '').trim().replace(/\/+$/, '').toLowerCase();
        var host = '';
        try { host = new URL(base).host.toLowerCase(); } catch (error) { host = ''; }
        for (var i = 0; i < LOCKED.length; i++) {
            var rule = LOCKED[i];
            if (id === rule.id || name === rule.name || base === 'https://' + rule.host || host === rule.host) return rule;
        }
        return null;
    }

    function applyCli(item) {
        var protocol = String(item.protocol || '').toLowerCase();
        var seed = CLI_SEEDS[protocol];
        if (!seed) return;
        item.base_url = '';
        item.protocol = protocol;
        var managed = item.model_selection_managed === true;
        if (protocol === 'jimeng') {
            item.image_models = distinct((item.image_models || []).filter(function (model) { return !seed.dropImage[String(model || '').trim()]; }).concat(splitSeed(seed.image)));
            item.video_models = distinct((item.video_models || []).filter(function (model) { return !seed.dropVideo[String(model || '').trim()]; }).concat(splitSeed(seed.video)));
            item.chat_models = distinct(item.chat_models || []);
            return;
        }
        if (protocol === 'codex') {
            var allow = function (model) {
                var token = String(model || '').trim().toLowerCase();
                return !seed.block[token];
            };
            var builtin = {};
            splitSeed(seed.image).forEach(function (model) { builtin[model.toLowerCase()] = true; });
            var savedImage = (item.image_models || []).filter(allow);
            var extras = savedImage.filter(function (model) { return !builtin[String(model || '').trim().toLowerCase()]; });
            item.image_models = managed ? distinct(savedImage) : distinct(splitSeed(seed.image).concat(extras));
            var savedChat = (item.chat_models || []).filter(allow);
            item.chat_models = managed ? distinct(savedChat) : distinct(savedChat.concat(splitSeed(seed.chat)));
            item.video_models = [];
            return;
        }
        item.image_models = managed ? distinct(item.image_models || []) : distinct((item.image_models || []).concat(splitSeed(seed.image)));
        item.chat_models = managed ? distinct(item.chat_models || []) : distinct((item.chat_models || []).concat(splitSeed(seed.chat)));
        item.video_models = [];
    }

    function prepareProviders(list, options) {
        var hooks = options || {};
        var selected = hooks.selectedId || '';
        var working = (list || []).map(function (item) { return Object.assign({}, item); });
        working.forEach(function (item) {
            var previous = item.id;
            item.id = compactId(freshId(item, working));
            if (selected === previous) selected = item.id;
            var locked = lockedRule(item);
            if (locked) {
                item.protocol = locked.protocol;
                item.image_request_mode = locked.mode;
            }
            var protocol = String(item.protocol || '').toLowerCase();
            if (item.id === 'runninghub') protocol = 'runninghub';
            else if (item.id === 'volcengine') protocol = 'volcengine';
            else if (PROTOCOLS.indexOf(protocol) < 0) protocol = 'openai';
            item.protocol = protocol;
            var cli = !!CLI[item.protocol];
            var forced = item.id === 'runninghub' || item.id === 'volcengine' || cli;
            var mode = String(forced ? 'openai' : (item.image_request_mode || '')).trim().toLowerCase();
            var route = String(forced ? 'general' : (item.image_edit_route || '')).trim().toLowerCase();
            item.image_request_mode = IMAGE_MODES[mode] ? mode : 'openai';
            item.image_edit_route = EDIT_ROUTES[route] ? route : 'general';
            if (cli) applyCli(item);
            if (item.id === 'runninghub') item.base_url = item.base_url || 'https://www.runninghub.cn';
            item.image_generation_endpoint = '';
            item.image_edit_endpoint = '';
            item.image_models = distinct(item.image_models || []);
            item.chat_models = distinct(item.chat_models || []);
            item.video_models = distinct(item.video_models || []);
            var labels = item.model_names && typeof item.model_names === 'object' ? item.model_names : {};
            var renamed = Object.create(null);
            item.image_models.concat(item.chat_models, item.video_models).forEach(function (model) {
                var raw = String(model || '').trim();
                var savedLabel = Object.hasOwn(labels, raw) ? labels[raw] : '';
                var label = String(savedLabel || (hooks.displayName ? hooks.displayName(raw, item) : '') || '').trim();
                if (raw && label && label !== raw) renamed[raw] = label;
            });
            item.model_names = renamed;
        });
        var ids = {};
        for (var i = 0; i < working.length; i++) {
            if (ids[working[i].id]) return { error: 'duplicate' };
            ids[working[i].id] = true;
        }
        return { providers: working, selectedId: selected };
    }

    function wireProviders(list) {
        return (list || []).map(function (item) {
            return {
                id: item.id,
                name: item.name,
                base_url: item.base_url,
                protocol: item.id === 'runninghub' ? 'runninghub' : item.id === 'volcengine' ? 'volcengine' : (item.protocol || 'openai'),
                image_request_mode: item.image_request_mode || 'openai',
                image_edit_route: item.image_edit_route || 'general',
                image_generation_endpoint: item.image_generation_endpoint || '',
                image_edit_endpoint: item.image_edit_endpoint || '',
                enabled: item.enabled !== false,
                primary: false,
                image_models: item.image_models || [],
                chat_models: item.chat_models || [],
                video_models: item.video_models || [],
                model_selection_managed: item.model_selection_managed === true,
                model_names: item.model_names && typeof item.model_names === 'object' ? item.model_names : {},
                model_protocols: item.model_protocols && typeof item.model_protocols === 'object' ? item.model_protocols : {},
                volcengine_project_name: item.id === 'volcengine' ? (item.volcengine_project_name || 'default') : '',
                volcengine_region: item.id === 'volcengine' ? (item.volcengine_region || 'cn-beijing') : '',
                volcengine_access_key_id: item.volcengine_access_key_id || undefined,
                volcengine_secret_access_key: item.volcengine_secret_access_key || undefined,
                api_key: item.api_key || undefined,
                wallet_api_key: item.wallet_api_key || undefined,
                clear_key: item._clearKey === true,
                clear_wallet_key: item._clearWalletKey === true,
                clear_volcengine_access_key_id: item._clearVolcengineAccessKey === true,
                clear_volcengine_secret_access_key: item._clearVolcengineSecretKey === true
            };
        });
    }

    markDocument();

    root.XiaomeiShellKernel = {
        isActive: isActive,
        setActive: setActive,
        toggleMember: toggleMember,
        bulkChoice: bulkChoice,
        bulkAll: bulkAll,
        historyDeleteBody: historyDeleteBody,
        assetBatch: assetBatch,
        mediaKind: mediaKind,
        folderRows: folderRows,
        matches: matches,
        previewWheel: previewWheel,
        resolveAppearance: resolveAppearance,
        scaleMode: scaleMode,
        autoScale: autoScale,
        scaleValue: scaleValue,
        prepareProviders: prepareProviders,
        wireProviders: wireProviders
    };
})(typeof window !== 'undefined' ? window : globalThis);
