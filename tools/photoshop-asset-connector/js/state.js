(function () {
  const panel = window.DX || (window.DX = {});

  // These keys belong to the installed UXP panel's preferences.
  panel.LS = {
    source: 'daxiong.assets.source',
    exportLayer: 'daxiong.assets.exportLayer',
    host: 'daxiong.assets.host',
  };

  panel.emptyCatalog = () => ({ assets: null, canvas: null, local: null });
  panel.state = {
    tab: 'settings',
    source: 'assets',
    aId: '',
    bId: '',
    selectedId: '',
    raw: panel.emptyCatalog(),
    connected: false,
    host: '',
    exportLayer: false,
  };
})();
