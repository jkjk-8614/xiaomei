(function (root) {
    'use strict';

    const mediaKinds = new Set(['image', 'video', 'audio']);
    const promptName = /prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向/i;
    const types = new Map([
        ['image', 'image'], ['video', 'video'], ['audio', 'audio'], ['slider', 'slider'],
        ['number', 'number'], ['float', 'number'], ['integer', 'number'], ['int', 'number'],
        ['boolean', 'boolean'], ['bool', 'boolean'],
    ]);
    const mediaPatterns = [
        ['image', /\b(image|img|mask|photo|picture)\b|\.(png|jpe?g|webp|gif|bmp)(\?|$)/i],
        ['video', /\b(video|movie|mp4)\b|\.(mp4|webm|mov|m4v|mkv)(\?|$)/i],
        ['audio', /\b(audio|sound|music|voice)\b|\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i],
    ];
    const optionKeys = ['fieldData', 'options', 'list', 'values', 'enum', 'choices', 'items', 'selectOptions', 'dropdown'];
    const knownOptions = {
        aspectratio: ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3', '21:9', '9:21'],
        ratio: ['1:1', '16:9', '9:16', '21:9', '9:21', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3'],
        resolution: ['1k', '2k', '4k', '8k'], quality: ['low', 'medium', 'high', 'best'],
        scheduler: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform'],
        sampler: ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc'],
    };
    const classicOptions = {
        mode: ['text2img', 'img2img'], instancetype: ['default', 'plus', 'pro'], precision: ['fp16', 'fp32', 'bf16'],
    };
    const keyOf = (nodeId, fieldName) => `${nodeId ?? ''}::${fieldName ?? ''}`;
    const isOptionValue = value => typeof value === 'string' || typeof value === 'number';
    const hasOptionLabel = option => option && typeof option === 'object'
        && ('value' in option || 'label' in option || 'name' in option);

    function fieldKind(field) {
        const type = String(field.fieldType || '').trim().toLowerCase();
        if (types.has(type)) return types.get(type);
        if (type === 'text' && promptName.test(field.fieldName || '')) return 'prompt';
        const sample = `${field.fieldName || ''} ${field.fieldValue || ''}`;
        const media = mediaPatterns.find(([, pattern]) => pattern.test(sample));
        if (media) return media[0];
        return promptName.test(`${field.fieldName || ''} ${field.label || ''} ${field.group || ''}`) ? 'prompt' : 'text';
    }

    function choices(field, classic = false) {
        const candidates = optionKeys.map(key => field[key]);
        if (classic && /^(list|select|dropdown|combo|enum)$/i.test(field.fieldType || '')) candidates.push(field.fieldValue);
        for (const options of candidates) {
            if (!Array.isArray(options) || !options.length) continue;
            if (!classic && !options.every(isOptionValue) && !options.every(hasOptionLabel)) continue;
            const values = options.map(option => hasOptionLabel(option) ? option.value ?? option.label ?? option.name : option);
            const usable = classic ? values.filter(isOptionValue) : values.filter(value => value != null);
            if (usable.length || !classic) return usable.map(String);
        }
        const name = String(field.fieldName || '').trim().toLowerCase();
        const key = classic ? name.replaceAll('_', '') : name === 'aspect_ratio' ? 'aspectratio' : name;
        if (key === 'size') return classic ? ['512', '768', '1024', '1536', '2048'] : ['512', '768', '1024', '1280', '1536', '2048'];
        if (Object.hasOwn(knownOptions, key)) return knownOptions[key];
        return classic && Object.hasOwn(classicOptions, key) ? classicOptions[key] : [];
    }

    function defaultValue(field) {
        const value = Array.isArray(field.fieldValue) ? field.fieldValue[0] : field.fieldValue;
        return value == null || typeof value === 'object' ? '' : String(value);
    }

    function orderedFields(fields) {
        const all = Array.isArray(fields) ? fields.filter(field => field?.fieldName != null) : [];
        const enabled = all.filter(field => field.enabled === true);
        return (enabled.length ? enabled : all).slice().sort((left, right) => {
            const leftImage = fieldKind(left) === 'image';
            const rightImage = fieldKind(right) === 'image';
            if (leftImage !== rightImage) return leftImage ? -1 : 1;
            const imageOrder = leftImage ? (Number(left.imageOrder) || 9999) - (Number(right.imageOrder) || 9999) : 0;
            return imageOrder || String(left.nodeId ?? '').localeCompare(String(right.nodeId ?? ''), undefined, { numeric: true })
                || String(left.fieldName).localeCompare(String(right.fieldName));
        });
    }

    function bindFields(fields, media) {
        const nextIndex = { image: 0, video: 0, audio: 0 };
        return fields.map(field => {
            const kind = fieldKind(field);
            const isMedia = mediaKinds.has(kind);
            const linked = isMedia ? media[kind]?.[nextIndex[kind]++]?.url : undefined;
            return { field, kind, key: keyOf(field.nodeId, field.fieldName), isMedia, linked };
        });
    }

    function pruneInputs(source, missing, { keepLinkedNodes = false } = {}) {
        const workflow = structuredClone(source);
        const touched = new Set();
        const removed = new Set();
        const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
        for (const { nodeId, fieldName } of missing) {
            const id = String(nodeId);
            if (!Object.hasOwn(workflow, id) || !workflow[id]) continue;
            const inputs = workflow[id].inputs;
            if (inputs && typeof inputs === 'object') delete inputs[fieldName];
            else if (!keepLinkedNodes) continue;
            touched.add(id);
        }
        for (const id of touched) {
            const remaining = Object.values(workflow[id].inputs || {});
            if (keepLinkedNodes ? remaining.length : remaining.some(value => !isLink(value))) continue;
            delete workflow[id];
            removed.add(id);
        }
        for (const node of Object.values(workflow)) {
            for (const [name, value] of Object.entries(node?.inputs || {})) {
                if (isLink(value) && removed.has(value[0])) delete node.inputs[name];
            }
        }
        return workflow;
    }

    function uploadUrl(value) {
        const url = String(value || '').trim();
        return /^(https?:\/\/|\/output\/|\/assets\/|\/api\/storage-files\/)/i.test(url) ? url : '';
    }

    root.XiaomeiRunningHubInputs = { fieldKind, keyOf, choices, defaultValue, orderedFields, bindFields, pruneInputs, uploadUrl };
}(window));
