(function () {
  const { state } = DX;
  const inputRoute = '/api/ai/upload-base64';
  const folderRoute = '/api/local-assets/import-urls';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function parseHost(value) {
    const entered = String(value || '').trim();
    const authority = entered.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i.exec(authority);
    if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return '';
    return authority;
  }

  const httpBase = () => state.host && 'http://' + state.host;
  const wsBase = () => state.host && 'ws://' + state.host;

  function absUrl(value) {
    const path = String(value || '');
    if (!path || !state.host || /^https?:\/\//i.test(path)) return path;
    return httpBase() + (path[0] === '/' ? path : '/' + path);
  }

  async function request(method, path, body, headers) {
    if (!state.host) throw new Error('请先连接小美画布');
    const options = { method, cache: 'no-store' };
    if (headers) options.headers = headers;
    if (body !== undefined) {
      options.headers = { ...headers, 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(httpBase() + path, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      if (response.ok) throw new Error('服务返回了无法读取的数据');
    }
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : (data?.detail?.message || '');
      const error = new Error(detail ? `${detail}（HTTP ${response.status}）` : `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const apiGet = (path, headers) => request('GET', path, undefined, headers);
  const apiSend = (method, path, body, headers) => request(method, path, body, headers);

  function needsJpeg(url) {
    return /\.(?:webp|bmp|avif|tiff?|hei[cf])$/i.test(String(url || '').split(/[?#]/, 1)[0]);
  }

  function mediaUrl(route, url, width) {
    const size = width ? '&w=' + encodeURIComponent(width) : '';
    return absUrl(route + '?url=' + encodeURIComponent(url) + size);
  }

  function displayUrl(url, width) {
    return needsJpeg(url) ? mediaUrl('/api/image-jpeg', url, width) : absUrl(url);
  }

  function thumbUrl(url, width) {
    return /^\/(?:assets|output)\//.test(url)
      ? mediaUrl('/api/media-preview', url, width || 256)
      : absUrl(url);
  }

  async function fetchBytes(url) {
    const response = await fetch(absUrl(url));
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    return response.arrayBuffer();
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    let symbols = '';
    let pending = 0;
    let bits = 0;
    for (const byte of bytes) {
      pending = (pending << 8) | byte;
      bits += 8;
      while (bits >= 6) {
        bits -= 6;
        symbols += alphabet[(pending >>> bits) & 63];
      }
      if (symbols.length >= 8192) {
        chunks.push(symbols);
        symbols = '';
      }
    }
    if (bits) symbols += alphabet[(pending << (6 - bits)) & 63];
    chunks.push(symbols, ['', '==', '='][bytes.length % 3]);
    return chunks.join('');
  }

  async function importIntoFolder(folder, data, name, contentType) {
    if (!data) throw new Error('图片为空，无法上传');
    const result = await apiSend('POST', folderRoute, {
      folder,
      items: [{ data: `data:${contentType};base64,${data}`, name, content_type: contentType }],
    });
    const file = result.files?.[0];
    if (!file?.url) throw new Error(result.items?.[0]?.error || '服务未返回已导入的素材');
    return file.url;
  }

  async function uploadBase64Raw(data, name, contentType = 'image/png') {
    if (!data) throw new Error('图片为空，无法上传');
    try {
      const uploaded = await apiSend('POST', inputRoute, { data, name, content_type: contentType });
      const url = uploaded.files?.[0]?.url;
      if (url) return url;
      throw new Error('服务未返回已上传的图片');
    } catch (error) {
      if (![404, 405, 501].includes(error.status)) throw error;
      return importIntoFolder('', data, name, contentType);
    }
  }

  const uploadInputBase64 = (buffer, name) => uploadBase64Raw(toBase64(buffer), name);
  const uploadToFolder = (folder, buffer, name) => importIntoFolder(folder, toBase64(buffer), name, 'image/png');

  DX.net = {
    parseHost, httpBase, wsBase, absUrl, thumbUrl, displayUrl, needsJpeg,
    apiGet, apiSend, fetchBytes, toBase64, uploadInputBase64, uploadBase64Raw, uploadToFolder,
  };
})();
