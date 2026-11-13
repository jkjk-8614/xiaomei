(function (root) {
    'use strict';

    const managed = /^\/(?:assets|output)\//;

    function create(host) {
        let report = { document: null, missing: new Set() };
        let revision = 0;

        function gather(nodes, logs) {
            const urls = new Set();
            function include(item) {
                const url = host.url(item);
                if (managed.test(url)) urls.add(url);
            }
            for (const node of nodes) {
                include(node.url);
                for (const image of node.images || []) include(image);
                for (const output of node.generatedOutputs || []) include(output);
                for (const [result, reference] of Object.entries(node.imageComparisons || {})) {
                    include(result);
                    include(reference);
                }
            }
            for (const log of logs || []) {
                for (const item of [...(log.outputs || []), ...(log.refs || []), ...(log.run?.refs || [])]) include(item);
            }
            return [...urls];
        }

        async function refresh() {
            const document = host.document();
            const attempt = ++revision;
            const current = () => revision === attempt && host.document() === document;
            const urls = gather(host.nodes(), document?.logs);
            if (!urls.length) {
                report = { document, missing: new Set() };
                return true;
            }
            try {
                const response = await root.fetch('/api/canvas-assets/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls }),
                });
                if (!response.ok) return false;
                const { exists } = await response.json();
                if (!current()) return false;
                report = { document, missing: new Set(urls.filter(url => exists?.[url] === false)) };
                return true;
            } catch (error) {
                if (current()) root.console.warn('Canvas asset check failed', error);
                return false;
            }
        }

        function has(url) {
            return report.document === host.document() && report.missing.has(url);
        }

        return { refresh, has };
    }

    root.XiaomeiClassicLocalAssets = { create };
})(window);
