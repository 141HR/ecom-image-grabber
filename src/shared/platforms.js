/**
 * 平台适配规则：详情页识别、CDN 域名白名单、缩略图还原原图、非商品图过滤。
 *
 * 注意：各平台的 DOM 结构与接口会不定期调整，本文件中的域名/规则属于"稳定部分"，
 * 选择器相关的探测放在 collector.js，并保留兜底的通用采集策略。
 */
(function (root) {
  'use strict';
  const EIG = (root.EIG = root.EIG || {});
  if (EIG.platforms) return;
  const U = EIG.urlUtils;

  /** 通用非商品图关键词（命中任意一个即丢弃） */
  const COMMON_BLACKLIST = [
    'logo', 'icon', 'sprite', 'avatar', 'head_', 'qrcode', 'qr_code', 'erweima',
    'placeholder', 'loading', 'blank.gif', 'spacer', 'pixel', '1x1', 'btn_',
    'button', 'arrow', 'star_', 'rating', 'dot.gif', 'default_', 'weixin',
    'wechat', 'kefu', 'service_', 'slogan', 'kong.png', 'watermark'
  ];

  /** 明显是页面静态资源的域名/路径前缀 */
  const COMMON_BLACK_HOSTS = [
    'assets.alicdn.com',
    'static.360buyimg.com',
    'static.pinduoduo.com',
    'static.yangkeduo.com'
  ];

  const COMMON_BLACK_PATHS = ['/tps/', '/img/blank', '/img/loading', '/iconfont'];

  function hostMatches(host, patterns) {
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(host)) return true;
    }
    return false;
  }

  function hitKeyword(text, keywords) {
    const lower = text.toLowerCase();
    for (let i = 0; i < keywords.length; i++) {
      if (lower.indexOf(keywords[i]) !== -1) return keywords[i];
    }
    return '';
  }

  // ---------------------------------------------------------------- 淘宝 / 天猫
  const taobao = {
    id: 'taobao',
    name: '淘宝 / 天猫',
    referer: 'https://item.taobao.com/',
    pageHosts: [/^(?:[a-z0-9-]+\.)*(?:taobao|tmall)\.com$/i, /^[a-z0-9-]+\.tb\.cn$/i],
    cdnHosts: [
      /\.alicdn\.com$/i,
      /\.taobaocdn\.com$/i,
      /^img\d*\.alibaba\.com$/i,
      /\.alibabacorp\.com$/i
    ],
    blacklistHosts: COMMON_BLACK_HOSTS.concat(['img.alicdn.com.tps']),
    blacklistPaths: COMMON_BLACK_PATHS,
    blacklistKeywords: COMMON_BLACKLIST,
    detailPage: function (url) {
      const host = U.hostOf(url);
      if (!hostMatches(host, this.pageHosts)) return false;
      if (/item\.htm/i.test(url)) return true;
      if (/\/item\/\d+/.test(url)) return true;
      if (/detail\.(tmall|taobao)/i.test(host) && /[?&]id=\d+/.test(url)) return true;
      return false;
    },
    /**
     * 缩略图还原原图：
     *   xxx.jpg_430x430q90.jpg  -> xxx.jpg
     *   xxx.jpg_q75.jpg         -> xxx.jpg
     *   xxx.png_.webp           -> xxx.png
     *   xxx.jpg?xxxx            -> xxx.jpg
     */
    cleanUrl: function (url) {
      let s = U.stripQuery(url);
      const m = s.match(/^(.*?\.(?:jpe?g|png|webp|gif|bmp|jfif))(_[^/?#]*)$/i);
      if (m) s = m[1];
      return s;
    }
  };

  // ---------------------------------------------------------------- 京东
  const jd = {
    id: 'jd',
    name: '京东',
    referer: 'https://item.jd.com/',
    pageHosts: [/^(?:[a-z0-9-]+\.)*jd\.com$/i, /^(?:[a-z0-9-]+\.)*jd\.hk$/i, /^(?:[a-z0-9-]+\.)*3\.cn$/i],
    cdnHosts: [
      /\.360buyimg\.com$/i,
      /^img\d+\.jd\.com$/i,
      /\.jdimg\.com$/i
    ],
    blacklistHosts: COMMON_BLACK_HOSTS,
    blacklistPaths: ['/img/', '/ads/', '/icon/', '/popup/', '/jdhelp/'],
    blacklistKeywords: COMMON_BLACKLIST,
    detailPage: function (url) {
      const host = U.hostOf(url);
      if (!hostMatches(host, this.pageHosts)) return false;
      if (/^\/(?:\d+)\.html$/i.test(U.pathOf(url))) return true;
      if (/\/product\/\d+/i.test(url)) return true;
      return false;
    },
    /**
     * 缩略图还原原图：
     *   /n5/jfs/t1/xxx.jpg            -> /jfs/t1/xxx.jpg
     *   /n5/s450x450_jfs/t1/xxx.jpg   -> /jfs/t1/xxx.jpg
     *   /imgzone/jfs/t1/xxx.jpg       -> /jfs/t1/xxx.jpg
     *   xxx.jpg!q70.dpg               -> xxx.jpg
     */
    cleanUrl: function (url) {
      let s = U.stripQuery(url).split('!')[0];
      s = s.replace(/\/(?:n\d+|imgzone\d*)\//gi, '/');      // 去掉尺寸/格式路径段，但保留下面的 jfs
      s = s.replace(/\/(?:s\d+x\d+_)?jfs\//i, '/jfs/');     // 统一成 /jfs/
      return s;
    }
  };

  // ---------------------------------------------------------------- 拼多多
  const pdd = {
    id: 'pdd',
    name: '拼多多',
    referer: 'https://mobile.yangkeduo.com/',
    pageHosts: [/\.yangkeduo\.com$/i, /\.pinduoduo\.com$/i],
    cdnHosts: [
      /\.pddpic\.com$/i,
      /\.pddimg\.com$/i,
      /\.pinimg\.com$/i,
      /\.yangkeduo\.com$/i,
      /\.pinduoduo\.com$/i
    ],
    blacklistHosts: COMMON_BLACK_HOSTS,
    blacklistPaths: ['/static/', '/assets/', '/logo/'],
    blacklistKeywords: COMMON_BLACKLIST,
    detailPage: function (url) {
      const host = U.hostOf(url);
      if (!hostMatches(host, this.pageHosts)) return false;
      if (/goods\d*\.html/i.test(url)) return true;
      if (/goods_id=\d+/i.test(url)) return true;
      // 商家版后台：/goods/goods_detail?goods_id=xxx、/goods/goods_add 等
      if (/^mms\.pinduoduo\.com$/i.test(host) && /\/goods\//i.test(U.pathOf(url))) return true;
      return false;
    },
    /**
     * 缩略图还原原图：
     *   xxx.jpeg?imageMogr2/thumbnail/400x/format/jpeg -> xxx.jpeg
     *   xxx_400x400.jpg                                -> xxx.jpg
     */
    cleanUrl: function (url) {
      let s = U.stripQuery(url);
      s = s.replace(/@[^/]*$/, '');
      s = s.replace(/_(?:\d+x\d+|\d+w|\d+h)(?=\.\w{3,4}$)/i, '');
      return s;
    }
  };

  const LIST = [taobao, jd, pdd];

  /** 按页面 URL 识别平台，识别不到返回 null */
  function detect(url) {
    if (!url) return null;
    const host = U.hostOf(url);
    if (!host) return null;
    for (let i = 0; i < LIST.length; i++) {
      if (hostMatches(host, LIST[i].pageHosts)) return LIST[i];
    }
    return null;
  }

  /** 按 id 取平台 */
  function get(id) {
    for (let i = 0; i < LIST.length; i++) {
      if (LIST[i].id === id) return LIST[i];
    }
    return null;
  }

  /** 图片域名是否属于该平台的图床 */
  function isCdnHost(platform, host) {
    if (!platform) return false;
    return hostMatches(host, platform.cdnHosts);
  }

  /**
   * 是否命中非商品图黑名单（域名 / 路径 / 文件名关键词）。
   * @returns {string} 命中的原因，未命中返回空串
   */
  function blacklistReason(platform, url) {
    const host = U.hostOf(url);
    const path = U.pathOf(url).toLowerCase();
    const blackHosts = (platform && platform.blacklistHosts) || COMMON_BLACK_HOSTS;
    const blackPaths = (platform && platform.blacklistPaths) || COMMON_BLACK_PATHS;
    const blackKeywords = (platform && platform.blacklistKeywords) || COMMON_BLACKLIST;

    for (let i = 0; i < blackHosts.length; i++) {
      if (host === blackHosts[i] || host.endsWith('.' + blackHosts[i])) return '静态资源域名 ' + host;
    }
    for (let i = 0; i < blackPaths.length; i++) {
      if (path.indexOf(blackPaths[i]) !== -1) return '静态资源路径 ' + blackPaths[i];
    }
    // 关键词只匹配文件名，避免误伤带随机串的哈希文件名
    const fileName = U.stripQuery(url).split('/').pop() || '';
    const kw = hitKeyword(decodeURIComponent(fileName).toLowerCase(), blackKeywords);
    if (kw) return '疑似非商品图关键词 ' + kw;
    return '';
  }

  EIG.platforms = {
    list: LIST,
    detect: detect,
    get: get,
    isCdnHost: isCdnHost,
    blacklistReason: blacklistReason,
    COMMON_BLACKLIST: COMMON_BLACKLIST
  };
})(globalThis);
