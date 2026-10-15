/**
 * 页面图片采集器：在每个 frame 内执行，输出"原始候选图片"列表。
 * 这里只做采集，不做业务过滤（过滤统一放在 Service Worker 里，避免规则分散）。
 */
(function (root) {
  'use strict';
  const EIG = (root.EIG = root.EIG || {});
  const U = EIG.urlUtils;
  if (!U || EIG.collector) return;

  /** 各平台常见的懒加载属性名 */
  const LAZY_ATTRS = [
    'data-src', 'data-lazyload', 'data-ks-lazyload', 'data-ks-lazyload-src',
    'data-original', 'data-original-src', 'data-lazy', 'data-lazy-src', 'data-lazysrc',
    'data-url', 'data-img', 'data-image', 'data-echo', 'data-origin',
    'data-srcset', 'data-spm-src', 'data-actualsrc', 'data-jpg'
  ];

  const STYLE_SCAN_SELECTOR = 'div,section,article,a,span,li,p,td,th,h1,h2,h3,i,em,b,strong,img,header,footer';
  const MAX_STYLE_SCAN = 9000;   // 防止超长详情页卡顿
  const MAX_TEXT_URLS = 4000;

  /** 从页面源码/内联 JSON 里捞 URL（兼容 https:\/\/ 这种转义写法） */
  const URL_IN_TEXT_RE = /(?:https?:)?(?:\\?\/){2}[^\s"'`<>\\)\]\},;]+?\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\?[^\s"'`<>\\)\]\},;]*)?/gi;

  function push(out, raw, source, el) {
    const url = U.resolve(raw, location.href);
    if (!url) return;
    const item = { url: url, source: source };
    if (el) {
      const w = el.naturalWidth || el.videoWidth || 0;
      const h = el.naturalHeight || el.videoHeight || 0;
      if (w && h) { item.width = w; item.height = h; }
    }
    out.push(item);
  }

  /** 采集 <img>：currentSrc / src / 各懒加载属性 / srcset */
  function collectImgs(out, stats) {
    let list = [];
    try { list = document.querySelectorAll('img'); } catch (e) { list = []; }

    for (let i = 0; i < list.length; i++) {
      const img = list[i];
      const before = out.length;

      if (img.currentSrc) push(out, img.currentSrc, 'img', img);
      const attrSrc = img.getAttribute && img.getAttribute('src');
      if (attrSrc) push(out, attrSrc, 'img', img);

      let lazyHit = false;
      for (let a = 0; a < LAZY_ATTRS.length; a++) {
        const value = img.getAttribute && img.getAttribute(LAZY_ATTRS[a]);
        if (value) { push(out, value, 'lazy', img); lazyHit = true; }
      }
      if (lazyHit) stats.lazy++;

      const srcset = (img.getAttribute && (img.getAttribute('srcset') || img.getAttribute('data-srcset'))) || '';
      if (srcset) {
        const best = U.bestFromSrcset(srcset, location.href);
        if (best) push(out, best, 'srcset', img);
      }

      if (out.length > before) stats.img++;
    }
  }

  /** 采集 <picture><source> */
  function collectPicture(out) {
    let list = [];
    try { list = document.querySelectorAll('picture source'); } catch (e) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const srcset = list[i].getAttribute('srcset') || list[i].getAttribute('data-srcset');
      const best = U.bestFromSrcset(srcset, location.href);
      if (best) push(out, best, 'picture');
    }
  }

  /** 采集 CSS background-image（详情长图常用此方式） */
  function collectBackground(out, stats) {
    let list = [];
    try { list = document.querySelectorAll(STYLE_SCAN_SELECTOR); } catch (e) { return; }
    const limit = Math.min(list.length, MAX_STYLE_SCAN);
    for (let i = 0; i < limit; i++) {
      const el = list[i];
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage || ''; } catch (e) { continue; }
      if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
      const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      let m;
      while ((m = re.exec(bg))) {
        const before = out.length;
        push(out, m[2], 'background');
        if (out.length > before) stats.background++;
      }
    }
  }

  /** 采集 <a href> 指向的图片链接（详情图有时挂在链接上） */
  function collectLinks(out) {
    let list = [];
    try { list = document.querySelectorAll('a[href], link[rel="preload"][as="image"], link[rel="prefetch"]'); } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const href = list[i].getAttribute('href');
      if (!href) continue;
      const abs = U.resolve(href, location.href);
      if (abs && U.hasImageExt(abs)) push(out, abs, 'link');
    }
  }

  /** 从 HTML 源码与内联脚本里提取图片 URL（捞取未渲染进 DOM 的图） */
  function collectFromText(out, stats) {
    let html = '';
    try { html = document.documentElement ? document.documentElement.innerHTML : ''; } catch (e) { html = ''; }
    if (!html) return;
    let count = 0;
    let m;
    URL_IN_TEXT_RE.lastIndex = 0;
    while ((m = URL_IN_TEXT_RE.exec(html)) && count < MAX_TEXT_URLS) {
      const before = out.length;
      push(out, m[0], 'text');
      if (out.length > before) { count++; stats.text++; }
    }
  }

  /**
   * 主入口：采集当前 frame 内的全部图片候选。
   * @returns {{items:Array, stats:object, frameUrl:string}}
   */
  function collect(options) {
    const opts = options || {};
    const out = [];
    const stats = { img: 0, lazy: 0, background: 0, text: 0 };

    try { collectImgs(out, stats); } catch (e) { /* 单步失败不影响整体 */ }
    try { collectPicture(out); } catch (e) { /* ignore */ }
    try {
      if (opts.skipBackground !== true) collectBackground(out, stats);
    } catch (e) { /* ignore */ }
    try { collectLinks(out); } catch (e) { /* ignore */ }
    try { collectFromText(out, stats); } catch (e) { /* ignore */ }

    return { items: out, stats: stats, frameUrl: location.href };
  }

  EIG.collector = { collect: collect, LAZY_ATTRS: LAZY_ATTRS };
})(globalThis);
