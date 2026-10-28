/* 商品研究工作区：顶部搜索、添加来源、最近访问、来源概览。
   只读写页面已有的 DOM 和 localStorage，不改动 commerce-analysis.js 的采集逻辑。 */
(function () {
  var grid = document.getElementById('desktopAppGrid');
  if (!grid) return;

  var RECENT_KEY = 'xiaomei.commerce.recentSources';
  var RECENT_MAX = 6;
  var search = document.getElementById('desktopAppSearch');
  var emptyState = document.getElementById('desktopEmptyState');
  var dialog = document.getElementById('desktopAddDialog');
  var form = document.getElementById('desktopAddForm');
  var urlField = document.getElementById('desktopAddUrl');

  function text(node, selector) {
    var el = node.querySelector(selector);
    return el ? String(el.textContent || '').trim() : '';
  }

  /* ---------------- 最近访问 ---------------- */
  function readRecent() {
    try {
      var list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) {}
  }
  function timeLabel(ts) {
    var diff = Date.now() - Number(ts || 0);
    if (!ts || diff < 0) return '刚刚';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
    var date = new Date(ts);
    var now = new Date();
    var sameDay = date.toDateString() === now.toDateString();
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    if (sameDay) return '今天 ' + hh + ':' + mm;
    var yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return '昨天';
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  function renderRecent() {
    var host = document.getElementById('railRecentList');
    if (!host) return;
    var list = readRecent();
    if (!list.length) {
      host.innerHTML = '<p class="rail-empty">打开平台后会自动记录在这里</p>';
      return;
    }
    host.innerHTML = list.map(function (item) {
      return '<button type="button" class="rail-recent-item" data-recent-id="' + item.id + '">' +
        '<span class="rail-recent-icon" style="' + (item.iconStyle || '') + '">' + (item.icon || '') + '</span>' +
        '<span class="rail-recent-copy"><span class="rail-recent-name">' + item.name + '</span>' +
        '<span class="rail-recent-time">' + timeLabel(item.ts) + '</span></span></button>';
    }).join('');
  }

  function rememberCard(card) {
    var id = card.getAttribute('data-desktop-app') || '';
    if (!id) return;
    var icon = card.querySelector('.desktop-app-icon');
    var list = readRecent().filter(function (x) { return x.id !== id; });
    list.unshift({
      id: id,
      name: text(card, 'strong') || id,
      domain: text(card, 'small'),
      ts: Date.now(),
      icon: icon ? icon.innerHTML : '',
      iconStyle: icon ? (icon.getAttribute('style') || '') : ''
    });
    writeRecent(list);
    renderRecent();
  }

  /* ---------------- 来源概览 ---------------- */
  function renderOverview() {
    var host = document.getElementById('railOverviewList');
    if (!host) return;
    // 按视觉顺序（grid-row）排，DOM 里跨境在内容平台之前，直接取 DOM 顺序会和页面对不上。
    var groups = [].slice.call(grid.querySelectorAll('.workspace-group:not(.local-workspace)'))
      .sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
    host.innerHTML = groups.map(function (group, index) {
      var color = getComputedStyle(group).getPropertyValue('--category-color').trim() || '#8a93a2';
      var count = group.querySelectorAll('.desktop-app-card').length;
      return '<button type="button" class="rail-overview-row" data-group-index="' + index + '">' +
        '<span class="rail-dot" style="background:' + color + '"></span>' +
        '<span class="rail-overview-name">' + (text(group, 'header h2') || '未命名分组') + '</span>' +
        '<b>' + count + '</b></button>';
    }).join('');
  }

  /* ---------------- 搜索 ---------------- */
  function columnCount() {
    var links = grid.querySelector('.workspace-links');
    if (!links) return 3;
    var tracks = getComputedStyle(links).gridTemplateColumns;
    return Math.max(1, tracks.split(' ').filter(Boolean).length);
  }

  function syncAddTiles() {
    var cols = columnCount();
    var filtering = Boolean(search && search.value.trim());
    [].slice.call(grid.querySelectorAll('.workspace-links')).forEach(function (links) {
      var tile = links.querySelector('.workspace-add-tile');
      if (!tile) return;
      var cards = links.querySelectorAll('.desktop-app-card').length;
      // 只在“补满最后一行”的位置显示占位卡，避免出现两格以上的空洞。
      var fits = cards % cols !== 0;
      tile.classList.toggle('is-hidden', filtering || !fits);
    });
  }

  function applyFilter() {
    var needle = String(search && search.value || '').trim().toLowerCase();
    var total = 0;
    [].slice.call(grid.querySelectorAll('.desktop-app-card')).forEach(function (card) {
      var haystack = (card.getAttribute('data-search') || '') + ' ' +
        text(card, 'strong') + ' ' + text(card, 'small');
      var hit = !needle || haystack.toLowerCase().indexOf(needle) !== -1;
      card.classList.toggle('is-filtered', !hit);
      if (hit) total += 1;
    });
    [].slice.call(grid.querySelectorAll('.workspace-group:not(.local-workspace)')).forEach(function (group) {
      var shown = group.querySelectorAll('.desktop-app-card:not(.is-filtered)').length;
      group.classList.toggle('is-empty-filtered', shown === 0);
    });
    if (emptyState) emptyState.classList.toggle('is-on', total === 0);
    syncAddTiles();
  }

  /* ---------------- 添加来源弹层 ---------------- */
  function openDialog() {
    if (!dialog) return;
    dialog.classList.add('is-open');
    dialog.setAttribute('aria-hidden', 'false');
    if (urlField) { urlField.value = ''; urlField.focus(); }
  }
  function closeDialog() {
    if (!dialog) return;
    dialog.classList.remove('is-open');
    dialog.setAttribute('aria-hidden', 'true');
  }

  function submitSource(raw) {
    var value = String(raw || '').trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    var field = document.getElementById('productUrl');
    if (field) field.value = value;
    var open = document.getElementById('openProduct');
    if (open) open.click();
    closeDialog();
  }

  /* ---------------- 事件 ---------------- */
  if (search) {
    search.addEventListener('input', applyFilter);
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { search.value = ''; applyFilter(); search.blur(); }
    });
  }

  document.addEventListener('keydown', function (event) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      if (search) search.focus();
    }
    if (event.key === 'Escape' && dialog && dialog.classList.contains('is-open')) closeDialog();
  });

  // 记录点击过的平台；不拦截原有路由，只是旁路记录。
  grid.addEventListener('click', function (event) {
    var card = event.target && event.target.closest ? event.target.closest('.desktop-app-card') : null;
    if (card && grid.contains(card)) { rememberCard(card); return; }
    var recent = event.target && event.target.closest ? event.target.closest('[data-recent-id]') : null;
    if (recent) {
      var target = grid.querySelector('.desktop-app-card[data-desktop-app="' + recent.getAttribute('data-recent-id') + '"]');
      if (target) target.click();
      return;
    }
    var overview = event.target && event.target.closest ? event.target.closest('[data-group-index]') : null;
    if (overview) {
      var groups = [].slice.call(grid.querySelectorAll('.workspace-group:not(.local-workspace)'))
        .sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
      var group = groups[Number(overview.getAttribute('data-group-index'))];
      if (group) group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    var addTile = event.target && event.target.closest ? event.target.closest('[data-add-source]') : null;
    if (addTile) openDialog();
  });

  var addLink = document.getElementById('desktopAddLink');
  if (addLink) addLink.addEventListener('click', openDialog);

  if (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target.closest('[data-add-close]')) closeDialog();
    });
  }
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitSource(urlField ? urlField.value : '');
    });
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncAddTiles, 120);
  });

  renderRecent();
  renderOverview();
  syncAddTiles();
})();
