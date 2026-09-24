/* Encipherer · ui/workbench — 工作台:文件上传 / 表格预览与选区 / 规则 / 执行脱敏 / 结果下载
 * 布局:左 260px 文件栏 / 中 sheet标签+工具条+grid / 右 300px 规则栏(小屏折叠为抽屉)。
 * 依赖:Encipherer.util / workspace / fakery / excel / grid(只读使用)。
 * UMD:浏览器挂 Encipherer.ui.workbench;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.workbench = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var workspace = E.workspace;
  var fakery = E.fakery;
  var excel = E.excel;
  var Grid = E.grid;

  var WINDOW_ROWS = 1000;      // grid 预览窗口(处理始终全量)
  var TINT_BUDGET = 1200;      // 即时高亮格数上限(可视窗口)
  var PREVIEW_BUDGET = 400;    // 预览格数上限(peek 为异步 HMAC)
  var SCAN_SAMPLE = 50;        // 自动扫描每列采样非空格数
  var SCAN_RATIO = 0.6;        // 命中率阈值

  var st = {
    root: null,
    wsId: null,
    files: [],            // [{wb, size, buf}] buf=原始 ArrayBuffer(重新执行时用)
    activeIdx: -1,
    activeSheet: 0,
    rules: [],            // Rule(ARCHITECTURE §1.3)
    results: {},          // {fileId: {blob, stats, doneAt}}
    headers: {},          // {fileId:sheetIdx -> 'auto' | 'none' | 0基行号} 表头行设置
    grid: null,
    gridHost: null,
    fileInput: null,
    els: {},
    previewOn: false,
    previewSeq: 0,
    suggestions: [],      // 自动扫描建议
    busy: false,
    unwatchScroll: null
  };

  /* ================= 表头行(支持多行) ================= */
  // st.headers[fid:sheetIdx] = 'auto' | [0基行号数组]([] = 无表头)
  // 兼容旧值:'none' → [],单个数字 → [n]
  function normHeaderMode(v) {
    if (v === 'auto' || v === undefined) return 'auto';
    if (v === 'none' || v === null) return [];
    if (typeof v === 'number') return [v];
    if (Array.isArray(v)) return v.slice().sort(function (a, b) { return a - b; });
    return 'auto';
  }
  // 当前文件+sheet 的表头行集合(0 基数组;空数组 = 无表头,所有行参与处理)
  function headerRowsOf(fid, sheetIdx) {
    var en = st.files.filter(function (e) { return e.wb.id === fid; })[0];
    var sheet = en && en.wb.sheets[sheetIdx];
    if (!sheet) return [];
    var mode = normHeaderMode(st.headers[fid + ':' + sheetIdx]);
    if (mode === 'auto') {
      var r = util.detectHeaderRow(sheet.rows).row;
      return r === null ? [] : [r];
    }
    return mode;
  }
  function activeHeaderRows() {
    var en = activeFile();
    return en ? headerRowsOf(en.wb.id, st.activeSheet) : [];
  }
  function activeHeaderSet() {
    var m = {};
    activeHeaderRows().forEach(function (r) { m[r] = 1; });
    return m;
  }
  // 表头集合 → 按钮文案:「自动(第1行)」「第1-2行」「第1、3行」「无」
  function headerRowsLabel(rows, isAuto) {
    if (!rows.length) return isAuto ? '表头:自动(未识别)' : '表头:无';
    var parts = [], run = null;
    for (var i = 0; i < rows.length; i++) {
      if (run !== null && rows[i] === run.to + 1) { run.to = rows[i]; continue; }
      if (run !== null) parts.push(run);
      run = { from: rows[i], to: rows[i] };
    }
    if (run !== null) parts.push(run);
    var s = parts.map(function (p) {
      return p.from === p.to ? '第' + (p.from + 1) + '行' : '第' + (p.from + 1) + '-' + (p.to + 1) + '行';
    }).join('、');
    return (isAuto ? '表头:自动·' : '表头:') + s;
  }
  // 表头选择按钮 + 复选弹层(文件/sheet 切换时刷新)
  function rebuildHeaderSel() {
    var btn = st.els.headerBtn;
    if (!btn) return;
    var en = activeFile();
    btn.style.display = en ? '' : 'none';
    if (!en) { closeHeaderPop(); return; }
    var key = en.wb.id + ':' + st.activeSheet;
    var stored = st.headers[key];
    var rows = headerRowsOf(en.wb.id, st.activeSheet);
    var isAuto = stored === undefined || stored === 'auto';
    btn.textContent = '🧭 ' + headerRowsLabel(rows, isAuto);
    btn.title = '表头行(勾选的行不参与脱敏,支持多行)';
    closeHeaderPop();
  }
  function closeHeaderPop() {
    if (st.els.headerPop) { st.els.headerPop.style.display = 'none'; }
  }
  function toggleHeaderPop() {
    var en = activeFile();
    if (!en) return;
    var pop = st.els.headerPop;
    if (!pop) return;
    if (pop.style.display === 'block') { pop.style.display = 'none'; return; }
    // 重建弹层内容
    pop.textContent = '';
    var key = en.wb.id + ':' + st.activeSheet;
    var sheet = en.wb.sheets[st.activeSheet] || { rows: [] };
    var stored = st.headers[key];
    var isAuto = stored === undefined || stored === 'auto';
    var checked = {};
    headerRowsOf(en.wb.id, st.activeSheet).forEach(function (r) { checked[r] = 1; });
    var dirty = false;
    var maxRow = Math.min(10, sheet.rows.length);
    pop.appendChild(util.el('div', { class: 'ec-pop-title', text: '勾选表头行(可多选,不参与脱敏)' }));
    for (var i = 0; i < maxRow; i++) {
      (function (ri) {
        var row = sheet.rows[ri] || [];
        var preview = [];
        for (var c = 0; c < row.length && preview.length < 3; c++) {
          var t = excel.cellText(row[c]);
          if (t && t.trim()) preview.push(t.trim().slice(0, 10));
        }
        var cb = util.el('input', { type: 'checkbox' });
        cb.checked = !!checked[ri];
        cb.addEventListener('change', function () {
          dirty = true;
          checked[ri] = cb.checked ? 1 : 0;
        });
        pop.appendChild(util.el('label', { class: 'ec-pop-row' }, [
          cb,
          util.el('span', { class: 'ec-pop-rowno', text: '第' + (ri + 1) + '行' }),
          util.el('span', { class: 'ec-pop-preview', text: preview.join('  ') || '(空行)' })
        ]));
      })(i);
    }
    var autoBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: '自动识别' });
    autoBtn.addEventListener('click', function () {
      st.headers[key] = 'auto';
      dirty = false;
      rebuildHeaderSel();
      refreshOverlays();
      refreshTip();
      pop.style.display = 'none';
      util.toast('已恢复自动识别表头', 'info');
    });
    var okBtn = util.el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '确定' });
    okBtn.addEventListener('click', function () {
      if (dirty) {
        var rows = [];
        for (var r = 0; r < maxRow; r++) if (checked[r]) rows.push(r);
        st.headers[key] = rows;
        util.toast(rows.length ? '已设表头:' + headerRowsLabel(rows, false) + ',这些行不参与脱敏' : '已设为无表头,所有行参与脱敏', 'info');
        rebuildHeaderSel();
        refreshOverlays();
        refreshTip();
      }
      pop.style.display = 'none';
    });
    pop.appendChild(util.el('div', { class: 'ec-pop-btns' }, [autoBtn, okBtn]));
    pop.style.display = 'block';
  }

  /* ================= 小工具 ================= */
  function ws() { return workspace.current; }
  function activeFile() { return st.activeIdx >= 0 ? st.files[st.activeIdx] : null; }
  function activeSheetModel() {
    var en = activeFile();
    return en ? (en.wb.sheets[st.activeSheet] || null) : null;
  }
  function rulesFor(fid, sheetIdx) {
    return st.rules.filter(function (r) {
      return r.fileIds.indexOf(fid) >= 0 && r.sheet === sheetIdx;
    });
  }
  function enabledRulesFor(fid) {
    return st.rules.filter(function (r) { return r.enabled && r.fileIds.indexOf(fid) >= 0; });
  }
  function typeLabel(t) {
    var meta = fakery.TYPE_META && fakery.TYPE_META[t];
    return meta ? meta.label : t;
  }
  function typeColor(t) {
    var meta = fakery.TYPE_META && fakery.TYPE_META[t];
    return meta ? meta.color : '#546e7a';
  }
  function typeChip(t, count) {
    var dot = util.el('span', { class: 'dot' });
    dot.style.background = typeColor(t);
    return util.el('span', { class: 'chip' }, [dot, util.el('span', {
      text: typeLabel(t) + (count != null ? ' × ' + count : '')
    })]);
  }
  function ruleDesc(r) {
    if (r.target.kind === 'col') return '整列 ' + util.colName(r.target.c);
    return util.a1(r.target.r1, r.target.c1) + ':' + util.a1(r.target.r2, r.target.c2);
  }
  function engineBadge(en) {
    var wb = en.wb;
    if (wb.engine === 'exceljs') return { text: 'xlsx · 保样式', cls: 'badge badge-primary' };
    if (wb.engine === 'sheetjs') return { text: wb.ext + ' · 将降级', cls: 'badge badge-warn' };
    return { text: 'CSV', cls: 'badge' };
  }
  function outMaskedName(wb) {
    return String(wb.name).replace(/\.[^.]+$/, '') + '.脱敏.' + wb.ext;
  }

  /* 可视窗口(与 grid 布局常量一致:行高26 表头26 列宽96 行号列48;只读查询,不改 grid) */
  function visibleRange() {
    if (!st.gridHost) return null;
    var body = st.gridHost.querySelector('.eg-body');
    if (!body) return null;
    var ROW_H = 26, HEAD_H = 26, COL_W = 96, ROWHEAD_W = 48;
    var r0 = Math.max(0, Math.floor((body.scrollTop - HEAD_H) / ROW_H) - 4);
    var r1 = Math.ceil((body.scrollTop + body.clientHeight - HEAD_H) / ROW_H) + 4;
    var c0 = Math.max(0, Math.floor((body.scrollLeft - ROWHEAD_W) / COL_W) - 3);
    var c1 = Math.ceil((body.scrollLeft + body.clientWidth - ROWHEAD_W) / COL_W) + 3;
    return { r0: r0, r1: r1, c0: c0, c1: c1 };
  }
  function watchGridScroll(fn) {
    if (!st.gridHost) return function () {};
    var body = st.gridHost.querySelector('.eg-body');
    if (!body) return function () {};
    var raf = 0;
    function handler() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; fn(); });
    }
    body.addEventListener('scroll', handler, { passive: true });
    return function () {
      body.removeEventListener('scroll', handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }

  /* 忙碌遮罩与进度 */
  function showBusy(text) {
    st.els.busyText.textContent = text || '处理中…';
    st.els.busy.style.display = 'flex';
  }
  function setBusyProgress(pct, text) {
    if (text) st.els.busyText.textContent = text;
    st.els.busyBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function hideBusy() {
    st.els.busy.style.display = 'none';
    st.els.busyBar.style.width = '0';
  }

  /* ================= 文件上传 ================= */
  async function addFiles(fileList) {
    if (st.busy) return;
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (/\.ecw$/i.test(file.name)) { util.toast('这是工作区文件(.ecw),请在首页打开', 'warn'); continue; }
      if (excel.SUPPORTED.indexOf((/\.([A-Za-z0-9]+)$/.exec(file.name) || [])[1] || '') < 0) {
        util.toast('不支持的文件类型:' + file.name + '(支持 ' + excel.SUPPORTED.join(' / ') + ')', 'err');
        continue;
      }
      st.busy = true;
      showBusy('正在解析:' + file.name);
      await util.nextFrame();
      try {
        var buf = await file.arrayBuffer();
        var wb = await excel.loadFile(buf.slice(0), file.name); // 传副本,原始 buf 留作重执行
        // 重名自动加 (2)
        var base = String(wb.name).replace(/\.[^.]+$/, '');
        var ext = wb.ext;
        var names = {};
        st.files.forEach(function (en) { names[en.wb.name] = 1; });
        if (names[wb.name]) {
          for (var n = 2; ; n++) {
            var cand = base + ' (' + n + ').' + ext;
            if (!names[cand]) { wb.name = cand; break; }
          }
        }
        st.files.push({ wb: wb, size: file.size, buf: buf });
        added++;
      } catch (e) {
        util.toast('解析失败:' + (e && e.message || e), 'err');
      } finally {
        st.busy = false;
        hideBusy();
      }
    }
    if (added) {
      if (st.activeIdx < 0) setActive(0);
      refreshFileList();
      util.bus.emit('files:changed', { count: st.files.length });
      util.toast('已上传 ' + added + ' 个文件', 'ok');
    }
  }

  async function removeFile(idx) {
    var en = st.files[idx];
    if (!en) return;
    var ok = await util.confirmDialog({
      title: '移除文件',
      body: '将移除「' + util.esc(en.wb.name) + '」及其全部脱敏规则与结果记录。确定?',
      confirmText: '移除'
    });
    if (!ok) return;
    var fid = en.wb.id;
    st.files.splice(idx, 1);
    delete st.results[fid];
    st.rules = st.rules.filter(function (r) { return r.fileIds.indexOf(fid) < 0; });
    if (st.activeIdx === idx) st.activeIdx = -1;
    else if (st.activeIdx > idx) st.activeIdx--;
    if (st.activeIdx < 0 && st.files.length) st.activeIdx = 0;
    setActive(st.activeIdx < 0 ? -1 : st.activeIdx, true);
    refreshFileList();
    util.bus.emit('files:changed', { count: st.files.length });
  }

  /* ================= 激活文件 / sheet ================= */
  function setActive(idx, force) {
    if (!force && idx === st.activeIdx) return;
    st.activeIdx = idx;
    st.activeSheet = 0;
    st.suggestions = [];
    refreshSheets();
    rebuildHeaderSel();
    loadGrid();
    refreshRulesPanel();
    refreshSuggestBar();
    refreshTip();
  }

  function refreshSheets() {
    var box = st.els.sheetTabs;
    box.textContent = '';
    var en = activeFile();
    if (!en) return;
    en.wb.sheets.forEach(function (sh, i) {
      var b = util.el('button', {
        class: 'ec-sheet-tab' + (i === st.activeSheet ? ' active' : ''),
        type: 'button',
        text: sh.name || ('Sheet' + (i + 1))
      });
      b.addEventListener('click', function () {
        if (st.activeSheet === i) return;
        st.activeSheet = i;
        st.suggestions = [];
        refreshSheets();
        rebuildHeaderSel();
        loadGrid();
        refreshRulesPanel();
        refreshSuggestBar();
      });
      box.appendChild(b);
    });
  }

  function loadGrid() {
    if (!st.grid) return;
    var sheet = activeSheetModel();
    st.grid.setData(sheet || null, { windowRows: WINDOW_ROWS });
    refreshOverlays();
  }

  /* ================= 规则 ================= */
  function addRule(rule) {
    st.rules.push(rule);
    refreshRulesPanel();
    refreshOverlays();
  }
  function makeRule(target, pii, note) {
    var en = activeFile();
    return {
      id: util.uid('rule'),
      fileIds: en ? [en.wb.id] : ['*'],
      sheet: st.activeSheet,
      target: target,
      pii: pii,
      enabled: true,
      note: note || ''
    };
  }

  function applySelection() {
    var en = activeFile();
    if (!en) { util.toast('请先上传表格文件', 'warn'); return; }
    var sels = st.grid ? st.grid.getSelections() : [];
    if (!sels.length) {
      util.toast('请先在表格中框选区域(可 Ctrl 累积多块选区,或点击列头选择整列)', 'warn');
      return;
    }
    var pii = st.els.piiSel.value;
    var rows = (activeSheetModel() || { rows: [] }).rows;
    var visRows = Math.min(rows.length, WINDOW_ROWS);
    var count = 0;
    sels.forEach(function (s) {
      // 整列(列头点击产生:r1=0 且选到窗口末行)
      if (s.r1 === 0 && visRows > 0 && s.r2 === visRows - 1) {
        for (var c = s.c1; c <= s.c2; c++) { addRule(makeRule({ kind: 'col', c: c }, pii)); count++; }
      } else {
        addRule(makeRule({ kind: 'range', r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 }, pii));
        count++;
      }
    });
    util.toast('已添加 ' + count + ' 条规则(' + (pii === 'auto' ? '自动检测' : typeLabel(pii)) + ')', 'ok');
  }

  function refreshRulesPanel() {
    var listEl = st.els.ruleList;
    listEl.textContent = '';
    var en = activeFile();
    var list = en ? rulesFor(en.wb.id, st.activeSheet) : [];
    st.els.ruleCount.textContent = en
      ? '共 ' + list.length + ' 条 / 全部 ' + st.rules.length + ' 条'
      : '共 0 条';

    if (!st.files.length) {
      listEl.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '📋' }),
        util.el('div', { text: '上传文件后,在这里管理脱敏规则' })
      ]));
      return;
    }
    if (!list.length) {
      listEl.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '🎯' }),
        util.el('div', { text: '当前工作表还没有规则' }),
        util.el('div', { class: 'ec-empty-hint', text: '框选区域 → 「对选中区域应用」,或点击「自动扫描」' })
      ]));
      return;
    }
    list.forEach(function (r) {
      var badge = util.el('span', { class: 'badge' });
      if (r.pii === 'auto') {
        badge.className = 'badge';
        badge.textContent = '自动检测';
        badge.style.background = 'var(--ec-primary-weak)';
        badge.style.color = 'var(--ec-primary)';
      } else {
        badge.style.background = typeColor(r.pii);
        badge.style.color = '#fff';
        badge.style.borderColor = 'transparent';
        badge.textContent = typeLabel(r.pii);
      }
      var chk = util.el('input', { type: 'checkbox' });
      chk.checked = r.enabled;
      var chkLabel = util.el('label', { class: 'ec-rule-check' }, [chk, util.el('span', { text: '启用' })]);
      var xBtn = util.el('button', { class: 'ec-rule-x', type: 'button', title: '删除规则', text: '✕' });

      var card = util.el('div', { class: 'ec-rule-card' + (r.enabled ? '' : ' off') });
      card.appendChild(util.el('div', { class: 'ec-rule-top' }, [
        util.el('span', { class: 'ec-rule-scope', text: ruleDesc(r) }),
        badge, chkLabel, xBtn
      ]));
      var note = util.el('input', { class: 'input ec-rule-note', type: 'text', placeholder: '备注(可选),如:手机号列', value: r.note || '' });
      note.addEventListener('change', function () { r.note = note.value; });
      card.appendChild(note);

      chk.addEventListener('change', function () {
        r.enabled = chk.checked;
        card.classList.toggle('off', !r.enabled);
        refreshOverlays();
      });
      xBtn.addEventListener('click', function () {
        st.rules = st.rules.filter(function (x) { return x.id !== r.id; });
        refreshRulesPanel();
        refreshOverlays();
      });
      listEl.appendChild(card);
    });
  }

  async function clearAllRules() {
    var en = activeFile();
    if (!en) return;
    if (!st.rules.some(function (r) { return r.fileIds.indexOf(en.wb.id) >= 0; })) return;
    var ok = await util.confirmDialog({
      title: '全部清除',
      body: '将删除该文件(所有工作表)的全部脱敏规则。确定?',
      confirmText: '清除'
    });
    if (!ok) return;
    st.rules = st.rules.filter(function (r) { return r.fileIds.indexOf(en.wb.id) < 0; });
    refreshRulesPanel();
    refreshOverlays();
    util.toast('规则已清空', 'info');
  }

  /* ================= 自动扫描 ================= */
  function scanSheet() {
    var sheet = activeSheetModel();
    if (!sheet) { util.toast('请先上传表格文件', 'warn'); return; }
    showBusy('正在扫描:' + (sheet.name || '') + ' …');
    st.busy = true;
    setTimeout(function () {
      try {
        var sug = doScan(sheet);
        st.suggestions = sug;
        refreshSuggestBar();
        if (!sug.length) util.toast('未发现明显敏感列,可手动框选后应用规则', 'info');
        else util.toast('发现 ' + sug.length + ' 条列建议,点击「应用」生成规则', 'ok');
      } catch (e) {
        util.toast('扫描失败:' + (e && e.message || e), 'err');
      } finally {
        st.busy = false;
        hideBusy();
      }
    }, 60); // 让 busy 先渲染
  }

  function doScan(sheet) {
    var out = [];
    var rows = sheet.rows;
    var en = activeFile();
    var hrArr = en ? headerRowsOf(en.wb.id, st.activeSheet) : [];
    var hrSet = {};
    hrArr.forEach(function (r) { hrSet[r] = 1; });
    for (var c = 0; c < sheet.maxCols; c++) {
      // ① 表头关键词命中 → 直接给类型建议(显示"表头"徽标)
      var headerText = '';
      for (var hi = 0; hi < hrArr.length && !headerText; hi++) {
        headerText = excel.cellText((rows[hrArr[hi]] || [])[c]);
      }
      var headerType = headerText ? fakery.typeFromHeader(headerText) : null;
      var sampled = 0, strong = {}, weak = { name: 0, address: 0, studentid: 0 };
      for (var r = 0; r < rows.length; r++) {
        if (hrSet[r]) continue; // 表头行不计入采样
        var row = rows[r] || [];
        var text = excel.cellText(row[c]);
        if (!text || !text.trim()) continue;
        sampled++;
        var det = fakery.detect(text);
        if (det) strong[det.type] = (strong[det.type] || 0) + 1;
        var sugs = fakery.suggest(text);
        for (var i = 0; i < sugs.length; i++) {
          if (sugs[i].type === 'name' || sugs[i].type === 'address' || sugs[i].type === 'studentid') weak[sugs[i].type]++;
        }
        if (sampled >= SCAN_SAMPLE) break;
      }
      if (!sampled && !headerType) continue;
      // 强检测列(采样占比达标)
      var bestT = null, bestN = 0;
      Object.keys(strong).forEach(function (t) { if (strong[t] > bestN) { bestN = strong[t]; bestT = t; } });
      if (bestT && bestN / sampled >= SCAN_RATIO) {
        out.push({ c: c, type: bestT, hit: bestN, total: sampled, weak: false });
        continue;
      }
      // 表头关键词列(值不一定可检测,如姓名/学号列)
      if (headerType) {
        out.push({ c: c, type: headerType, hit: bestN, total: sampled || 1, weak: true, fromHeader: true, headerText: headerText });
        continue;
      }
      // 弱建议列(name/address/studentid)
      if (weak.studentid / sampled >= SCAN_RATIO) out.push({ c: c, type: 'studentid', hit: weak.studentid, total: sampled, weak: true });
      else if (weak.name / sampled >= SCAN_RATIO) out.push({ c: c, type: 'name', hit: weak.name, total: sampled, weak: true });
      else if (weak.address / sampled >= SCAN_RATIO) out.push({ c: c, type: 'address', hit: weak.address, total: sampled, weak: true });
    }
    return out;
  }

  function refreshSuggestBar() {
    var bar = st.els.suggestBar;
    bar.textContent = '';
    if (!st.suggestions.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    st.suggestions.forEach(function (s) {
      var applyBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: s.applied ? '已应用' : '应用' });
      if (s.applied) applyBtn.disabled = true;
      else applyBtn.addEventListener('click', function () {
        addRule(makeRule({ kind: 'col', c: s.c }, s.type));
        s.applied = true;
        applyBtn.disabled = true;
        applyBtn.textContent = '已应用';
        util.toast('已为 ' + util.colName(s.c) + ' 列添加「' + typeLabel(s.type) + '」规则', 'ok');
      });
      var item = util.el('span', { class: 'ec-sug-item' }, [
        util.el('b', { text: util.colName(s.c) + ' 列' }),
        util.el('span', { text: '·' }),
        typeChip(s.type),
        s.fromHeader
          ? util.el('span', { class: 'badge', text: '表头「' + (s.headerText || '') + '」' })
          : (s.weak ? util.el('span', { class: 'badge badge-warn', text: '建议' }) : null),
        s.fromHeader
          ? util.el('span', { class: 'ec-file-meta', text: s.hit ? '值命中 ' + s.hit + '/' + s.total : '按表头' })
          : util.el('span', { class: 'ec-file-meta', text: s.hit + '/' + s.total }),
        applyBtn
      ]);
      bar.appendChild(item);
    });
  }

  /* ================= 覆盖层:列徽标 / 命中高亮 / 预览 ================= */
  function firstHitRule(rules, r, c) {
    for (var i = 0; i < rules.length; i++) {
      var t = rules[i].target;
      if (t.kind === 'col') { if (c === t.c) return rules[i]; }
      else if (r >= t.r1 && r <= t.r2 && c >= t.c1 && c <= t.c2) return rules[i];
    }
    return null;
  }

  function refreshOverlays() {
    var en = activeFile();
    if (!en || !st.grid) return;
    var sheet = activeSheetModel();
    if (!sheet) return;
    st.previewSeq++; // 使进行中的异步预览作废

    // 列头徽标
    var marks = {};
    rulesFor(en.wb.id, st.activeSheet).forEach(function (r) {
      if (!r.enabled || r.target.kind !== 'col') return;
      marks[r.target.c] = r.pii === 'auto'
        ? { type: 'generic', label: '自动', color: '#546e7a' }
        : { type: r.pii, label: typeLabel(r.pii), color: typeColor(r.pii) };
    });
    st.grid.setColMarks(marks);

    // 可视窗口内命中格淡色高亮(auto 类型带置信度;表头行不参与)
    var rng = visibleRange();
    if (!rng) return;
    var rules = rulesFor(en.wb.id, st.activeSheet).filter(function (r) { return r.enabled; });
    var tints = {};
    if (rules.length) {
      var rows = sheet.rows;
      var hrSet = activeHeaderSet();
      var n = 0;
      outer:
      for (var r = Math.max(0, rng.r0); r <= rng.r1 && r < rows.length; r++) {
        if (hrSet[r]) continue; // 表头行不参与
        var row = rows[r] || [];
        for (var c = Math.max(0, rng.c0); c <= rng.c1 && c < sheet.maxCols; c++) {
          var rule = firstHitRule(rules, r, c);
          if (!rule) continue;
          var text = excel.cellText(row[c]);
          if (!text || !text.trim()) continue;
          if (rule.pii === 'auto') {
            var det = fakery.detect(text);
            if (det) tints[r + ':' + c] = { type: det.type, confidence: det.confidence };
          } else {
            tints[r + ':' + c] = { type: rule.pii, confidence: 1 };
          }
          if (++n >= TINT_BUDGET) break outer;
        }
      }
    }
    st.grid.setCellTints(tints);

    if (st.previewOn) refreshPreview();
    else st.grid.setPreview({});
  }

  async function refreshPreview() {
    var w = ws();
    var en = activeFile();
    var sheet = activeSheetModel();
    if (!w || w.isLocked() || !en || !sheet || !st.grid) return;
    var seq = ++st.previewSeq;
    var rules = rulesFor(en.wb.id, st.activeSheet).filter(function (r) { return r.enabled; });
    var prev = {};
    if (!rules.length) { st.grid.setPreview(prev); return; }
    var rng = visibleRange() || { r0: 0, r1: 40, c0: 0, c1: 20 };
    var rows = sheet.rows;
    var hrSet = activeHeaderSet();
    var n = 0;
    try {
      outer:
      for (var r = Math.max(0, rng.r0); r <= rng.r1 && r < rows.length; r++) {
        if (hrSet[r]) continue; // 表头行不参与
        var row = rows[r] || [];
        for (var c = Math.max(0, rng.c0); c <= rng.c1 && c < sheet.maxCols; c++) {
          var rule = firstHitRule(rules, r, c);
          if (!rule) continue;
          var text = excel.cellText(row[c]);
          if (!text || !text.trim()) continue;
          var type = rule.pii === 'auto' ? ((fakery.detect(text) || {}).type) : rule.pii;
          if (!type) continue;
          var res = await w.peek(type, text); // 无副作用,不写入映射
          if (seq !== st.previewSeq) return; // 已切换/已关闭
          if (res && res.placeholder) prev[r + ':' + c] = res.placeholder;
          if (++n >= PREVIEW_BUDGET) break outer;
          if (n % 60 === 0) await util.nextFrame();
        }
      }
      if (seq !== st.previewSeq) return;
      st.grid.setPreview(prev);
    } catch (e) {
      if (seq === st.previewSeq) {
        util.toast('预览失败:' + (e && e.message || e), 'err');
        st.previewOn = false;
        st.els.previewBtn.classList.remove('active');
        st.grid.setPreview({});
        refreshTip();
      }
    }
  }

  /* ================= 底部提示 ================= */
  function refreshTip() {
    var tip = st.els.tip;
    tip.textContent = '';
    var en = activeFile();
    if (en && en.wb.lossy) {
      tip.appendChild(util.el('span', { class: 'chip chip-warn', text: '⚠ ' + en.wb.ext.toUpperCase() + ' 导出将降级:样式/宏可能丢失' }));
    }
    if (st.previewOn) {
      tip.appendChild(util.el('span', { text: '👁 预览模式:红点格悬浮可查看替换后文本;预览不写入映射表。' }));
    } else if (en) {
      tip.appendChild(util.el('span', { text: '提示:点击列头选整列;Ctrl+拖选累积多块;Shift+点击扩展选区。' }));
    }
  }

  /* ================= 文件列表 ================= */
  function refreshFileList() {
    var list = st.els.fileList;
    list.textContent = '';
    if (!st.files.length) {
      list.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '📄' }),
        util.el('div', { text: '上传或拖入 .xlsx / .xlsm / .xls / .csv' }),
        util.el('div', { class: 'ec-empty-hint', text: '支持多选;文件只在内存中处理,不上传任何地方' })
      ]));
      return;
    }
    st.files.forEach(function (en, idx) {
      var eng = engineBadge(en);
      var card = util.el('div', { class: 'ec-file-card' + (idx === st.activeIdx ? ' active' : '') });
      card.appendChild(util.el('div', { class: 'ec-file-name', title: en.wb.name, text: en.wb.name }));
      var meta = util.el('div', { class: 'ec-file-meta' }, [
        util.el('span', { text: util.fmtBytes(en.size) }),
        util.el('span', { class: eng.cls, text: eng.text }),
        util.el('span', { text: (en.wb.sheets.length || 1) + ' 个工作表' })
      ]);
      if (st.results[en.wb.id]) {
        meta.appendChild(util.el('span', { class: 'badge badge-ok', text: '已脱敏 ✓' }));
      }
      card.appendChild(meta);
      var x = util.el('button', { class: 'ec-file-x', type: 'button', title: '移除文件', text: '✕' });
      x.addEventListener('click', function (e) { e.stopPropagation(); removeFile(idx); });
      card.appendChild(x);
      card.addEventListener('click', function () { setActive(idx); });
      list.appendChild(card);
    });
  }

  /* ================= 执行脱敏 ================= */
  function estimateRuleCells(wb, rule) {
    var sheet = wb.sheets[rule.sheet];
    if (!sheet) return 0;
    var t = rule.target;
    if (t.kind === 'col') return sheet.rows.length;
    var r2 = Math.min(t.r2, sheet.rows.length - 1);
    return r2 < t.r1 ? 0 : (r2 - t.r1 + 1) * (t.c2 - t.c1 + 1);
  }

  async function execute() {
    var w = ws();
    if (!w || w.isLocked()) { util.toast('工作区已锁定,请先解锁', 'warn'); E.ui.app.navigate('home'); return; }
    if (!st.files.length) { util.toast('请先上传表格文件', 'warn'); return; }
    var targets = st.files.filter(function (en) {
      return enabledRulesFor(en.wb.id).length > 0;
    });
    if (!targets.length) { util.toast('请先添加至少一条启用的脱敏规则', 'warn'); return; }

    var ruleCount = 0;
    targets.forEach(function (en) { ruleCount += enabledRulesFor(en.wb.id).length; });
    var hasExisting = targets.some(function (en) { return st.results[en.wb.id]; });
    var ok = await util.confirmDialog({
      title: '执行脱敏',
      body: '将处理 <strong>' + targets.length + '</strong> 个文件、<strong>' + ruleCount + '</strong> 条启用规则,命中的敏感值将替换为格式保真的占位符。' +
        (hasExisting ? '<br><br>部分文件已有脱敏结果,重新执行将<strong>基于原始上传内容</strong>重新生成(结果会覆盖)。' : ''),
      confirmText: '开始执行'
    });
    if (!ok) return;

    // 已有结果的文件:从原始 ArrayBuffer 重新解析,保证“基于原始上传内容”
    st.busy = true;
    showBusy('准备中…');
    await util.nextFrame();
    try {
      for (var i = 0; i < targets.length; i++) {
        var en = targets[i];
        if (!st.results[en.wb.id]) continue;
        try {
          var fresh = await excel.loadFile(en.buf.slice(0), en.wb.name);
          fresh.id = en.wb.id; // 保留 id,规则/结果按 id 关联
          en.wb = fresh;
        } catch (e) {
          util.toast('重新读取「' + en.wb.name + '」失败,已跳过:' + (e && e.message || e), 'err');
        }
      }

      var totalCells = 0;
      targets.forEach(function (en) {
        enabledRulesFor(en.wb.id).forEach(function (r) { totalCells += estimateRuleCells(en.wb, r); });
      });
      var processed = 0;
      var summary = { files: 0, masked: 0, newMap: 0, skipped: 0 };

      for (var f = 0; f < targets.length; f++) {
        var entry = targets[f];
        var wb = entry.wb;
        var stats = { masked: 0, byType: {}, newMap: 0, skipped: 0 };
        var patches = [];
        var seen = {};
        var rules = enabledRulesFor(wb.id);

        for (var ri = 0; ri < rules.length; ri++) {
          var rule = rules[ri];
          var sheet = wb.sheets[rule.sheet];
          if (!sheet) continue;
          var rows = sheet.rows;
          var t = rule.target;
          var hrList = headerRowsOf(wb.id, rule.sheet); // 表头行(可多行)不参与脱敏
          var hrSet = {};
          hrList.forEach(function (x) { hrSet[x] = 1; });
          var firstData = hrList.length ? hrList[hrList.length - 1] + 1 : 0;
          var r1, r2, c1, c2;
          if (t.kind === 'col') { r1 = firstData; r2 = rows.length - 1; c1 = t.c; c2 = t.c; }
          else { r1 = t.r1; r2 = Math.min(t.r2, rows.length - 1); c1 = t.c1; c2 = Math.min(t.c2, sheet.maxCols - 1); }
          var lastC2 = c2; // 列上界(超界自动夹紧)
          if (lastC2 < c1) continue;

          for (var r = r1; r <= r2; r++) {
            if (hrSet[r]) continue; // 表头行(范围规则跨到表头行时跳过)
            var row = rows[r] || [];
            for (var c = c1; c <= lastC2; c++) {
              processed++;
              var key = rule.sheet + ':' + r + ':' + c;
              if (seen[key]) continue;
              var text = excel.cellText(row[c]);
              if (!text || !text.trim()) continue; // 空白跳过
              var type = rule.pii === 'auto' ? ((fakery.detect(text) || {}).type) : rule.pii;
              if (!type) { stats.skipped++; continue; } // auto 未命中强检测
              var res = await w.mask(type, text);
              if (res && res.skipped) continue;
              seen[key] = 1;
              patches.push({ sheet: rule.sheet, r: r, c: c, text: res.placeholder });
              stats.masked++;
              stats.byType[type] = (stats.byType[type] || 0) + 1;
              if (res.isNew) stats.newMap++;
              if (processed % 200 === 0) {
                setBusyProgress(totalCells ? Math.min(90, processed / totalCells * 90) : 80,
                  '正在处理「' + wb.name + '」… ' + processed + ' / ' + totalCells + ' 格');
                await util.nextFrame();
              }
            }
          }
        }

        setBusyProgress(90 + 10 * (f + 1) / targets.length, '正在导出「' + wb.name + '」…');
        await util.nextFrame();
        var blob = await excel.patchAndExport(wb, patches);
        st.results[wb.id] = { blob: blob, stats: stats, doneAt: Date.now() };
        summary.files++;
        summary.masked += stats.masked;
        summary.newMap += stats.newMap;
        summary.skipped += stats.skipped;
      }

      hideBusy();
      refreshFileList();
      loadGrid(); // 模型已被补丁更新,刷新预览
      // 映射有更新 → 静默保存本地副本(失败仅提醒)
      w.saveLocal().then(null, function () {
        util.toast('映射已更新,但本机自动保存失败;建议在「映射表」页导出 .ecw', 'warn');
      });
      showResultModal(summary);
    } catch (e) {
      util.toast('执行失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
      hideBusy();
    }
  }

  /* ================= 结果弹窗 ================= */
  function showResultModal(summary) {
    var overlay = util.el('div', { class: 'ec-modal-overlay' });
    var box = util.el('div', { class: 'ec-modal ec-modal-wide' });
    box.appendChild(util.el('h3', { text: '✅ 脱敏完成' }));
    box.appendChild(util.el('div', { class: 'ec-modal-body' }, [
      util.el('div', null, ['共处理 ' + summary.files + ' 个文件;替换 ' + summary.masked + ' 格,新增映射 ' + summary.newMap + ' 条,自动检测未命中跳过 ' + summary.skipped + ' 格。'])
    ]));

    var fids = st.files.map(function (en) { return en.wb.id; });
    fids.forEach(function (fid) {
      var res = st.results[fid];
      if (!res) return;
      var en = st.files.filter(function (x) { return x.wb.id === fid; })[0];
      var wb = en.wb;
      var card = util.el('div', { class: 'ec-result-card', style: { 'margin-bottom': '10px' } });
      var head = util.el('div', { class: 'ec-result-head' }, [
        util.el('span', { class: 'ec-result-name', title: wb.name, text: outMaskedName(wb) }),
        wb.lossy ? util.el('span', { class: 'chip chip-warn', text: '将降级:样式/宏可能丢失' }) : null
      ]);
      card.appendChild(head);
      var chips = util.el('div', { class: 'ec-result-chips' });
      var types = Object.keys(res.stats.byType);
      if (types.length) {
        types.forEach(function (t) { chips.appendChild(typeChip(t, res.stats.byType[t])); });
      } else {
        chips.appendChild(util.el('span', { class: 'chip chip-plain', text: '没有命中任何敏感格' }));
      }
      card.appendChild(chips);
      card.appendChild(util.el('div', { class: 'ec-result-meta', text: '新增映射 ' + res.stats.newMap + ' 条 · 跳过 ' + res.stats.skipped + ' 格 · 完成于 ' + util.fmtTime(res.doneAt) }));
      var dl = util.el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '⬇ 下载脱敏文件' });
      dl.addEventListener('click', function () {
        util.download(res.blob, outMaskedName(wb));
      });
      card.appendChild(dl);
      box.appendChild(card);
    });

    var closeBtn = util.el('button', { class: 'btn', type: 'button', text: '关闭' });
    closeBtn.addEventListener('click', close);
    var btns = [closeBtn];
    if (summary.files > 1) {
      var zipBtn = util.el('button', { class: 'btn btn-primary', type: 'button', text: '📦 打包下载全部' });
      zipBtn.addEventListener('click', async function () {
        zipBtn.classList.add('is-loading');
        try {
          var used = {};
          var entries = [];
          for (var i = 0; i < fids.length; i++) {
            var res2 = st.results[fids[i]];
            if (!res2) continue;
            var en2 = st.files.filter(function (x) { return x.wb.id === fids[i]; })[0];
            var name = outMaskedName(en2.wb);
            if (used[name]) {
              var m = /^(.*?)(\.[^.]+)$/.exec(name);
              for (var n = 2; ; n++) {
                var cand = m[1] + ' (' + n + ')' + m[2];
                if (!used[cand]) { name = cand; break; }
              }
            }
            used[name] = 1;
            entries.push({ name: name, data: new Uint8Array(await res2.blob.arrayBuffer()) });
          }
          var zip = util.zipStore(entries);
          util.download(new Blob([zip], { type: 'application/zip' }), '脱敏结果.zip');
        } catch (e) {
          util.toast('打包失败:' + (e && e.message || e), 'err');
        } finally {
          zipBtn.classList.remove('is-loading');
        }
      });
      btns.unshift(zipBtn);
    }
    box.appendChild(util.el('div', { class: 'ec-modal-btns' }, btns));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
    function close() {
      overlay.classList.remove('show');
      setTimeout(function () { overlay.remove(); }, 200);
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  /* ================= 挂载 ================= */
  function mount(container) {
    var w = ws();
    if (!w || w.isLocked()) { E.ui.app.navigate('home'); return; }
    // 切换到另一个工作区时,清空上一工作区遗留的文件/规则/结果
    if (st.wsId !== w.id) {
      st.wsId = w.id;
      st.files = []; st.rules = []; st.results = {};
      st.activeIdx = -1; st.activeSheet = 0; st.suggestions = [];
    }

    st.root = util.el('div', { class: 'ec-wb' });

    /* ---- 左:文件栏 ---- */
    st.fileInput = util.el('input', {
      type: 'file', multiple: 'multiple',
      accept: '.' + excel.SUPPORTED.join(',.'),
      style: { display: 'none' }
    });
    st.fileInput.addEventListener('change', function () {
      if (st.fileInput.files && st.fileInput.files.length) addFiles(st.fileInput.files);
      st.fileInput.value = '';
    });
    var uploadBtn = util.el('button', { class: 'btn btn-primary btn-block', type: 'button', text: '⬆ 上传表格' });
    uploadBtn.addEventListener('click', function () { st.fileInput.click(); });
    st.els.fileList = util.el('div', { class: 'ec-file-list' });

    var left = util.el('aside', { class: 'ec-wb-left' }, [
      util.el('div', { class: 'ec-wb-left-head' }, [
        uploadBtn,
        util.el('div', { class: 'ec-drop-hint', text: '或把文件拖到窗口任意位置 · 可多选' }),
        st.fileInput
      ]),
      st.els.fileList
    ]);

    /* ---- 中:预览区 ---- */
    st.els.sheetTabs = util.el('div', { class: 'ec-sheet-tabs' });

    st.els.piiSel = util.el('select', { class: 'select', title: '规则类型' });
    st.els.piiSel.appendChild(util.el('option', { value: 'auto', text: '自动检测(命中才替换)' }));
    fakery.TYPES.forEach(function (t) {
      st.els.piiSel.appendChild(util.el('option', { value: t, text: typeLabel(t) }));
    });

    var applyBtn = util.el('button', { class: 'btn', type: 'button', text: '对选中区域应用' });
    applyBtn.addEventListener('click', applySelection);
    var scanBtn = util.el('button', { class: 'btn', type: 'button', text: '自动扫描' });
    scanBtn.addEventListener('click', scanSheet);
    st.els.previewBtn = util.el('button', { class: 'btn ec-toggle-btn', type: 'button', text: '👁 预览效果' });
    st.els.previewBtn.addEventListener('click', function () {
      st.previewOn = !st.previewOn;
      st.els.previewBtn.classList.toggle('active', st.previewOn);
      refreshTip();
      if (st.previewOn) refreshPreview();
      else if (st.grid) st.grid.setPreview({});
    });
    var clearSelBtn = util.el('button', { class: 'btn', type: 'button', text: '清除选择' });
    clearSelBtn.addEventListener('click', function () { if (st.grid) st.grid.clearSelection(); });
    // 表头行选择:按钮 + 复选弹层(支持多行;勾选行不参与脱敏)
    st.els.headerBtn = util.el('button', { class: 'btn', type: 'button', text: '🧭 表头:自动' });
    st.els.headerBtn.addEventListener('click', toggleHeaderPop);
    st.els.headerPop = util.el('div', { class: 'ec-pop ec-pop-header', style: { display: 'none' } });
    document.addEventListener('click', function (e) {
      if (st.els.headerPop && st.els.headerPop.style.display === 'block' &&
        !st.els.headerPop.contains(e.target) && e.target !== st.els.headerBtn) {
        closeHeaderPop();
      }
    });
    rebuildHeaderSel();
    var drawerBtn = util.el('button', { class: 'btn ec-wb-drawer-toggle', type: 'button', text: '📋 规则' });
    var drawerMask = util.el('div', { class: 'ec-drawer-mask' });
    function closeDrawer() {
      st.els.right.classList.remove('open');
      drawerMask.classList.remove('show');
    }
    drawerBtn.addEventListener('click', function () {
      var open = st.els.right.classList.toggle('open');
      drawerMask.classList.toggle('show', open);
    });
    drawerMask.addEventListener('click', closeDrawer);

    st.els.suggestBar = util.el('div', { class: 'ec-suggest-bar', style: { display: 'none' } });
    st.gridHost = util.el('div', { class: 'ec-grid-host' });
    st.els.tip = util.el('div', { class: 'ec-wb-tip' });

    var mid = util.el('section', { class: 'ec-wb-mid' }, [
      st.els.sheetTabs,
      util.el('div', { class: 'ec-toolbar' }, [
        st.els.headerBtn, st.els.headerPop, st.els.piiSel, applyBtn, scanBtn, st.els.previewBtn, clearSelBtn,
        util.el('span', { class: 'ec-toolbar-gap' }), drawerBtn
      ]),
      st.els.suggestBar,
      st.gridHost,
      st.els.tip
    ]);

    /* ---- 右:规则栏 ---- */
    st.els.ruleCount = util.el('span', { class: 'ec-file-meta', text: '共 0 条' });
    st.els.ruleList = util.el('div', { class: 'ec-rule-list' });
    var clearBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: '全部清除' });
    clearBtn.addEventListener('click', clearAllRules);
    var execBtn = util.el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', text: '▶ 执行脱敏' });
    execBtn.addEventListener('click', execute);
    st.els.right = util.el('aside', { class: 'ec-wb-right' }, [
      util.el('div', { class: 'ec-wb-right-head' }, [
        util.el('b', { text: '脱敏规则' }), st.els.ruleCount
      ]),
      st.els.ruleList,
      util.el('div', { class: 'ec-rule-foot' }, [clearBtn, execBtn])
    ]);

    /* ---- 忙碌遮罩 ---- */
    st.els.busyText = util.el('div', { class: 'ec-busy-text', text: '处理中…' });
    st.els.busyBar = util.el('i');
    st.els.busy = util.el('div', { class: 'ec-busy', style: { display: 'none' } }, [
      util.el('div', { class: 'ec-spin' }), st.els.busyText,
      util.el('div', { class: 'progress', style: { width: '240px' } }, [st.els.busyBar])
    ]);

    st.root.appendChild(left);
    st.root.appendChild(mid);
    st.root.appendChild(st.els.right);
    st.root.appendChild(drawerMask);
    st.root.appendChild(st.els.busy);
    container.appendChild(st.root);

    /* ---- Grid(一次) ---- */
    st.grid = new Grid(st.gridHost, {
      onSelectionChange: function () { /* 状态条由 grid 自维护 */ },
      onColumnHeaderClick: function () { /* grid 已自行选中整列 */ },
      maxPreviewRows: 2000
    });
    st.unwatchScroll = watchGridScroll(function () { refreshOverlays(); });

    refreshFileList();
    if (st.activeIdx < 0 && st.files.length) st.activeIdx = 0;
    if (st.activeIdx >= 0) setActive(st.activeIdx, true);
    else { refreshSheets(); refreshRulesPanel(); }
    refreshTip();
  }

  function unmount() {
    if (st.unwatchScroll) { st.unwatchScroll(); st.unwatchScroll = null; }
    if (st.grid) { try { st.grid.destroy(); } catch (e) { /* 忽略 */ } st.grid = null; }
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null; st.gridHost = null; st.fileInput = null; st.els = {};
    st.previewOn = false; st.previewSeq++;
  }

  /* 全局拖放回调(app.js 转发)与 Ctrl+O */
  function handleFiles(files) { addFiles(files); }
  function openPicker() { if (st.fileInput) st.fileInput.click(); }

  return { mount: mount, unmount: unmount, handleFiles: handleFiles, openPicker: openPicker };
});
