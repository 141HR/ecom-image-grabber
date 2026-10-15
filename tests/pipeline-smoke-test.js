/**
 * 一次性冒烟测试：在 Node 中打桩 chrome API，验证 Service Worker 的
 * 采集汇总 -> 清洗还原 -> 去重过滤 流水线，以及共享模块的 URL 规则。
 * 用法：node _smoke-eig.js
 */
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');
const store = {};
const messageListeners = [];
let broadcast = null;
let createdTab = null;

global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    getURL: (p) => 'chrome-extension://abcdefghijklmnop/' + p.replace(/^\//, '')
  },
  tabs: {
    onRemoved: { addListener() {} },
    sendMessage: async (tabId, msg) => { broadcast = msg; return { ok: true }; },
    create: async (opts) => { createdTab = opts.url; return { id: 99 }; }
  },
  action: { onClicked: { addListener() {} } },
  declarativeNetRequest: { updateDynamicRules: async () => {} },
  storage: {
    session: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return Object.assign({}, store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        list.forEach((k) => { if (k in store) out[k] = store[k]; });
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); }
    }
  }
};

global.importScripts = function () {
  Array.prototype.slice.call(arguments).forEach((file) => {
    const p = path.join(EXT, file.replace(/^\//, ''));
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(p, 'utf8'));
  });
};

require(path.join(EXT, 'src/background/service-worker.js'));

const U = globalThis.EIG.urlUtils;
const P = globalThis.EIG.platforms;

function send(msg, sender) {
  return new Promise((resolve) => {
    messageListeners.forEach((fn) => fn(msg, sender || {}, resolve));
  });
}

/** 只派发、不等待响应（如 EIG_FRAME_RESULT 这类单向消息） */
function sendFire(msg, sender) {
  messageListeners.forEach((fn) => fn(msg, sender || {}, function () {}));
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual)); }
}

function section(title) { console.log('\n' + title); }

