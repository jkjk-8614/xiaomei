const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'xiaomei-fixture.test') return route.abort();
      if (url.pathname.startsWith('/static/')) {
        let file = path.join(root, decodeURIComponent(url.pathname));
        if (!fs.existsSync(file)) file = path.join(root, 'ComfyUI/web', url.pathname.slice(8));
        return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
      }
      if (url.pathname === '/api/canvases/fixture') {
        return route.fulfill({ json: { canvas: { id: 'fixture', title: 'Test canvas', nodes: [], connections: [], logs: [], settings: {} } } });
      }
      if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
      return route.fulfill({ json: {} });
    });

    await page.goto('http://xiaomei-fixture.test/static/smart-canvas.html?id=fixture');
    await page.waitForFunction(() => document.getElementById('smartTitle')?.textContent === 'Test canvas');
    const result = await page.evaluate(async () => {
      const workflow = {
        id: 'workflow', type: SMART_COMFY_WORKFLOW_NODE_TYPE, x: 260, y: 100, w: 390, h: 500,
        workflowRef: 'custom/test.json', workflowTitle: 'Test workflow', workflowFields: [],
        workflowStatus: 'ready', workflowReadiness: { can_run: true },
        runSettings: { engine: 'comfy', comfyMode: 'custom', comfyWorkflow: 'custom/test.json', comfyParams: {} }
      };
      const output = {
        id: 'existing-output', type: SMART_UPLOAD_NODE_TYPE, x: 720, y: 180, w: 280, h: 220,
        title: 'Image', images: [{ url: '/output/old.png', name: 'old.png', kind: 'image' }],
        runSettings: { engine: 'comfy', comfyMode: 'custom', comfyWorkflow: 'custom/test.json' },
        runAt: 100, runFinishedAt: 110, scale: 1
      };
      const downstream = { id: 'downstream', type: SMART_PAINT_NODE_TYPE, x: 1080, y: 180, images: [], runSettings: { engine: 'api' } };
      nodes = [workflow, output, downstream];
      canvas.connections = [
        { from: workflow.id, to: output.id, kind: 'flow' },
        { from: output.id, to: downstream.id, kind: 'input' }
      ];
      canvasUsesConnections = true;
      selectedId = workflow.id;
      selectedIds = [];
      selectedImage = { nodeId: '', index: -1 };
      settings = { ...settings, engine: 'comfy', comfyMode: 'custom', comfyWorkflow: 'custom/test.json', comfyParams: {} };
      promptInput.textContent = '更新工作流输出';
      ensureGenerationNotificationPermission = () => {};
      window.comfyRuns = [];
      window.failNextComfyRun = false;
      runComfyGeneration = async (source, prompt, refs, target, meta, options = {}) => {
        window.comfyRuns.push({ sourceId: source.id, targetId: target.id, preserveHistory: Boolean(options.preserveHistory) });
        if (window.failNextComfyRun) throw new Error('fixture generation failed');
        finalizePendingNode(target, [{ url: '/output/replacement.png', name: 'replacement.png', kind: 'image' }], meta, 'image', options);
      };

      await runGeneration();
      const firstOutput = nodes.find(item => item.id === output.id);
      const history = nodes.find(item => item.historyFor === output.id);
      const firstRun = {
        nodeIds: nodes.map(item => item.id),
        outputId: firstOutput?.id,
        outputImages: (firstOutput?.images || []).map(item => item.url),
        outputPosition: { x: firstOutput?.x, y: firstOutput?.y },
        historyImages: (history?.images || []).map(item => item.url),
        flowLinkKept: canvas.connections.some(item => item.from === workflow.id && item.to === output.id && item.kind === 'flow'),
        downstreamLinkKept: canvas.connections.some(item => item.from === output.id && item.to === downstream.id && item.kind === 'input'),
        historyLinkAdded: canvas.connections.some(item => item.from === output.id && item.to === history?.id && item.kind === 'history')
      };

      const busyWorkflow = { id: 'busy-workflow', type: SMART_COMFY_WORKFLOW_NODE_TYPE };
      const busyOutput = {
        id: 'busy-output', type: SMART_UPLOAD_NODE_TYPE, images: [], runSettings: { engine: 'comfy' },
        runAt: 200, pending: 1
      };
      nodes.push(busyWorkflow, busyOutput);
      canvas.connections.push({ from: busyWorkflow.id, to: busyOutput.id, kind: 'flow' });
      const busyOutputWasSkipped = existingComfyWorkflowOutputNode(busyWorkflow) === null;
      nodes = nodes.filter(item => item.id !== busyWorkflow.id && item.id !== busyOutput.id);
      canvas.connections = canvas.connections.filter(item => item.from !== busyWorkflow.id && item.to !== busyOutput.id);

      const emptyWorkflow = { id: 'empty-workflow', type: SMART_COMFY_WORKFLOW_NODE_TYPE };
      const emptyOutput = {
        id: 'empty-output', type: SMART_UPLOAD_NODE_TYPE, images: [], runSettings: { engine: 'comfy' },
        runAt: 300, runFinishedAt: 310
      };
      nodes.push(emptyWorkflow, emptyOutput);
      canvas.connections.push({ from: emptyWorkflow.id, to: emptyOutput.id, kind: 'flow' });
      const emptyOutputWasSkipped = existingComfyWorkflowOutputNode(emptyWorkflow) === null;
      nodes = nodes.filter(item => item.id !== emptyWorkflow.id && item.id !== emptyOutput.id);
      canvas.connections = canvas.connections.filter(item => item.from !== emptyWorkflow.id && item.to !== emptyOutput.id);

      window.failNextComfyRun = true;
      selectedId = workflow.id;
      await runGeneration();
      const failedOutput = nodes.find(item => item.id === output.id);
      const afterFailure = {
        outputId: failedOutput?.id,
        outputImages: (failedOutput?.images || []).map(item => item.url),
        runError: failedOutput?.runError || '',
        historyGroupCount: nodes.filter(item => item.historyFor === output.id).length,
        nodeIds: nodes.map(item => item.id)
      };
      return { firstRun, afterFailure, runs: window.comfyRuns, busyOutputWasSkipped, emptyOutputWasSkipped };
    });

    assert.equal(result.firstRun.outputId, 'existing-output');
    assert.deepEqual(result.firstRun.outputImages, ['/output/replacement.png']);
    assert(result.firstRun.nodeIds.includes('existing-output'));
    assert.equal(result.firstRun.nodeIds.filter(id => id === 'existing-output').length, 1);
    assert.deepEqual(result.firstRun.outputPosition, { x: 720, y: 180 });
    assert.deepEqual(result.firstRun.historyImages, ['/output/old.png']);
    assert.equal(result.firstRun.flowLinkKept, true);
    assert.equal(result.firstRun.downstreamLinkKept, true);
    assert.equal(result.firstRun.historyLinkAdded, true);
    assert.equal(result.busyOutputWasSkipped, true);
    assert.equal(result.emptyOutputWasSkipped, true);
    assert.deepEqual(result.runs, [
      { sourceId: 'existing-output', targetId: 'existing-output', preserveHistory: true },
      { sourceId: 'existing-output', targetId: 'existing-output', preserveHistory: true }
    ]);
    assert.equal(result.afterFailure.outputId, 'existing-output');
    assert.deepEqual(result.afterFailure.outputImages, ['/output/replacement.png']);
    assert.equal(result.afterFailure.runError, 'fixture generation failed');
    assert.equal(result.afterFailure.historyGroupCount, 1);
    assert.equal(result.afterFailure.nodeIds.filter(id => id === 'existing-output').length, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: ComfyUI workflow reuses its latest completed result node, preserves links and history, and keeps the last image after a failed rerun.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
