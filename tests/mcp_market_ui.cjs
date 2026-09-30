const {chromium, expect} = require('../tools/commerce-analysis/node_modules/playwright');
const assert = require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>{if(e.stack?.includes('mcp-settings'))errors.push(e.message);});
    let saved={servers:[]}, writes=0, tests=0;
    await page.route('**/api/mcp/settings',async route=>{
      if(route.request().method()==='PUT'){saved=route.request().postDataJSON();writes++;}
      await route.fulfill({json:saved});
    });
    await page.route('**/api/mcp/test',async route=>{tests++;await route.fulfill({json:{ok:true,tools:[]}});});
    const item={name:'io.example/blender',title:'Blender Studio',version:'1.0.0',description:'Create and inspect Blender scenes.',website:'https://example.com',metadata:{name:'io.example/blender'},options:[{label:'npm · blender-fixture@1.0.0',config:{name:'io.example-blender',transport:'stdio',command:'npx',args:['-y','blender-fixture@1.0.0'],env:{},headers:{},enabled:false}}]};
    await page.route('**/api/mcp/market?*',async route=>{
      const url=new URL(route.request().url());
      if(url.searchParams.get('q')==='failure')return route.fulfill({status:502,json:{detail:'MCP 官方目录暂时不可用，请稍后重试。'}});
      if(url.searchParams.get('q')==='empty')return route.fulfill({json:{items:[],nextCursor:''}});
      if(url.searchParams.get('cursor'))return route.fulfill({json:{items:[{...item,name:'io.example/manual',title:'Manual service',website:'javascript:alert(1)',options:[]}],nextCursor:''}});
      return route.fulfill({json:{items:[item],nextCursor:'page2'}});
    });
    await page.goto('http://127.0.0.1:3129/');
    await page.getByRole('button',{name:'MCP 设置',exact:true}).click();
    await page.locator('#mcp-market-tab').click();
    await page.locator('#mcp-search').fill('blender');
    await page.locator('#mcp-search-button').click();
    await page.getByText('已显示 1 个服务',{exact:true}).waitFor();
    await page.getByRole('button',{name:'查看详情',exact:true}).first().click();
    await page.locator('#mcp-market-add').click();
    assert.equal(await page.locator('#mcp-enabled').isChecked(),false);
    assert.equal(writes,0);assert.equal(tests,0);
    await page.locator('#mcp-save').click();
    await page.getByText('设置已保存',{exact:true}).waitFor();
    assert.equal(saved.servers.length,1);
    await page.locator('#mcp-market-tab').click();
    await page.locator('#mcp-market-add').click();
    await page.getByText('此名称的配置已存在，请在“我的配置”中查看；未重复添加。',{exact:true}).waitFor();
    await page.locator('#mcp-market-more').click();
    await page.getByText('已显示 2 个服务',{exact:true}).waitFor();
    await page.getByRole('button',{name:'查看详情',exact:true}).last().click();
    assert.equal(await page.locator('#mcp-market-detail a').count(),0);
    assert.equal(await page.locator('#mcp-market-add').count(),0);
    await page.locator('#mcp-market-view').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:'C:/Users/小美/Documents/临时对话/mcp-market-desktop.png'});
    await page.setViewportSize({width:600,height:800});
    assert.equal(await page.locator('#mcp-market-view').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.screenshot({path:'C:/Users/小美/Documents/临时对话/mcp-market-mobile.png'});
    for(const q of ['empty','failure']){
      await page.locator('#mcp-search').fill(q);await page.locator('#mcp-search-button').click();
      await page.waitForFunction(()=>!document.getElementById('mcp-market-status').textContent.includes('正在查询'));
      assert.equal(await page.locator('.mcp-market-card').count(),0);
    }
    assert.equal(tests,0);assert.equal(writes,1);assert.deepEqual(errors,[]);
    console.log('Market UI passed: search, pagination, details, safe draft, duplicate, unsupported, network error, empty, responsive.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
