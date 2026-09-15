// HMusic Bridge 配置/搜索页
// 运行于 Songloft webview:window.SongloftPlugin 由宿主注入(apiGet/apiPost/player)。
// 无宿主环境(浏览器直开)时降级为仅搜索,入库/播放禁用。
//
// 注:宿主 common.js 封装按 '.' + path 拼接,插件 API 必须传前导斜杠 '/api/...'。
// 静态资源由宿主经 /static/* 提供,HTML 引用须带 static/ 前缀。

(function () {
  'use strict';

  var plugin = window.SongloftPlugin;
  var apiGet = plugin && plugin.apiGet;
  var apiPost = plugin && plugin.apiPost;
  var host = plugin && plugin.host;
  // player 与 host 平级挂在 SongloftPlugin 上;player.setQueue 把宿主数字歌曲 ID 交给宿主播放器。
  var player = plugin && plugin.player;

  var el = function (id) { return document.getElementById(id); };
  var chip = el('status-chip');
  var hint = el('config-hint');
  var hostHint = el('host-hint');
  var searchMeta = el('search-meta');
  var resultsWrap = el('results-wrap');
  var resultsList = el('results');

  var browserOnly = !apiGet || !apiPost;
  // hostAvailable 必须等 host.getInfo() 握手成功才置位；握手失败即回退禁用。
  var hostAvailable = false;
  var hostCaps = [];
  var lastResults = [];
  var lastImportedIds = [];
  var importBusy = false;

  function setChip(text, cls) {
    chip.textContent = text;
    chip.className = 'chip' + (cls ? ' ' + cls : '');
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ===== 宿主能力 =====

  function canPlay() {
    // 三重门槛：宿主握手成功 + capabilities 声明 player + player.setQueue 存在。
    // 宿主公共脚本在桥不可用时也会注入 player.setQueue，缺任何一环都会“先入库再播放失败”。
    return hostAvailable
      && hostCaps.indexOf('player') >= 0
      && Boolean(player && typeof player.setQueue === 'function');
  }

  // 搜索结果已渲染时同步刷新按钮可用性（握手是异步的，可能晚于首次搜索完成）。
  function updateImportButtons() {
    if (resultsWrap.classList.contains('hidden')) return;
    el('btn-import-play').disabled = importBusy || !canPlay();
    el('btn-import').disabled = importBusy || !hostAvailable;
    el('btn-retry-play').disabled = importBusy || !canPlay() || !lastImportedIds.length;
  }

  function checkHost() {
    if (browserOnly) {
      hostHint.textContent = '未检测到 Songloft 宿主（浏览器直开）：仅搜索，入库/播放请在 Songloft 客户端内使用。';
      return;
    }
    if (!host || !host.isAvailable || !host.isAvailable()) {
      hostHint.textContent = '宿主环境不可用：无法入库与播放。';
      return;
    }
    host.getInfo().then(function (info) {
      hostAvailable = true;
      hostCaps = (info && info.capabilities) || [];
      hostHint.textContent = '宿主就绪：' + (info.version || '')
        + (canPlay() ? '（支持播放）' : hostCaps.indexOf('player') >= 0 ? '' : '（无 player 能力，仅入库）');
      updateImportButtons();
    }).catch(function () {
      // 握手失败必须回退：否则按钮在 isAvailable 单独通过时被放行，入库成功、播放必败。
      hostAvailable = false;
      hostCaps = [];
      hostHint.textContent = '宿主握手失败：入库/播放已禁用，请重进页面重试。';
      updateImportButtons();
    });
  }

  // ===== 配置 =====

  var baseUrlInput = el('config-baseurl');
  var tokenInput = el('config-token');
  var draftBaseUrl = baseUrlInput.value.trim();
  var configRevision = 0;
  var configBusy = false;

  function setConfigBusy(busy) {
    configBusy = busy;
    ['btn-save', 'btn-test', 'btn-clear-token'].forEach(function (id) {
      el(id).disabled = busy;
    });
  }

  function updateTokenPlaceholder(config) {
    tokenInput.placeholder = config.hasToken
      ? '已保存 ' + (config.tokenMasked || 'Token') + '，同一服务留空沿用'
      : '请输入当前服务的 Token';
  }

  function onBaseUrlChanged() {
    var value = baseUrlInput.value.trim();
    if (value === draftBaseUrl) return;
    draftBaseUrl = value;
    configRevision++;
    // 输入的凭据只属于填写时的地址，改地址即失效，不等待保存或测试结果。
    tokenInput.value = '';
    tokenInput.placeholder = '地址已更改，请重新填写 Token';
    setChip('未保存');
    hint.textContent = '服务地址已更改，请重新填写 Token 后保存或测试连通。';
  }

  baseUrlInput.addEventListener('input', onBaseUrlChanged);
  baseUrlInput.addEventListener('change', onBaseUrlChanged);
  tokenInput.addEventListener('input', function () {
    configRevision++;
    setChip('未保存');
    hint.textContent = 'Token 已更改，请保存或测试连通。';
  });

  function loadConfig() {
    if (browserOnly) { hint.textContent = '浏览器模式：请在 Songloft 内配置连接。'; return; }
    var revision = ++configRevision;
    setConfigBusy(true);
    apiGet('/api/config').then(function (c) {
      if (revision !== configRevision) return;
      baseUrlInput.value = c.baseUrl || '';
      draftBaseUrl = baseUrlInput.value.trim();
      updateTokenPlaceholder(c);
      refreshStatus(revision);
    }).catch(function (e) {
      if (revision === configRevision) hint.textContent = '读取配置失败：' + e;
    }).finally(function () { setConfigBusy(false); });
  }

  function refreshStatus(revision, showDetail) {
    if (browserOnly || revision !== configRevision) return Promise.resolve();
    setChip(showDetail ? '测试中…' : '检测中…');
    return apiGet('/api/status').then(function (s) {
      if (revision !== configRevision) return;
      if (!s.reachable) {
        setChip('不可达', 'bad');
        if (showDetail) hint.textContent = '连通失败：' + (s.error || '');
      } else if (s.authenticated) {
        setChip('已认证', 'ok');
        if (showDetail) hint.textContent = '连通成功，Token 有效。';
      } else {
        // HMusic 搜索/解析强制 JWT：匿名连通≠可用，必须明确标红。
        setChip('未认证', 'bad');
        if (showDetail) hint.textContent = '服务可达但鉴权失败：' + (s.error || 'Token 缺失或已过期，请填入有效 JWT。');
      }
    }).catch(function (e) {
      if (revision !== configRevision) return;
      setChip('插件离线', 'bad');
      if (showDetail) hint.textContent = '连通失败：' + e;
    });
  }

  // 保存、测试、清除共用串行入口；输入保持可编辑，但旧响应不能覆盖新输入。
  function submitConfig(action) {
    if (browserOnly || configBusy) return;
    onBaseUrlChanged();
    var baseUrl = baseUrlInput.value.trim();
    var token = tokenInput.value.trim();
    // 不带 token 字段 = 沿用已存凭证(后端约定)。
    var payload = { baseUrl: baseUrl };
    if (action === 'clear') payload.token = '';
    else if (token) payload.token = token;

    // 提交时就清空：网络失败、鉴权失败和请求未返回都不能留下可复用的旧值。
    tokenInput.value = '';
    tokenInput.placeholder = '';
    var revision = ++configRevision;
    setConfigBusy(true);
    setChip(action === 'test' ? '测试中…' : '保存中…');
    hint.textContent = action === 'clear' ? '正在清除 Token…' : '正在保存连接…';
    return apiPost('/api/config', payload).then(function (r) {
      if (revision !== configRevision) return;
      if (action === 'clear' && r.hasToken) throw new Error('Token 未被清除');
      updateTokenPlaceholder(r);
      hint.textContent = action === 'clear' ? '已清除 Token。'
        : '已保存：' + r.baseUrl + (r.hasToken ? '（带 Token）' : '（匿名，请填入 Token）');
      return refreshStatus(revision, action === 'test');
    }).catch(function (e) {
      if (revision !== configRevision) return;
      setChip('未保存', 'bad');
      hint.textContent = '保存失败：' + e + '；请重新填写 Token 后重试。';
    }).finally(function () { setConfigBusy(false); });
  }

  el('config-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    return submitConfig('save');
  });

  el('btn-clear-token').addEventListener('click', function () {
    return submitConfig('clear');
  });

  el('btn-test').addEventListener('click', function () {
    return submitConfig('test');
  });

  // ===== 搜索 =====

  el('search-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var keyword = el('search-keyword').value.trim();
    if (!keyword) return;
    el('btn-search').disabled = true;
    searchMeta.textContent = '搜索中…';
    (browserOnly ? rawSearch(keyword) : apiPost('/api/search', {
      keyword: keyword, page: 1, page_size: 20, source: el('search-source').value || ''
    }))
      .then(function (r) {
        lastResults = r.results || [];
        el('btn-search').disabled = false;
        if (lastResults.length === 0) {
          searchMeta.textContent = '无结果。';
          resultsWrap.classList.add('hidden');
          return;
        }
        searchMeta.textContent = '共 ' + lastResults.length + ' 条。';
        renderResults(lastResults);
        resultsWrap.classList.remove('hidden');
        updateImportButtons();
        if (browserOnly) {
          searchMeta.textContent += '（浏览器模式：仅展示）';
        }
      })
      .catch(function (e) {
        el('btn-search').disabled = false;
        searchMeta.textContent = '搜索失败：' + e;
      });
  });

  // 浏览器直开时无法走插件路由，给明确提示即可。
  function rawSearch() {
    return Promise.reject(new Error('浏览器模式不支持'));
  }

  // 用 DOM 构建行节点：封面 URL 等不可信字段一律走 textContent / 属性赋值，
  // 不拼接 HTML（文本转义不处理引号，拼属性会注入 onerror 等事件）。
  function renderResults(items) {
    resultsList.innerHTML = '';
    items.forEach(function (item, idx) {
      var li = document.createElement('li');

      var check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'row-check';
      check.dataset.idx = String(idx);
      check.checked = true;
      li.appendChild(check);

      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (item.cover_url) img.src = item.cover_url;
      li.appendChild(img);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = item.title;
      var a = document.createElement('div');
      a.className = 'a';
      a.textContent = item.artist + ' · ' + (item.album || '—') + ' · ' + item.duration + 's';
      var src = document.createElement('div');
      src.className = 'src';
      src.textContent = item.source_data && item.source_data.track ? item.source_data.track.source : '';
      meta.appendChild(t);
      meta.appendChild(a);
      meta.appendChild(src);
      li.appendChild(meta);

      resultsList.appendChild(li);
    });
  }

  el('check-all').addEventListener('change', function () {
    var checked = el('check-all').checked;
    document.querySelectorAll('.row-check').forEach(function (c) { c.checked = checked; });
  });

  function checkedItems() {
    var chosen = [];
    document.querySelectorAll('.row-check').forEach(function (c) {
      if (c.checked) chosen.push(lastResults[Number(c.dataset.idx)]);
    });
    return chosen;
  }

  function doImport(items) {
    return apiPost('/api/import', { items: items }).then(function (r) {
      return (r.songs || []).map(function (s) { return s.id; });
    });
  }

  el('btn-import').addEventListener('click', function () {
    if (importBusy || !hostAvailable) return;
    var items = checkedItems();
    if (items.length === 0) { searchMeta.textContent = '未勾选任何条目。'; return; }
    searchMeta.textContent = '入库中…';
    importBusy = true;
    updateImportButtons();
    doImport(items).then(function (ids) {
      lastImportedIds = ids;
      searchMeta.textContent = '已入库 ' + ids.length + ' 首：' + ids.join(', ');
    }).catch(function (e) { searchMeta.textContent = '入库失败：' + e; })
      .finally(function () { importBusy = false; updateImportButtons(); });
  });

  el('btn-import-play').addEventListener('click', function () {
    if (importBusy || !canPlay()) return;
    var items = checkedItems();
    if (items.length === 0) { searchMeta.textContent = '未勾选任何条目。'; return; }
    searchMeta.textContent = '入库中…';
    importBusy = true;
    updateImportButtons();
    doImport(items).then(function (ids) {
      lastImportedIds = ids;
      if (!canPlay()) {
        searchMeta.textContent = '已入库 ' + ids.length + ' 首（宿主无 player 能力，请在客户端播放）：' + ids.join(', ');
        return;
      }
      searchMeta.textContent = '已入库 ' + ids.length + ' 首，尝试播放…';
      return player.setQueue(ids, { startIndex: 0 }).then(function () {
        searchMeta.textContent = '已入库并开始播放 ' + ids.length + ' 首。';
      });
    }).catch(function (e) { searchMeta.textContent = '入库/播放失败：' + e + '；已入库的歌曲可点“重试播放”。'; })
      .finally(function () { importBusy = false; updateImportButtons(); });
  });

  el('btn-retry-play').addEventListener('click', function () {
    if (importBusy || !canPlay() || !lastImportedIds.length) return;
    importBusy = true;
    updateImportButtons();
    searchMeta.textContent = '正在重新请求播放…';
    return player.setQueue(lastImportedIds, { startIndex: 0 }).then(function () {
      searchMeta.textContent = '已重新发起播放。';
    }).catch(function (e) { searchMeta.textContent = '播放失败：' + e; })
      .finally(function () { importBusy = false; updateImportButtons(); });
  });

  el('btn-miot-register').disabled = browserOnly;
  el('btn-miot-register').addEventListener('click', function () {
    if (browserOnly) return;
    el('btn-miot-register').disabled = true;
    return apiPost('/api/miot/register', {}).then(function (result) {
      el('miot-hint').textContent = result.message;
    }).catch(function (e) { el('miot-hint').textContent = '注册失败：' + e; })
      .finally(function () { el('btn-miot-register').disabled = false; });
  });

  // ===== 启动 =====
  checkHost();
  loadConfig();
})();
