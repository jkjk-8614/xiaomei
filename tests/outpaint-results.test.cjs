const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');

function definition(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? tail : tail.slice(0, end + 1);
}

function resultContext() {
  const context = vm.createContext({escapeHtml:value => String(value)});
  vm.runInContext(definition('resultMediaUrls') + '\n' + definition('imageResolutionLabel')
    + '\n' + definition('imageResolutionBadgeLabel') + '\n' + definition('imageResolutionBadgeHtml'), context);
  return context;
}

test('outpaint result keeps the saved model URL and dimensions', () => {
  const context = resultContext();
  const items = context.resultMediaUrls([{url:'/generated.png',kind:'image',natural_w:2880,natural_h:2880}]);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, '/generated.png');
  assert.equal(items[0].natural_w, 2880);
  assert.equal(items[0].natural_h, 2880);
  assert.equal(items[0].outpaintOriginalRedrawn, undefined);
  assert.doesNotMatch(context.imageResolutionBadgeHtml(items[0]), /原图已重绘/);
});

test('detected redraw metadata remains visible on the canvas', () => {
  const context = resultContext();
  const items = context.resultMediaUrls([{url:'/redrawn.png',kind:'image',natural_w:200,natural_h:120,outpaint_original_redrawn:true}]);
  assert.equal(items.length, 1);
  assert.equal(items[0].outpaintOriginalRedrawn, true);
  assert.match(context.imageResolutionBadgeHtml(items[0]), /原图已重绘/);
});
