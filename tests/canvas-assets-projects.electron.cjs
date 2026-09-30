const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-canvas-assets-ui-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => app.exit(1), 60000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false, width:1500, height:960, webPreferences:{contextIsolation:true, nodeIntegration:false}});
  const run = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async code => {
    for(let index = 0; index < 100; index++){
      if(await run(`Boolean(${code})`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout: ${code}`);
  };
  await win.loadURL('http://127.0.0.1:3017/static/asset-manager.html');
  await waitFor("document.querySelector('[data-tab=canvas-assets]') && localAssetsLoaded");
  await run(`
    canvasAssetsData = {
      projects:[
        {id:'default',name:'水晶相框',order:0},
        {id:'wedding',name:'婚纱相框',order:1},
        {id:'empty',name:'空项目',order:2}
      ],
      canvases:[
        {id:'a',title:'主图',kind:'smart',project:'default'},
        {id:'b',title:'详情页',kind:'smart',project:'wedding'},
        {id:'c',title:'旧画布',kind:'classic',project:'wedding'}
      ],
      items:[
        {id:'a1',name:'水晶.png',url:'/fixtures/相框00.png',kind:'image',canvas_id:'a',canvas_title:'主图',canvas_kind:'smart',project:'default'},
        {id:'b1',name:'婚纱.png',url:'/fixtures/相框01.png',kind:'image',canvas_id:'b',canvas_title:'详情页',canvas_kind:'smart',project:'wedding'},
        {id:'c1',name:'旧图.png',url:'/fixtures/相框02.png',kind:'image',canvas_id:'c',canvas_title:'旧画布',canvas_kind:'classic',project:'wedding'}
      ]
    };
    document.querySelector('[data-tab=canvas-assets]').click();
  `);
  await waitFor("document.querySelectorAll('[data-canvas-asset-project]').length === 3");
  assert.deepEqual(await run("[...document.querySelectorAll('[data-canvas-asset-project] .tree-row-name')].map(el => el.textContent)"),
    ['水晶相框', '婚纱相框', '空项目']);
  assert.deepEqual(await run("currentCanvasAssetItems().map(item => item.id)"), ['a1']);
  await run("document.querySelector('[data-canvas-asset-project=wedding]').click()");
  assert.deepEqual(await run("currentCanvasAssetItems().map(item => item.id)"), ['b1']);
  assert.equal(await run("document.querySelector('[data-canvas-asset-project=wedding] .tree-row-count').textContent"), '1');
  assert.equal(await run("document.querySelector('.detail-meta-grid').textContent.includes('婚纱相框')"), true);
  await run("document.querySelector('[data-canvas-asset-canvas=b]').click()");
  assert.equal(await run('activeCanvasAssetCanvasId'), 'b');
  await run("document.querySelector('[data-canvas-asset-project=empty]').click()");
  assert.deepEqual(await run('currentCanvasAssetItems().map(item => item.id)'), []);
  assert.equal(await run("document.querySelector('.empty-state').textContent.includes('当前项目')"), true);
  assert.equal(await run('activeCanvasAssetCanvasId'), '');
  clearTimeout(watchdog);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
