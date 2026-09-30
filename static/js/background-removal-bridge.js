(function(global){
    'use strict';

    async function responseJson(response){
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
        return data;
    }

    async function getStatus(){
        return fetch('/api/background-removal/status', {cache:'no-store'}).then(responseJson);
    }

    async function getModelDownload(modelId){
        return fetch(`/api/background-removal/models/${encodeURIComponent(modelId)}/download`, {cache:'no-store'}).then(responseJson);
    }

    function modelSizeLabel(bytes){
        const value = Number(bytes || 0);
        if(value <= 0) return '模型';
        return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB 模型`;
    }

    async function ensureModel(model, onProgress){
        if(!model?.id) throw new Error('本地抠图模型信息为空');
        let current = model;
        if(!current.downloaded && !current.downloading){
            const confirmed = window.confirm(
                `首次使用需要下载「${current.name || '本地抠图模型'}」（${modelSizeLabel(current.size)}）。\n模型只在本机运行，不会上传原图。现在下载吗？`
            );
            if(!confirmed) return null;
            current = await fetch(`/api/background-removal/models/${encodeURIComponent(current.id)}/download`, {
                method:'POST'
            }).then(responseJson);
        }
        const total = Number(current.total_bytes || current.size || 0);
        for(let attempt = 0; attempt < 2250; attempt++){
            if(current.downloaded || current.status === 'downloaded') return current;
            if(current.status === 'failed') throw new Error(current.error || `${current.name || '抠图模型'} 下载失败`);
            const done = Number(current.downloaded_bytes || 0);
            const percent = total > 0 ? Math.min(100, Math.floor(done / total * 100)) : 0;
            if(typeof onProgress === 'function') onProgress(percent, total, current);
            await new Promise(resolve => setTimeout(resolve, 800));
            current = await getModelDownload(model.id);
        }
        throw new Error('抠图模型下载超时，请检查网络后重试');
    }

    async function ensureEngine(options={}){
        const status = await getStatus();
        const engine = status.engine || {};
        if(engine.available === false){
            throw new Error(engine.message || '本地抠图运行环境不可用，请检查 ONNX Runtime 和 GPU 驱动');
        }
        const modelId = String(options.modelId || engine.default_model_id || 'bria-rmbg-2.0');
        let model = (status.models || []).find(item => item?.id === modelId);
        if(!model) model = await getModelDownload(modelId);
        if(!model?.available) throw new Error(model?.error || `找不到本地抠图模型：${modelId}`);
        const ready = await ensureModel(model, options.onDownloadProgress);
        if(!ready) return null;
        const provider = String(engine.provider || engine.preferred_provider || 'CPUExecutionProvider');
        const device = String(engine.device || (engine.device_is_gpu ? 'GPU' : 'CPU'));
        return {
            backend:'onnx',
            modelId:ready.id || model.id,
            modelName:ready.name || model.name || '本地抠图模型',
            device,
            deviceIsGpu:Boolean(engine.device_is_gpu),
            provider,
            providerVerified:Boolean(engine.provider_verified),
        };
    }

    const bridge = Object.freeze({ensureEngine, getModelDownload, getStatus});
    global.XiaomeiBackgroundRemovalBridge = bridge;
})(window);
