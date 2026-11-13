(function (root) {
    'use strict';

    function create({ clientId, snapshot, onSaved, onRemote, status }) {
        let canvasId = '';
        let revision = 0;
        let edited = 0;
        let saved = 0;
        let saveTimer;
        let saveRequest;
        let remoteRequest;
        let pollTimer;
        let applyingRemote = false;

        const url = () => `/api/canvases/${encodeURIComponent(canvasId)}`;
        const dirty = () => edited !== saved;

        function open(canvas) {
            canvasId = canvas.id;
            revision = Number(canvas.updated_at) || 0;
            clearInterval(pollTimer);
            pollTimer = setInterval(poll, 2500);
        }

        function changed() {
            if (!canvasId || applyingRemote) return;
            edited += 1;
            status('Saving...');
            clearTimeout(saveTimer);
            if (!saveRequest) saveTimer = setTimeout(flush, 500);
        }

        function send(body) {
            return root.fetch(url(), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, base_updated_at: revision }),
            });
        }

        async function write() {
            try {
                while (dirty()) {
                    const edit = edited;
                    const body = snapshot();
                    let response = await send(body);
                    if (response.status === 409) {
                        const conflict = await response.json();
                        const latest = Number(conflict.detail?.updated_at ?? conflict.updated_at);
                        if (latest > revision) {
                            revision = latest;
                            response = await send(body);
                        }
                    }
                    if (!response.ok) throw new Error(`Canvas save failed (${response.status})`);
                    const { canvas } = await response.json();
                    revision = Number(canvas?.updated_at) || revision;
                    saved = edit;
                    if (canvas) onSaved(canvas);
                }
                status('Saved');
                return true;
            } catch (error) {
                status('Save failed');
                console.error(error);
                return false;
            }
        }

        function flush() {
            clearTimeout(saveTimer);
            if (!dirty()) return Promise.resolve(true);
            if (!saveRequest) {
                saveRequest = write().finally(() => { saveRequest = null; });
            }
            return saveRequest;
        }

        function save() {
            changed();
            return flush();
        }

        async function read(checkVersion) {
            if (checkVersion) {
                const meta = await root.fetch(`${url()}/meta`);
                if (!meta.ok || Number((await meta.json()).updated_at) <= revision || dirty()) return;
            }
            const response = await root.fetch(url());
            if (!response.ok) return;
            const { canvas } = await response.json();
            const incoming = Number(canvas?.updated_at) || 0;
            if (canvas?.id !== canvasId || incoming <= revision || dirty()) return;
            applyingRemote = true;
            try {
                onRemote(canvas);
                revision = incoming;
            } finally {
                applyingRemote = false;
            }
            status('Synced');
        }

        function sync(checkVersion = false) {
            if (!canvasId || dirty() || remoteRequest) return remoteRequest;
            remoteRequest = read(checkVersion).catch(error => {
                if (!checkVersion) {
                    status('Sync failed');
                    console.error(error);
                }
            }).finally(() => { remoteRequest = null; });
            return remoteRequest;
        }

        function poll() {
            if (!root.document.hidden) sync(true);
        }

        function receive(event) {
            if (event.canvas_id === canvasId && event.client_id !== clientId &&
                (!event.updated_at || Number(event.updated_at) > revision)) sync();
        }

        return { open, changed, save, flush, sync, receive };
    }

    root.XiaomeiClassicSession = { create };
}(window));
