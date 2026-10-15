/**
 * 内容脚本入口：
 *  1) 顶层 frame 在商品详情页右下角注入「获取图片」按钮（Shadow DOM 隔离）
 *  2) 所有 frame 响应采集请求并回传候选图片
 *  3) 监听 SPA 路由变化，动态显示/隐藏按钮
 */
(function () {
  'use strict';
  const EIG = globalThis.EIG || {};
  const U = EIG.urlUtils;
  const P = EIG.platforms;
  const C = EIG.collector;
  const utils = EIG.utils;
  if (!U || !P || !C || !utils) return;
  if (globalThis.__EIG_CONTENT_LOADED__) return;
  globalThis.__EIG_CONTENT_LOADED__ = true;

  const SETTINGS_KEY = 'eig:settings';
  const IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  let hostEl = null;      // shadow host
  let ui = null;          // shadow 内部元素引用
  let busy = false;
  let resetTimer = null;
  let lastUrl = location.href;

  // ------------------------------------------------------------ 按钮
  const BUTTON_STYLE = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;}',
    '.eig-wrap{position:fixed;right:20px;bottom:80px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
    '.eig-btn{display:flex;align-items:center;gap:8px;padding:11px 18px;border:0;border-radius:10px;',
    'background:linear-gradient(135deg,#ff6a3d 0%,#ff3b30 100%);color:#fff;font-size:14px;font-weight:600;',
    'cursor:pointer;box-shadow:0 6px 18px rgba(255,70,40,.35);transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease;',
    'letter-spacing:.5px;white-space:nowrap;}',
    '.eig-btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(255,70,40,.42);}',
    '.eig-btn:active{transform:translateY(0);}',
    '.eig-btn[data-state="loading"]{cursor:progress;opacity:.9;}',
    '.eig-btn[data-state="done"]{background:linear-gradient(135deg,#3ec37a 0%,#1f9d55 100%);box-shadow:0 6px 18px rgba(31,157,85,.32);}',
    '.eig-btn[data-state="error"]{background:linear-gradient(135deg,#8a8f99 0%,#5f6673 100%);box-shadow:0 6px 18px rgba(95,102,115,.3);}',
    '.eig-ico{width:16px;height:16px;flex:0 0 auto;display:block;}',
    '.eig-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;',
    'animation:eig-spin .7s linear infinite;display:none;}',
    '.eig-btn[data-state="loading"] .eig-spinner{display:block;}',
    '.eig-btn[data-state="loading"] .eig-ico,.eig-btn[data-state="done"] .eig-ico,.eig-btn[data-state="error"] .eig-ico{display:none;}',
    '@keyframes eig-spin{to{transform:rotate(360deg);}}',
    '@media (prefers-color-scheme:dark){.eig-btn{box-shadow:0 6px 20px rgba(0,0,0,.45);}}'
  ].join('');

  const ICON_DOWNLOAD = '<svg class="eig-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';

  function currentPlatform() {
    return P.detect(location.href);
  }

  function isDetailPage() {
    const platform = currentPlatform();
    return !!(platform && platform.detailPage(location.href));
  }

  function ensureButton() {
    if (!IS_TOP || hostEl || !isDetailPage()) return;

    hostEl = document.createElement('div');
    hostEl.id = 'eig-floating-host';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + BUTTON_STYLE + '</style>' +
      '<div class="eig-wrap">' +
        '<button class="eig-btn" type="button" data-state="idle" title="提取当前页面全部商品图片">' +
          ICON_DOWNLOAD +
          '<span class="eig-spinner"></span>' +
          '<span class="eig-label">获取图片</span>' +
        '</button>' +
      '</div>';

    ui = {
      button: shadow.querySelector('.eig-btn'),
      label: shadow.querySelector('.eig-label')
    };
    ui.button.addEventListener('click', startCollect, true);
    (document.body || document.documentElement).appendChild(hostEl);
  }

  function removeButton() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    ui = null;
  }

  function setState(state, count, message) {
    if (!ui) return;
    ui.button.dataset.state = state;
    if (state === 'idle') ui.label.textContent = '获取图片';
    else if (state === 'loading') ui.label.textContent = '获取中…';
    else if (state === 'done') ui.label.textContent = '已获取 ' + (count || 0) + ' 张';
    else ui.label.textContent = message || '获取失败';
  }

  // ------------------------------------------------------------ 采集流程
  async function readSettings() {
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      return Object.assign({ autoScroll: false }, (data && data[SETTINGS_KEY]) || {});
    } catch (e) {
      return { autoScroll: false };
    }
  }

  /** 先滚到底触发懒加载，再采集；完成后滚回原位 */
  async function autoScrollPage() {
    const startY = window.scrollY || 0;
    const startedAt = Date.now();
    let y = startY;
    while (Date.now() - startedAt < 15000) {
      const full = document.documentElement.scrollHeight;
      const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
      if (y >= full - window.innerHeight - 4) break;
      y += step;
      window.scrollTo(0, y);
      await utils.sleep(220);
    }
    window.scrollTo(0, startY);
    await utils.sleep(250);
  }

  async function startCollect() {
    if (busy) return;
    busy = true;
    clearTimeout(resetTimer);
    setState('loading');

    try {
      const settings = await readSettings();
      if (settings.autoScroll) {
        await autoScrollPage();
      }
      const platform = currentPlatform();
      const response = await chrome.runtime.sendMessage({
        type: 'EIG_COLLECT_START',
        pageTitle: document.title,
        pageUrl: location.href,
        platform: platform ? platform.id : ''
      });
      if (response && response.ok) {
        setState('done', response.count);
      } else {
        setState('error', 0, (response && response.error) || '获取失败');
      }
    } catch (err) {
      setState('error', 0, (err && err.message) || '获取失败');
    } finally {
      busy = false;
      resetTimer = setTimeout(function () { setState('idle'); }, 4000);
    }
  }

  // ------------------------------------------------------------ 消息
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'EIG_COLLECT_FRAME') return;
    try {
      const data = C.collect({});
      chrome.runtime.sendMessage({
        type: 'EIG_FRAME_RESULT',
        collectId: msg.collectId,
        frameUrl: location.href,
        isTop: IS_TOP,
        items: data.items,
        stats: data.stats
      }).catch(function () { /* 后台可能已结束等待，忽略 */ });
      sendResponse({ ok: true, count: data.items.length });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
    return false;
  });

  // ------------------------------------------------------------ SPA 路由监听
  function syncVisibility() {
    if (!IS_TOP) return;
    if (isDetailPage()) ensureButton();
    else if (hostEl) removeButton();
  }

  setInterval(function () {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    removeButton();          // 换商品后按钮状态重置
    syncVisibility();
  }, 800);

  window.addEventListener('popstate', syncVisibility, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncVisibility, { once: true });
  }
  syncVisibility();
})();
