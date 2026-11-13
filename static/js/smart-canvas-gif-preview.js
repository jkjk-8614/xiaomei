function createSmartGifPreview(onLayoutChange){
    const byId = id => document.getElementById(`gifPreview${id}`);
    const stage = document.getElementById('imageEditStage');
    const bar = byId('Bar');
    const controls = byId('Controls');
    const status = byId('Status');
    const message = byId('Message');
    const retry = byId('Retry');
    const canvas = byId('Image');
    const strip = byId('Strip');
    const slider = byId('Slider');
    const frame = byId('Frame');
    const total = byId('Total');
    const rate = byId('Rate');
    const play = byId('Play');
    const loop = byId('Loop');
    let session = null;
    let visible = false;

    function syncControls(){
        const wasHidden = bar.hidden;
        const phase = visible ? session?.phase : null;
        const ready = phase === 'ready';
        const statusKey = {loading:'smart.gifLoading', error:'smart.gifLoadFailed', unsupported:'smart.gifUnsupported'}[phase];
        controls.hidden = !ready;
        status.hidden = !statusKey;
        if(statusKey) message.textContent = tr(statusKey);
        retry.hidden = phase !== 'error';
        canvas.hidden = !ready;
        bar.hidden = !ready && !statusKey;
        stage.classList.toggle('gif-preview-frame-on', ready);
        stage.classList.toggle('gif-preview-bar-on', !bar.hidden);
        if(wasHidden !== bar.hidden) onLayoutChange();
        const playing = ready && session.playing;
        const playLabel = tr(playing ? 'smart.gifPause' : 'smart.gifPlay');
        play.classList.toggle('is-playing', playing);
        play.title = playLabel;
        play.setAttribute('aria-label', playLabel);
    }

    function closeDecoders(state){
        clearTimeout(state.timer);
        state.request.abort();
        state.decoder?.close();
        state.stripDecoder?.close();
        state.decoder = state.stripDecoder = null;
    }

    function reset(){
        if(!session) return;
        closeDecoders(session);
        session = null;
        visible = false;
        canvas.width = canvas.height = 1;
        strip.getContext('2d').clearRect(0, 0, strip.width, strip.height);
        syncControls();
    }

    function fail(state){
        if(state !== session) return;
        closeDecoders(state);
        state.phase = 'error';
        syncControls();
    }

    function schedule(state){
        clearTimeout(state.timer);
        if(!visible || !state.playing || state.drawing || state.phase !== 'ready') return;
        const next = state.index + 1;
        const delay = state.duration / Number(rate.value) - (performance.now() - state.shownAt);
        state.timer = setTimeout(() => {
            if(next === state.count && loop.getAttribute('aria-pressed') === 'false'){
                setPlaying(false);
                return;
            }
            void showFrame(state, next % state.count);
        }, Math.max(0, delay));
    }

    function updateFrameLabel(state){
        slider.setAttribute('aria-valuetext', trf('smart.gifFramePosition', {frame:state.index + 1, total:state.count}));
    }

    async function showFrame(state, index){
        state.target = index;
        if(state.drawing) return;
        if(state.index === index){ schedule(state); return; }
        state.drawing = true;
        try {
            const {image} = await state.decoder.decode({frameIndex:index});
            try {
                if(state !== session || index !== state.target) return;
                if(canvas.width !== image.displayWidth || canvas.height !== image.displayHeight){
                    canvas.width = image.displayWidth;
                    canvas.height = image.displayHeight;
                }
                const context = canvas.getContext('2d');
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0);
                state.index = index;
                const milliseconds = image.duration / 1000;
                state.duration = milliseconds >= 20 ? milliseconds : 100;
                state.shownAt = performance.now();
                slider.value = frame.value = index + 1;
                updateFrameLabel(state);
                if(state.phase === 'loading'){
                    state.phase = 'ready';
                    syncControls();
                }
            } finally {
                image.close();
            }
        } catch {
            fail(state);
        } finally {
            state.drawing = false;
            if(state === session && state.phase === 'ready'){
                if(state.target !== state.index) void showFrame(state, state.target);
                else schedule(state);
            }
        }
    }

    async function drawStrip(state, data){
        let decoder;
        try {
            decoder = state.stripDecoder = new ImageDecoder({type:'image/gif', data, desiredHeight:strip.height});
            const context = strip.getContext('2d');
            const cells = Math.min(12, state.count);
            const cellWidth = strip.width / cells;
            for(let cell = 0; cell < cells; cell++){
                const frameIndex = Math.round(cell * (state.count - 1) / (cells - 1));
                const {image} = await decoder.decode({frameIndex});
                try {
                    if(state !== session || state.stripDecoder !== decoder) return;
                    const scale = Math.max(cellWidth / image.displayWidth, strip.height / image.displayHeight);
                    const width = cellWidth / scale;
                    const height = strip.height / scale;
                    context.drawImage(image, (image.displayWidth - width) / 2, (image.displayHeight - height) / 2,
                        width, height, cell * cellWidth, 0, cellWidth, strip.height);
                } finally {
                    image.close();
                }
            }
        } catch {
            // The slider can still seek when thumbnails are unavailable.
        } finally {
            if(decoder && state.stripDecoder === decoder){
                decoder.close();
                state.stripDecoder = null;
            }
        }
    }

    async function load(src){
        if(session?.src === src){ setVisible(true); return; }
        reset();
        visible = true;
        const state = session = {
            src, phase:'loading', request:new AbortController(), index:-1,
            playing:!matchMedia('(prefers-reduced-motion: reduce)').matches
        };
        rate.value = '1';
        loop.setAttribute('aria-pressed', 'true');
        syncControls();
        try {
            if(!window.ImageDecoder || !await ImageDecoder.isTypeSupported('image/gif')){
                if(state === session){ state.phase = 'unsupported'; syncControls(); }
                return;
            }
            if(state !== session) return;
            const signal = AbortSignal.any([state.request.signal, AbortSignal.timeout(15000)]);
            const response = await fetch(src, {signal});
            if(!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.arrayBuffer();
            if(state !== session) return;
            state.decoder = new ImageDecoder({type:'image/gif', data});
            await state.decoder.tracks.ready;
            if(state !== session) return;
            state.count = state.decoder.tracks.selectedTrack.frameCount;
            if(state.count <= 1){
                closeDecoders(state);
                state.phase = 'still';
                syncControls();
                return;
            }
            slider.max = frame.max = state.count;
            total.textContent = state.count;
            frame.style.setProperty('--gif-frame-digits', String(state.count).length);
            await showFrame(state, 0);
            if(state === session && state.phase === 'ready') void drawStrip(state, data);
        } catch {
            fail(state);
        }
    }

    function setPlaying(playing){
        const state = session;
        if(!state) return;
        state.playing = playing;
        if(!playing) state.target = Math.max(0, state.index);
        state.shownAt = performance.now();
        syncControls();
        schedule(state);
    }

    function seek(value){
        if(session?.phase !== 'ready') return;
        const number = Number.isFinite(value) ? Math.min(session.count, Math.max(1, Math.round(value))) : session.index + 1;
        setPlaying(false);
        frame.value = number;
        void showFrame(session, number - 1);
    }

    function setVisible(next){
        if(visible === next) return;
        visible = next;
        if(!next && session) setPlaying(false);
        else syncControls();
    }

    play.addEventListener('click', () => {
        if(session?.phase !== 'ready') return;
        const restart = !session.playing && session.index === session.count - 1 && loop.getAttribute('aria-pressed') === 'false';
        setPlaying(!session.playing);
        if(restart) void showFrame(session, 0);
    });
    loop.addEventListener('click', () => loop.setAttribute('aria-pressed', loop.getAttribute('aria-pressed') === 'false'));
    rate.addEventListener('change', () => { if(session) schedule(session); });
    slider.addEventListener('pointerdown', () => setPlaying(false));
    slider.addEventListener('input', () => seek(slider.valueAsNumber));
    frame.addEventListener('focus', () => setPlaying(false));
    frame.addEventListener('change', () => seek(frame.valueAsNumber));
    frame.addEventListener('keydown', event => { if(event.key === 'Enter') seek(frame.valueAsNumber); });
    retry.addEventListener('click', () => {
        const src = session?.src;
        if(src){ reset(); void load(src); }
    });
    bar.addEventListener('keydown', event => { if(event.key !== 'Escape') event.stopPropagation(); });
    window.addEventListener('studio-lang-change', () => {
        for(const control of [slider, frame, rate, loop]) control.setAttribute('aria-label', control.title);
        if(session?.phase === 'ready') updateFrameLabel(session);
        syncControls();
    });
    window.addEventListener('resize', () => { if(!bar.hidden) onLayoutChange(); });
    return {load, reset, setVisible};
}