(async function run() {
  const taobao = P.get('taobao');
  const jd = P.get('jd');
  const pdd = P.get('pdd');

  section('1. 缩略图还原原图');
  check('淘宝 jpg_430x430q90',
    taobao.cleanUrl('https://img.alicdn.com/imgextra/i1/123/O1CN01a.jpg_430x430q90.jpg'),
    'https://img.alicdn.com/imgextra/i1/123/O1CN01a.jpg');
  check('淘宝 png_.webp',
    taobao.cleanUrl('https://img.alicdn.com/imgextra/i1/123/O1CN01a.png_.webp'),
    'https://img.alicdn.com/imgextra/i1/123/O1CN01a.png');
  check('淘宝 带查询串',
    taobao.cleanUrl('https://img.alicdn.com/i1/x.jpg?t=1'),
    'https://img.alicdn.com/i1/x.jpg');
  check('京东 /n5/jfs/',
    jd.cleanUrl('https://img14.360buyimg.com/n5/jfs/t1/123/45/678/9012/abc.jpg'),
    'https://img14.360buyimg.com/jfs/t1/123/45/678/9012/abc.jpg');
  check('京东 /n5/s450x450_jfs/',
    jd.cleanUrl('https://img14.360buyimg.com/n5/s450x450_jfs/t1/123/45/678/9012/abc.jpg'),
    'https://img14.360buyimg.com/jfs/t1/123/45/678/9012/abc.jpg');
  check('京东 /imgzone/jfs/ 与 !q70',
    jd.cleanUrl('https://img10.360buyimg.com/imgzone/jfs/t1/1/2/3/4/abc.jpg!q70.dpg'),
    'https://img10.360buyimg.com/jfs/t1/1/2/3/4/abc.jpg');
  check('拼多多 imageMogr2',
    pdd.cleanUrl('https://img.pddpic.com/mms-material-img/2023/abc.jpeg?imageMogr2/thumbnail/400x/format/jpeg'),
    'https://img.pddpic.com/mms-material-img/2023/abc.jpeg');
  check('拼多多 _400x400 后缀',
    pdd.cleanUrl('https://img.pddpic.com/mms/abc_400x400.jpg'),
    'https://img.pddpic.com/mms/abc.jpg');

  section('2. 详情页识别');
  check('淘宝详情页', !!taobao.detailPage('https://item.taobao.com/item.htm?id=123'), true);
  check('天猫详情页', !!P.get('taobao').detailPage('https://detail.tmall.com/item.htm?spm=a1&id=9'), true);
  check('淘宝首页不算', !!taobao.detailPage('https://www.taobao.com/'), false);
  check('京东详情页', !!jd.detailPage('https://item.jd.com/100012043978.html'), true);
  check('京东详情描述 iframe 不算', !!jd.detailPage('https://dx.3.cn/desc/100012043978'), false);
  check('拼多多商家版详情', !!pdd.detailPage('https://mms.pinduoduo.com/goods/goods_detail?goods_id=123'), true);
  check('拼多多前台商品页', !!pdd.detailPage('https://mobile.yangkeduo.com/goods.html?goods_id=99'), true);

  section('3. 非商品图过滤');
  check('静态资源域名', !!P.blacklistReason(taobao, 'https://assets.alicdn.com/xxx/1.png'), true);
  check('iconfont 路径', !!P.blacklistReason(taobao, 'https://img.alicdn.com/iconfont/a.png'), true);
  check('文件名含 logo', !!P.blacklistReason(taobao, 'https://img.alicdn.com/imgextra/i1/logo_new.png'), true);
  check('正常商品图不误杀', P.blacklistReason(taobao, 'https://img.alicdn.com/imgextra/i1/123/O1CN01abcdef.jpg'), '');

  section('4. 采集流水线（含跨 frame 汇总）');
  const pageUrl = 'https://item.taobao.com/item.htm?id=123';
  const started = send({ type: 'EIG_COLLECT_START', pageTitle: '测试商品', pageUrl, platform: 'taobao' },
    { tab: { id: 7, url: pageUrl } });
  await new Promise((r) => setTimeout(r, 50));

  const collectId = broadcast && broadcast.collectId;
  check('已向所有 frame 广播采集指令', !!collectId, true);

  sendFire({
    type: 'EIG_FRAME_RESULT',
    collectId,
    frameUrl: pageUrl,
    items: [
      { url: 'https://img.alicdn.com/imgextra/i1/123/O1CN01a.jpg_430x430q90.jpg', source: 'img', width: 430, height: 430 },
      { url: 'https://img.alicdn.com/imgextra/i1/123/O1CN01a.jpg', source: 'lazy', width: 800, height: 800 },
      { url: 'https://img.alicdn.com/tps/i4/TB1logo_50x50.png', source: 'img', width: 50, height: 50 },
      { url: 'https://img.alicdn.com/imgextra/i1/123/logo_new.png', source: 'img', width: 400, height: 400 },
      { url: 'data:image/png;base64,AAA', source: 'img' },
      { url: '//img.alicdn.com/imgextra/i2/999/B1.png', source: 'background' },
      { url: 'https://img.alicdn.com/imgextra/i1/123/promo_badge.png', source: 'img', width: 200, height: 160 },
      { url: 'https://img.alicdn.com/imgextra/i1/123/discount_strip.png', source: 'img', width: 285, height: 48 },
      { url: 'https://img.alicdn.com/imgextra/i1/123/brand_mark.png', source: 'img', width: 300, height: 300 },
      { url: 'https://cdn.example.com/some/pic.png', source: 'img', width: 0, height: 0 },
      { url: 'https://cdn.example.com/some/big.png', source: 'img', width: 600, height: 600 }
    ]
  }, { url: pageUrl });

  sendFire({
    type: 'EIG_FRAME_RESULT',
    collectId,
    frameUrl: 'https://desc.alicdn.com/desc/123.html',
    items: [
      { url: 'https://img.alicdn.com/imgextra/i3/123/detail1.jpg', source: 'img', width: 750, height: 1200 },
      { url: 'https://img.alicdn.com/imgextra/i3/123/detail1.jpg_800x800.jpg', source: 'lazy' }
    ]
  }, { url: 'https://desc.alicdn.com/desc/123.html' });

  const result = await started;
  check('返回抓取成功', result.ok, true);
  check('最终保留 5 张', result.count, 5);
  check('已打开结果页', /src\/gallery\/gallery\.html$/.test(createdTab || ''), true);
  check('新窗口协议为扩展页', (createdTab || '').indexOf('chrome-extension://') === 0, true);

  const collectionId = store['eig:lastCollectionId'];
  const collection = store['eig:collection:' + collectionId];
  check('结果已写入 session storage', !!collection, true);
  check('去重数量（同图不同尺寸合并 2 组）', collection.stats.duplicates, 2);
  check('丢弃：黑名单 2 张', collection.stats.dropped.blacklist, 2);
  check('丢弃：非法/base64 1 张', collection.stats.dropped.invalid, 1);
  check('丢弃：非白名单域名且尺寸未知 1 张', collection.stats.dropped.offCdn, 1);
  check('丢弃：最小边不足 200px 的角标 2 张', collection.stats.dropped.small, 2);
  check('跨 2 个 frame 汇总', collection.stats.frames, 2);
  check('保留顺序与 URL 正确', collection.items.map((i) => i.url), [
    'https://img.alicdn.com/imgextra/i1/123/O1CN01a.jpg',
    'https://img.alicdn.com/imgextra/i2/999/B1.png',
    'https://img.alicdn.com/imgextra/i1/123/brand_mark.png',
    'https://cdn.example.com/some/big.png',
    'https://img.alicdn.com/imgextra/i3/123/detail1.jpg'
  ]);
  check('平台信息正确', collection.platformName, '淘宝 / 天猫');
  check('携带防盗链 Referer', collection.referer, 'https://item.taobao.com/');
  check('同图保留更高清尺寸的记录', collection.items[0].width, 800);

  section('5. URL 工具');
  check('normalizeKey 忽略协议与查询串',
    U.normalizeKey('http://img.alicdn.com/a/b.jpg?x=1') === U.normalizeKey('https://img.alicdn.com/a/b.jpg'),
    true);
  check('srcset 取最高清',
    U.bestFromSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x', 'https://x.com/p/'),
    'https://x.com/p/b.jpg');
  check('尺寸推断', U.guessSize('https://x.com/a_800x600.jpg'), { w: 800, h: 600 });
  check('过滤 data URI', U.resolve('data:image/png;base64,AAA'), '');
  check('协议相对地址补全', U.resolve('//img.alicdn.com/a.jpg'), 'https://img.alicdn.com/a.jpg');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
