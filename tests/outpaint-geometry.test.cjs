const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resize} = require('../static/js/outpaint-geometry');
const {output} = require('../static/js/outpaint-geometry');
const start = {x:50,y:30,w:200,h:140}, source={w:100,h:80};
test('edge drags preserve other margins and all four corners resize', () => {
  assert.deepEqual(resize(start,source,'left',-20,0,false,0),{x:70,y:30,w:220,h:140});
  assert.deepEqual(resize(start,source,'right',20,0,false,0),{x:50,y:30,w:220,h:140});
  for(const h of ['nw','ne','sw','corner']) {
    const result=resize(start,source,h,h.includes('w')?-20:20,h !== 'corner' && h.includes('n')?-20:20,false,0);
    assert.equal(result.w,220);assert.equal(result.h,160);
  }
});
test('large source at 1K retains selected frame proportions and placement',()=>{
  const result=output({w:800,h:500,x:200,y:100},{w:400,h:300},{w:4000,h:3000},'1k');
  assert.deepEqual(result,{w:1024,h:640,x:256,y:128,sourceW:512,sourceH:384});
  assert.ok(result.x+result.sourceW<=result.w && result.y+result.sourceH<=result.h);
  assert.throws(()=>output({w:10000,h:10000,x:0,y:0},{w:400,h:300},{w:4000,h:3000},'auto'),/尺寸过大/);
});
test('fixed-ratio side shrink preserves orthogonal center for an off-center image',()=>{
  const s={w:300,h:300,x:100,y:180};
  const r=resize(s,{w:100,h:80},'right',-180,0,false,1);
  assert.equal(r.y-s.y,(r.h-s.h)/2);
  assert.equal(r.x,s.x);
});
test('Alt resizes symmetrically and frame cannot cut off source', () => {
  assert.deepEqual(resize(start,source,'left',-20,0,true,0),{x:70,y:30,w:240,h:140});
  for (const h of ['left','right','top','bottom','nw','ne','sw','corner']) {
    for(const delta of [-1000,1000]) for(const symmetric of [false,true]) for(const ratio of [0,1,16/9]) {
      const r=resize(start,source,h,delta,delta,symmetric,ratio);
      assert.ok(r.x>=0&&r.y>=0&&r.w>=r.x+source.w-1e-7&&r.h>=r.y+source.h-1e-7,JSON.stringify(r));
      if(ratio) assert.ok(Math.abs(r.w/r.h-ratio)<1e-7);
    }
  }
});
