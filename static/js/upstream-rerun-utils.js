(function(global){
    'use strict';

    function clean(list){
        return Array.isArray(list) ? list.filter(Boolean) : [];
    }

    function selectUpstreamRerunReferences(options){
        const opts = options || {};
        const upstream = clean(opts.upstream);
        const manual = clean(opts.manual);
        const fallback = clean(opts.fallback);
        return upstream.length ? upstream.concat(manual) : (manual.length ? manual : fallback);
    }

    global.UpstreamRerunUtils = Object.freeze({
        selectUpstreamRerunReferences
    });
})(window);
