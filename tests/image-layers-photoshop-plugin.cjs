const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');

test('UXP opens a layered document, preserves normal placement, and reports open failures', async () => {
    const source = fs.readFileSync(path.join(root,'packages/photoshop-bridge/main.js'),'utf8');
    const start = source.indexOf('async function importJob(');
    const end = source.indexOf('\nfunction startAutoImport()', start);
    const calls = [], receipts = [];
    let mode = 'document', fail = false;
    const context = vm.createContext({busy:false, $:()=>null, loadHostApis:()=>true,
        fetchJob:async()=>({job:{id:'job', filename:'image.psd',open_mode:mode}}),
        downloadJobFile:async()=>({name:'image.psd'}),
        fallbackOpenImage:async()=>{calls.push('open');if(fail)throw new Error('Photoshop open failed');return 'opened-document';},
        ensureImportDocument:async()=>calls.push('ensure'), placeEmbedded:async()=>{calls.push('place');return 'smart-object';},
        ack:async(...args)=>receipts.push(args), setStatus:()=>{},logLine:()=>{},pluginLog:()=>{},setTimeout:()=>{},refreshBridgeStatus:()=>{}});
    vm.runInContext(source.slice(start,end), context);
    await context.importJob(); assert.deepEqual(calls,['open']); assert.equal(receipts[0][1],'done');
    calls.length = 0; mode='place';
    await context.importJob(); assert.deepEqual(calls,['ensure','place']);
    calls.length=0;mode='document';fail=true;
    await context.importJob(); assert.deepEqual(calls,['open']);assert.equal(receipts.at(-1)[1],'failed');
});

test('CEP opens layered PSD as a document even with an existing document', () => {
    let opens=0;
    const context = vm.createContext({File:function(name){this.exists=true;this.fsName=name;},app:{documents:[{}],open:()=>opens++}});
    vm.runInContext(fs.readFileSync(path.join(root,'packages/photoshop-bridge-cep/host.jsx'),'utf8'),context);
    assert.equal(context.importInfiniteCanvasImage('中文路径.psd','图层','document'),'opened-document');
    assert.equal(opens,1);
});
