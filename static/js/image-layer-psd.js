(function (global) {
    'use strict';
    function uuid() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    async function loadImage(url) {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
    }
    async function build(info) {
        if (!global.AgPsd) throw new Error('PSD 组件未加载，请刷新后重试');
        const {width, height} = info;
        if (!(width > 0 && height > 0) || width * height * (info.layers.length + 2) > 180000000) throw new Error('PSD 过大，请减少层数或降低分辨率');
        const composite = document.createElement('canvas');
        composite.width = width; composite.height = height;
        const children = [], linkedFiles = [], transfers = [];
        function pixels(canvas) {
            const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            transfers.push(imageData.data.buffer);
            canvas.width = canvas.height = 0;
            return imageData;
        }
        if (info.original_url) {
            const original = document.createElement('canvas'); original.width = width; original.height = height;
            original.getContext('2d').drawImage(await loadImage(info.original_url), 0, 0, width, height);
            children.push({name:'原图（对照）', imageData:pixels(original), hidden:true});
        }
        for (const layer of info.layers) {
            const image = await loadImage(layer.aligned_url || layer.url);
            const canvas = document.createElement('canvas');
            canvas.width = layer.right == null ? width : layer.right - layer.left;
            canvas.height = layer.bottom == null ? height : layer.bottom - layer.top;
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            const hidden = Boolean(layer.transparent && layer.alpha_issue);
            const child = {name:layer.name, canvas, left:layer.left || 0, top:layer.top || 0, blendMode:'normal', opacity:1, hidden};
            if (!hidden) composite.getContext('2d').drawImage(canvas, child.left, child.top);
            if (layer.native_width && layer.transform) {
                // Embed PNG bytes, so Photoshop can edit the original independently of placement.
                const raw = await loadImage(layer.prepared_url || layer.url);
                const native = document.createElement('canvas'); native.width = raw.naturalWidth; native.height = raw.naturalHeight;
                native.getContext('2d').drawImage(raw, 0, 0);
                const blob = await new Promise(resolve => native.toBlob(resolve, 'image/png'));
                native.width = native.height = 0;
                if (!blob) throw new Error('无法读取图层原图');
                const id = uuid();
                const data = new Uint8Array(await blob.arrayBuffer());
                linkedFiles.push({id, name:layer.id + '.png', type:'png ', data});
                transfers.push(data.buffer);
                child.placedLayer = {id, type:'raster', width:raw.naturalWidth, height:raw.naturalHeight, resolution:{units:'Density', value:72}, transform:layer.transform};
            }
            child.imageData = pixels(canvas);
            delete child.canvas;
            children.push(child);
        }
        const psdDocument = {width, height, imageData:pixels(composite), children, linkedFiles};
        return await new Promise((resolve, reject) => {
            const worker = new Worker('/static/js/image-layer-psd-worker.js?layers=2026.09.22.3');
            const finish = (error, bytes) => {clearTimeout(timer);worker.terminate();error ? reject(new Error(error)) : resolve(bytes);};
            const timer = setTimeout(() => finish('PSD 打包超时，请减少层数或降低分辨率'), 180000);
            worker.onmessage = event => finish(event.data.error, event.data.bytes);
            worker.onerror = event => finish('PSD 打包组件运行失败：' + (event.message || '请刷新后重试或降低分辨率'));
            try {worker.postMessage({document:psdDocument, expectedLayers:children.length}, transfers);}
            catch (error) {finish(error.message);}
        });
    }
    global.XiaomeiLayerPsd = {build, uuid};
})(window);
