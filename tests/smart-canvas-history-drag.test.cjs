const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const historySource = fs.readFileSync(path.join(__dirname, '../static/history.html'), 'utf8');
function extract(name, text=source) {
    const start = text.search(new RegExp(`^(?:\\s*)(?:async )?function ${name}\\(`, 'm'));
    const end = text.indexOf('\n        }', start) + 10;
    if(text === source){
        const functionEnd = text.indexOf('\n}', start) + 2;
        assert.ok(start >= 0 && functionEnd > start, name);
        return text.slice(start, functionEnd);
    }
    assert.ok(start >= 0 && end > start, name);
    return text.slice(start, end);
}
function setup() {
    const added = [];
    const uploads = [];
    const context = vm.createContext({
        readSmartDropData: (transfer, type) => transfer.data?.[type] || '',
        smartOriginalMediaUrl: url => url,
        smartImageFilesFromDataTransfer: transfer => transfer.files || [],
        smartLocalImagePathsFromDataTransfer: () => [],
        smartDropTextCandidates: transfer => transfer.data?.['text/uri-list'] ? [transfer.data['text/uri-list']] : [],
        isRemoteSmartImageDropValue: value => /^https?:\/\//i.test(value),
        uploadFilesFromDataTransfer: async transfer => transfer.files || [],
        pushUndo() {},
        appendImagesToSmartNode: images => added.push(...images),
        handleFiles: async files => uploads.push(...files),
        importSmartLocalImages: async () => [],
        smartImageNameFromUrl: url => url.split('/').pop(),
        mediaKindForItem: () => 'image',
        toast: error => { throw new Error(error); },
        tr: value => value,
    });
    for(const name of ['smartImageDropPayload', 'resolveSmartImageDropPayload', 'handleSmartImageDropPayload']) {
        vm.runInContext(extract(name), context);
    }
    return {context, added, uploads};
}

test('history drag keeps the original image when a compressed file is also present', async () => {
    const {context, added, uploads} = setup();
    const original = 'http://127.0.0.1:3000/output/full-size.png';
    const compressed = {name:'full-size.jpg', size:12000, type:'image/jpeg'};
    const transfer = {
        files:[compressed],
        data:{
            'application/x-smart-history-image':JSON.stringify({url:original, source:'history', kind:'image', natural_w:2048, natural_h:3072}),
            'text/uri-list':original,
        },
    };
    const payload = await context.resolveSmartImageDropPayload(transfer);
    assert.equal(payload.type, 'url');
    assert.equal(payload.url, original);
    await context.handleSmartImageDropPayload(payload);
    assert.equal(added[0].url, original);
    assert.equal(added[0].natural_w, 2048);
    assert.equal(added[0].natural_h, 3072);
    assert.equal(uploads.length, 0);
});

test('ordinary file drags still use their files', async () => {
    const {context, added, uploads} = setup();
    const file = {name:'camera.png', type:'image/png'};
    const payload = await context.resolveSmartImageDropPayload({files:[file], data:{}});
    assert.equal(payload.type, 'files');
    await context.handleSmartImageDropPayload(payload);
    assert.equal(uploads[0], file);
    assert.equal(added.length, 0);
});

test('history keeps original dimensions when a plain URL and metadata both describe the image', () => {
    const context = vm.createContext({VIDEO_URL_RE:/\\.mp4$/i});
    for(const name of ['mediaUrl', 'mediaKind', 'recordMediaEntries']) {
        vm.runInContext(extract(name, historySource), context);
    }
    const entries = context.recordMediaEntries({
        items:[{url:'/output/full-size.png', width:448, height:448}],
        image_items:[{url:'/output/full-size.png', natural_w:2048, natural_h:3072}],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].natural_w, 2048);
    assert.equal(entries[0].natural_h, 3072);
});
