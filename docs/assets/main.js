/**
 * 官网交互增强：移动端导航、顶栏滚动状态、滚动入场动效、代码片段点击复制。
 * 全部为渐进增强——脚本失效时正文内容依然完整可读。
 */
(function () {
  'use strict';

  var MOBILE_MAX = 880;   // 与 style.css 中导航收起的断点保持一致

  /* ------------------------------------------------------------ 移动端导航 */
  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('navToggle');

  function closeNav() {
    if (!nav || !navToggle) return;
    nav.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '展开导航菜单');
  }

  if (nav && navToggle) {
    navToggle.addEventListener('click', function () {
      var opened = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(opened));
      navToggle.setAttribute('aria-label', opened ? '收起导航菜单' : '展开导航菜单');
    });

    // 点击锚点后自动收起
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeNav();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeNav();
    });

    // 点击导航之外的区域也收起
    document.addEventListener('click', function (event) {
      if (!nav.classList.contains('is-open')) return;
      if (nav.contains(event.target) || navToggle.contains(event.target)) return;
      closeNav();
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > MOBILE_MAX) closeNav();
    });
  }

  /* ------------------------------------------------------------ 顶栏滚动状态 */
  var header = document.querySelector('.site-header');
  if (header) {
    var ticking = false;

    var updateHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    };

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateHeader);
    }, { passive: true });

    updateHeader();
  }

  /* ------------------------------------------------------------ 滚动入场 */
  var revealItems = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!revealItems.length) {
    // 无需处理
  } else if (!('IntersectionObserver' in window) || prefersReduced) {
    revealItems.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });

    revealItems.forEach(function (el) { observer.observe(el); });

    // 兜底：若 2 秒后仍然一个都没显示，说明观察器未能回调（部分渲染环境会如此），
    // 直接展示全部内容，绝不让页面主体停留在隐藏态。
    window.setTimeout(function () {
      if (document.querySelector('.reveal.is-visible')) return;
      revealItems.forEach(function (el) { el.classList.add('is-visible'); });
    }, 2000);
  }

  /* ------------------------------------------------------------ 点击复制 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    // file:// 等场景下回退到 execCommand
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return Promise.resolve(ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  document.querySelectorAll('.copyable').forEach(function (el) {
    el.addEventListener('click', function () {
      var text = el.getAttribute('data-copy') || el.textContent.trim();
      copyText(text).then(function (ok) {
        if (!ok) return;   // 复制失败时保持原样，文本仍可手动选中
        el.classList.add('is-copied');
        el.setAttribute('title', '已复制到剪贴板');
        window.setTimeout(function () { el.classList.remove('is-copied'); }, 1400);
      });
    });
  });
})();
