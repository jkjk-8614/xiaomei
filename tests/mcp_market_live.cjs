const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto('http://127.0.0.1:3129/');
    await page.getByRole('button',{name:'MCP 设置',exact:true}).click();
    await page.locator('#mcp-market-tab').click();
    await page.locator('#mcp-search').fill('blender');
    await page.locator('#mcp-search-button').click();
    await page.locator('.mcp-market-card').first().waitFor({timeout:25000});
    assert.ok(await page.locator('.mcp-market-card').count());
    await page.screenshot({path:'C:/Users/小美/Documents/临时对话/mcp-market-live.png'});
    console.log(await page.locator('#mcp-market-status').textContent());
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
