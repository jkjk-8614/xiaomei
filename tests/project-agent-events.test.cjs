const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/js/project-agent-events.js'),'utf8'), context);
const {snapshot,trigger} = context.window.ProjectAgentEvents;
const canvas = nodes => ({updated_at:1,nodes,connections:[],viewport:{x:0,y:0,scale:1}});

test('movement, zoom, selection and save timestamps do not trigger analysis',()=>{
    const first = canvas([{id:'a',type:'smart-upload',x:0,y:0,images:[{url:'/assets/a.png'}]}]);
    const next = canvas([{id:'a',type:'smart-upload',x:100,y:200,selected:true,images:[{url:'/assets/a.png'}]}]);
    next.updated_at = 2; next.viewport = {x:500,y:500,scale:2};
    assert.equal(trigger(snapshot(first),snapshot(next)),'');
});

test('asset, formal connection, prompt and result changes are meaningful',()=>{
    const base = canvas([{id:'a',type:'smart-upload',images:[]},{id:'b',type:'smart-paint',images:[]}]);
    const withAsset = canvas([{id:'a',type:'smart-upload',images:[{url:'/assets/a.png'}]},{id:'b',type:'smart-paint',images:[]}]);
    assert.equal(trigger(snapshot(base),snapshot(withAsset)),'assets_added');
    assert.equal(trigger(snapshot(withAsset),snapshot(base)),'asset_removed');
    const connected = {...withAsset,connections:[{from:'a',to:'b',kind:'input'}]};
    assert.equal(trigger(snapshot(withAsset),snapshot(connected)),'connection_changed');
    const prompt = canvas([{id:'a',type:'smart-upload',images:[{url:'/assets/a.png'}]},{id:'b',type:'smart-paint',promptDraftText:'商品主图',images:[]}]);
    assert.equal(trigger(snapshot(withAsset),snapshot(prompt)),'prompt_committed');
    const generated = canvas([{id:'a',type:'smart-upload',images:[{url:'/assets/a.png'}]},{id:'b',type:'smart-paint',images:[{url:'/output/result.png'}]}]);
    assert.equal(trigger(snapshot(withAsset),snapshot(generated)),'task_succeeded');
    const failed = canvas([{id:'a',type:'smart-upload',images:[{url:'/assets/a.png'}]},{id:'b',type:'smart-paint',runError:'失败',images:[]}]);
    assert.equal(trigger(snapshot(withAsset),snapshot(failed)),'task_failed');
});

test('replacing a finished result is a success, while reordering without a new finish is not',()=>{
    const before = canvas([{id:'a',type:'smart-paint',runFinishedAt:10,images:[{url:'/output/a.png'}]}]);
    const after = canvas([{id:'a',type:'smart-paint',runFinishedAt:20,images:[{url:'/output/b.png'}]}]);
    assert.equal(trigger(snapshot(before),snapshot(after)),'task_succeeded');
    after.nodes[0].runFinishedAt = 10;
    assert.equal(trigger(snapshot(before),snapshot(after)),'node_content_changed');
});
