const {chromium} = require('../tools/commerce-analysis/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
    const browser = await chromium.launch({channel:'msedge',headless:true});
    try {
        const page = await browser.newPage();
        const html = fs.readFileSync(path.join(__dirname,'../static/smart-canvas.html'),'utf8');
        const modal = html.slice(html.indexOf('<div id="promptOptimizeModal"'),html.indexOf('<div id="smartBackgroundRemovalStatus"'));
        await page.setContent(`<style>:root{--card:#fff9ee;--line:#dbc5a6;--text:#493726;--soft:#fffaf3;--strong:#ad5900;--strong-text:#fff}*{box-sizing:border-box}</style>${modal}`);
        await page.addStyleTag({path:path.join(__dirname,'../static/css/smart-canvas.css')});
        await page.locator('#promptOptimizeModal').evaluate(el=>el.classList.add('open'));
        for(const viewport of [{width:1440,height:900},{width:768,height:700},{width:390,height:844}]){
            await page.setViewportSize(viewport);
            await page.locator('#promptOptimizeApply').scrollIntoViewIfNeeded();
            const box = await page.locator('#promptOptimizeApply').boundingBox();
            assert.ok(box && box.x>=0 && box.x+box.width<=viewport.width && box.y+box.height<=viewport.height);
        }
        console.log('PASS: optimizer actions reachable at desktop, tablet and mobile widths');
    } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
