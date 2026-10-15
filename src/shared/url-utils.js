/**
 * 图片 URL 工具：解析、去重归一化、srcset 择优、尺寸推断。
 * 同时被内容脚本（页面上下文可用 document/location）与 Service Worker 使用，
 * 因此所有依赖浏览器环境的调用都做了兜底。
 */
(function (root) {
  'use strict';
  const EIG = (root.EIG = root.EIG || {});
  if (EIG.urlUtils) return;

  const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|bmp|avif|jfif|tiff?)$/i;
  const NON_HTTP_RE = /^(?:data:|blob:|javascript:|about:|chrome:|chrome-extension:|moz-extension:|file:)/i;

  /** 把任意 src 值解析成绝对 http(s) URL；无效值返回空串 */
  function resolve(raw, base) {
    if (raw === undefined || raw === null) return '';
    let s = String(raw).trim();
    if (!s) return '';

    s = s.replace(/\\\//g, '/');            // JSON 中被转义的斜杠
    const wrapped = s.match(/^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i);
    if (wrapped) s = wrapped[2].trim();     // CSS background-image 包裹
    if (!s || s === 'none' || NON_HTTP_RE.test(s)) return '';
    if (s.indexOf('//') === 0) s = 'https:' + s;

    let baseHref = base;
    if (!baseHref && typeof location !== 'undefined' && location.href) baseHref = location.href;
    try {
      const u = new URL(s, baseHref);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function pathOf(url) {
    try { return new URL(url).pathname; } catch (e) { return ''; }
  }

  function stripQuery(url) {
    const i = url.indexOf('?');
    const cut = i === -1 ? url : url.slice(0, i);
    const h = cut.indexOf('#');
    return h === -1 ? cut : cut.slice(0, h);
  }

  /** 取扩展名（小写，不带点），没有则返回空串 */
  function extOf(url) {
    const m = stripQuery(url).match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  /** 是否以常见图片扩展名结尾 */
  function hasImageExt(url) {
    return IMAGE_EXT_RE.test(stripQuery(url));
  }

  /** 从 srcset 中挑选清晰度最高的一项 */
  function bestFromSrcset(srcset, base) {
    if (!srcset) return '';
    const parts = String(srcset).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    let best = '';
    let bestScore = -1;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].split(/\s+/);
      const url = resolve(seg[0], base);
      if (!url) continue;
      const desc = seg[1] || '';
      let score = 1;
      const mx = desc.match(/^(\d+(?:\.\d+)?)x$/);
      const mw = desc.match(/^(\d+)w$/);
      if (mx) score = parseFloat(mx[1]);
      else if (mw) score = parseInt(mw[1], 10) / 1000;
      if (score > bestScore) { bestScore = score; best = url; }
    }
    return best;
  }

  /**
   * 从 URL 文本里粗略推断声明尺寸，用于"同一张图不同尺寸只保留最大"的判断。
   * 支持 _430x430、s450x450_、/w/700、w=700 等常见写法。
   */
  function guessSize(url) {
    const s = stripQuery(url);
    const both = s.match(/(\d{2,5})[xX×](\d{2,5})/);
    if (both) return { w: parseInt(both[1], 10), h: parseInt(both[2], 10) };
    const wOnly = s.match(/(?:^|[^a-z0-9])w[_=/]?(\d{2,5})(?![0-9])/i);
    if (wOnly) return { w: parseInt(wOnly[1], 10), h: 0 };
    return { w: 0, h: 0 };
  }

  /**
   * 去重用的归一化 key：忽略协议差异、查询串、大小写与末尾斜杠。
   * 归一化后相同的 URL 视为同一张图片。
   */
  function normalizeKey(url) {
    let s = stripQuery(String(url)).toLowerCase();
    s = s.replace(/^https:\/\//, '').replace(/^http:\/\//, '');
    s = s.replace(/\/+$/, '');
    return s;
  }

  /** 只保留同一张图中清晰度最高的一条 */
  function dedupe(items) {
    const map = new Map();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = item.key || normalizeKey(item.url);
      const size = guessSize(item.url);
      const score = Math.max(item.width || 0, item.height || 0, size.w, size.h);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, Object.assign({}, item, { key: key, _score: score }));
      } else if (score > prev._score) {
        map.set(key, Object.assign({}, item, { key: key, _score: score }));
      }
    }
    return Array.from(map.values()).map(function (it) {
      const copy = Object.assign({}, it);
      delete copy._score;
      return copy;
    });
  }

  EIG.urlUtils = {
    IMAGE_EXT_RE: IMAGE_EXT_RE,
    resolve: resolve,
    hostOf: hostOf,
    pathOf: pathOf,
    stripQuery: stripQuery,
    extOf: extOf,
    hasImageExt: hasImageExt,
    bestFromSrcset: bestFromSrcset,
    guessSize: guessSize,
    normalizeKey: normalizeKey,
    dedupe: dedupe
  };
})(globalThis);
