/* Shared selection sessions. Targets own references, persistence and model rules. */
(function(){
    'use strict';
    const factories = new Map();
    const tileSelector = '.image-node .image-wrap[data-image-index],.image-node .thumb-item[data-image-index]';
    const uiSelector = '.composer,.canvas-agent-panel,.smart-minimap,.canvas-nav-panel,.reference-picker-bar,.smart-selection-toolbar';
    let host = null, session = null, bar = null, observer = null, frame = 0, press = null;
    let tiles = [], tilesDirty = true, space = false;
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    function status(message=''){
        if(!bar || !session) return;
        const refs = session.adapter.read();
        const error = message || session.adapter.validate(refs) || '';
        bar.querySelector('[data-picker-count]').textContent = `已选 ${refs.length} 张`;
        bar.querySelector('[data-picker-hint]').textContent = error || '点击图片添加 · 再次点击取消';
        bar.classList.toggle('has-error', Boolean(error));
        bar.querySelector('[data-picker-hint]').setAttribute('role', error ? 'alert' : 'status');
    }
    function alive(){
        if(!session) return false;
        if(session.context !== host.context() || !session.adapter.alive()){
            finish('target-unavailable');
            return false;
        }
        return true;
    }
    function refresh(){
        if(!alive()) return;
        if(tilesDirty){
            tiles = [...host.root.querySelectorAll(tileSelector)];
            tilesDirty = false;
        }
        const refs = session.adapter.read();
        const ranks = new Map(refs.map((ref, index) => [host.identity(ref), index + 1]));
        const sourceCache = new Map();
        for(const tile of tiles){
            if(!tile.isConnected) continue;
            const source = host.resolve(tile,sourceCache);
            const reason = !source ? '引用已失效' : session.adapter.accept(source);
            const rank = source ? ranks.get(host.identity(source)) : 0;
            tile.classList.toggle('reference-picker-source', Boolean(source));
            tile.classList.toggle('reference-picker-unavailable', Boolean(reason));
            tile.classList.toggle('reference-picker-selected', Boolean(rank));
            if(!tile.hasAttribute('data-picker-original-title')) tile.dataset.pickerOriginalTitle = tile.getAttribute('title') || '';
            const title = reason || (rank ? `已选 图${rank} · 再次点击取消` : '点击图片添加');
            if(tile.title !== title) tile.title = title;
            if(rank) tile.dataset.pickerOrder = String(rank);
            else delete tile.dataset.pickerOrder;
        }
        status();
    }
    function invalidate(){
        if(!session || frame) return;
        frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    }
    function finish(reason='done'){
        if(!session) return;
        const previous = session;
        session = null;
        press = null;
        space = false;
        if(frame) cancelAnimationFrame(frame);
        frame = 0;
        observer?.disconnect();
        observer = null;
        for(const tile of tiles){
            tile.classList.remove('reference-picker-source','reference-picker-selected','reference-picker-unavailable');
            delete tile.dataset.pickerOrder;
            if(tile.hasAttribute('data-picker-original-title')){
                if(tile.dataset.pickerOriginalTitle) tile.title = tile.dataset.pickerOriginalTitle;
                else tile.removeAttribute('title');
                delete tile.dataset.pickerOriginalTitle;
            }
        }
        tiles = [];
        tilesDirty = true;
        document.body.classList.remove('reference-picker-active');
        bar?.remove();
        bar = null;
        previous.adapter.finish?.({reason, changed:previous.changed});
        window.dispatchEvent(new CustomEvent('smart-reference-picker-change',{detail:{active:false,reason}}));
    }
    function start({type, targetId}){
        if(!host || !factories.has(type)) return false;
        finish('switch-target');
        const adapter = factories.get(type)(targetId);
        if(!adapter?.alive()) return false;
        session = {type, targetId, adapter, context:host.context(), changed:false};
        adapter.begin?.();
        document.body.classList.add('reference-picker-active');
        bar = document.createElement('div');
        bar.className = 'reference-picker-bar';
        bar.setAttribute('aria-label','从画布选择参考图');
        bar.innerHTML = '<strong data-picker-count></strong><span data-picker-hint></span><button type="button" data-reference-picker-done>完成选择</button>';
        bar.querySelector('button').onclick = () => finish();
        document.body.appendChild(bar);
        observer = new MutationObserver(records => {
            if(records.some(record => [...record.addedNodes,...record.removedNodes].some(node => node.nodeType === 1))){
                tilesDirty = true;
                invalidate();
            }
        });
        observer.observe(host.root,{childList:true,subtree:true});
        refresh();
        window.dispatchEvent(new CustomEvent('smart-reference-picker-change',{detail:{active:true,type,targetId}}));
        return true;
    }
    function toggle(source){
        if(!alive() || !source) return false;
        const current = session;
        const refs = current.adapter.read();
        const existing = refs.find(ref => current.adapter.same(ref,source));
        const error = existing ? '' : current.adapter.accept(source) || current.adapter.validate([...refs,source]);
        if(error){ status(error); host.message?.(error); return false; }
        if(!current.changed){ current.adapter.beforeChange?.(); current.changed = true; }
        if(existing) current.adapter.remove(existing);
        else current.adapter.add(source);
        current.adapter.sync();
        refresh();
        return true;
    }
    function tileAt(event){
        const tile = event.target?.closest?.(tileSelector);
        return tile && host.root.contains(tile) ? tile : null;
    }
    function inCanvas(event){
        return host?.surface.contains(event.target) && !event.target.closest(uiSelector);
    }
    function isNavigation(event){ return space || event.button === 1 || event.button === 2; }
    function down(event){
        if(!alive() || !inCanvas(event)) return;
        // Middle/right drag and wheel remain the canvas navigation gestures.
        if(isNavigation(event)){
            if(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) stop(event);
            else if(event.target.closest('.image-node') && (space || event.button === 1)){
                stop(event);
                if(event.type === 'pointerdown') host.pan?.(event);
            }
            return;
        }
        const tile = tileAt(event);
        if(tile){
            if(event.type === 'pointerdown' || !press) press = {tile, x:event.clientX, y:event.clientY, moved:false};
            stop(event);
            return;
        }
        const node = event.target.closest('.image-node');
        if(node && node.dataset.id === session.targetId && event.target.closest('input,textarea,select,button,[contenteditable],.smart-node-input-thumbs')) return;
        // Keep the task target and graph fixed while choosing references.
        if(node || event.target.closest('.node-port,.connection-layer') || event.shiftKey || event.ctrlKey || event.metaKey) stop(event);
    }
    for(const name of ['pointerdown','mousedown']) window.addEventListener(name,down,true);
    window.addEventListener('pointermove', event => {
        if(press && Math.hypot(event.clientX-press.x,event.clientY-press.y) > 6) press.moved = true;
        if(session && inCanvas(event) && (event.buttons & 6) && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) stop(event);
    },true);
    window.addEventListener('mousemove', event => {
        if(session && inCanvas(event) && (event.buttons & 6) && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) stop(event);
    },true);
    window.addEventListener('pointercancel', () => { if(press) press.moved = true; },true);
    window.addEventListener('click', event => {
        if(!alive() || !inCanvas(event) || isNavigation(event)) return;
        const tile = tileAt(event);
        if(tile){
            stop(event);
            const click = !press || (press.tile === tile && !press.moved);
            press = null;
            if(click) toggle(host.resolve(tile));
            return;
        }
        const node = event.target.closest('.image-node');
        if(!node || node.dataset.id !== session.targetId) stop(event);
    },true);
    for(const name of ['dblclick','dragstart','contextmenu']) window.addEventListener(name,event => {
        if(alive() && inCanvas(event)) stop(event);
    },true);
    window.addEventListener('keydown', event => {
        if(!session) return;
        if(event.code === 'Space' && !event.target.closest('input,textarea,[contenteditable]')) space = true;
        if(event.key === 'Escape'){ stop(event); finish('escape'); }
        else if((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())) finish('history');
        else if(event.key === 'Delete' || event.key === 'Backspace'){
            if(!event.target.closest('input,textarea,[contenteditable]')) finish('delete');
        }
    },true);
    window.addEventListener('keyup', event => { if(event.code === 'Space') space = false; },true);
    window.addEventListener('blur', () => { space = false; if(press) press.moved = true; });
    window.addEventListener('pagehide', () => finish('navigation'));
    window.addEventListener('popstate', () => finish('navigation'));
    window.addEventListener('smart-canvas-generation-settings-change',invalidate);
    window.addEventListener('smart-canvas-config-ready',invalidate);
    window.SmartCanvasReferencePicker = {
        configure(options){ host = options; },
        register(type,factory){ factories.set(type,factory); },
        start, finish, toggle, refresh, invalidate,
        get active(){ return session ? {type:session.type,targetId:session.targetId} : null; },
        owns(targetId){ return Boolean(session && session.targetId === targetId); },
        recordChange(targetId){
            if(!session || session.targetId !== targetId) return false;
            if(!session.changed){ session.adapter.beforeChange?.(); session.changed = true; }
            return true;
        }
    };
})();
