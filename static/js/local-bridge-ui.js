(function(){
    'use strict';

    const sharedCanvasMode = new URLSearchParams(location.search).get('shared') === '1';

    const EAGLE_SETTINGS_KEY = 'xiaomei_eagle_bridge_settings_v1';
    function fileName(item, fallback='xiaomei-canvas.png'){
        return String(item?.name || fallback).replace(/[\\/:*?"<>|]+/g, '_');
    }
    async function responseJson(response){
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
        return data;
    }
    async function photoshopBridgeStatus(){
        try{
            return await fetch('/api/photoshop-bridge/status').then(responseJson);
        }catch(_){
            return null;
        }
    }
    async function waitForPhotoshopImport(jobId, timeoutMs=8000){
        const deadline = Date.now() + timeoutMs;
        let latest = null;
        while(Date.now() < deadline){
            await new Promise(resolve => setTimeout(resolve, 500));
            try{
                const data = await fetch(`/api/photoshop-bridge/jobs/${encodeURIComponent(jobId)}`).then(responseJson);
                latest = data.job || latest;
                if(latest?.status === 'done' || latest?.status === 'failed') return latest;
            }catch(_){
                break;
            }
        }
        return latest;
    }
    window.sendSmartImageToPhotoshop = async function(node, index=0){
        if(sharedCanvasMode){ toast('共享页不能直接控制分享者电脑上的 Photoshop，请在分享者端操作'); return; }
        const item = imageForDisplay(node?.images?.[index]);
        if(!item?.url){ toast('没有可发送的图片'); return; }
        try{
            const data = await fetch('/api/photoshop-bridge/send', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({url:item.url, name:fileName(item), canvas_id:canvas?.id || '', node_id:node.id})
            }).then(responseJson);
            const jobId = data.job?.id || '';
            const status = await photoshopBridgeStatus();
            const psOnline = Boolean(status?.photoshop?.online || status?.online);
            if(psOnline && jobId){
                const imported = await waitForPhotoshopImport(jobId);
                if(imported?.status === 'done'){
                    toast('图片已导入当前 Photoshop 文档');
                }else if(imported?.status === 'failed'){
                    toast(`已发送，但 Photoshop 导入失败：${imported.error || '请打开 PS 桥接面板查看日志'}`);
                }else{
                    toast(`已发送到 Photoshop，插件正在导入 · ${jobId.slice(0, 8)}`);
                }
            }else{
                toast(`已进入 Photoshop 队列 · ${jobId.slice(0, 8)}；请在 PS 打开“无限画布”桥接插件`);
            }
        }catch(error){ toast(`发送到 Photoshop 失败：${error.message}`); }
    };
    function eagleSettings(){
        try{return JSON.parse(localStorage.getItem(EAGLE_SETTINGS_KEY) || '{}');}catch(_){return {};}
    }
    function askEagleSettings(){
        const old = eagleSettings();
        const base_url = prompt('Eagle 本地 API 地址或端口', old.base_url || 'http://127.0.0.1:41595');
        if(base_url == null) return null;
        const folder_id = prompt('Eagle 文件夹 ID（可留空）', old.folder_id || '');
        if(folder_id == null) return null;
        const tagsText = prompt('标签，用逗号分隔（可留空）', (old.tags || []).join(', '));
        if(tagsText == null) return null;
        const settings = {base_url:base_url.trim(), folder_id:folder_id.trim(), tags:tagsText.split(/[,，]/).map(v=>v.trim()).filter(Boolean)};
        localStorage.setItem(EAGLE_SETTINGS_KEY, JSON.stringify(settings));
        return settings;
    }
    window.sendSmartImageToEagle = async function(node, index=0){
        if(sharedCanvasMode){ toast('共享页不能直接控制分享者电脑上的 Eagle，请在分享者端操作'); return; }
        const item = imageForDisplay(node?.images?.[index]);
        if(!item?.url){ toast('没有可发送的图片'); return; }
        const settings = askEagleSettings();
        if(!settings) return;
        try{
            await fetch('/api/eagle/send', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({...settings, url:item.url, name:fileName(item), annotation:'来自小美画布'})
            }).then(responseJson);
            toast('已发送到 Eagle');
        }catch(error){ toast(`发送到 Eagle 失败：${error.message}`); }
    };

    async function pollPhotoshopCanvasInbox(){
        if(!canvas?.id) return;
        try{
            const data = await fetch(`/api/photoshop-bridge/canvas-inbox?canvas_id=${encodeURIComponent(canvas.id)}`).then(responseJson);
            for(const item of data.items || []){
                const point = item.canvas_point || {};
                const fallback = screenToWorld(innerWidth / 2, innerHeight / 2);
                const node = createImageNodeAt({
                    x:Number.isFinite(Number(point.x)) ? Number(point.x) : fallback.x,
                    y:Number.isFinite(Number(point.y)) ? Number(point.y) : fallback.y
                }, [{url:item.url, name:item.filename || item.layer_name || 'Photoshop Layer.png', kind:'image'}], {select:false, skipUndo:true});
                if(node) node.title = item.layer_name || 'Photoshop 图层';
                await fetch('/api/photoshop-bridge/canvas-inbox/ack', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({item_id:item.id, status:'done'})
                }).then(responseJson);
                render(); scheduleSave(); toast('已从 Photoshop 接收图层');
            }
        }catch(_){}
    }
    // 分享页不应轮询分享者本机的 Photoshop/Eagle 桥接队列；除去无意义的
    // 403 请求，也避免访客页面把本机桥接事件写回共享画布。
    if(!sharedCanvasMode){
        setInterval(pollPhotoshopCanvasInbox, 3000);
        setTimeout(pollPhotoshopCanvasInbox, 1200);
    }
})();
