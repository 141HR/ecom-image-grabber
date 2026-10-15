/**
 * Service Worker：采集调度中心
 *  1) 接收顶层 frame 的采集请求，向同一标签页的所有 frame 广播
 *  2) 汇总各 frame 的候选图片 -> 清洗 / 还原原图 / 去重 -> 存入 session storage
 *  3) 打开结果页
 *  4) 为结果页提供跨域取图代理，以及防盗链场景下的 Referer 补全
 */
importScripts('/src/shared/utils.js', '/src/shared/url-utils.js', '/src/shared/platforms.js');

const EIG = globalThis.EIG;
const KEY_PREFIX = 'eig:collection:';
const LAST_KEY = 'eig:lastCollectionId';
const FRAME_QUIET_MS = 1200;      // 最后一个 frame 回传后再等这么久
const COLLECT_TIMEOUT_MS = 12000; // 单次采集的硬上限
const MAX_COLLECTIONS = 5;        // session storage 中保留的历史结果数
const MIN_EDGE = 120;             // 两个方向都小于该值的图片视为图标类
const NON_CDN_MIN_EDGE = 200;     // 非平台图床的图片，需至少一边达到该尺寸

/** collectId -> { ... } */
const sessions = new Map();

// ------------------------------------------------------------------ 采集调度
function handleCollectStart(msg, sender) {
  const tab = sender && sender.tab;
  const tabId = tab && tab.id;
  if (tabId === undefined || tabId === null) {
    return Promise.resolve({ ok: false, error: '无法定位当前标签页' });
  }

  const collectId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const session = {
    collectId: collectId,
    tabId: tabId,
    platform: msg.platform || '',
    pageTitle: msg.pageTitle || '',
    pageUrl: msg.pageUrl || (tab && tab.url) || '',
    items: [],
    frames: 0,
    finished: false,
    timer: null,
    deadline: null,
    resolve: null
  };
  session.promise = new Promise(function (resolve) { session.resolve = resolve; });
  sessions.set(collectId, session);

  session.timer = setTimeout(function () { finalize(session); }, FRAME_QUIET_MS);
  session.deadline = setTimeout(function () { finalize(session); }, COLLECT_TIMEOUT_MS);

  // 不带 frameId 广播到该标签页的所有 frame（all_frames 已开启）
  try {
    Promise.resolve(chrome.tabs.sendMessage(tabId, {
      type: 'EIG_COLLECT_FRAME',
      collectId: collectId,
      platform: session.platform
    })).catch(function () { /* 部分 frame 没有接收方是正常的 */ });
  } catch (e) {
    // 标签页可能已关闭，交给 deadline 收尾
  }

  return session.promise;
}

function handleFrameResult(msg, sender) {
  const session = sessions.get(msg.collectId);
  if (!session || session.finished) return;

  session.frames++;
  const frameUrl = msg.frameUrl || (sender && sender.url) || session.pageUrl;
  const list = Array.isArray(msg.items) ? msg.items : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || !item.url) continue;
    session.items.push({
      url: item.url,
      source: item.source || 'img',
      width: item.width || 0,
      height: item.height || 0,
      base: frameUrl
    });
  }

  clearTimeout(session.timer);
  session.timer = setTimeout(function () { finalize(session); }, FRAME_QUIET_MS);
}

async function finalize(session) {
  if (session.finished) return;
  session.finished = true;
  clearTimeout(session.timer);
  clearTimeout(session.deadline);
  sessions.delete(session.collectId);

  const collection = buildCollection(session);
  try {
    await persistCollection(collection);
    await chrome.tabs.create({
      url: chrome.runtime.getURL('src/gallery/gallery.html'),
      active: true
    });
    session.resolve({
      ok: true,
      count: collection.items.length,
      collectionId: collection.id,
      stats: collection.stats
    });
  } catch (err) {
    session.resolve({ ok: false, error: (err && err.message) || String(err) });
  }
}

// ------------------------------------------------------------------ 清洗与去重
function buildCollection(session) {
  const U = EIG.urlUtils;
  const P = EIG.platforms;
  const platform = P.get(session.platform) || P.detect(session.pageUrl);
  const stats = {
    raw: session.items.length,
    frames: session.frames,
    kept: 0,
    duplicates: 0,
    dropped: { invalid: 0, blacklist: 0, small: 0, offCdn: 0 }
  };

  const byKey = new Map();
  const order = [];

  for (let i = 0; i < session.items.length; i++) {
    const raw = session.items[i];
    const url = U.resolve(raw.url, raw.base || session.pageUrl);
    if (!url) { stats.dropped.invalid++; continue; }

    const host = U.hostOf(url);
    if (!U.hasImageExt(url) && !P.isCdnHost(platform, host)) { stats.dropped.invalid++; continue; }

    const clean = platform ? platform.cleanUrl(url) : url;
    if (P.blacklistReason(platform, clean)) { stats.dropped.blacklist++; continue; }

    const width = raw.width || 0;
    const height = raw.height || 0;
    if (width && height && width < MIN_EDGE && height < MIN_EDGE) { stats.dropped.small++; continue; }

    const inCdn = P.isCdnHost(platform, host);
    if (!inCdn && !(width >= NON_CDN_MIN_EDGE || height >= NON_CDN_MIN_EDGE)) {
      stats.dropped.offCdn++;
      continue;
    }

    const key = U.normalizeKey(clean);
    const guessed = U.guessSize(clean);
    const score = Math.max(width, height, guessed.w, guessed.h);
    const prev = byKey.get(key);

    if (prev) {
      stats.duplicates++;
      if (score > prev.score) {
        prev.url = clean;
        prev.host = U.hostOf(clean);
        prev.width = width || prev.width;
        prev.height = height || prev.height;
        prev.score = score;
      }
      continue;
    }

    byKey.set(key, {
      key: key,
      url: clean,
      host: U.hostOf(clean),
      width: width,
      height: height,
      source: raw.source,
      score: score,
      order: order.length
    });
    order.push(key);
  }

  const items = order.map(function (key, index) {
    const it = byKey.get(key);
    return {
      id: 'i' + index,
      index: index,
      url: it.url,
      host: it.host,
      width: it.width,
      height: it.height,
      source: it.source,
      ext: EIG.urlUtils.extOf(it.url)
    };
  });

  order.length = 0;
  stats.kept = items.length;

  return {
    id: session.collectId,
    createdAt: Date.now(),
    pageTitle: session.pageTitle,
    pageUrl: session.pageUrl,
    platform: platform ? platform.id : '',
    platformName: platform ? platform.name : '通用',
    referer: platform ? platform.referer : '',
    frames: session.frames,
    items: items,
    stats: stats
  };
}

