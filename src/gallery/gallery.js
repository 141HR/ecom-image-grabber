/**
 * 结果页逻辑：展示抓取到的图片、勾选、预览、批量转换为 PNG 下载。
 */
(function () {
  'use strict';
  const EIG = globalThis.EIG;
  const utils = EIG.utils;
  const U = EIG.urlUtils;
  const png = EIG.png;

  const KEY_PREFIX = 'eig:collection:';
  const LAST_KEY = 'eig:lastCollectionId';
  const SETTINGS_KEY = 'eig:settings';
  const RENDER_CHUNK = 120;
  const HIDE_SMALL_EDGE = 200;   // 最短边小于该值的图片视为角标 / 图标 / 按钮

  const IDS = [
    'title', 'meta', 'prefix', 'concurrency', 'download',
    'select-all', 'invert', 'select-none', 'first-count', 'select-first',
    'filter-host', 'filter-size', 'search', 'stats', 'auto-scroll', 'hide-small',
    'progress', 'progress-text', 'progress-size', 'bar-fill',
    'failures', 'failure-title', 'retry', 'failure-list', 'grid', 'empty',
    'lightbox', 'lb-close', 'lb-prev', 'lb-next', 'lb-img', 'lb-index', 'lb-info',
    'lb-select', 'lb-download', 'lb-original'
  ];

  const el = {};
  const state = {
    collection: null,
    items: [],
    filtered: [],
    selected: new Set(),
    removed: new Set(),
    filters: { host: 'all', minSize: 0, keyword: '' },
    settings: { prefix: '', concurrency: 4, autoScroll: false, hideSmall: true },
    downloading: false,
    objectUrls: new Set(),
    failures: [],
    lightboxIndex: -1,
    observer: null,
    byId: new Map(),
    prunedIds: new Set()
  };

  // ------------------------------------------------------------------ 初始化
  function bindDom() {
    IDS.forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      const saved = (data && data[SETTINGS_KEY]) || {};
      state.settings = Object.assign({ prefix: '', concurrency: 4, autoScroll: false, hideSmall: true }, saved);
    } catch (e) { /* 使用默认值 */ }
  }

  const saveSettings = utils.debounce(function () {
    try {
      chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
    } catch (e) { /* ignore */ }
  }, 400);

  async function loadCollection(id) {
    if (!id) return false;
    let data;
    try {
      data = await chrome.storage.session.get(KEY_PREFIX + id);
    } catch (e) {
      return false;
    }
    const collection = data && data[KEY_PREFIX + id];
    if (!collection) return false;

    state.collection = collection;
    state.items = Array.isArray(collection.items) ? collection.items.slice() : [];
    state.byId = new Map(state.items.map(function (it) { return [it.id, it]; }));
    state.prunedIds = new Set();
    state.selected = new Set();
    state.removed = new Set();
    state.failures = [];
    state.filters = { host: 'all', minSize: 0, keyword: '' };
    el.search.value = '';
    el['filter-size'].value = '0';

    // 默认文件名前缀：优先用户设置，其次商品标题
    if (!el.prefix.value) {
      el.prefix.value = state.settings.prefix ||
        utils.sanitizeFilename((collection.pageTitle || '').replace(/[-_|].*$/, '').trim(), '商品图片');
    }

    renderHeader();
    renderHostFilter();
    applyFilters();
    hideProgress();
    return true;
  }

  function renderHeader() {
    const c = state.collection;
    el.title.textContent = c.pageTitle || '图片提取结果';
    el.meta.textContent = [
      c.platformName || '通用',
      utils.formatTime(c.createdAt),
      '共 ' + state.items.length + ' 张',
      '扫描 ' + (c.frames || 1) + ' 个框架',
      c.pageUrl ? U.hostOf(c.pageUrl) : ''
    ].filter(Boolean).join(' · ');
  }

  function renderHostFilter() {
    const counts = new Map();
    state.items.forEach(function (it) {
      counts.set(it.host, (counts.get(it.host) || 0) + 1);
    });
    const hosts = Array.from(counts.keys()).sort(function (a, b) {
      return counts.get(b) - counts.get(a);
    });
    const current = el['filter-host'].value;
    el['filter-host'].innerHTML = '<option value="all">全部域名 (' + state.items.length + ')</option>' +
      hosts.map(function (h) {
        return '<option value="' + escapeAttr(h) + '">' + escapeHtml(h) + ' (' + counts.get(h) + ')</option>';
      }).join('');
    el['filter-host'].value = hosts.indexOf(current) !== -1 ? current : 'all';
  }

  // ------------------------------------------------------------------ 渲染
  /**
   * 图片尺寸：优先用采集阶段量到的尺寸，其次用结果页图片加载后量到的真实尺寸。
   * 页面里通过源码正则 / 背景图拿到的候选往往没有尺寸，只能在这里补测。
   */
  function itemEdge(item) {
    const w = item.width || item.measuredW || 0;
    const h = item.height || item.measuredH || 0;
    if (!w || !h) return { known: false, minEdge: 0, maxEdge: 0 };
    return { known: true, minEdge: Math.min(w, h), maxEdge: Math.max(w, h) };
  }

  function hiddenSmallCount() {
    if (!state.settings.hideSmall) return 0;
    let n = 0;
    state.items.forEach(function (it) {
      if (state.removed.has(it.id)) return;
      const size = itemEdge(it);
      if (size.known && size.minEdge < HIDE_SMALL_EDGE) n++;
    });
    return n;
  }

  /**
   * 图片加载完、拿到真实尺寸后，把判定为小图的卡片直接从网格里摘掉。
   *
   * 这里刻意不做整体重绘：重绘会让剩余卡片重新加载图片，重新触发尺寸判定，
   * 形成「重绘 → 重新加载 → 再重绘」的循环，表现为结果页持续闪烁。
   */
  const schedulePrune = utils.debounce(function () {
    if (!state.settings.hideSmall) return;
    if (state.lightboxIndex >= 0) return;   // 预览打开时先不摘卡片，关闭后再处理

    let removed = 0;
    state.items.forEach(function (it) {
      if (state.removed.has(it.id) || state.prunedIds.has(it.id)) return;
      const size = itemEdge(it);
      if (!size.known || size.minEdge >= HIDE_SMALL_EDGE) return;

      state.prunedIds.add(it.id);
      const pos = state.filtered.indexOf(it);
      if (pos !== -1) state.filtered.splice(pos, 1);
      const card = el.grid.querySelector('.card[data-id="' + it.id + '"]');
      if (card && card.parentNode) card.parentNode.removeChild(card);
      removed++;
    });

    if (!removed) return;
    el['empty'].hidden = state.filtered.length > 0;
    updateStats();
  }, 400);

  function applyFilters() {
    const f = state.filters;
    state.filtered = state.items.filter(function (it) {
      if (state.removed.has(it.id)) return false;
      const size = itemEdge(it);
      if (state.settings.hideSmall && size.known && size.minEdge < HIDE_SMALL_EDGE) return false;
      if (f.host !== 'all' && it.host !== f.host) return false;
      if (f.minSize && size.known && size.maxEdge < f.minSize) return false;
      if (f.keyword && it.url.toLowerCase().indexOf(f.keyword) === -1) return false;
      return true;
    });
    renderGrid();
    updateStats();
  }

  function renderGrid() {
    if (state.observer) state.observer.disconnect();
    el.grid.innerHTML = '';
    el['empty'].hidden = state.filtered.length > 0;
    if (!state.filtered.length) return;

    state.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        state.observer.unobserve(entry.target);
        loadCardImage(entry.target);
      });
    }, { rootMargin: '400px 0px' });

    let cursor = 0;
    function renderChunk() {
      const end = Math.min(cursor + RENDER_CHUNK, state.filtered.length);
      const html = [];
      for (let i = cursor; i < end; i++) html.push(cardHtml(state.filtered[i], i));
      cursor = end;
      el.grid.insertAdjacentHTML('beforeend', html.join(''));

      const cards = el.grid.querySelectorAll('.card');
      for (let i = Math.max(0, end - RENDER_CHUNK); i < cards.length; i++) {
        state.observer.observe(cards[i]);
      }
      if (cursor < state.filtered.length) setTimeout(renderChunk, 16);
    }
    renderChunk();
  }

  function cardHtml(item, position) {
    const selected = state.selected.has(item.id);
    const size = (item.width && item.height) ? item.width + '×' + item.height : (U.guessSize(item.url).w ? '≥' + U.guessSize(item.url).w + 'px' : '未知尺寸');
    return '' +
      '<article class="card' + (selected ? ' selected' : '') + '" data-id="' + item.id + '" data-pos="' + position + '">' +
        '<div class="card-media">' +
          '<img class="pending" alt="" referrerpolicy="no-referrer" data-src="' + escapeAttr(item.url) + '">' +
          '<span class="badge">' + escapeHtml(size) + '</span>' +
          '<span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' +
          '<button class="zoom" type="button" title="预览大图">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
          '</button>' +
          '<button class="remove" type="button" title="从结果中移除">' +
            '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="card-foot">' +
          '<span class="idx">#' + String(position + 1).padStart(2, '0') + '</span>' +
          '<span class="host">' + escapeHtml(item.host || '') + '</span>' +
        '</div>' +
      '</article>';
  }

  /** 卡片图片加载：直连失败时走后台代理，破解防盗链 */
  async function loadCardImage(card) {
    const img = card.querySelector('img[data-src]');
    if (!img || img.dataset.loaded) return;
    img.dataset.loaded = '1';
    const url = img.dataset.src;
    const item = state.byId.get(card.dataset.id);

    img.onload = function () {
      img.classList.remove('pending');
      if (!item || !img.naturalWidth) return;
      item.measuredW = img.naturalWidth;
      item.measuredH = img.naturalHeight;
      const badge = card.querySelector('.badge');
      if (badge && !item.width) badge.textContent = img.naturalWidth + '×' + img.naturalHeight;
      schedulePrune();
    };
    img.onerror = async function () {
      try {
        const blob = await fetchViaProxy(url);
        const objectUrl = URL.createObjectURL(blob);
        state.objectUrls.add(objectUrl);
        img.onerror = null;
        img.src = objectUrl;
        img.classList.remove('pending');
      } catch (e) {
        img.classList.remove('pending');
        img.replaceWith(failedBox('加载失败，仍可直接下载'));
      }
    };
    img.src = url;
  }

  function failedBox(text) {
    const div = document.createElement('div');
    div.className = 'failed';
    div.textContent = text;
    return div;
  }

  function updateStats() {
    let text = '显示 ' + state.filtered.length + ' / 共 ' + state.items.length +
      ' 张 · 已选 ' + state.selected.size + ' 张';
    const hidden = hiddenSmallCount();
    if (hidden) text += ' · 已隐藏 ' + hidden + ' 张小图';
    el.stats.textContent = text;
    el.download.textContent = '下载选中 (' + state.selected.size + ')';
    el.download.disabled = state.selected.size === 0 || state.downloading;
  }

  // ------------------------------------------------------------------ 选择
  function setSelected(id, value) {
    if (value) state.selected.add(id);
    else state.selected.delete(id);
    const card = el.grid.querySelector('.card[data-id="' + id + '"]');
    if (card) card.classList.toggle('selected', value);
    updateStats();
    if (state.lightboxIndex >= 0) updateLightboxSelectButton();
  }

  function selectAll(value) {
    state.filtered.forEach(function (it) {
      if (value) state.selected.add(it.id);
      else state.selected.delete(it.id);
    });
    el.grid.querySelectorAll('.card').forEach(function (card) {
      card.classList.toggle('selected', value);
    });
    updateStats();
    if (state.lightboxIndex >= 0) updateLightboxSelectButton();
  }

  function invertSelection() {
    state.filtered.forEach(function (it) {
      if (state.selected.has(it.id)) state.selected.delete(it.id);
      else state.selected.add(it.id);
    });
    el.grid.querySelectorAll('.card').forEach(function (card) {
      card.classList.toggle('selected', state.selected.has(card.dataset.id));
    });
    updateStats();
  }

  // ------------------------------------------------------------------ 预览
  function openLightbox(position) {
    if (position < 0 || position >= state.filtered.length) return;
    state.lightboxIndex = position;
    const item = state.filtered[position];
    const img = el['lb-img'];
    img.onerror = async function () {
      try {
        const blob = await fetchViaProxy(item.url);
        const objectUrl = URL.createObjectURL(blob);
        state.objectUrls.add(objectUrl);
        img.onerror = null;
        img.src = objectUrl;
      } catch (e) {
        img.alt = '这张图片无法预览（可能是防盗链或已失效），仍可尝试下载';
      }
    };
    img.src = item.url;
    el['lb-index'].textContent = (position + 1) + ' / ' + state.filtered.length;
    const isExternal = /^https?:/i.test(item.url);
    const fileName = isExternal ? U.stripQuery(item.url).split('/').pop() : '';
    el['lb-info'].textContent = [
      item.width && item.height ? item.width + '×' + item.height : '尺寸未知',
      item.host,
      isExternal ? (fileName.length > 48 ? fileName.slice(0, 45) + '…' : fileName) : '非外链图片'
    ].filter(Boolean).join(' · ');
    el['lb-original'].hidden = !isExternal;
    el['lb-original'].href = isExternal ? item.url : '#';
    el['lb-prev'].disabled = position === 0;
    el['lb-next'].disabled = position === state.filtered.length - 1;
    updateLightboxSelectButton();
    el.lightbox.hidden = false;
  }

  function updateLightboxSelectButton() {
    const item = state.filtered[state.lightboxIndex];
    if (!item) return;
    el['lb-select'].textContent = state.selected.has(item.id) ? '取消选中' : '选中';
  }

  function closeLightbox() {
    state.lightboxIndex = -1;
    el.lightbox.hidden = true;
    el['lb-img'].removeAttribute('src');
    schedulePrune();   // 预览期间暂缓的小图清理在这里补上
  }

  function stepLightbox(delta) {
    const next = state.lightboxIndex + delta;
    if (next < 0 || next >= state.filtered.length) return;
    openLightbox(next);
  }

  // ------------------------------------------------------------------ 下载
  async function fetchViaProxy(url) {
    const response = await chrome.runtime.sendMessage({
      type: 'EIG_FETCH_PROXY',
      url: url,
      referer: (state.collection && state.collection.referer) || ''
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || '后台取图失败');
    }
    return base64ToBlob(response.base64, response.mime);
  }

  function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  /** 先直连，失败再走扩展后台代理 */
  async function loadBlob(url) {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (!blob.size) throw new Error('返回内容为空');
      if (blob.type && blob.type.indexOf('image/') !== 0 && blob.type.indexOf('application/octet-stream') !== 0) {
        throw new Error('返回内容不是图片（' + blob.type + '）');
      }
      return blob;
    } catch (e) {
      return await fetchViaProxy(url);
    }
  }

  function buildFilename(prefix, item, position, total, folder) {
    const index = item.index !== undefined ? item.index + 1 : position + 1;
    const name = utils.sanitizeFilename(prefix, '商品图片') + '_' + utils.padIndex(index, total) + '.png';
    return (folder === false ? '' : '电商图片/') + name;
  }

  function waitDownload(downloadId, timeout) {
    return new Promise(function (resolve, reject) {
      const limit = timeout || 120000;
      const timer = setTimeout(function () { cleanup(); reject(new Error('下载超时')); }, limit);
      function cleanup() {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
      }
      function listener(delta) {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') { cleanup(); resolve(); }
        else if (delta.state.current === 'interrupted') {
          cleanup();
          reject(new Error('下载中断：' + ((delta.error && delta.error.current) || '未知原因')));
        }
      }
      chrome.downloads.onChanged.addListener(listener);
    });
  }

  async function downloadPng(item, filename) {
    const source = await loadBlob(item.url);
    const converted = await png.blobToPngBlob(source);
    const objectUrl = URL.createObjectURL(converted.blob);
    try {
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
      if (typeof downloadId !== 'number') throw new Error('浏览器未接受下载请求');
      await waitDownload(downloadId);
      return { size: converted.blob.size, width: converted.width, height: converted.height };
    } finally {
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 3000);
    }
  }

  async function downloadItems(items) {
    if (state.downloading || !items.length) return;
    state.downloading = true;
    state.failures = [];
    state.settings.prefix = el.prefix.value.trim();
    saveSettings();
    updateStats();
    showProgress();

    const prefix = utils.sanitizeFilename(el.prefix.value.trim() || (state.collection.pageTitle || '商品图片'), '商品图片');
    const total = items.length;
    let success = 0, fail = 0, bytes = 0;
    el['bar-fill'].style.width = '0%';
    el['failure-list'].innerHTML = '';
    el.failures.hidden = true;

    await utils.runPool(items, state.settings.concurrency, function (item, position) {
      return downloadPng(item, buildFilename(prefix, item, position, total));
    }, function (done, totalCount, result, item) {
      if (result.status === 'ok') {
        success++;
        bytes += (result.value && result.value.size) || 0;
      } else {
        fail++;
        state.failures.push({ item: item, reason: result.error || '未知错误' });
      }
      const percent = Math.round((done / totalCount) * 100);
      el['bar-fill'].style.width = percent + '%';
      el['progress-text'].textContent = '已完成 ' + done + ' / ' + totalCount +
        ' · 成功 ' + success + ' · 失败 ' + fail;
      el['progress-size'].textContent = '已保存约 ' + utils.formatBytes(bytes);
    });

    state.downloading = false;
    updateStats();

    if (state.failures.length) {
      el.failures.hidden = false;
      el['failure-title'].textContent = '失败项（' + state.failures.length + '）';
      el['failure-list'].innerHTML = state.failures.map(function (f) {
        return '<li><span class="f-url">' + escapeHtml(U.stripQuery(f.item.url).split('/').slice(-1)[0] || f.item.url) +
          '</span><span class="f-reason">' + escapeHtml(f.reason) + '</span></li>';
      }).join('');
    } else {
      el['progress-text'].textContent = '全部完成：成功 ' + success + ' 张，共 ' + utils.formatBytes(bytes) + '（PNG）';
    }
  }

  function showProgress() {
    el.progress.hidden = false;
    el['failure-list'].innerHTML = '';
    el.failures.hidden = true;
    el['progress-text'].textContent = '准备中…';
    el['progress-size'].textContent = '';
    el['bar-fill'].style.width = '0%';
  }

  function hideProgress() {
    el.progress.hidden = true;
    el['failure-list'].innerHTML = '';
    el.failures.hidden = true;
  }

  // ------------------------------------------------------------------ 事件
  function bindEvents() {
    el.grid.addEventListener('click', function (event) {
      const card = event.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      if (event.target.closest('.zoom')) {
        openLightbox(Number(card.dataset.pos));
        return;
      }
      if (event.target.closest('.remove')) {
        state.removed.add(id);
        state.selected.delete(id);
        applyFilters();
        return;
      }
      setSelected(id, !state.selected.has(id));
    });

    el.grid.addEventListener('dblclick', function (event) {
      const card = event.target.closest('.card');
      if (card && !event.target.closest('.zoom, .remove')) openLightbox(Number(card.dataset.pos));
    });

    el['select-all'].addEventListener('click', function () { selectAll(true); });
    el['select-none'].addEventListener('click', function () { selectAll(false); });
    el['invert'].addEventListener('click', invertSelection);
    el['select-first'].addEventListener('click', function () {
      const count = Math.max(1, parseInt(el['first-count'].value, 10) || 0);
      selectAll(false);
      state.filtered.slice(0, count).forEach(function (it) { state.selected.add(it.id); });
      el.grid.querySelectorAll('.card').forEach(function (card) {
        card.classList.toggle('selected', state.selected.has(card.dataset.id));
      });
      updateStats();
    });

    el['filter-host'].addEventListener('change', function () {
      state.filters.host = el['filter-host'].value;
      applyFilters();
    });
    el['filter-size'].addEventListener('change', function () {
      state.filters.minSize = parseInt(el['filter-size'].value, 10) || 0;
      applyFilters();
    });
    el.search.addEventListener('input', utils.debounce(function () {
      state.filters.keyword = el.search.value.trim().toLowerCase();
      applyFilters();
    }, 200));

    el.concurrency.addEventListener('change', function () {
      state.settings.concurrency = parseInt(el.concurrency.value, 10) || 4;
      saveSettings();
    });
    el['auto-scroll'].addEventListener('change', function () {
      state.settings.autoScroll = el['auto-scroll'].checked;
      saveSettings();
    });
    el['hide-small'].addEventListener('change', function () {
      state.settings.hideSmall = el['hide-small'].checked;
      saveSettings();
      applyFilters();
    });
    el.prefix.addEventListener('change', function () {
      state.settings.prefix = el.prefix.value.trim();
      saveSettings();
    });

    el.download.addEventListener('click', function () {
      const items = state.filtered.filter(function (it) { return state.selected.has(it.id); });
      downloadItems(items);
    });
    el.retry.addEventListener('click', function () {
      const items = state.failures.map(function (f) { return f.item; });
      if (items.length) downloadItems(items);
    });

    // 灯箱
    el['lb-close'].addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', function (event) {
      if (event.target === el.lightbox) closeLightbox();
    });
    el['lb-prev'].addEventListener('click', function () { stepLightbox(-1); });
    el['lb-next'].addEventListener('click', function () { stepLightbox(1); });
    el['lb-select'].addEventListener('click', function () {
      const item = state.filtered[state.lightboxIndex];
      if (item) setSelected(item.id, !state.selected.has(item.id));
    });
    el['lb-download'].addEventListener('click', function () {
      const item = state.filtered[state.lightboxIndex];
      if (item) downloadItems([item]);
    });

    document.addEventListener('keydown', function (event) {
      if (el.lightbox.hidden) return;
      if (event.key === 'Escape') closeLightbox();
      else if (event.key === 'ArrowLeft') stepLightbox(-1);
      else if (event.key === 'ArrowRight') stepLightbox(1);
    });

    window.addEventListener('beforeunload', function () {
      state.objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    });
  }

  // ------------------------------------------------------------------ 工具
  function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeAttr(text) { return escapeHtml(text); }

  function showEmpty(title, sub) {
    el['empty'].hidden = false;
    el['empty'].querySelector('.empty-title').textContent = title;
    el['empty'].querySelector('.empty-sub').textContent = sub;
  }

  // ------------------------------------------------------------------ 启动
  async function init() {
    bindDom();
    bindEvents();
    await loadSettings();
    el.prefix.value = state.settings.prefix || '';
    el.concurrency.value = String(state.settings.concurrency || 4);
    el['auto-scroll'].checked = !!state.settings.autoScroll;
    el['hide-small'].checked = state.settings.hideSmall !== false;

    let loaded = false;
    try {
      const data = await chrome.storage.session.get(LAST_KEY);
      loaded = await loadCollection(data && data[LAST_KEY]);
    } catch (e) {
      loaded = false;
    }
    if (!loaded) {
      el.meta.textContent = '暂无抓取结果';
      showEmpty('还没有抓取结果', '请打开淘宝 / 京东 / 拼多多的商品详情页，点击右下角的「获取图片」按钮。');
    }

    // 若在结果页停留期间又抓了一次，自动刷新
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'session' || !changes[LAST_KEY]) return;
      const nextId = changes[LAST_KEY].newValue;
      if (nextId && (!state.collection || nextId !== state.collection.id)) loadCollection(nextId);
    });
  }

  init();
})();
