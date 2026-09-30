const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function definition(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
const preserve = {canvasW:200, canvasH:120, sourceW:80, sourceH:80, x:100, y:20};

test('cropping keeps one scale and the selected original placement', () => {
  const context = vm.createContext({});
  vm.runInContext(definition('outpaintSourceDrawGeometry'), context);
  const result = context.outpaintSourceDrawGeometry(400, 250, preserve, {x:0,y:5,width:400,height:240});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {x:200,y:40,width:160,height:160});
  assert.equal(context.outpaintSourceDrawGeometry(200,120,{...preserve,x:-1}), null);
});

test('browser fallback preserves all original pixels and rejects an incompatible result', {timeout:30000}, async t => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addScriptTag({content:[
    'outpaintOutputCropRect','outpaintSourceDrawGeometry','compositeOutpaintResultItem',
  ].map(definition).join('\n')});
  const result = await page.evaluate(async preserve => {
    const canvas = (w,h,color) => {
      const c=document.createElement('canvas'); c.width=w;c.height=h;
      const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,w,h);return c;
    };
    const original=canvas(80,80,'red');
    original.getContext('2d').clearRect(0,0,1,1);
    let generated=canvas(202,120,'blue'), saved;
    window.loadOutpaintImage = async () => generated;
    window.fileNameFromUrl = () => 'result.png';
    window.uploadCroppedBlob = async blob => {
      saved=await createImageBitmap(blob);return {url:'/locked.png',name:'locked.png'};
    };
    const item=await compositeOutpaintResultItem({url:'/generated.png'},preserve,original);
    const output=canvas(saved.width,saved.height,'black');
    const ctx=output.getContext('2d');ctx.clearRect(0,0,output.width,output.height);ctx.drawImage(saved,0,0);
    const actual=Array.from(ctx.getImageData(100,20,80,80).data);
    const expected=Array.from(original.getContext('2d').getImageData(0,0,80,80).data);
    generated=canvas(200,200,'blue');
    let error='';try {await compositeOutpaintResultItem({url:'/bad.png'},preserve,original);}catch(e){error=e.message;}
    return {item,same:actual.every((v,i)=>v===expected[i]),error};
  }, preserve);
  assert.equal(result.same,true);
  assert.equal(result.item.width,200);assert.equal(result.item.height,120);
  assert.equal(result.item.outpaintCenterLocked,true);
  assert.match(result.error,/比例/);
});
