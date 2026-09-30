// 在隔离、不可见的 Electron 页面中执行当前桌面端采集脚本。
// fixture 只验证六站点各自的页型/资料白名单，避免把小红书的互动或媒体
// 规则错误带到千牛、生意参谋、达摩盘和 1688。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let electron = null;
try { electron = require('electron'); } catch {}

// 开发源码包不携带 Electron 运行时；此文件在桌面端 CI/打包环境运行。
// 用普通 node 执行时明确跳过，而不是把 require('electron') 返回的可执行路径
// 误当成 Electron API。
if (!electron || typeof electron !== 'object' || !electron.app || !electron.BrowserWindow) {
  console.log('assistant DOM assertions skipped (Electron runtime unavailable)');
  process.exit(0);
}

const { app, BrowserWindow } = electron;
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const tick = String.fromCharCode(96);
const prefix = `const ELECTRON_ASSISTANT_CONTEXT_SCRIPT = String.raw${tick}`;
const start = source.indexOf(prefix) + prefix.length;
const lfMarker = `${tick};\n\nif (process.platform`;
const crlfMarker = `${tick};\r\n\r\nif (process.platform`;
const end = source.indexOf(lfMarker, start) >= 0 ? source.indexOf(lfMarker, start) : source.indexOf(crlfMarker, start);
if (start < prefix.length || end < 0) throw new Error('未找到桌面端采集脚本');

const captureScript = source.slice(start, end);
function scriptFor(host, pathname) {
  // data: URL 没有站点 host；仅替换位置以使同一采集器进入对应站点分支，
  // 不加载或访问任何真实平台页面。
  return captureScript
    .replace('const host = location.hostname.toLowerCase();', `const host = '${host}';`)
    .replace('const path = location.pathname.toLowerCase();', `const path = '${pathname}';`);
}
function fixture(body) {
  return `<!doctype html><html><body style="margin:0;display:block;width:1200px;height:800px">${body}</body></html>`;
}
function xhsFixture() {
  return fixture(`<section role="dialog" style="display:block;width:1000px;height:700px;overflow:auto">
    <a href="/user/profile/abcdef" style="display:block"><span>无锥10010001</span><span> 关注</span></a>
    <h1>原来10年前就有鼻癌了吗。！</h1><div>08-04 河南</div><div>#all命 #从零开始的异世界生活 #抽纹</div>
    <div>1/9</div><img src="https://img.example/cover.jpg" style="display:block;width:500px;height:300px" />
    <div class="interactions" style="display:flex;gap:12px">
      <span class="like-icon" aria-label="like"></span><span class="like-count">4346</span><button class="collect-wrapper">268</button>
      <button class="chat-wrapper">95</button><button class="share-wrapper">5</button>
    </div><div>共 95 条评论</div><div class="comment-item">用户A：作品很有意思</div>
  </section>`);
}
async function capture(win, host, pathname, html) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win.webContents.executeJavaScript(scriptFor(host, pathname), true);
}
function factMap(snapshot) {
  return new Map((snapshot?.structured?.facts || []).map((item) => [item.label, item.value]));
}
function resourceIds(snapshot) {
  return (snapshot?.structured?.resources || []).map((item) => item.id).sort();
}