async function persistCollection(collection) {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(function (k) { return k.indexOf(KEY_PREFIX) === 0; });
  const entries = keys.map(function (k) {
    return { key: k, createdAt: (all[k] && all[k].createdAt) || 0 };
  }).sort(function (a, b) { return b.createdAt - a.createdAt; });

  const stale = entries.slice(MAX_COLLECTIONS - 1).map(function (e) { return e.key; });
  if (stale.length) await chrome.storage.session.remove(stale);

  const payload = {};
  payload[KEY_PREFIX + collection.id] = collection;
  payload[LAST_KEY] = collection.id;
  await chrome.storage.session.set(payload);
}

// ------------------------------------------------------------------ 取图代理
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', jfif: 'image/jpeg'
};

function guessMime(url) {
  const ext = EIG.urlUtils.extOf(url);
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const refererRuleIds = new Map();   // 域名 -> DNR 规则 id
let nextRuleId = 1001;
const MULTI_PART_SUFFIX = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'co.uk', 'com.hk', 'com.au'];

function registrableDomain(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length < 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIX.indexOf(lastTwo) !== -1 && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** 为某个图床域名补 Referer，破解防盗链 */
async function ensureRefererRule(host, refererUrl) {
  const domain = registrableDomain(host);
  if (!domain) return null;

  let ruleId = refererRuleIds.get(domain);
  if (!ruleId) {
    ruleId = nextRuleId++;
    refererRuleIds.set(domain, ruleId);
  }

  const referer = refererUrl && /^https?:\/\//.test(refererUrl)
    ? refererUrl
    : 'https://' + domain + '/';

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
        },
        condition: {
          urlFilter: '||' + domain,
          resourceTypes: ['xmlhttprequest', 'image', 'other']
        }
      }]
    });
    return ruleId;
  } catch (e) {
    return null;
  }
}

async function doFetch(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    cache: 'force-cache'   // 优先命中页面已经下载过的缓存
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.arrayBuffer();
}

/**
 * 结果页取图代理：扩展源发起请求，绕过内容脚本的同源限制。
 * 首次失败时补 Referer 再试一次。
 */
async function proxyFetch(url, referer) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: '非法的图片地址' };
  try {
    const buffer = await doFetch(url);
    return {
      ok: true,
      mime: guessMime(url),
      size: buffer.byteLength,
      base64: arrayBufferToBase64(buffer)
    };
  } catch (first) {
    try {
      const host = EIG.urlUtils.hostOf(url);
      const ruleId = await ensureRefererRule(host, referer);
      const buffer = await doFetch(url);
      return {
        ok: true,
        mime: guessMime(url),
        size: buffer.byteLength,
        base64: arrayBufferToBase64(buffer),
        usedRefererRule: !!ruleId
      };
    } catch (second) {
      return {
        ok: false,
        error: '取图失败：' + ((second && second.message) || (first && first.message) || '未知错误')
      };
    }
  }
}

// ------------------------------------------------------------------ 消息路由
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'EIG_COLLECT_START') {
    handleCollectStart(msg, sender).then(sendResponse, function (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });
    return true;   // 异步响应
  }

  if (msg.type === 'EIG_FRAME_RESULT') {
    handleFrameResult(msg, sender);
    return false;
  }

  if (msg.type === 'EIG_FETCH_PROXY') {
    proxyFetch(msg.url, msg.referer).then(sendResponse, function (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });
    return true;
  }

});

// 标签页关闭时清理未完成的会话
chrome.tabs.onRemoved.addListener(function (tabId) {
  sessions.forEach(function (session) {
    if (session.tabId === tabId && !session.finished) {
      clearTimeout(session.timer);
      clearTimeout(session.deadline);
      session.finished = true;
      sessions.delete(session.collectId);
      session.resolve({ ok: false, error: '标签页已关闭' });
    }
  });
});

// 点击扩展图标：打开结果页（自动读取最后一次抓取结果）
chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/gallery/gallery.html') });
});
