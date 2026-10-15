/**
 * 通用小工具：时间/体积格式化、文件名净化、并发池、延时。
 * 以全局命名空间 EIG.utils 暴露，内容脚本、Service Worker、结果页共用。
 */
(function (root) {
  'use strict';
  const EIG = (root.EIG = root.EIG || {});
  if (EIG.utils) return;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** 时间戳 -> "2026-10-15 14:30:05" */
  function formatTime(ts) {
    const d = new Date(ts);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 字节数 -> "1.2 MB" */
  function formatBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(n) : n.toFixed(1)) + ' ' + units[i];
  }

  const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

  /** 把任意文本净化成合法的文件名片段（不含扩展名） */
  function sanitizeFilename(name, fallback, maxLen) {
    let s = String(name === undefined || name === null ? '' : name)
      .replace(ILLEGAL_CHARS, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (!s) s = fallback || '图片';
    const limit = maxLen || 60;
    if (s.length > limit) s = s.slice(0, limit).replace(/[.\s]+$/, '');
    return s || (fallback || '图片');
  }

  /** 序号补零：12 -> "12"，128 张里的 12 -> "012" */
  function padIndex(index, total) {
    const width = Math.max(2, String(total || 0).length);
    return String(index).padStart(width, '0');
  }

  /**
   * 带并发上限的任务池。
   * @param {Array} items 待处理数据
   * @param {number} limit 并发数
   * @param {(item:any, index:number)=>Promise<any>} worker 单个任务
   * @param {(done:number, total:number, result:object, item:any, index:number)=>void} [onProgress]
   * @returns {Promise<Array<{status:'ok'|'error', value?:any, error?:string}>>}
   */
  async function runPool(items, limit, worker, onProgress) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;
    const size = Math.max(1, Math.min(limit || 1, items.length || 1));

    async function runner() {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        let result;
        try {
          result = { status: 'ok', value: await worker(items[index], index) };
        } catch (err) {
          result = { status: 'error', error: (err && err.message) || String(err) };
        }
        results[index] = result;
        done++;
        if (onProgress) {
          try { onProgress(done, items.length, result, items[index], index); } catch (e) { /* 进度回调异常不影响主流程 */ }
        }
      }
    }

    await Promise.all(Array.from({ length: size }, runner));
    return results;
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  EIG.utils = {
    sleep: sleep,
    formatTime: formatTime,
    formatBytes: formatBytes,
    sanitizeFilename: sanitizeFilename,
    padIndex: padIndex,
    runPool: runPool,
    debounce: debounce
  };
})(globalThis);
