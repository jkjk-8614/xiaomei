(function (root) {
    'use strict';

    const rows = entries => Array.isArray(entries) ? entries : [];
    const isRemote = url => /^(?:https?|asset):\/\/[^/\s]+/i.test(String(url || ''));
    const isHttp = url => /^https?:\/\/[^/\s]+/i.test(String(url || ''));

    function manualLinks(entries) {
        return rows(entries).filter(entry => entry?.manual === true);
    }

    function withoutManualLinks(entries) {
        return rows(entries).filter(entry => entry?.manual !== true);
    }

    function findLink(entries, source) {
        if (!source) return undefined;
        return rows(entries).find(entry => entry?.url &&
            [entry.source, entry.originalLocalUrl, entry.url].includes(source));
    }

    function storeLink(entries, link) {
        return [...rows(entries).filter(entry => entry?.source !== link.source), link];
    }

    function replaceReference(ref, url, source = ref.url) {
        if (!url || url === ref.url) return ref;
        return { ...ref, url, originalLocalUrl: ref.originalLocalUrl || source };
    }

    function createUploadSession(upload) {
        const receipts = new Map();
        const inFlight = new Map();

        function stage(source) {
            const existing = receipts.get(source);
            if (existing) return Promise.resolve(existing.url);
            if (inFlight.has(source)) return inFlight.get(source);
            const pending = Promise.resolve().then(() => upload(source)).then(url => {
                receipts.set(source, { url });
                return url;
            }).finally(() => inFlight.delete(source));
            inFlight.set(source, pending);
            return pending;
        }

        function prepare(refs, sourceFor, manual) {
            const used = new Map();
            const references = refs.map(ref => {
                if (!ref?.url) return ref;
                const source = sourceFor(ref);
                const receipt = receipts.get(source);
                if (receipt) used.set(source, receipt);
                const url = receipt?.url || findLink(manual, source)?.url;
                return replaceReference(ref, url, source);
            });
            return {
                references,
                release() {
                    for (const [source, receipt] of used) {
                        if (receipts.get(source) === receipt) receipts.delete(source);
                    }
                },
            };
        }

        return { stage, prepare, urlFor: source => receipts.get(source)?.url };
    }

    root.XiaomeiCanvasMediaLinks = {
        isRemote, isHttp, manualLinks, withoutManualLinks, findLink, storeLink, replaceReference, createUploadSession,
    };
}(window));
