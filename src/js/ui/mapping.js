/* Encipherer · ui/mapping — 映射表:统计 / 搜索 / 分页 / 导出(.ecw 与明文 CSV)
 * 明文 CSV 导出需再次输入主密码验证 + 红色危险确认。
 * UMD:浏览器挂 Encipherer.ui.mapping;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.mapping = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var crypto = E.crypto;
  var workspace = E.workspace;
  var fakery = E.fakery;
  var excel = E.excel;

  var PAGE_SIZE = 100;
  var st = {
    root: null,
    q: '',
    type: '',
    page: 0,
    els: {},
    total: 0
  };

  function ws() { return workspace.current; }
  function typeLabel(t) {
    var meta = fakery && fakery.TYPE_META && fakery.TYPE_META[t];
    return meta ? meta.label : t;
  }
  function typeColor(t) {
    var meta = fakery && fakery.TYPE_META && fakery.TYPE_META[t];
    return meta ? meta.color : '#546e7a';
  }
  function typeChip(t, count) {
    var dot = util.el('span', { class: 'dot' });
    dot.style.background = typeColor(t);
    var chip = util.el('span', { class: 'chip' }, [dot, util.el('span', {
      text: typeLabel(t) + (count != null ? ' × ' + count : '')
    })]);
    return chip;
  }

  function renderStats() {
    var box = st.els.statBox;
    box.textContent = '';
    var s = ws().stats();
    box.appendChild(util.el('div', { class: 'card ec-stat' }, [
      util.el('b', { text: String(s.entries) }),
      util.el('span', { text: '映射条目(不同原值)' })
    ]));
    box.appendChild(util.el('div', { class: 'card ec-stat' }, [
      util.el('b', { text: String(s.totalHits) }),
      util.el('span', { text: '累计替换次数' })
    ]));
    var typeStat = util.el('div', { class: 'card ec-stat' }, [
      util.el('b', { text: String(Object.keys(s.byType).length) }),
      util.el('span', { text: '涉及的隐私类型' })
    ]);
    var chips = util.el('div', { class: 'ec-stat-chips' });
    Object.keys(s.byType).forEach(function (t) { chips.appendChild(typeChip(t, s.byType[t])); });
    if (!Object.keys(s.byType).length) {
      chips.appendChild(util.el('span', { class: 'chip chip-plain', text: '暂无' }));
    }
    typeStat.appendChild(chips);
    box.appendChild(typeStat);
  }

  function renderPager() {
    var pages = Math.max(1, Math.ceil(st.total / PAGE_SIZE));
    if (st.page >= pages) st.page = pages - 1;
    st.els.pageInfo.textContent = st.total
      ? '第 ' + (st.page + 1) + ' / ' + pages + ' 页 · 共 ' + st.total + ' 条'
      : '共 0 条';
    st.els.prevBtn.disabled = st.page <= 0;
    st.els.nextBtn.disabled = st.page >= pages - 1;
  }

  function renderTable() {
    var w = ws();
    var tbody = st.els.tbody;
    tbody.textContent = '';
    var res = w.listMappings({
      type: st.type || undefined,
      q: st.q || undefined,
      offset: st.page * PAGE_SIZE,
      limit: PAGE_SIZE
    });
    st.total = res.total;
    if (!res.rows.length) {
      st.els.tableWrap.style.display = 'none';
      st.els.empty.style.display = '';
      renderPager();
      return;
    }
    st.els.tableWrap.style.display = '';
    st.els.empty.style.display = 'none';
    res.rows.forEach(function (r) {
      var badge = util.el('span', { class: 'badge' });
      badge.style.background = typeColor(r.type);
      badge.style.color = '#fff';
      badge.style.borderColor = 'transparent';
      badge.textContent = typeLabel(r.type);
      tbody.appendChild(util.el('tr', null, [
        util.el('td', null, [badge]),
        util.el('td', { title: r.original, text: r.original }),
        util.el('td', { title: r.placeholder, text: r.placeholder }),
        util.el('td', { class: 'ec-td-num', text: String(r.count) })
      ]));
    });
    renderPager();
  }

  function refresh() {
    renderStats();
    renderTable();
  }

  /* ================= 导出 ================= */
  async function exportEcw(btn) {
    var w = ws();
    btn.classList.add('is-loading');
    try {
      var blob = await w.exportFile();
      util.download(blob, w.suggestedFileName());
      util.toast('已导出加密工作区文件。妥善保管:泄露该文件 + 泄露密码 = 泄露全部映射', 'warn');
    } catch (e) {
      util.toast('导出失败:' + (e && e.message || e), 'err');
    } finally {
      btn.classList.remove('is-loading');
    }
  }

  /* 密码验证:与 workspace.changePassword 内部同款算法(deriveKeys + verifier 比对),
   * 不走 openFromBlob 以免产生重复的最近记录/替换 current。 */
  async function verifyPassword(pw) {
    var w = ws();
    var keys = await crypto.deriveKeys(pw, w.saltB64, w.iter);
    var v = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
    crypto.zeroize(keys);
    return v === w.verifier;
  }

  function promptPasswordVerify() {
    return new Promise(function (resolve) {
      var input = util.el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '再次输入工作区主密码' });
      var msg = util.el('div', { class: 'ec-form-err', text: '' });
      var cancel = util.el('button', { class: 'btn', type: 'button', text: '取消' });
      var okBtn = util.el('button', { class: 'btn btn-danger', type: 'button', text: '验证并继续' });
      var box = util.el('div', { class: 'ec-modal ec-modal-danger' }, [
        util.el('h3', { text: '⚠ 导出明文映射' }),
        util.el('div', { class: 'ec-modal-body', text: '即将把全部「原值 ↔ 占位符」对照导出为明文 CSV。请输入工作区主密码确认身份。' }),
        util.el('div', { class: 'ec-form-row' }, [input]),
        msg,
        util.el('div', { class: 'ec-modal-btns' }, [cancel, okBtn])
      ]);
      var overlay = util.el('div', { class: 'ec-modal-overlay' }, [box]);
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); input.focus(); });
      var done = false;
      function close(v) {
        if (done) return; done = true;
        overlay.classList.remove('show');
        setTimeout(function () { overlay.remove(); }, 200);
        resolve(v);
      }
      async function submit() {
        var pw = input.value;
        if (!pw) { msg.textContent = '请输入密码'; return; }
        okBtn.classList.add('is-loading');
        await util.nextFrame();
        try {
          var ok = await verifyPassword(pw);
          if (!ok) {
            okBtn.classList.remove('is-loading');
            msg.textContent = '密码错误';
            input.value = '';
            input.classList.remove('ec-shake'); void input.offsetWidth; input.classList.add('ec-shake');
            input.focus();
            return;
          }
          close(true);
        } catch (e) {
          okBtn.classList.remove('is-loading');
          msg.textContent = '验证失败:' + (e && e.message || e);
        }
      }
      cancel.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
    });
  }

  async function exportCsv() {
    var w = ws();
    var verified = await promptPasswordVerify();
    if (!verified) return;
    var ok = await util.confirmDialog({
      title: '最后确认:导出明文 CSV',
      body: '<strong style="color:var(--ec-danger)">明文 CSV 将包含全部原始隐私数据</strong>(每个原值与对应占位符的对照表)。<br>任何拿到该文件的人都能还原你已脱敏的全部数据。确定继续?',
      danger: true,
      confirmText: '我已知晓风险,导出'
    });
    if (!ok) return;
    try {
      var all = w.listMappings({ offset: 0, limit: 1e9 });
      var rows = [['类型', '原值', '占位符', '出现次数']];
      all.rows.forEach(function (r) {
        rows.push([typeLabel(r.type), r.original, r.placeholder, r.count]);
      });
      var blob = excel.exportCSVFromModel(rows);
      util.download(blob, w.name + '.映射表.csv');
      util.toast('明文映射 CSV 已导出,请存放在安全位置并尽快用完删除', 'warn');
    } catch (e) {
      util.toast('导出失败:' + (e && e.message || e), 'err');
    }
  }

  /* ================= 渲染 ================= */
  function mount(container) {
    var w = ws();
    if (!w || w.isLocked()) { E.ui.app.navigate('home'); return; }
    st.q = ''; st.type = ''; st.page = 0; st.total = 0;

    var searchInput = util.el('input', { class: 'input', type: 'search', placeholder: '搜索原值或占位符…' });
    var debouncedSearch = util.debounce(function () {
      st.q = searchInput.value.trim();
      st.page = 0;
      renderTable();
    }, 300);
    searchInput.addEventListener('input', debouncedSearch);

    var typeSel = util.el('select', { class: 'select' });
    typeSel.appendChild(util.el('option', { value: '', text: '全部类型' }));
    fakery.TYPES.forEach(function (t) {
      typeSel.appendChild(util.el('option', { value: t, text: typeLabel(t) }));
    });
    typeSel.addEventListener('change', function () {
      st.type = typeSel.value;
      st.page = 0;
      renderTable();
    });

    st.els.prevBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: '上一页' });
    st.els.nextBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: '下一页' });
    st.els.pageInfo = util.el('span', { text: '' });
    st.els.prevBtn.addEventListener('click', function () { if (st.page > 0) { st.page--; renderTable(); } });
    st.els.nextBtn.addEventListener('click', function () { st.page++; renderTable(); });

    st.els.tbody = util.el('tbody');
    st.els.tableWrap = util.el('div', { class: 'card', style: { padding: '0', overflow: 'auto' } }, [
      util.el('table', { class: 'table' }, [
        util.el('thead', null, [util.el('tr', null, [
          util.el('th', { text: '类型', style: { width: '90px' } }),
          util.el('th', { text: '原值' }),
          util.el('th', { text: '占位符' }),
          util.el('th', { text: '出现次数', style: { width: '90px', 'text-align': 'right' } })
        ])]),
        st.els.tbody
      ])
    ]);
    st.els.empty = util.el('div', { class: 'card' }, [
      util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '🗺' }),
        util.el('div', { text: '还没有任何映射——去工作台执行一次脱敏' }),
        util.el('div', { class: 'ec-empty-hint', text: '脱敏后,同一原值与占位符的对照关系会保存在这里(加密)' })
      ])
    ]);

    st.els.statBox = util.el('div', { class: 'ec-stat-cards' });

    var ecwBtn = util.el('button', { class: 'btn btn-primary', type: 'button', text: '🔐 导出加密工作区(.ecw)' });
    ecwBtn.addEventListener('click', function () { exportEcw(ecwBtn); });
    var csvBtn = util.el('button', { class: 'btn btn-danger btn-outline', type: 'button', text: '⚠ 导出明文映射 CSV' });
    csvBtn.addEventListener('click', exportCsv);

    st.root = util.el('div', { class: 'ec-scroll' });
    var page = util.el('div', { class: 'ec-page' });
    page.appendChild(util.el('h2', { text: '映射表', style: { 'margin-bottom': '14px' } }));
    page.appendChild(st.els.statBox);
    page.appendChild(util.el('section', { class: 'card' }, [
      util.el('div', { class: 'ec-map-toolbar' }, [searchInput, typeSel]),
      st.els.tableWrap,
      st.els.empty,
      util.el('div', { class: 'ec-pager' }, [st.els.pageInfo, st.els.prevBtn, st.els.nextBtn]),
      util.el('div', { class: 'ec-map-export' }, [
        ecwBtn, csvBtn,
        util.el('span', { class: 'chip chip-warn', text: '明文 CSV = 全部隐私数据,导出前请三思' })
      ])
    ]));
    st.root.appendChild(page);
    container.appendChild(st.root);
    refresh();
  }

  function unmount() {
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null; st.els = {};
  }

  return { mount: mount, unmount: unmount };
});
