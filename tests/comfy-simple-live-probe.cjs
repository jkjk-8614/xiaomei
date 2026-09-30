const {chromium}=require('../tools/commerce-analysis/node_modules/playwright');
(async()=>{
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1680,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:3000/static/comfyui.html');
await page.locator('#app-run').waitFor({timeout:60000});
console.log(JSON.stringify({title:await page.locator('.app-heading h2').innerText(),images:await page.locator('#app-detail input[type=file]').count(),disabled:await page.locator('#app-run').isDisabled(),errors}));
await page.screenshot({path:'logs/comfy-simple-actual.png',fullPage:true});
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
