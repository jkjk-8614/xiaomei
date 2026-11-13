(function () {
  const { net, state } = DX;
  const allCanvases = '__all__';
  const list = (value) => Array.isArray(value) ? value : [];

  function itemIsImage(item) {
    if (!item) return false;
    if (item.kind) return item.kind === 'image';
    const path = String(item.url || item.name || '').split(/[?#]/, 1)[0];
    return /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(path);
  }

  function classificationText(classification) {
    if (!classification) return '';
    const categories = Object.values(classification.categories || {}).flatMap(list);
    return [classification.summary, ...list(classification.tags), ...categories].filter(Boolean).join(' ');
  }

  function imageRow(item, ...keywords) {
    return {
      id: item.id,
      url: item.url,
      kind: item.kind || 'image',
      name: item.name || '未命名',
      search: [item.name, ...keywords].filter(Boolean).join(' ').toLowerCase(),
    };
  }

  const catalogRow = (item) => imageRow(item, item.caption, classificationText(item.classification));
  const named = (id, name) => ({ id, name });
  const counted = (name, count) => `${name} · ${count}`;

  function libraries() {
    return list(state.raw.assets?.libraries);
  }

  function groups(libraryId) {
    const entries = libraries();
    const library = entries.find(({ id }) => id === libraryId) || entries[0];
    return list(library?.categories);
  }

  function groupById(libraryId, groupId) {
    return groups(libraryId).find(({ id }) => id === groupId);
  }

  function matchesKind(kind, filter) {
    return !filter || filter === 'all' || (kind || 'classic') === filter;
  }

  function appendFolders(options, node, depth) {
    for (const child of list(node?.children)) {
      options.push(named(child.path, '　'.repeat(depth) + (child.name || child.path)));
      appendFolders(options, child, depth + 1);
    }
  }

  const adapters = {
    assets: {
      async load() {
        const response = await net.apiGet('/api/asset-library');
        return response.library || null;
      },
      optionsA() {
        return libraries().map(({ id, name }) => named(id, name || '资产库'));
      },
      optionsB(libraryId) {
        return groups(libraryId).map((group) => {
          const name = (group.name || '分组') + (group.type === 'workflow' ? '（工作流）' : '');
          return named(group.id, counted(name, list(group.items).length));
        });
      },
      items(libraryId, groupId) {
        const group = groupById(libraryId, groupId);
        return group?.type === 'workflow' ? [] : list(group?.items).map(catalogRow);
      },
      exportTarget(libraryId, groupId) {
        const group = groupById(libraryId, groupId);
        return group?.type === 'image' ? { label: group.name || '分组' } : null;
      },
      async doExport(libraryId, groupId, name, buffer) {
        const url = await net.uploadInputBase64(buffer, name);
        await net.apiSend('POST', '/api/asset-library/items', {
          library_id: libraryId, category_id: groupId, url, name,
        });
      },
    },
    canvas: {
      load: () => net.apiGet('/api/canvas-assets'),
      optionsA() {
        return list(state.raw.canvas?.categories).map(({ id, name }) => named(id, String(name)));
      },
      optionsB(kind) {
        const canvases = list(state.raw.canvas?.canvases).filter((canvas) => matchesKind(canvas.kind, kind));
        return [named(allCanvases, '全部画布'), ...canvases.map((canvas) =>
          named(canvas.id, counted(canvas.title || '未命名画布', canvas.asset_count || 0)))];
      },
      items(kind, canvasId) {
        return list(state.raw.canvas?.items)
          .filter((item) => matchesKind(item.canvas_kind, kind)
            && (!canvasId || canvasId === allCanvases || item.canvas_id === canvasId))
          .map((item) => imageRow(item, item.canvas_title, item.node_title));
      },
      exportTarget: () => null,
    },
    local: {
      load: () => net.apiGet('/api/local-assets'),
      optionsA: () => null,
      optionsB() {
        const options = [named('', '全部素材')];
        appendFolders(options, state.raw.local?.tree, 0);
        return options;
      },
      items(_libraryId, folder) {
        return list(state.raw.local?.items)
          .filter((item) => !folder || item.folder === folder || String(item.folder || '').startsWith(folder + '/'))
          .map(catalogRow);
      },
      exportTarget(_libraryId, folder) {
        return { label: folder || '全部素材' };
      },
      doExport(_libraryId, folder, name, buffer) {
        return net.uploadToFolder(folder || '', buffer, name);
      },
    },
  };

  DX.sources = { adapters, adapter: () => adapters[state.source], itemIsImage };
})();
