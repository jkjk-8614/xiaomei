const assert=require('node:assert/strict');
const {test}=require('node:test');
const pd=require('../static/js/physical-dimensions.js');
test('30×40×2cm, decimals, null depth, units and invalid dimensions',()=>{
    const d={...pd.defaults(),enabled:true,width:pd.convertToMillimeters(30,'cm'),height:pd.convertToMillimeters(40,'cm'),depth:pd.convertToMillimeters(2,'cm')};
    assert.deepEqual([d.width,d.height,d.depth],[300,400,20]);
    assert.equal(pd.calculateAspectRatio(d.width,d.height).label,'3:4');
    const initial=pd.signature(d);
    for(const unit of ['mm','cm','m','in']){
        d.unit=unit;
        for(const key of ['width','height','depth'])assert.ok(Math.abs(pd.convertToMillimeters(pd.convertFromMillimeters(d[key],unit),unit)-d[key])<1e-10);
    }
    assert.equal(pd.signature(d),initial);
    assert.equal(pd.convertToMillimeters(1,'in'),25.4);
    d.depth=null;assert.equal(pd.buildNormalizedDimensions(d).thicknessRatio,null);
    for(const value of [0,-5,Infinity,NaN,true,'abc'])assert.equal(pd.validatePhysicalDimensions({...d,depth:value}).valid,false);
    assert.equal(pd.convertToMillimeters(null,'cm'),null);
    assert.equal(pd.calculateAspectRatio(.3,.4).label,'3:4');
});
test('legacy dimensions migrate once and roundtrip JSON without losing blanks',()=>{
    const d=pd.migrate({width:30,height:40,depth:0,unit:'cm'},'box');
    assert.equal(d.width,300);assert.equal(d.height,400);assert.equal(d.depth,null);assert.equal(d.shape,'cuboid');
    assert.deepEqual(pd.migrate(JSON.parse(JSON.stringify(d))),d);
    assert.equal(d.enabled,false);
    assert.equal(pd.validatePhysicalDimensions({...d,enabled:true,shape:'circle'}).valid,false);
});
