(function () {
  const { net } = DX;
  const rows = (value) => Array.isArray(value) ? value : [];
  const text = (value) => String(value ?? '');
  const segment = encodeURIComponent;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const apiTask = '/api/canvas-image-tasks';
  const comfyTask = '/api/canvas-comfy-tasks';
  const rhTask = '/api/runninghub/workflow-submit';

  function options(value) {
    return rows(value).filter((option) => option != null).map((option) => (
      typeof option === 'object'
        ? { value: option.value, label: option.label ?? option.value }
        : { value: option, label: text(option) }
    )).filter(({ value: key }) => key != null && key !== '');
  }

  function isCount(field) {
    return /^(n|count|number|num_images|batch_size)$/.test(field.key) || ['数量', '张数'].includes(field.label);
  }

  function fallbackApiFields() {
    return [
      { key: 'size', type: 'size', label: '尺寸', ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'],
        resolutions: [{ value: '1k', label: '1K' }, { value: '2k', label: '2K' }] },
      { key: 'n', type: 'int', label: '数量', options: [1, 2, 4], default: 1 },
      { key: 'reference_images', type: 'refs', label: '参考图', max: 3 },
    ];
  }

  function apiFields(fields) {
    return rows(fields).filter((field) => field?.key && field.type !== 'notice' && field.key !== 'quality')
      .map((field) => {
        const choices = options(field.options);
        const picker = field.type === 'dropdown' || isCount(field) || ['picker', 'dropdown'].includes(field.control);
        return { ...field, choices: !choices.length && isCount(field) ? options([1, 2, 4]) : choices, picker };
      });
  }

  const bool = (value) => value === true || value === 1 || /^(true|1)$/i.test(text(value));
  const imageField = /(?:^|[^a-z])(?:image|img|mask|photo)(?:[^a-z]|$)/i;

  function workflowField(field, descriptor) {
    const { key, label, kind, input, target } = descriptor;
    const choices = options(field.options);
    const numeric = kind === 'number' || kind === 'slider';
    const type = kind === 'image' ? 'image'
      : kind === 'boolean' ? 'bool'
      : choices.length ? 'dropdown'
      : numeric ? 'number' : 'textarea';
    const fallback = field.default;
    const initial = type === 'bool' ? bool(fallback)
      : type === 'dropdown' && !choices.some(({ value }) => text(value) === text(fallback))
        ? choices[0].value : fallback;
    return {
      key, label, input, target, type, choices: type === 'image' ? [] : choices, picker: type === 'dropdown',
      default: initial, min: field.min, max: field.max, step: field.step,
      random_enabled: field.random_enabled === true,
    };
  }

  function runningHubFields(workflow) {
    return rows(workflow?.fields)
      .filter((field) => field.enabled && field.nodeId != null && field.fieldName)
      .map((field) => workflowField({ ...field, default: field.fieldValue }, {
        key: text(field.nodeId) + '.' + field.fieldName,
        label: field.label || field.fieldName,
        input: field.fieldName,
        target: field.nodeId,
        kind: text(field.fieldType).toLowerCase(),
      }));
  }

  function comfyFields(config) {
    return rows(config?.fields).filter((field) => field.id).map((field) => workflowField(field, {
      key: field.id,
      label: field.name || field.id,
      input: field.input,
      target: field.node,
      kind: imageField.test([field.id, field.input, field.name].join(' ')) ? 'image' : field.type,
    }));
  }

  const seedName = (field) => /seed|noise|随机|种子|噪/i.test([field.key, field.label, field.input].join(' '));
  const numeric = (field) => field.type === 'number' || field.type === 'int';
  const finite = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);

  function canRandomize(field) {
    return numeric(field) && (field.random_enabled || seedName(field));
  }

  function randomNumber(field) {
    const low = Math.ceil(finite(field.min) ?? (seedName(field) ? 1 : 0));
    const limit = seedName(field) ? 4294967295 : 999999;
    const declared = Math.floor(finite(field.max) ?? limit);
    const high = Math.max(low, seedName(field) ? Math.min(limit, declared) : declared);
    return low + Math.floor(Math.random() * (high - low + 1));
  }

  function sizeDraft(field) {
    return {
      ratio: field.default?.ratio || '1:1',
      res: field.default?.resolution || '1k',
      w: field.default?.width || 1024,
      h: field.default?.height || 1024,
    };
  }

  function initialValues(fields) {
    const values = new Map();
    for (const field of fields) {
      if (field.type === 'refs') continue;
      const value = field.type === 'size' ? sizeDraft(field) : field.default;
      values.set(field.key, (value == null || value === '') && canRandomize(field) ? randomNumber(field) : value);
    }
    return values;
  }

  function resolutionChoices(field) {
    const available = new Map(options(field.resolutions).map((option) => [text(option.value), option]));
    for (const [value, label] of [['doc', '画布尺寸'], ['custom', '自定义']]) {
      if (!available.has(value)) available.set(value, { value, label });
    }
    return [...available.values()];
  }

  function imageSize(selection, documentSize) {
    if (selection.res === 'auto') return 'auto';
    let { w, h } = selection;
    if (selection.res === 'doc') ({ w, h } = documentSize || { w: 1024, h: 1024 });
    else if (selection.res !== 'custom') {
      const [rw, rh] = text(selection.ratio).split(':').map(Number);
      const base = ({ '1k': 1024, '2k': 2048, '4k': 4096 })[selection.res] || 1024;
      if (rw > 0 && rh > 0) {
        const max = Math.max(rw, rh);
        w = Math.round(base * rw / max);
        h = Math.round(base * rh / max);
      } else {
        w = h = base;
      }
    }
    const align = (value) => Math.max(64, Math.ceil((finite(value) || 1024) / 16) * 16);
    return align(w) + 'x' + align(h);
  }

  function apiPayload(form) {
    const payload = { prompt: form.prompt, provider_id: form.entry, model: form.model,
      reference_images: form.refs.map(({ url, name }) => ({ url, name, kind: 'image' })) };
    for (const field of form.fields) {
      const value = form.values.get(field.key);
      if (value === undefined || field.type === 'refs') continue;
      if (field.type === 'size') payload[field.key] = imageSize(value, form.docSize);
      else payload[field.key] = field.type === 'int' ? Number(value) : value;
    }
    return payload;
  }

  function comfyPayload(form) {
    const params = Object.create(null);
    for (const field of form.fields) {
      if (!field.target || !field.input || !form.values.has(field.key)) continue;
      let value = form.values.get(field.key);
      if (numeric(field)) {
        const number = finite(value);
        if (number !== undefined) value = finite(field.step) < 1 ? number : Math.round(number);
      } else if (field.type === 'bool') {
        value = bool(value);
      } else if (field.type === 'dropdown' && /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(text(value).trim())) {
        value = Number(value);
      }
      const node = params[field.target] ||= Object.create(null);
      node[field.input] = value;
    }
    return { workflow_json: form.entry, params, type: 'workflow-test', client_id: '' };
  }

  async function uploadToRunningHub(url, useWallet) {
    const response = await net.apiSend('POST', '/api/runninghub/upload-asset', { url, useWallet });
    const value = response.data?.fileName;
    if (!value) throw new Error('RunningHub 未返回上传文件名');
    return value;
  }

  async function rhPayload(form, current) {
    const nodeInfoList = [];
    for (const field of form.fields) {
      const attachment = form.images.get(field.key);
      let value = form.values.get(field.key);
      if (attachment) {
        const names = attachment.remoteNames;
        if (!names.has(form.wallet)) {
          if (!current()) return null;
          names.set(form.wallet, await uploadToRunningHub(attachment.url, form.wallet));
        }
        value = names.get(form.wallet);
      }
      nodeInfoList.push({ nodeId: field.target, fieldName: field.input, fieldValue: text(value) });
    }
    return { workflowId: form.entry, nodeInfoList, useWallet: form.wallet };
  }

  const routes = {
    api: {
      async catalog() {
        const response = await net.apiGet('/api/providers');
        return rows(response.providers || response.api_providers)
          .filter((item) => item.enabled !== false && item.id && item.id !== 'runninghub' && item.id !== 'modelscope'
            && item.protocol !== 'runninghub' && rows(item.image_models).length)
          .map((item) => ({ value: item.id, label: item.name || item.id, models: item.image_models }));
      },
      async fields(provider, model) {
        const url = '/api/image-params?provider_id=' + segment(provider) + '&model=' + segment(model);
        try {
          const schema = await net.apiGet(url);
          const fields = apiFields(schema.fields);
          if (fields.length) return fields;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        return apiFields(fallbackApiFields());
      },
      submit: apiTask, payload: apiPayload, query: (id) => apiTask + '/' + segment(id), interval: 2000, attempts: 200,
    },
    rh: {
      async catalog() {
        const data = await net.apiGet('/api/runninghub/workflows');
        return rows(data.workflows).map((item) => ({ value: text(item.workflowId), label: item.title || item.workflowId }));
      },
      async fields(id) {
        const data = await net.apiGet('/api/runninghub/workflows/' + segment(id));
        return runningHubFields(data.workflow);
      },
      submit: rhTask, payload: rhPayload,
      query: (id, form) => '/api/runninghub/query?taskId=' + segment(id) + '&useWallet=' + form.wallet,
      interval: 2500, attempts: 240,
    },
    comfy: {
      async catalog() {
        const data = await net.apiGet('/api/workflows');
        return rows(data.workflows).map((item) => ({ value: item.name, label: item.title || item.name }));
      },
      async fields(name) {
        const data = await net.apiGet('/api/workflows/' + segment(name));
        return comfyFields(data.config);
      },
      submit: comfyTask, payload: comfyPayload, query: (id) => comfyTask + '/' + segment(id), interval: 1600, attempts: 900,
    },
  };

  function outputStatus(mode, response) {
    const rh = mode === 'rh';
    const data = (rh ? response.data : response) || {};
    const status = text(data.status).toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(data.error || data.failReason || (status.startsWith('cancel') ? '任务已取消' : '服务未完成生成'));
    }
    if (rh ? status === 'success' : status === 'succeeded') {
      const result = data.result || {};
      return rows(rh ? data.urls : (result.images || result.outputs))
        .map((item) => typeof item === 'string' ? item : item?.url).filter(Boolean);
    }
    return null;
  }

  async function generate(mode, form, current) {
    const route = routes[mode];
    const payload = await route.payload(form, current);
    if (!current()) return null;
    const task = await net.apiSend('POST', route.submit, payload);
    if (!current()) return null;
    const id = mode === 'rh' ? task.data?.taskId : task.task_id;
    if (!id) throw new Error('服务未返回任务 ID');
    const query = route.query(id, form);
    let failures = 0;
    for (let i = 0; i < route.attempts && current(); i += 1) {
      let response;
      try {
        response = await net.apiGet(query);
        failures = 0;
      } catch (error) {
        if (!current()) return null;
        failures += 1;
        if (failures >= 3 || (error.status >= 400 && error.status < 500)) throw error;
      }
      if (!current()) return null;
      if (response) {
        const result = outputStatus(mode, response);
        if (result) return result;
      }
      await delay(route.interval);
    }
    if (!current()) return null;
    throw new Error('任务等待超时，请到小美画布查看任务状态');
  }

  async function attach(mode, png, wallet, current) {
    if (!current()) return null;
    const { buffer, name } = png;
    const url = await net.uploadInputBase64(buffer, name);
    if (!current()) return null;
    let value = url;
    if (mode === 'rh') value = await uploadToRunningHub(url, wallet);
    if (mode === 'comfy') {
      const response = await net.apiSend('POST', '/api/comfyui/upload-base64', {
        data: net.toBase64(buffer), name, content_type: 'image/png',
      });
      value = response.name;
      if (!value) throw new Error('ComfyUI 未返回上传文件名');
    }
    if (!current()) return null;
    return { url, name, value, remoteNames: mode === 'rh' ? new Map([[wallet, value]]) : null };
  }

  DX.generationTasks = {
    routes, options, isCount, resolutionChoices, canRandomize, randomNumber, initialValues, generate, attach,
  };
})();
