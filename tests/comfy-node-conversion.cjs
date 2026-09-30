const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

(async () => {
  for (const invalid of [true, false]) {
    let extension, receive;
    const loads = [], replies = [];
    const previous = {nodes: [{id: 1, type: 'Original'}]};
    const parent = {postMessage: message => replies.push(message)};
    const app = {
      registerExtension: value => { extension = value; },
      graph: {serialize: () => previous},
      loadGraphData: async graph => { loads.push(graph); },
      graphToPrompt: async () => ({output: {'79': invalid ? {inputs: {}} : {class_type: 'SaveImage', inputs: {}}}})
    };
    const window = {parent, addEventListener: (_, fn) => { receive = fn; }};
    const script = fs.readFileSync(path.join(__dirname, '../ComfyUI/tools/comfy-app-bridge/web/bridge.js'), 'utf8').replace(/^import .*;\r?\n/, '');
    vm.runInNewContext(script, {app, window, structuredClone,
      document: {getElementById: () => true}, HTMLAnchorElement: {prototype: {}}});
    extension.setup(); extension.afterConfigureGraph();
    const workflow = {nodes: [{id: 79, type: 'MissingExtension'}]};
    await receive({source: parent, origin: 'http://127.0.0.1:3000',
      data: {type: 'xiaomei-convert', nonce: 'test', workflow}});
    assert.equal(loads.at(-1), previous, 'restore original editor graph');
    if (invalid) {
      assert.match(replies[0].error, /MissingExtension（节点 79）/);
      assert.equal(replies[0].prompt, undefined);
    } else {
      assert.equal(replies[0].prompt['79'].class_type, 'SaveImage');
    }
  }
  console.log('Node conversion bridge: passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
