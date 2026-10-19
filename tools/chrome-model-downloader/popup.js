(() => {
  let modelUrl = '';
  const $ = id => document.getElementById(id);
  async function start() {
    const saved = await chrome.storage.local.get('modelReceiver');
    $('receiver').value = saved.modelReceiver || window.MODEL_RECEIVER_DEFAULT;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const url = new URL(tab?.url || '');
      if (url.protocol !== 'https:' || url.username || url.password || url.port
          || !['civitai.com', 'civitai.red', 'www.civitai.com', 'www.civitai.red', 'huggingface.co'].includes(url.hostname)) throw new Error();
      if (url.hostname.includes('civitai') && !/^\/(?:models|model-versions|api\/download\/models)\/\d+(?:\/|$)/.test(url.pathname)) throw new Error();
      if (url.hostname === 'huggingface.co' && !/^\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname)) throw new Error();
      for (const key of [...url.searchParams.keys()]) {
        if (['token', 'key', 'api_key', 'apikey'].includes(key.toLowerCase())) url.searchParams.delete(key);
      }
      url.hash = '';
      modelUrl = url.href;
      $('model').textContent = modelUrl;
      $('send').disabled = false;
    } catch (_) { $('model').textContent = '请先打开 Civitai 或 Hugging Face 的模型页面。'; }
  }
  $('send').onclick = async () => {
    try {
      const receiver = new URL($('receiver').value.trim());
      if (receiver.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(receiver.hostname)
          || receiver.username || receiver.password || receiver.pathname !== '/' || receiver.search || receiver.hash) {
        throw new Error('接收地址需为本机 HTTP 地址，例如 http://127.0.0.1:3000');
      }
      await chrome.storage.local.set({ modelReceiver: receiver.origin });
      await chrome.tabs.create({ url: receiver.origin + '/static/comfyui.html#model-download=' + encodeURIComponent(modelUrl) });
      $('status').textContent = '已打开小美画布，请选择版本、文件和保存目录。';
    } catch (error) { $('status').textContent = error.message; }
  };
  start().catch(() => { $('status').textContent = '无法读取当前标签页，请关闭扩展后重试。'; });
})();
