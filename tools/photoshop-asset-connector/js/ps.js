(function () {
  const { app, action, core, constants } = require('photoshop');
  const { storage, shell } = require('uxp');
  const { net, sources, state } = DX;
  const anchors = constants.AnchorPosition;
  const binary = { format: storage.formats.binary };
  const edges = [
    { name: 'left', horizontal: true, leading: true, near: anchors.MIDDLELEFT, far: anchors.MIDDLERIGHT },
    { name: 'right', horizontal: true, leading: false, near: anchors.MIDDLELEFT, far: anchors.MIDDLERIGHT },
    { name: 'top', horizontal: false, leading: true, near: anchors.TOPCENTER, far: anchors.BOTTOMCENTER },
    { name: 'bottom', horizontal: false, leading: false, near: anchors.TOPCENTER, far: anchors.BOTTOMCENTER },
  ];
  let nextFile = 0;

  function activeDocument() {
    return app.documents.length ? app.activeDocument : null;
  }

  function requireDocument() {
    const doc = activeDocument();
    if (!doc) throw new Error('没有打开的 Photoshop 文档');
    return doc;
  }

  function hasDocument() {
    return app.documents.length > 0;
  }

  function docSize() {
    const doc = activeDocument();
    return doc && { w: Math.round(doc.width), h: Math.round(doc.height) };
  }

  async function modal(commandName, operation) {
    let result;
    await core.executeAsModal(async (context) => {
      result = await operation(context);
    }, { commandName });
    return result;
  }

  function stem(name, fallback) {
    return String(name || '').replace(/\.(?:png|jpe?g|tiff?|bmp|gif|avif|webp|hei[cf]|psd|psb|pdf)$/i, '').trim() || fallback;
  }

  async function temporaryFile(label, extension) {
    const folder = await storage.localFileSystem.getTemporaryFolder();
    const name = String(label || '图片').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').slice(0, 48).trim();
    const key = Date.now().toString(36) + '-' + (++nextFile);
    return folder.createFile('xm-' + key + '-' + (name || '图片') + '.' + extension);
  }

  async function removeTemporaryFile(file) {
    try {
      await file.delete();
    } catch (_) {
      // UXP also clears its temporary storage when the session ends.
    }
  }

  async function exportFile(extension, save) {
    const file = await temporaryFile('导出', extension);
    try {
      const metadata = await save(file);
      if (!metadata) return null;
      return { ...metadata, buffer: await file.read(binary) };
    } finally {
      await removeTemporaryFile(file);
    }
  }

  async function command(descriptor) {
    const [result] = await action.batchPlay([descriptor], {});
    if (result?._obj === 'error') {
      throw new Error(result.message || 'Photoshop 无法执行此操作');
    }
  }

  async function embedImage(file) {
    const token = storage.localFileSystem.createSessionToken(file);
    await command({
      _obj: 'placeEvent',
      null: { _kind: 'local', _path: token },
      linked: false,
      _options: { dialogOptions: 'dontDisplay' },
    });
  }

  async function fitLayer(layer, bounds) {
    const original = layer.boundsNoEffects;
    const width = original.right - original.left;
    const height = original.bottom - original.top;
    if (!(width > 0 && height > 0)) throw new Error('生成的图层没有可置入的像素');
    await layer.scale(100 * bounds.width / width, 100 * bounds.height / height, anchors.TOPLEFT);
    const scaled = layer.boundsNoEffects;
    const x = bounds.left - scaled.left;
    const y = bounds.top - scaled.top;
    if (x || y) await layer.translate(x, y);
  }

  async function place(item, bounds) {
    if (!sources.itemIsImage(item)) throw new Error('请选择图片素材');
    const targetId = bounds?.documentId ?? activeDocument()?.id;
    const converted = net.needsJpeg(item.url);
    const path = String(item.url).split(/[?#]/, 1)[0];
    const extension = converted ? 'jpg' : (/\.(\w{1,5})$/.exec(path)?.[1]?.toLowerCase() || 'png');
    const buffer = await net.fetchBytes(converted ? net.displayUrl(item.url) : item.url);
    const file = await temporaryFile(stem(item.name, '素材'), extension);
    let opened = false;
    try {
      await file.write(buffer, binary);
      const title = bounds ? '置入选区结果' : '置入素材';
      await modal(title, async ({ hostControl }) => {
        if (targetId == null) {
          await app.open(file);
          opened = true;
          return;
        }
        const doc = Array.from(app.documents).find((entry) => entry.id === targetId);
        if (!doc) throw new Error('素材对应的 Photoshop 文档已关闭');
        const previous = activeDocument();
        if (previous?.id !== doc.id) app.activeDocument = doc;
        try {
          const history = await hostControl.suspendHistory({ documentID: doc.id, name: title });
          await embedImage(file);
          const layer = doc.activeLayers[0];
          if (!layer) throw new Error('Photoshop 未返回置入的图层');
          if (item.name) layer.name = stem(item.name, layer.name);
          if (bounds) await fitLayer(layer, bounds);
          await hostControl.resumeHistory(history, true);
        } finally {
          if (previous && previous.id !== doc.id) app.activeDocument = previous;
        }
      });
    } finally {
      // The document opened directly still owns its backing file.
      if (!opened) await removeTemporaryFile(file);
    }
  }

  const placeImage = (item) => place(item, null);
  const placeImageAt = (item, bounds) => place(item, bounds);

  async function withTemporaryDocument(source, context, create, use) {
    const existing = new Set(Array.from(app.documents, (doc) => doc.id));
    const copy = await create();
    if (!copy || existing.has(copy.id)) throw new Error('Photoshop 未创建临时文档');
    try {
      // Also close when Photoshop cancels the modal before cleanup can run.
      await context.hostControl.registerAutoCloseDocument(copy.id);
      return await use(copy);
    } finally {
      if (!context.isCancelled) {
        await copy.closeWithoutSaving();
        await context.hostControl.unregisterAutoCloseDocument(copy.id);
        app.activeDocument = source;
      }
    }
  }

  function exportDocPng() {
    return exportFile('png', (file) => modal('导出文档', async () => {
      const doc = requireDocument();
      await doc.saveAs.png(file, {}, true);
      return { name: stem(doc.name, '文档') };
    }));
  }

  function exportActiveLayerPng() {
    return exportFile('png', (file) => modal('导出选中图层', async (context) => {
      const doc = requireDocument();
      const selected = doc.activeLayers[0];
      if (!selected) throw new Error('请在图层面板选择要导出的图层');
      const name = stem(selected.name, '图层');
      const create = async () => {
        await command({
          _obj: 'make',
          _target: [{ _ref: 'document' }],
          using: {
            _ref: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
              { _ref: 'document', _id: doc.id }],
          },
          name: '小美画布图层副本',
        });
        return activeDocument();
      };
      await withTemporaryDocument(doc, context, create, (copy) => copy.saveAs.png(file, {}, true));
      return { name };
    }));
  }

  const exportCurrentPng = () => state.exportLayer ? exportActiveLayerPng() : exportDocPng();

  async function selectionRectangle(doc) {
    let box;
    if (doc.selection) {
      box = doc.selection.bounds;
    } else {
      const [result] = await action.batchPlay([{
        _obj: 'get',
        _target: [{ _property: 'selection' }, { _ref: 'document', _id: doc.id }],
      }], {});
      box = result?.selection;
    }
    if (!box) return null;
    const pixel = (value) => Math.round(value?._value ?? value);
    const rect = { left: pixel(box.left), top: pixel(box.top), right: pixel(box.right), bottom: pixel(box.bottom) };
    return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
  }

  function exportSelection(transparent) {
    const mime = transparent ? 'image/png' : 'image/jpeg';
    const extension = transparent ? 'png' : 'jpg';
    return exportFile(extension, (file) => modal('导出选区', async (context) => {
      const doc = requireDocument();
      const rect = await selectionRectangle(doc);
      if (!rect) return null;
      const create = () => doc.duplicate('小美画布选区副本', true);
      await withTemporaryDocument(doc, context, create, async (copy) => {
        await copy.crop(rect);
        if (transparent) await copy.saveAs.png(file, {}, true);
        else await copy.saveAs.jpg(file, { quality: 12, matteColor: constants.MatteColor.WHITE }, true);
      });
      return {
        mime, name: 'selection',
        bounds: { left: rect.left, top: rect.top, width: rect.right - rect.left,
          height: rect.bottom - rect.top, documentId: doc.id },
      };
    })).then((result) => {
      if (!result) return null;
      const { buffer, ...metadata } = result;
      return { ...metadata, base64: net.toBase64(buffer) };
    });
  }

  const exportSelectionJpeg = () => exportSelection(false);
  const exportSelectionTransparent = () => exportSelection(true);

  function outpaintDirections(directions, amount) {
    const selectedEdges = edges.filter(({ name }) => directions?.[name]);
    if (!selectedEdges.length) return Promise.resolve({ error: '请选择要扩展的方向' });
    const pixels = Math.round(Number(amount));
    if (!Number.isSafeInteger(pixels) || pixels < 1) throw new Error('请输入有效的扩展像素数');
    return modal('导出扩图参考', async (context) => {
      const doc = requireDocument();
      const { w, h } = docSize();
      const blocks = [];
      for (const edge of selectedEdges) {
        const { name, horizontal, leading, near, far } = edge;
        const extent = horizontal ? w : h;
        const start = leading ? 0 : Math.max(0, extent - pixels);
        const end = leading ? Math.min(extent, pixels) : extent;
        const crop = horizontal
          ? { left: start, top: 0, right: end, bottom: h }
          : { left: 0, top: start, right: w, bottom: end };
        const create = () => doc.duplicate('小美画布扩图副本', true);
        const width = horizontal ? 2 * pixels : w;
        const height = horizontal ? h : 2 * pixels;
        const { buffer } = await exportFile('png', async (file) => {
          await withTemporaryDocument(doc, context, create, async (copy) => {
            const background = copy.backgroundLayer;
            if (background) {
              await background.duplicate();
              await background.delete();
            }
            if (end - start < extent) await copy.crop(crop);
            // Pad short reference strips before adding the transparent extension.
            if (extent < pixels) {
              await copy.resizeCanvas(horizontal ? pixels : w, horizontal ? h : pixels, leading ? near : far);
            }
            await copy.resizeCanvas(width, height, leading ? far : near);
            await copy.saveAs.png(file, {}, true);
          });
          return {};
        });
        const origin = leading ? -pixels : extent - pixels;
        blocks.push({
          dir: name, mime: 'image/png', name: 'outpaint_' + name, size: width + 'x' + height,
          base64: net.toBase64(buffer),
          bounds: { left: horizontal ? origin : 0, top: horizontal ? 0 : origin,
            width, height, documentId: doc.id },
        });
      }
      return { blocks };
    });
  }

  const openUrl = (url) => shell.openExternal(url);
  const openExternal = (item) => openUrl(net.absUrl(item.url));

  function onDocChange(callback) {
    return action.addNotificationListener(['open', 'close', 'select', 'make'], callback).catch(() => {});
  }

  DX.ps = {
    hasDocument, docSize, placeImage, placeImageAt, exportDocPng, exportActiveLayerPng, exportCurrentPng,
    exportSelectionJpeg, exportSelectionTransparent, outpaintDirections, openExternal, openUrl, onDocChange,
  };
})();
