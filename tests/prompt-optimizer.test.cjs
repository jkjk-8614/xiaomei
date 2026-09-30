const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function extract(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match);
    const rest = source.slice(match.index);
    const end = rest.slice(1).search(/\n(?:async )?function /);
    return end < 0 ? rest : rest.slice(0, end + 1);
}
function fixture() {
    const elements = new Map();
    const element = id => {
        if(!elements.has(id)) elements.set(id, {value:'', textContent:'', children:[], disabled:false,
            appendChild(child){this.children.push(child);}, querySelectorAll(){return [];},
            setAttribute(){}, focus(){}});
        return elements.get(id);
    };
    const draft = {original:'宝宝第一年', images:[], videos:[], selection:{provider:'api',model:'test'}, versions:[],versionIndex:-1};
    const c = vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>element(Math.random())},
        promptOptimizeDraft:draft, promptOptimizeCandidate:element('candidate'),
        promptOptimizeModalModel:element('model'), promptOptimizeModalStatus:element('status'),
        promptOptimizeApply:element('promptOptimizeApply'), promptOptimizeRegenerate:element('regenerate'),
        PROMPT_OPTIMIZER_IMAGE_MAX:8, SMART_REFERENCE_VIDEO_MAX:4, PROMPT_OPTIMIZER_TIMEOUT_MS:180000,
        DEFAULT_PROMPT_OPTIMIZER_SYSTEM:'', PROMPT_OPTIMIZER_MODEL_KEY:'model',
        localStorage:{setItem(){}}, refreshPromptOptimizerModelSelect(){},
        setPromptOptimizeStatus(){}, AbortController, setInterval,clearInterval,setTimeout,clearTimeout,
        smartResponseErrorMessage:async()=> '模拟失败',
        fetch:async()=>({ok:true,json:async()=>({text:JSON.stringify({prompt:'优化结果',changes:'整理表达',questions:'无'}),model:'actual-model'})})});
    element('promptOptimizeMode').value = 'faithful';
    for(const name of ['cleanOptimizedPromptText','savePromptOptimizeVersion','showPromptOptimizeVersion',
        'syncPromptOptimizeControls','promptOptimizeMessage','stopPromptOptimizeRequest','requestPromptOptimization']) vm.runInContext(extract(name),c);
    return {c,draft,element};
}
test('request keeps original constraints and supplementary feedback',()=>{
    const {c,draft,element} = fixture();
    element('promptOptimizeFeedback').value = '不改变产品';
    const message = c.promptOptimizeMessage('当前版本',draft);
    for(const text of ['宝宝第一年','当前版本','不改变产品','不新增视觉设定','不得照搬无关广告文案']) assert.ok(message.includes(text));
});
test('success adds versions and preserves edited previous versions',async()=>{
    const {c,draft} = fixture();
    await c.requestPromptOptimization(draft.original);
    assert.equal(draft.versions.length,1);
    assert.equal(draft.versions[0].model,'actual-model');
    c.promptOptimizeCandidate.value = '手动修改';
    await c.requestPromptOptimization('手动修改');
    assert.equal(draft.versions[0].text,'手动修改');
    c.showPromptOptimizeVersion(0);
    assert.equal(c.promptOptimizeCandidate.value,'手动修改');
    assert.equal(draft.original,'宝宝第一年');
});
test('failed request retains candidate and allows retry',async()=>{
    const {c,draft} = fixture();
    c.promptOptimizeCandidate.value = '保留结果';
    c.fetch = async()=>({ok:false});
    await c.requestPromptOptimization(draft.original);
    assert.equal(c.promptOptimizeCandidate.value,'保留结果');
    assert.equal(draft.versions.length,0);
    assert.equal(c.promptOptimizeApply.disabled,false);
    assert.equal(draft.abortController,null);
});
test('late response after modal closes cannot add a version',async()=>{
    const {c,draft} = fixture();
    let resolve;
    c.fetch = ()=>new Promise(r=>{resolve=r;});
    const pending = c.requestPromptOptimization(draft.original);
    await new Promise(r=>setImmediate(r));
    c.stopPromptOptimizeRequest(draft);
    c.promptOptimizeDraft = null;
    resolve({ok:true,json:async()=>({text:'迟到结果'})});
    await pending;
    assert.equal(draft.versions.length,0);
});
test('empty response does not create a version',async()=>{
    const {c,draft} = fixture();
    c.fetch = async()=>({ok:true,json:async()=>({text:''})});
    await c.requestPromptOptimization(draft.original);
    assert.equal(draft.versions.length,0);
    assert.equal(c.promptOptimizeApply.disabled,true);
});
