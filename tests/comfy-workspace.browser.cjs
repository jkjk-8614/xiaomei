const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto('http://127.0.0.1:3000/static/comfyui.html');
    await page.getByText(/本地服务在线/).waitFor();
    if (!(await page.locator('#library').isVisible())) throw new Error('默认应显示应用库');
    await page.getByRole('button', {name:'高级编辑',exact:true}).click();
    const native = page.frameLocator('#editor');
    await native.locator('#vue-app').waitFor();
    await native.getByRole('button').first().waitFor({timeout: 60000});
    if (!(await native.locator('body').innerText()).trim()) throw new Error('ComfyUI 编辑器为空');
    await page.locator('#file').setInputFiles({ name: 'dependency-test.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({nodes:[{id:1,type:'MissingTestNode'}]})) });
    await page.getByText('缺少节点：', {exact:false}).waitFor();
    await page.getByRole('button', {name:'关闭检查结果'}).click();
    await page.getByText('更多', {exact:true}).click();
    await page.getByRole('button', {name:'画布设置',exact:true}).click();
    await page.frameLocator('#settings').getByText('ComfyUI 后端地址', {exact:true}).waitFor();
    await page.getByRole('button', {name:'高级编辑',exact:true}).click();
    await page.screenshot({path:'logs/comfy-workspace-verification.png'});
    if (process.env.COMFY_TEST_WORKFLOW) {
      const source = require('fs').readFileSync(process.env.COMFY_TEST_WORKFLOW, 'utf8');
      const frame = page.frames().find(f => f.url().startsWith('http://127.0.0.1:8188/'));
      const count = await frame.evaluate(async text => {
        const { app } = await import('/scripts/app.js');
        await app.handleFile(new File([text], 'import-verification.json', {type:'application/json'}));
        return app.graph._nodes.length;
      }, source);
      if (count !== JSON.parse(source).nodes.length) throw new Error('导入后的节点数量不符');
      console.log('PASS: native JSON import, nodes=' + count + '; workflow not executed');
    }
    console.log('PASS: local editor, dependency inspection, settings, tab preservation');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
