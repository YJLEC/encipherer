/* Encipherer · ui/app — 应用外壳:topbar / hash 路由 / 主题 / 锁定遮罩 / 全局拖放 / 快捷键
 * 依赖:Encipherer.util / Encipherer.workspace(只读使用)。
 * UMD:浏览器挂 Encipherer.ui.app;Node 分支导出空对象(纯 UI 模块)。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.app = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var workspace = E.workspace;

  var ROUTES = ['home', 'workbench', 'restore', 'mapping', 'settings', 'help'];
  var NAV = [
    ['workbench', '文件与脱敏'],
    ['restore', '还原'],
    ['mapping', '映射表'],
    ['settings', '设置'],
    ['help', '帮助']
  ];

  var st = {
    booted: false,
    mainEl: null,
    topbarEl: null,
    navEls: {},
    wsBadge: null,
    btnLock: null,
    btnClose: null,
    btnTheme: null,
    screen: null,
    module: null,
    theme: 'auto',
    dragEl: null,
    dragDepth: 0,
    themeMqHandler: null
  };

  /* ================= 主题 =================
   * 三态:auto(跟随系统)→ light → dark 循环;持久化于 localStorage('ec_theme'),
   * 工作区 settings.theme 通过 bus 'theme:change' 同步进来。 */
  function effectiveTheme(mode) {
    if (mode === 'auto') {
      try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (e) { return 'light'; }
    }
    return mode === 'dark' ? 'dark' : 'light';
  }
  function applyTheme() {
    document.documentElement.classList.toggle('dark', effectiveTheme(st.theme) === 'dark');
  }
  function refreshThemeBtn() {
    if (!st.btnTheme) return;
    var label = st.theme === 'auto' ? '🌗 自动' : (st.theme === 'dark' ? '🌙 深色' : '🌞 浅色');
    st.btnTheme.textContent = label;
    st.btnTheme.title = '主题:' + label + '(点击切换 自动 → 浅色 → 深色)';
  }
  function setTheme(mode, persist) {
    st.theme = (mode === 'light' || mode === 'dark') ? mode : 'auto';
    if (persist !== false) { try { localStorage.setItem('ec_theme', st.theme); } catch (e) { /* 忽略 */ } }
    applyTheme();
    refreshThemeBtn();
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('ec_theme'); } catch (e) { /* 忽略 */ }
    setTheme(saved, false);
    // auto 模式下跟随系统变化
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      st.themeMqHandler = function () { if (st.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', st.themeMqHandler);
      else if (mq.addListener) mq.addListener(st.themeMqHandler);
    } catch (e) { /* 旧浏览器忽略 */ }
  }

  /* ================= 路由 ================= */
  function routeName() {
    var m = /^#\/([a-z]+)/.exec(location.hash || '');
    return m ? m[1] : 'home';
  }
  function navigate(name) {
    if (ROUTES.indexOf(name) < 0) name = 'home';
    if (routeName() === name) route();
    else location.hash = '#/' + name;
  }
  function route() {
    var name = routeName();
    if (ROUTES.indexOf(name) < 0 || !E.ui[name]) name = 'home';
    // 守卫:无工作区(或已锁定)时,非 home 屏强制回 home(锁屏遮罩另行覆盖)
    if (name !== 'home') {
      var ws = workspace.current;
      if (!ws || ws.isLocked()) {
        name = 'home';
        if (routeName() !== 'home') { location.replace('#/home'); return; }
      }
    }
    var mod = E.ui[name];
    if (!mod || typeof mod.mount !== 'function') { name = 'home'; mod = E.ui.home; }
    if (st.module) {
      try { if (typeof st.module.unmount === 'function') st.module.unmount(); }
      catch (e) { util.toast('切换页面时出错:' + (e && e.message || e), 'err'); }
    }
    st.module = mod;
    st.screen = name;
    st.mainEl.textContent = '';
    try { mod.mount(st.mainEl); }
    catch (e) {
      util.toast('页面加载失败:' + (e && e.message || e), 'err');
      console.error(e);
    }
    refreshTopbar();
  }

  /* ================= 顶栏 ================= */
  var LOGO_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 8 14v16c0 15 10 25 24 30 14-5 24-15 24-30V14L32 4z" fill="#1a7f5a"/><rect x="18" y="22" width="28" height="22" rx="2" fill="#fff"/><path d="M18 29h28M18 36h28M27 22v22M37 22v22" stroke="#1a7f5a" stroke-width="2.5"/></svg>';

  function refreshTopbar() {
    var ws = workspace.current;
    for (var r in st.navEls) st.navEls[r].classList.toggle('active', r === st.screen && !!ws);
    // 无工作区:导航不可用(隐藏由 CSS 类控制)
    Object.keys(st.navEls).forEach(function (r) {
      st.navEls[r].style.display = ws ? '' : 'none';
    });
    if (st.wsBadge) {
      st.wsBadge.style.display = ws ? '' : 'none';
      if (ws) {
        st.wsBadge.querySelector('.ec-ws-name').textContent = ws.name;
        st.wsBadge.title = '当前工作区:' + ws.name;
      }
    }
    if (st.btnLock) st.btnLock.style.display = ws ? '' : 'none';
    if (st.btnClose) st.btnClose.style.display = ws ? '' : 'none';
  }

  function buildShell() {
    var root = document.getElementById('app');
    root.textContent = '';
    var brand = util.el('div', { class: 'ec-brand' });
    var icoWrap = util.el('span', { html: LOGO_SVG }); // 静态 SVG,无用户数据
    brand.appendChild(icoWrap);
    brand.appendChild(util.el('div', { class: 'ec-brand-t' }, [
      util.el('b', { text: 'Encipherer' }),
      util.el('span', { text: '表格隐私卫士' })
    ]));

    st.wsBadge = util.el('span', { class: 'ec-ws-badge', style: { display: 'none' } }, [
      util.el('span', { text: '🗂' }),
      util.el('span', { class: 'ec-ws-name', text: '' })
    ]);

    var nav = util.el('nav', { class: 'ec-nav' });
    NAV.forEach(function (item) {
      var b = util.el('button', { class: 'ec-nav-item', type: 'button', text: item[1] });
      b.addEventListener('click', function () { navigate(item[0]); });
      st.navEls[item[0]] = b;
      nav.appendChild(b);
    });

    st.btnTheme = util.el('button', { class: 'ec-iconbtn', type: 'button', title: '切换主题' });
    st.btnTheme.addEventListener('click', function () {
      var next = st.theme === 'auto' ? 'light' : (st.theme === 'light' ? 'dark' : 'auto');
      setTheme(next);
      var ws = workspace.current;
      if (ws && !ws.isLocked()) { ws.settings.theme = next; }
      util.toast('主题:' + (next === 'auto' ? '跟随系统' : (next === 'dark' ? '深色' : '浅色')), 'info');
    });
    st.btnLock = util.el('button', { class: 'ec-iconbtn', type: 'button', title: '立即锁定 (Ctrl+L)' });
    st.btnLock.appendChild(util.el('span', { text: '🔒' }));
    st.btnLock.appendChild(util.el('span', { text: '锁定' }));
    st.btnLock.addEventListener('click', lockNow);
    st.btnClose = util.el('button', { class: 'ec-iconbtn', type: 'button', title: '关闭当前工作区' });
    st.btnClose.appendChild(util.el('span', { text: '✕' }));
    st.btnClose.appendChild(util.el('span', { text: '关闭工作区' }));
    st.btnClose.addEventListener('click', closeWorkspace);

    st.topbarEl = util.el('header', { class: 'ec-topbar' }, [
      brand, st.wsBadge, nav,
      util.el('div', { class: 'ec-topbar-right' }, [st.btnTheme, st.btnLock, st.btnClose])
    ]);
    st.mainEl = util.el('main', { id: 'ec-main' });
    root.appendChild(st.topbarEl);
    root.appendChild(st.mainEl);
  }

  /* ================= 锁定 / 关闭 ================= */
  function lockNow() {
    var ws = workspace.current;
    if (ws && !ws.isLocked()) ws.lock(); // 触发 bus 'workspace:locked' → 显示遮罩
  }
  async function closeWorkspace() {
    var ws = workspace.current;
    if (!ws) { navigate('home'); return; }
    var ok = await util.confirmDialog({
      title: '关闭工作区',
      body: '关闭后内存中的密钥与映射将被清除。<br>如需下次继续使用,请先在「映射表」页导出 .ecw 文件或确认本机已有副本。',
      confirmText: '关闭工作区'
    });
    if (!ok) return;
    // 先断开 current 再 lock(),避免 lock 事件又弹出锁屏遮罩
    workspace.current = null;
    try { ws.lock(); } catch (e) { /* 已锁定也无妨 */ }
    if (E.ui.lock && typeof E.ui.lock.unmount === 'function') E.ui.lock.unmount();
    util.toast('工作区已关闭', 'info');
    navigate('home');
  }

  /* ================= 全局拖放 ================= */
  function screenAcceptsFiles() {
    if (workspace.current && workspace.current.isLocked()) return false; // 锁屏期间不接受
    return st.module && typeof st.module.handleFiles === 'function';
  }
  function showDrag(v) { if (st.dragEl) st.dragEl.classList.toggle('show', !!v); }
  function initDragDrop() {
    st.dragEl = util.el('div', { class: 'ec-dragover' }, [
      util.el('div', { class: 'ec-dragover-box', text: '松开鼠标,上传文件' })
    ]);
    document.body.appendChild(st.dragEl);
    window.addEventListener('dragenter', function (e) {
      e.preventDefault(); // 始终阻止浏览器默认打开文件
      if (!screenAcceptsFiles()) return;
      st.dragDepth++;
      showDrag(true);
    });
    window.addEventListener('dragover', function (e) {
      e.preventDefault(); // 允许 drop,且阻止浏览器默认跳转打开文件
      if (!screenAcceptsFiles()) return;
      if (!st.dragDepth) { st.dragDepth = 1; showDrag(true); }
    });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      st.dragDepth = Math.max(0, st.dragDepth - 1);
      if (st.dragDepth === 0) showDrag(false);
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); // 不论哪个屏,都不允许浏览器直接打开文件
      st.dragDepth = 0;
      showDrag(false);
      if (!screenAcceptsFiles()) return;
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        try { st.module.handleFiles(files); } catch (err) { util.toast('处理拖入文件失败:' + (err && err.message || err), 'err'); }
      }
    });
  }

  /* ================= 快捷键 =================
   * Ctrl/Cmd+O 上传(转发当前屏 openPicker);Ctrl/Cmd+L 锁定;Esc 由各弹窗自行处理 */
  function initShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'o') {
        if (workspace.current && workspace.current.isLocked()) return; // 锁屏期间不弹文件选择
        var mod = st.module;
        if (mod && typeof mod.openPicker === 'function') { e.preventDefault(); mod.openPicker(); }
      } else if (k === 'l') {
        if (workspace.current && !workspace.current.isLocked()) { e.preventDefault(); lockNow(); }
      }
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    if (st.booted) return;
    st.booted = true;
    buildShell();
    initTheme();
    initDragDrop();
    initShortcuts();

    util.bus.on('workspace:locked', function () {
      if (workspace.current && E.ui.lock && typeof E.ui.lock.mount === 'function') E.ui.lock.mount();
      refreshTopbar();
    });
    util.bus.on('workspace:unlocked', function () {
      if (E.ui.lock && typeof E.ui.lock.unmount === 'function') E.ui.lock.unmount();
    });
    util.bus.on('theme:change', function (d) {
      setTheme(d && d.mode);
      // 同步回工作区设置(容错:可能未开工作区)
      var ws = workspace.current;
      if (ws && !ws.isLocked()) ws.settings.theme = st.theme;
    });

    window.addEventListener('hashchange', route);
    if (typeof workspace.startAutoLock === 'function') workspace.startAutoLock();
    // 存储受限提示:无法持久化本机副本时,提醒用户用导出 .ecw 的方式保存进度
    try {
      if (workspace.storageKind && workspace.storageKind() === 'memory') {
        util.toast('当前浏览器禁止本机存储:自动保存不可用,请用「映射表 → 导出加密工作区」保存进度', 'warn');
      }
    } catch (e) { /* 忽略 */ }
    route();
  }

  return {
    boot: boot,
    navigate: navigate,
    route: route,
    lockNow: lockNow,
    closeWorkspace: closeWorkspace,
    setTheme: setTheme,
    getTheme: function () { return st.theme; },
    screen: function () { return st.screen; }
  };
});
