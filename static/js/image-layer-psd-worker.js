/* Keep PSD compression and verification off the canvas UI thread. */
'use strict';
self.window = self;
importScripts('/static/vendor/js/ag-psd-seethrough.bundle.js?layers=2026.09.22.3');
AgPsd.initializeCanvas((width, height) => new OffscreenCanvas(width, height));
self.onmessage = event => {
    try {
        const {document: psd, expectedLayers} = event.data;
        const bytes = AgPsd.writePsd(psd, {noBackground:true});
        const verified = AgPsd.readPsd(bytes, {skipLayerImageData:true, skipCompositeImageData:true, skipThumbnail:true});
        if (verified.children?.length !== expectedLayers || (psd.linkedFiles.length && verified.linkedFiles?.length !== psd.linkedFiles.length)) throw new Error('PSD 图层校验失败，请重试导出');
        for (const file of psd.linkedFiles) {
            const embedded = verified.linkedFiles.find(x => x.id === file.id)?.data;
            if (!embedded || embedded.length !== file.data.length || !embedded.every((byte, index) => byte === file.data[index])) throw new Error('PSD 智能对象内容校验失败，请重试导出');
        }
        self.postMessage({bytes}, [bytes]);
    } catch (error) {
        self.postMessage({error: error.message || 'PSD 打包失败，请降低分辨率后重试'});
    }
};
