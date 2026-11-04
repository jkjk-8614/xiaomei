(function(){
    'use strict';

    async function imageBlobToPng(blob){
        if(String(blob?.type || '').toLowerCase() === 'image/png') return blob;
        const objectUrl = URL.createObjectURL(blob);
        try{
            const imageEl = await new Promise((resolve,reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('图片解码失败'));
                image.src = objectUrl;
            });
            const canvasEl = document.createElement('canvas');
            canvasEl.width = Math.max(1,imageEl.naturalWidth || imageEl.width || 1);
            canvasEl.height = Math.max(1,imageEl.naturalHeight || imageEl.height || 1);
            const context = canvasEl.getContext('2d');
            if(!context) throw new Error('无法创建图片画布');
            context.drawImage(imageEl,0,0,canvasEl.width,canvasEl.height);
            const png = await new Promise(resolve => canvasEl.toBlob(resolve,'image/png'));
            if(!png) throw new Error('无法转换图片格式');
            return png;
        }finally{ URL.revokeObjectURL(objectUrl); }
    }
    function getElectronApi(){
        if(window.electronAPI?.writeImageToClipboard) return window.electronAPI;
        try{
            if(window.parent && window.parent !== window && window.parent.electronAPI?.writeImageToClipboard){
                return window.parent.electronAPI;
            }
        }catch(error){}
        return null;
    }
    async function loadImagePng(url){
        const response = await fetch(url,{credentials:'same-origin'});
        if(!response.ok) throw new Error(`图片读取失败（${response.status}）`);
        const blob = await response.blob();
        if(!/^image\//i.test(String(blob.type || ''))) throw new Error('读取到的内容不是图片');
        return imageBlobToPng(blob);
    }

    async function writeImage(url){
        const electron = getElectronApi();
        if(electron){
            const png = await loadImagePng(url);
            const result = await electron.writeImageToClipboard(await png.arrayBuffer());
            if(!result?.ok) throw new Error(result?.message || '桌面剪贴板写入失败');
            return;
        }
        if(!navigator.clipboard?.write || typeof window.ClipboardItem !== 'function'){
            throw new Error('当前浏览器不支持复制图片');
        }
        // 在点击时发起剪贴板写入，图片可异步读取和转换。
        await navigator.clipboard.write([new window.ClipboardItem({'image/png':loadImagePng(url)})]);
    }

    window.StudioImageClipboard = {writeImage};
})();