app.setPath('userData', path.join(os.tmpdir(), `xiaomei-assistant-dom-test-${process.pid}`));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: false },
  });
  try {
    const xhs = await capture(win, 'www.xiaohongshu.com', '/', xhsFixture());
    const xhsFacts = factMap(xhs);
    assert.equal(xhs?.structured?.title, '小红书图文');
    assert.equal(xhsFacts.get('博主'), '无锥10010001');
    assert.equal(xhsFacts.get('图片'), '9 张');
    assert.equal(xhsFacts.get('点赞'), '4346');
    assert.equal(xhsFacts.get('收藏'), '268');
    assert.equal(xhsFacts.get('评论'), '95');
    assert.equal(xhsFacts.get('分享'), '5');
    assert.deepEqual(resourceIds(xhs), ['xhs-comments', 'xhs-content']);

    const qianNiu = await capture(win, 'myseller.taobao.com', '/home.htm/app-customer-service/toolpage/Message', fixture(`
      <h1>客户聊天记录</h1><div>客户：示例客户</div><div>接待中</div>
      <div data-message-id="1">您好，我想了解尺码</div><div data-message-id="2">您好，可以为您说明。</div>`));
    const qianNiuFacts = factMap(qianNiu);
    assert.equal(qianNiu?.structured?.title, '客服 > 聊天记录');
    assert.equal(qianNiuFacts.get('客户'), '示例客户');
    assert.equal(qianNiuFacts.get('聊天消息'), '2 条');
    assert.equal(qianNiuFacts.has('支付金额'), false);
    assert.deepEqual(resourceIds(qianNiu), ['qianniu-chat-records']);

    const sycm = await capture(win, 'sycm.taobao.com', '/marketing', fixture(`
      <h1>营销概况</h1><div>统计时间：2026-09-01</div><div class="metric">消耗：120</div>
      <div class="metric">引导支付金额：999</div><div class="metric">ROI：3.5</div><table><caption>推广计划</caption><tr><th>计划</th><th>消耗</th></tr><tr><td>A</td><td>120</td></tr></table>`));
    const sycmFacts = factMap(sycm);
    assert.equal(sycm?.structured?.title, '生意参谋 > 营销');
    assert.equal(sycmFacts.get('当前模块'), '营销');
    assert.equal(sycmFacts.get('消耗'), '120');
    assert.equal(sycmFacts.get('ROI'), '3.5');
    assert.deepEqual(resourceIds(sycm), ['sycm-current-report']);

    const dmp = await capture(win, 'dmp.taobao.com', '/items/growup-path', fixture(`
      <h1>商品打爆路径</h1><div>当前商品：示例商品A</div><div>对比商品：示例商品B</div>
      <div class="metric">商品支付金额：2000</div><div class="metric">支付转化率：12.5%</div>
      <table><caption>打爆路径</caption><tr><th>阶段</th><th>金额</th></tr><tr><td>成长</td><td>2000</td></tr></table>`));
    const dmpFacts = factMap(dmp);
    assert.equal(dmp?.structured?.title, '达摩盘 > 商品打爆路径');
    assert.equal(dmpFacts.get('当前商品'), '示例商品A');
    assert.equal(dmpFacts.get('对比商品'), '示例商品B');
    assert.equal(dmpFacts.get('商品支付金额'), '2000');
    assert.deepEqual(resourceIds(dmp), ['dmp-growup-path']);

    const douyin = await capture(win, 'www.douyin.com', '/video/123', fixture(`
      <section role="dialog" style="display:block;width:900px;height:650px"><a href="/user/example">示例作者 关注</a><h1>当前视频标题</h1><div>昨天</div>
      <video style="display:block;width:400px;height:240px"></video><div class="interactions">
      <button class="like-wrapper">88</button><button class="collect-wrapper">9</button>
      <button class="comment-wrapper">7</button><button class="share-wrapper">6</button></div></section>`));
    const douyinFacts = factMap(douyin);
    assert.equal(douyin?.structured?.title, '抖音当前视频');
    assert.equal(douyinFacts.get('作者'), '示例作者');
    assert.equal(douyinFacts.get('点赞'), '88');
    assert.equal(douyinFacts.get('收藏'), '9');
    assert.equal(douyinFacts.get('评论'), '7');
    assert.equal(douyinFacts.get('转发'), '6');
    assert.deepEqual(resourceIds(douyin), ['douyin-content']);

    const offer = await capture(win, 'detail.1688.com', '/offer/123.html', fixture(`
      <h1>样品商品</h1><div>￥12.50</div><div>10件起批</div><div>示例服饰工厂</div>
      <div>成交 321</div><div>评价 45</div>
      <img src="https://img.example/offer.jpg" style="display:block;width:120px;height:80px"><video style="display:block;width:120px;height:80px"></video>
      <div class="detail-description">图文详情<img src="https://img.example/detail.jpg" style="display:block;width:120px;height:80px"></div>
      <div class="sku-options">规格：颜色 尺码<img src="https://img.example/sku.jpg" style="display:block;width:80px;height:80px"></div>
      <div class="review-item">买家评价：质量很好</div>`));
    const offerFacts = factMap(offer);
    assert.equal(offer?.structured?.title, '1688 商品详情');
    assert.equal(offerFacts.get('价格'), '￥12.50');
    assert.equal(offerFacts.get('起订量'), '10件起批');
    assert.equal(offerFacts.get('成交'), '321');
    assert.equal(offerFacts.get('评价'), '45');
    assert.deepEqual(resourceIds(offer), ['1688-detail-image-files', '1688-detail-images', '1688-main-images', '1688-main-videos', '1688-product-info', '1688-reviews', '1688-sku-images', '1688-sku-list']);
    console.log('assistant per-site DOM assertions passed');
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(error?.stack || error);
  app.exitCode = 1;
  app.quit();
});
