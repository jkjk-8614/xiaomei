(function(global){
    'use strict';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const definitions = Object.freeze({
        'smart-table': {title:'多维表格', inputs:['text','table'], outputs:['table','text']},
        'smart-timeline': {title:'视频时间线', inputs:['image','video','audio'], outputs:['video']},
        'smart-prompt': {title:'LLM / 提示词', inputs:['text','image','video','table'], outputs:['text']},
        'smart-paint': {title:'绘画', inputs:['text','image','video','table'], outputs:['image','video']},
        'smart-upload': {title:'上传', inputs:[], outputs:['image','video','audio']},
        'smart-agent': {title:'Agent', inputs:['text','image','video','table'], outputs:['text']},
        'smart-compare': {title:'对比', inputs:['image'], outputs:[]}
    });
    function typeOfMedia(item){
        const kind = String(item?.kind || item?.type || '').toLowerCase();
        if(['image','video','audio'].includes(kind)) return kind;
        const url = String(item?.url || '').split('?')[0].toLowerCase();
        if(/\.(mp4|mov|webm|m4v)$/.test(url)) return 'video';
        if(/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(url)) return 'audio';
        return 'image';
    }
    function outputTypes(node){
        if(node?.type === 'smart-table') return ['table','text'];
        if(node?.type === 'smart-timeline') return node.timelineOutput?.url ? ['video'] : [];
        if(node?.type === 'smart-prompt' || node?.type === 'smart-agent') return ['text'];
        const media = (node?.images || []).filter(item => item?.url).map(typeOfMedia);
        return [...new Set(media.length ? media : definitions[node?.type]?.outputs || [])];
    }
    function canConnect(from, to){
        const accepts = definitions[to?.type]?.inputs;
        if(!accepts) return true;
        if(!accepts.length) return false;
        const offered = outputTypes(from);
        return offered.some(type => accepts.includes(type));
    }
    function normalizeTable(node){
        node.columns = Array.isArray(node.columns) && node.columns.length ? node.columns.slice(0,20).map(x => String(x).slice(0,80)) : ['字段','内容'];
        node.rows = Array.isArray(node.rows) ? node.rows.slice(0,200).map(row => Array.isArray(row) ? node.columns.map((_, index) => String(row[index] ?? '').slice(0,2000)) : node.columns.map(() => '')) : [['','']];
        node.w = Math.max(380, Number(node.w) || 500);
        node.h = Math.max(280, Number(node.h) || 360);
        return node;
    }
    function tableText(node){
        normalizeTable(node);
        const rows = node.rows.filter(row => row.some(cell => cell.trim()));
        if(!rows.length) return '';
        return [node.columns.join('\t'), ...rows.map(row => row.join('\t'))].join('\n');
    }
    function tableHtml(node){
        normalizeTable(node);
        return `<div class="smart-data-card"><div class="smart-data-head"><strong>多维表格</strong><span>${node.rows.length} 行 · ${node.columns.length} 列</span></div>
            <div class="smart-data-scroll"><table><thead><tr>${node.columns.map((column, index) => `<th><input class="smart-data-control" data-table-header="${index}" value="${esc(column)}" aria-label="第 ${index+1} 列名称"></th>`).join('')}</tr></thead>
            <tbody>${node.rows.map((row, rowIndex) => `<tr>${row.map((cell, colIndex) => `<td><input class="smart-data-control" data-table-row="${rowIndex}" data-table-col="${colIndex}" value="${esc(cell)}" aria-label="第 ${rowIndex+1} 行第 ${colIndex+1} 列"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
            <div class="smart-data-actions"><button class="smart-data-control" data-table-action="row" type="button">＋ 行</button><button class="smart-data-control" data-table-action="column" type="button" ${node.columns.length >= 20 ? 'disabled' : ''}>＋ 列</button><button class="smart-data-control" data-table-action="remove-row" type="button" ${!node.rows.length ? 'disabled' : ''}>删除末行</button></div></div>`;
    }
    function timelineMedia(node, upstream){
        const found = [];
        for(const source of upstream){
            const media = source?.type === 'smart-timeline' && source.timelineOutput?.url ? [source.timelineOutput] : source?.images || [];
            for(const item of media){
                if(!item?.url) continue;
                const kind = typeOfMedia(item);
                if(!['video','image','audio'].includes(kind)) continue;
                found.push({url:item.url, kind, name:item.name || item.url.split('/').pop() || kind});
            }
        }
        const saved = new Map((node.timelineClips || []).map(item => [item.url, item]));
        const ordered = found.map(item => ({...item, ...saved.get(item.url), kind:item.kind, url:item.url}));
        const rank = new Map((node.timelineOrder || []).map((url,index) => [url,index]));
        ordered.sort((a,b) => (rank.get(a.url) ?? 10000) - (rank.get(b.url) ?? 10000));
        return ordered;
    }
    function timelineHtml(node, upstream){
        const clips = timelineMedia(node, upstream);
        const visuals = clips.filter(item => item.kind !== 'audio');
        const audios = clips.filter(item => item.kind === 'audio');
        const row = (item, index, list) => `<div class="smart-timeline-clip" data-timeline-url="${esc(item.url)}"><span class="smart-timeline-kind">${item.kind === 'video' ? '视频' : item.kind === 'image' ? '图片' : '音频'}</span><span class="smart-timeline-name" title="${esc(item.name)}">${esc(item.name)}</span><button class="smart-data-control" data-timeline-move="up" data-timeline-index="${index}" type="button" ${index===0?'disabled':''} title="上移">↑</button><button class="smart-data-control" data-timeline-move="down" data-timeline-index="${index}" type="button" ${index===list.length-1?'disabled':''} title="下移">↓</button><label>时长 <input class="smart-data-control" data-timeline-field="duration" data-timeline-index="${index}" data-timeline-kind="${item.kind === 'audio' ? 'audio' : 'visual'}" type="number" min="0.1" max="120" step="0.1" value="${esc(item.duration || (item.kind === 'image' ? 3 : 5))}"></label>${item.kind === 'image' ? '' : `<label>入点 <input class="smart-data-control" data-timeline-field="source_start" data-timeline-index="${index}" data-timeline-kind="${item.kind === 'audio' ? 'audio' : 'visual'}" type="number" min="0" step="0.1" value="${esc(item.source_start || 0)}"></label>`}${item.kind === 'audio' ? `<label>时间线位置 <input class="smart-data-control" data-timeline-field="timeline_start" data-timeline-index="${index}" data-timeline-kind="audio" type="number" min="0" step="0.1" value="${esc(item.timeline_start || 0)}"></label><label>音量 <input class="smart-data-control" data-timeline-field="volume" data-timeline-index="${index}" data-timeline-kind="audio" type="number" min="0" max="2" step="0.1" value="${esc(item.volume ?? 1)}"></label>` : ''}</div>`;
        return `<div class="smart-timeline-card"><div class="smart-data-head"><strong>视频时间线</strong><span>${visuals.length} 画面 · ${audios.length} 音频</span></div>
            <div class="smart-timeline-scroll"><div class="smart-timeline-section">画面顺序</div>${visuals.length ? visuals.map((item,index) => row(item,index,visuals)).join('') : '<p>连接视频或图片节点，按顺序编排画面。</p>'}
            <div class="smart-timeline-section">配音与音乐</div>${audios.length ? audios.map((item,index) => row(item,index,audios)).join('') : '<p>连接音频节点可加入配音或音乐。</p>'}
            <div class="smart-timeline-section">字幕</div><textarea class="smart-data-control smart-timeline-caption" placeholder="输入一段字幕；留空则不添加">${esc(node.timelineCaption || '')}</textarea>
            <div class="smart-timeline-section">输出画幅</div><div class="smart-timeline-size"><label>宽 <input class="smart-data-control" data-timeline-setting="width" type="number" min="256" max="3840" value="${esc(node.timelineWidth || 1080)}"></label><label>高 <input class="smart-data-control" data-timeline-setting="height" type="number" min="256" max="3840" value="${esc(node.timelineHeight || 1920)}"></label></div></div>
            <div class="smart-data-actions"><span>${esc(node.timelineError || node.timelineStatus || '')}</span><button class="smart-data-control smart-timeline-export" type="button" ${!visuals.length || node.timelineExporting ? 'disabled' : ''}>${node.timelineExporting ? '正在导出…' : '导出 MP4'}</button></div>
            ${node.timelineOutput?.url ? `<video controls preload="metadata" src="${esc(node.timelineOutput.url)}"></video><a href="${esc(node.timelineOutput.url)}" download>下载成片</a>` : ''}</div>`;
    }
    global.SmartCanvasDataVideo = {definitions, canConnect, typeOfMedia, tableText, tableHtml, timelineMedia, timelineHtml, normalizeTable};
})(window);
