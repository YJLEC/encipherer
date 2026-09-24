/* Encipherer · ui/restore — 还原:① 智能扫描(推荐,全表逐格 unmask)② 按选区还原
 * 左:文件栏(独立列表);中:模式标签 + 内容;右:说明(智能)/ 规则(选区)。
 * 依赖:Encipherer.util / workspace / excel / grid(只读使用)。
 * UMD:浏览器挂 Encipherer.ui.restore;Node 分支导出空对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = {}; return; }
  root.Encipherer = root.Encipherer || {};
  root.Encipherer.ui = root.Encipherer.ui || {};
  root.Encipherer.ui.restore = factory(root.Encipherer);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  var util = E.util;
  var workspace = E.workspace;
  var excel = E.excel;
  var Grid = E.grid;

  var WINDOW_ROWS = 1000;
  // generic prefix 样式占位符:T-XXXXX(与 fakery B32 字符集一致,去 I/L/O/0/1)
  var RE_TPLACEHOLDER = /^T-[A-HJ-KM-NP-Z2-9]{5}$/;

  var st = {
    root: null,
    wsId: null,
    mode: 'smart',          // 'smart' | 'select'
    files: [],              // [{wb, size, buf}]
    activeIdx: -1,
    activeSheet: 0,
    rules: [],              // 还原规则(pii 固定 'any':target 内全部尝试 unmask)
    results: {},            // {fileId: {blob, stats, doneAt}}
    grid: null,
    gridHost: null,
    fileInput: null,
    els: {},
    busy: false,
    unwatchScroll: null
  };

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
    var meta = E.fakery && E.fakery.TYPE_META && E.fakery.TYPE_META[t];
    return meta ? meta.label : t;
  }
  function typeColor(t) {
    var meta = E.fakery && E.fakery.TYPE_META && E.fakery.TYPE_META[t];
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
  function outRestoredName(wb) {
    return String(wb.name).replace(/\.[^.]+$/, '') + '.还原.' + wb.ext;
  }
  function engineBadge(en) {
    var wb = en.wb;
    if (wb.engine === 'exceljs') return { text: 'xlsx · 保样式', cls: 'badge badge-primary' };
    if (wb.engine === 'sheetjs') return { text: wb.ext + ' · 将降级', cls: 'badge badge-warn' };
    return { text: 'CSV', cls: 'badge' };
  }
  function prefixMode() {
    var w = ws();
    return !!(w && w.settings && w.settings.genericStyle === 'prefix');
  }

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

  /* ================= 文件上传(独立列表) ================= */
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
        var wb = await excel.loadFile(buf.slice(0), file.name);
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
      refreshSmartPane();
      util.bus.emit('files:changed', { count: st.files.length });
      util.toast('已上传 ' + added + ' 个文件', 'ok');
    }
  }

  async function removeFile(idx) {
    var en = st.files[idx];
    if (!en) return;
    var ok = await util.confirmDialog({
      title: '移除文件',
      body: '将移除「' + util.esc(en.wb.name) + '」及其还原规则与结果记录。确定?',
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
    refreshSmartPane();
  }

  function setActive(idx, force) {
    if (!force && idx === st.activeIdx) return;
    st.activeIdx = idx;
    st.activeSheet = 0;
    refreshSheets();
    loadGrid();
    refreshRulesPanel();
    refreshSelectTip();
  }

  function refreshFileList() {
    var list = st.els.fileList;
    list.textContent = '';
    if (!st.files.length) {
      list.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '📄' }),
        util.el('div', { text: '上传脱敏后的表格文件' }),
        util.el('div', { class: 'ec-empty-hint', text: '.xlsx / .xlsm / .xls / .csv · 可拖入窗口' })
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
        meta.appendChild(util.el('span', { class: 'badge badge-ok', text: '已还原 ✓' }));
      }
      card.appendChild(meta);
      var x = util.el('button', { class: 'ec-file-x', type: 'button', title: '移除文件', text: '✕' });
      x.addEventListener('click', function (e) { e.stopPropagation(); removeFile(idx); });
      card.appendChild(x);
      card.addEventListener('click', function () { setActive(idx); });
      list.appendChild(card);
    });
  }

  /* ================= 模式切换 ================= */
  function setMode(mode) {
    st.mode = mode;
    st.els.tabSmart.classList.toggle('active', mode === 'smart');
    st.els.tabSelect.classList.toggle('active', mode === 'select');
    st.els.smartPane.style.display = mode === 'smart' ? '' : 'none';
    st.els.selectPane.style.display = mode === 'select' ? 'flex' : 'none';
    if (mode === 'select') {
      loadGrid();       // 显示后重载数据与覆盖层
      refreshRulesPanel();
      refreshSelectTip();
    }
    refreshRightPanel();
  }

  /* ================= 智能还原 ================= */
  function refreshSmartPane() {
    var pane = st.els.smartPane;
    pane.textContent = '';
    if (!st.files.length) {
      pane.appendChild(util.el('div', { class: 'card', style: { 'margin': '14px' } }, [
        util.el('h3', { text: '🧠 智能还原(推荐)' }),
        util.el('p', { style: { color: 'var(--ec-muted)', 'font-size': '13px' }, text: '上传对方处理完回传的表格,点击「开始扫描」。应用会逐格识别占位符并换回真实值。' }),
        util.el('p', { style: { color: 'var(--ec-muted)', 'font-size': '13px' }, text: '第三方改了表也没关系:识别按单元格内容逐格进行,不依赖行列位置——他们增、删、改行都不会影响还原。' }),
        util.el('p', { style: { color: 'var(--ec-muted)', 'font-size': '13px' }, text: '未识别的占位符(不在当前工作区映射表里)将保持原样,不会误替换。' })
      ]));
      return;
    }
    var scanBtn = util.el('button', { class: 'btn btn-primary btn-lg', type: 'button', text: '🔎 开始扫描全部文件' });
    scanBtn.addEventListener('click', function () { smartScan(); });
    var bar = util.el('i');
    var progWrap = util.el('div', { class: 'progress', style: { display: 'none', 'max-width': '420px' } }, [bar]);
    st.els.scanBar = bar; st.els.scanBarWrap = progWrap;
    var head = util.el('div', { style: { 'margin': '14px', display: 'flex', 'align-items': 'center', gap: '14px', 'flex-wrap': 'wrap' } }, [
      scanBtn,
      util.el('span', { class: 'ec-file-meta', text: '共 ' + st.files.length + ' 个文件 · 全部工作表逐格扫描' })
    ]);
    pane.appendChild(head);
    pane.appendChild(util.el('div', { style: { 'margin': '0 14px' } }, [progWrap]));

    // 报告卡
    st.files.forEach(function (en) {
      var res = st.results[en.wb.id];
      if (!res) return;
      pane.appendChild(buildReportCard(en, res));
    });
  }

  function buildReportCard(en, res) {
    var wb = en.wb;
    var card = util.el('div', { class: 'card', style: { 'margin': '12px 14px' } });
    var head = util.el('div', { class: 'ec-result-head' }, [
      util.el('span', { class: 'ec-result-name', title: wb.name, text: outRestoredName(wb) }),
      wb.lossy ? util.el('span', { class: 'chip chip-warn', text: '将降级:样式/宏可能丢失' }) : null
    ]);
    card.appendChild(head);
    var chips = util.el('div', { class: 'ec-result-chips' });
    var types = Object.keys(res.stats.byType);
    if (res.stats.hits) {
      chips.appendChild(util.el('span', { class: 'chip', text: '命中 ' + res.stats.hits + ' 格' }));
      types.forEach(function (t) { chips.appendChild(typeChip(t, res.stats.byType[t])); });
    } else {
      chips.appendChild(util.el('span', { class: 'chip chip-plain', text: '未发现可还原的占位符' }));
    }
    card.appendChild(chips);
    var unknownText = prefixMode()
      ? ('未识别占位符样式格 ' + res.stats.unknown + ' 个(T- 开头但不在映射表)')
      : '未识别统计仅在使用「带前缀」通用样式时可用';
    card.appendChild(util.el('div', { class: 'ec-result-meta', text: unknownText + ' · 未识别的占位符将保持原样 · 完成于 ' + util.fmtTime(res.doneAt) }));
    var dl = util.el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '⬇ 下载还原文件' });
    dl.addEventListener('click', function () { util.download(res.blob, outRestoredName(wb)); });
    card.appendChild(dl);
    return card;
  }

  async function smartScan() {
    var w = ws();
    if (!w || w.isLocked()) { util.toast('工作区已锁定,请先解锁', 'warn'); E.ui.app.navigate('home'); return; }
    if (!st.files.length) { util.toast('请先上传要还原的表格', 'warn'); return; }
    var ok = await util.confirmDialog({
      title: '开始智能扫描',
      body: '将对 ' + st.files.length + ' 个文件的全部工作表逐格识别占位符并还原为真实值。确定?',
      confirmText: '开始扫描'
    });
    if (!ok) return;

    st.busy = true;
    showBusy('正在扫描…');
    if (st.els.scanBarWrap) st.els.scanBarWrap.style.display = '';
    await util.nextFrame();
    var isPrefix = prefixMode();
    try {
      var total = 0;
      st.files.forEach(function (en) {
        en.wb.sheets.forEach(function (sh) { total += sh.rows.length * sh.maxCols; });
      });
      var processed = 0;
      for (var f = 0; f < st.files.length; f++) {
        var en = st.files[f];
        var wb = en.wb;
        var stats = { hits: 0, byType: {}, unknown: 0 };
        var patches = [];
        for (var si = 0; si < wb.sheets.length; si++) {
          var rows = wb.sheets[si].rows;
          for (var r = 0; r < rows.length; r++) {
            var row = rows[r] || [];
            var width = Math.max(wb.sheets[si].maxCols, row.length);
            for (var c = 0; c < width; c++) {
              processed++;
              var text = excel.cellText(row[c]);
              if (!text) continue;
              var hit = w.unmask(text);
              if (hit) {
                patches.push({ sheet: si, r: r, c: c, text: hit.value });
                stats.hits++;
                stats.byType[hit.type] = (stats.byType[hit.type] || 0) + 1;
              } else if (isPrefix && RE_TPLACEHOLDER.test(text.trim())) {
                stats.unknown++;
              }
              if (processed % 500 === 0) {
                setBusyProgress(total ? processed / total * 95 : 50, '正在扫描「' + wb.name + '」… ' + processed + ' / ' + total + ' 格');
                await util.nextFrame();
              }
            }
          }
        }
        setBusyProgress(95 + 5 * (f + 1) / st.files.length, '正在导出「' + wb.name + '」…');
        await util.nextFrame();
        var blob = await excel.patchAndExport(wb, patches);
        st.results[wb.id] = { blob: blob, stats: stats, doneAt: Date.now() };
      }
      setBusyProgress(100, '扫描完成');
      var hitTotal = 0;
      Object.keys(st.results).forEach(function (fid) { hitTotal += st.results[fid].stats.hits; });
      util.toast('扫描完成:共还原 ' + hitTotal + ' 格', hitTotal ? 'ok' : 'info');
      refreshFileList();
    } catch (e) {
      util.toast('扫描失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
      hideBusy();
      refreshSmartPane();
    }
  }

  async function zipAll(btn) {
    btn.classList.add('is-loading');
    try {
      var used = {};
      var entries = [];
      for (var i = 0; i < st.files.length; i++) {
        var en = st.files[i];
        var res = st.results[en.wb.id];
        if (!res) continue;
        var name = outRestoredName(en.wb);
        if (used[name]) {
          var m = /^(.*?)(\.[^.]+)$/.exec(name);
          for (var n = 2; ; n++) {
            var cand = m[1] + ' (' + n + ')' + m[2];
            if (!used[cand]) { name = cand; break; }
          }
        }
        used[name] = 1;
        entries.push({ name: name, data: new Uint8Array(await res.blob.arrayBuffer()) });
      }
      if (!entries.length) { util.toast('还没有可下载的还原结果', 'warn'); return; }
      var zip = util.zipStore(entries);
      util.download(new Blob([zip], { type: 'application/zip' }), '还原结果.zip');
    } catch (e) {
      util.toast('打包失败:' + (e && e.message || e), 'err');
    } finally {
      btn.classList.remove('is-loading');
    }
  }

  /* ================= 按选区还原 ================= */
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
        refreshSheets();
        loadGrid();
        refreshRulesPanel();
      });
      box.appendChild(b);
    });
  }

  function loadGrid() {
    if (!st.grid) return;
    var sheet = activeSheetModel();
    st.grid.setData(sheet || null, { windowRows: WINDOW_ROWS });
    // 还原屏不做检测高亮/预览;列徽标显示已设规则的列
    refreshColMarks();
  }
  function refreshColMarks() {
    if (!st.grid) return;
    var en = activeFile();
    var marks = {};
    if (en) {
      rulesFor(en.wb.id, st.activeSheet).forEach(function (r) {
        if (!r.enabled || r.target.kind !== 'col') return;
        marks[r.target.c] = { type: 'generic', label: '还原', color: '#00838f' };
      });
    }
    st.grid.setColMarks(marks);
  }

  function applySelection() {
    var en = activeFile();
    if (!en) { util.toast('请先上传表格文件', 'warn'); return; }
    var sels = st.grid ? st.grid.getSelections() : [];
    if (!sels.length) { util.toast('请先在表格中框选要还原的区域', 'warn'); return; }
    var rows = (activeSheetModel() || { rows: [] }).rows;
    var visRows = Math.min(rows.length, WINDOW_ROWS);
    var count = 0;
    sels.forEach(function (s) {
      var target;
      if (s.r1 === 0 && visRows > 0 && s.r2 === visRows - 1) {
        for (var c = s.c1; c <= s.c2; c++) {
          st.rules.push({
            id: util.uid('rrule'), fileIds: [en.wb.id], sheet: st.activeSheet,
            target: { kind: 'col', c: c }, pii: 'any', enabled: true, note: ''
          });
          count++;
        }
      } else {
        st.rules.push({
          id: util.uid('rrule'), fileIds: [en.wb.id], sheet: st.activeSheet,
          target: { kind: 'range', r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 },
          pii: 'any', enabled: true, note: ''
        });
        count++;
      }
    });
    refreshRulesPanel();
    refreshColMarks();
    util.toast('已添加 ' + count + ' 条还原范围(区域内全部尝试还原,未命中的格保持原样)', 'ok');
  }

  function refreshRulesPanel() {
    var listEl = st.els.ruleList;
    if (!listEl) return;
    listEl.textContent = '';
    var en = activeFile();
    var list = en ? rulesFor(en.wb.id, st.activeSheet) : [];
    st.els.ruleCount.textContent = en ? '共 ' + list.length + ' 条范围' : '共 0 条';

    if (!st.files.length) {
      listEl.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '📐' }),
        util.el('div', { text: '上传文件后框选要还原的区域' })
      ]));
      return;
    }
    if (!list.length) {
      listEl.appendChild(util.el('div', { class: 'ec-empty' }, [
        util.el('div', { class: 'ec-empty-ico', text: '🎯' }),
        util.el('div', { text: '当前工作表还没有还原范围' }),
        util.el('div', { class: 'ec-empty-hint', text: '框选区域 → 「对选中区域应用」' })
      ]));
      return;
    }
    list.forEach(function (r) {
      var badge = util.el('span', {
        class: 'badge',
        text: '任意类型 · 命中即还原'
      });
      badge.style.background = '#00838f'; badge.style.color = '#fff'; badge.style.borderColor = 'transparent';
      var chk = util.el('input', { type: 'checkbox' });
      chk.checked = r.enabled;
      var xBtn = util.el('button', { class: 'ec-rule-x', type: 'button', title: '删除', text: '✕' });
      var card = util.el('div', { class: 'ec-rule-card' + (r.enabled ? '' : ' off') });
      card.appendChild(util.el('div', { class: 'ec-rule-top' }, [
        util.el('span', { class: 'ec-rule-scope', text: ruleDesc(r) }),
        badge,
        util.el('label', { class: 'ec-rule-check' }, [chk, util.el('span', { text: '启用' })]),
        xBtn
      ]));
      var note = util.el('input', { class: 'input ec-rule-note', type: 'text', placeholder: '备注(可选)', value: r.note || '' });
      note.addEventListener('change', function () { r.note = note.value; });
      card.appendChild(note);
      chk.addEventListener('change', function () {
        r.enabled = chk.checked;
        card.classList.toggle('off', !r.enabled);
        refreshColMarks();
      });
      xBtn.addEventListener('click', function () {
        st.rules = st.rules.filter(function (x) { return x.id !== r.id; });
        refreshRulesPanel();
        refreshColMarks();
      });
      listEl.appendChild(card);
    });
  }

  function refreshSelectTip() {
    var tip = st.els.selectTip;
    if (!tip) return;
    tip.textContent = '';
    var en = activeFile();
    if (en && en.wb.lossy) {
      tip.appendChild(util.el('span', { class: 'chip chip-warn', text: '⚠ ' + en.wb.ext.toUpperCase() + ' 导出将降级:样式/宏可能丢失' }));
    }
    tip.appendChild(util.el('span', { text: '范围内每个格都会尝试还原:能对上占位符的换回原值,对不上的保持原样。' }));
  }

  async function executeSelectRestore() {
    var w = ws();
    if (!w || w.isLocked()) { util.toast('工作区已锁定,请先解锁', 'warn'); E.ui.app.navigate('home'); return; }
    if (!st.files.length) { util.toast('请先上传表格文件', 'warn'); return; }
    var targets = st.files.filter(function (en) { return enabledRulesFor(en.wb.id).length > 0; });
    if (!targets.length) { util.toast('请先框选区域并「对选中区域应用」', 'warn'); return; }

    var ruleCount = 0;
    targets.forEach(function (en) { ruleCount += enabledRulesFor(en.wb.id).length; });
    var ok = await util.confirmDialog({
      title: '按选区还原',
      body: '将对 ' + targets.length + ' 个文件、' + ruleCount + ' 条范围执行还原:范围内能识别的占位符换回原值,未命中的格保持原样。确定?',
      confirmText: '开始还原'
    });
    if (!ok) return;

    st.busy = true;
    showBusy('正在还原…');
    await util.nextFrame();
    try {
      for (var f = 0; f < targets.length; f++) {
        var en = targets[f];
        var wb = en.wb;
        var stats = { hits: 0, byType: {}, unknown: 0 };
        var patches = [];
        var seen = {};
        var rules = enabledRulesFor(wb.id);
        for (var ri = 0; ri < rules.length; ri++) {
          var rule = rules[ri];
          var sheet = wb.sheets[rule.sheet];
          if (!sheet) continue;
          var rows = sheet.rows;
          var t = rule.target;
          var r1, r2, c1, c2;
          if (t.kind === 'col') { r1 = 0; r2 = rows.length - 1; c1 = t.c; c2 = t.c; }
          else { r1 = t.r1; r2 = Math.min(t.r2, rows.length - 1); c1 = t.c1; c2 = Math.min(t.c2, sheet.maxCols - 1); }
          if (c2 < c1) continue;
          var cells = 0;
          for (var r = r1; r <= r2; r++) {
            var row = rows[r] || [];
            for (var c = c1; c <= c2; c++) {
              var key = rule.sheet + ':' + r + ':' + c;
              if (seen[key]) continue;
              seen[key] = 1;
              cells++;
              var text = excel.cellText(row[c]);
              if (!text) continue;
              var hit = w.unmask(text); // 同步
              if (hit) {
                patches.push({ sheet: rule.sheet, r: r, c: c, text: hit.value });
                stats.hits++;
                stats.byType[hit.type] = (stats.byType[hit.type] || 0) + 1;
              }
              if (cells % 1000 === 0) {
                setBusyProgress(100 * (f + 0.5) / targets.length, '正在还原「' + wb.name + '」…');
                await util.nextFrame();
              }
            }
          }
        }
        setBusyProgress(100 * (f + 1) / targets.length, '正在导出「' + wb.name + '」…');
        await util.nextFrame();
        var blob = await excel.patchAndExport(wb, patches);
        st.results[wb.id] = { blob: blob, stats: stats, doneAt: Date.now() };
      }
      util.toast('还原完成,可在下方/智能页下载结果', 'ok');
      refreshFileList();
      showSelectResultModal();
    } catch (e) {
      util.toast('还原失败:' + (e && e.message || e), 'err');
    } finally {
      st.busy = false;
      hideBusy();
    }
  }

  function showSelectResultModal() {
    var overlay = util.el('div', { class: 'ec-modal-overlay' });
    var box = util.el('div', { class: 'ec-modal ec-modal-wide' });
    box.appendChild(util.el('h3', { text: '✅ 还原完成' }));
    var hitTotal = 0;
    st.files.forEach(function (en) {
      var res = st.results[en.wb.id];
      if (!res) return;
      hitTotal += res.stats.hits;
      var card = util.el('div', { class: 'ec-result-card', style: { 'margin-bottom': '10px' } });
      card.appendChild(util.el('div', { class: 'ec-result-head' }, [
        util.el('span', { class: 'ec-result-name', title: en.wb.name, text: outRestoredName(en.wb) })
      ]));
      var chips = util.el('div', { class: 'ec-result-chips' });
      chips.appendChild(util.el('span', { class: 'chip', text: '还原 ' + res.stats.hits + ' 格' }));
      Object.keys(res.stats.byType).forEach(function (t) {
        chips.appendChild(typeChip(t, res.stats.byType[t]));
      });
      card.appendChild(chips);
      var dl = util.el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '⬇ 下载还原文件' });
      dl.addEventListener('click', function () { util.download(res.blob, outRestoredName(en.wb)); });
      card.appendChild(dl);
      box.appendChild(card);
    });
    box.appendChild(util.el('div', { class: 'ec-modal-body', text: '共还原 ' + hitTotal + ' 格。' }));
    var closeBtn = util.el('button', { class: 'btn', type: 'button', text: '关闭' });
    var zipBtn = util.el('button', { class: 'btn btn-primary', type: 'button', text: '📦 打包下载全部' });
    zipBtn.addEventListener('click', function () { zipAll(zipBtn); });
    box.appendChild(util.el('div', { class: 'ec-modal-btns' }, [zipBtn, closeBtn]));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
    function close() {
      overlay.classList.remove('show');
      setTimeout(function () { overlay.remove(); }, 200);
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  async function clearAllRules() {
    var en = activeFile();
    if (!en) return;
    if (!st.rules.some(function (r) { return r.fileIds.indexOf(en.wb.id) >= 0; })) return;
    var ok = await util.confirmDialog({ title: '全部清除', body: '删除该文件(所有工作表)的全部还原范围?', confirmText: '清除' });
    if (!ok) return;
    st.rules = st.rules.filter(function (r) { return r.fileIds.indexOf(en.wb.id) < 0; });
    refreshRulesPanel();
    refreshColMarks();
  }

  /* ================= 右栏 ================= */
  function refreshRightPanel() {
    var box = st.els.rightBody;
    box.textContent = '';
    if (st.mode === 'smart') {
      var w = ws();
      var s = w ? w.stats() : { entries: 0 };
      box.appendChild(util.el('div', { class: 'card', style: { 'margin': '12px', 'box-shadow': 'none', 'background': 'var(--ec-bg)' } }, [
        util.el('h3', { text: '📌 智能还原说明' }),
        util.el('ul', { style: { 'padding-left': '18px', color: 'var(--ec-muted)', 'font-size': '12.5px', margin: 0 }, text: '' }, [
          util.el('li', { text: '逐格识别占位符,不依赖行列位置;对方增删行列、跨文件都能还原。' }),
          util.el('li', { text: '当前工作区映射表:' + s.entries + ' 条,只有登记过的占位符才会被还原。' }),
          util.el('li', { text: '未识别内容保持原样,绝不误替换。' })
        ])
      ]));
      var zipBtn2 = util.el('button', { class: 'btn btn-block', type: 'button', style: { margin: '0 12px', width: 'auto' }, text: '📦 打包下载全部结果' });
      zipBtn2.style.width = 'calc(100% - 24px)';
      zipBtn2.addEventListener('click', function () { zipAll(zipBtn2); });
      box.appendChild(zipBtn2);
      return;
    }
    // 选区模式:规则列表 + 执行(常驻 DOM,见 mount)
    box.appendChild(st.els.rulePanel);
  }

  /* ================= 挂载 ================= */
  function mount(container) {
    var w = ws();
    if (!w || w.isLocked()) { E.ui.app.navigate('home'); return; }
    // 切换到另一个工作区时,清空遗留状态
    if (st.wsId !== w.id) {
      st.wsId = w.id;
      st.files = []; st.rules = []; st.results = {};
      st.activeIdx = -1; st.activeSheet = 0; st.mode = 'smart';
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
    var uploadBtn = util.el('button', { class: 'btn btn-primary btn-block', type: 'button', text: '⬆ 上传待还原表格' });
    uploadBtn.addEventListener('click', function () { st.fileInput.click(); });
    st.els.fileList = util.el('div', { class: 'ec-file-list' });
    var left = util.el('aside', { class: 'ec-wb-left' }, [
      util.el('div', { class: 'ec-wb-left-head' }, [
        uploadBtn,
        util.el('div', { class: 'ec-drop-hint', text: '回传的脱敏文件 · 可拖入窗口' }),
        st.fileInput
      ]),
      st.els.fileList
    ]);

    /* ---- 中:模式标签 + 两个面板 ---- */
    st.els.tabSmart = util.el('button', { class: 'tab active', type: 'button', text: '🧠 智能还原(推荐)' });
    st.els.tabSelect = util.el('button', { class: 'tab', type: 'button', text: '📐 按选区还原' });
    st.els.tabSmart.addEventListener('click', function () { setMode('smart'); });
    st.els.tabSelect.addEventListener('click', function () { setMode('select'); });

    st.els.smartPane = util.el('div', { class: '', style: { 'flex': '1 1 auto', 'min-height': '0', 'overflow': 'auto' } });

    st.els.sheetTabs = util.el('div', { class: 'ec-sheet-tabs' });
    var applyBtn = util.el('button', { class: 'btn', type: 'button', text: '对选中区域应用' });
    applyBtn.addEventListener('click', applySelection);
    var clearSelBtn = util.el('button', { class: 'btn', type: 'button', text: '清除选择' });
    clearSelBtn.addEventListener('click', function () { if (st.grid) st.grid.clearSelection(); });
    st.gridHost = util.el('div', { class: 'ec-grid-host' });
    st.els.selectTip = util.el('div', { class: 'ec-wb-tip' });
    st.els.selectPane = util.el('div', {
      class: 'ec-wb-mid', style: { display: 'none' }
    }, [
      st.els.sheetTabs,
      util.el('div', { class: 'ec-toolbar' }, [
        util.el('span', { class: 'chip chip-plain', text: '还原类型:任意(命中即还原)' }),
        applyBtn, clearSelBtn
      ]),
      st.gridHost,
      st.els.selectTip
    ]);

    var mid = util.el('section', { class: 'ec-wb-mid' }, [
      util.el('div', { class: 'tabs', style: { 'padding-top': '8px' } }, [st.els.tabSmart, st.els.tabSelect]),
      st.els.smartPane,
      st.els.selectPane
    ]);
    // mid 本身不再承担 grid 布局:smartPane 与 selectPane 各自撑满
    mid.style.flexDirection = 'column';

    /* ---- 右栏 ---- */
    st.els.ruleCount = util.el('span', { class: 'ec-file-meta', text: '共 0 条范围' });
    st.els.ruleList = util.el('div', { class: 'ec-rule-list' });
    var clearBtn = util.el('button', { class: 'btn btn-sm', type: 'button', text: '全部清除' });
    clearBtn.addEventListener('click', clearAllRules);
    var execBtn = util.el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', text: '◀ 执行还原' });
    execBtn.addEventListener('click', executeSelectRestore);
    st.els.rulePanel = util.el('div', { style: { display: 'flex', 'flex-direction': 'column', 'flex': '1 1 auto', 'min-height': '0' } }, [
      util.el('div', { class: 'ec-wb-right-head' }, [
        util.el('b', { text: '还原范围' }), st.els.ruleCount
      ]),
      st.els.ruleList,
      util.el('div', { class: 'ec-rule-foot' }, [clearBtn, execBtn])
    ]);
    st.els.rightBody = util.el('div', { style: { display: 'flex', 'flex-direction': 'column', 'flex': '1 1 auto', 'min-height': '0' } });
    var right = util.el('aside', { class: 'ec-wb-right' }, [st.els.rightBody]);

    /* ---- 忙碌遮罩 ---- */
    st.els.busyText = util.el('div', { class: 'ec-busy-text', text: '处理中…' });
    st.els.busyBar = util.el('i');
    st.els.busy = util.el('div', { class: 'ec-busy', style: { display: 'none' } }, [
      util.el('div', { class: 'ec-spin' }), st.els.busyText,
      util.el('div', { class: 'progress', style: { width: '240px' } }, [st.els.busyBar])
    ]);

    st.root.appendChild(left);
    st.root.appendChild(mid);
    st.root.appendChild(right);
    st.root.appendChild(st.els.busy);
    container.appendChild(st.root);

    /* ---- Grid(一次,选区模式用) ---- */
    st.grid = new Grid(st.gridHost, { maxPreviewRows: 2000 });

    refreshFileList();
    refreshSmartPane();
    refreshRightPanel();
    refreshSheets();
    refreshRulesPanel();
    refreshSelectTip();
    setMode('smart');
  }

  function unmount() {
    if (st.grid) { try { st.grid.destroy(); } catch (e) { /* 忽略 */ } st.grid = null; }
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
    st.root = null; st.gridHost = null; st.fileInput = null; st.els = {};
  }

  function handleFiles(files) { addFiles(files); }
  function openPicker() { if (st.fileInput) st.fileInput.click(); }

  return { mount: mount, unmount: unmount, handleFiles: handleFiles, openPicker: openPicker };
});
