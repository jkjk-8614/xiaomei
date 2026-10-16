(function(){
    'use strict';
    function semanticSnapshot(source){
        const result = {nodes:new Map(), connections:'', revision:Number(source?.updated_at || 0)};
        for(const node of (source?.nodes || [])){
            if(!node?.id) continue;
            const media = (node.images || []).filter(item => item?.url).map(item => String(item.asset_ref_id || item.url || '').slice(0,200));
            const kind = String(node.type || '');
            result.nodes.set(String(node.id), {
                kind, media:JSON.stringify(media), mediaCount:media.length,
                resultCount:kind === 'smart-paint' || (kind === 'smart-upload' && node.runAt) ? media.length : 0,
                finishedAt:Number(node.runFinishedAt || 0),
                assetCount:(kind === 'smart-upload' && !node.runAt) || kind === 'smart-image' ? media.length : 0,
                prompt:String(node.promptDraftText || node.text || node.prompt || '').slice(0,500),
                error:String(node.runError || node.promptRunError || '').slice(0,200),
                settings:JSON.stringify(node.runSettings || {}),
            });
        }
        result.connections = JSON.stringify((source?.connections || []).filter(item => item?.from && item?.to)
            .map(item => [item.from,item.to,item.kind || 'flow',item.input_slot || ''].join(':')).sort());
        return result;
    }
    function semanticTrigger(before, after){
        if(!before) return '';
        let added = false, deleted = false, changed = false, prompt = false, assets = false, removedAssets = false, success = false, failed = false;
        for(const [id, node] of after.nodes){
            const old = before.nodes.get(id);
            if(!old){added = true; if(node.assetCount) assets = true; if(node.resultCount) success = true; if(node.error) failed = true; continue;}
            if(node.error && node.error !== old.error) failed = true;
            if(node.resultCount > old.resultCount || (node.resultCount && node.media !== old.media && node.finishedAt > old.finishedAt)) success = true;
            if(node.assetCount > old.assetCount) assets = true;
            if(node.assetCount < old.assetCount) removedAssets = true;
            if(node.prompt !== old.prompt) prompt = true;
            if(node.media !== old.media || node.kind !== old.kind || node.settings !== old.settings) changed = true;
        }
        for(const id of before.nodes.keys()) if(!after.nodes.has(id)){
            deleted = true; if(before.nodes.get(id).assetCount) removedAssets = true;
        }
        if(failed) return 'task_failed';
        if(assets) return 'assets_added';
        if(removedAssets) return 'asset_removed';
        if(success) return 'task_succeeded';
        if(deleted) return 'node_deleted';
        if(added) return 'node_added';
        if(prompt) return 'prompt_committed';
        if(before.connections !== after.connections) return 'connection_changed';
        if(changed) return 'node_content_changed';
        return '';
    }
    window.ProjectAgentEvents = {snapshot:semanticSnapshot, trigger:semanticTrigger};
})();
