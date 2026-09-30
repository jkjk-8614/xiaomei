(function(){
    'use strict';

    const sharedCanvasMode = new URLSearchParams(location.search).get('shared') === '1';

    async function responseJson(response){
        const data = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
        return data;
    }

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
    // 分享页不应轮询分享者本机的 Photoshop 收件箱，避免访客页面把本机
    // 桥接事件写回共享画布。
    if(!sharedCanvasMode){
        setInterval(pollPhotoshopCanvasInbox, 3000);
        setTimeout(pollPhotoshopCanvasInbox, 1200);
    }
})();
