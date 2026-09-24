/*! Encipherer.grid — 表格预览组件(虚拟滚动 + 选区 + 覆盖层)
 * 依据 docs/ARCHITECTURE.md §2.5 / §1.2。
 * - 经典 script + UMD:浏览器挂到 Encipherer.grid(构造函数);
 *   Node 下 require 可加载,但构造时若无 DOM 会抛错(本组件仅浏览器使用)。
 * - 不依赖 util.js:colName / a1 为私有实现(规范允许的内联)。
 * - 布局常量:行高 26、表头高 26、列宽 96、行号列宽 48。
 * - 双向虚拟滚动:仅渲染可视行/列(含少量 overscan),表头用 CSS sticky 固定。
 * - 安全:所有单元格文本均通过 textContent 写入,无 innerHTML 拼接。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.Encipherer = root.Encipherer || {};
    var m = factory(root.Encipherer);
    for (var k in m) root.Encipherer[k] = m[k];
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  E = E || {};

  // —— 布局常量 ——
  var ROW_H = 26, HEAD_H = 26, COL_W = 96, ROWHEAD_W = 48;
  var OVER_R = 3, OVER_C = 3; // 可视区外预渲染的行/列数

  // PII 类型展示元数据(fakery.TYPE_META 的兜底副本,避免模块间依赖;
  // 颜色仅用于徽标/角标的默认值,setColMarks 传入的 color 优先)
  var TYPE_META = {
    phone:    { label: '手机号',   color: '#e65100' },
    idcard:   { label: '身份证号', color: '#ad1457' },
    email:    { label: '邮箱',     color: '#1565c0' },
    name:     { label: '姓名',     color: '#2e7d32' },
    bankcard: { label: '银行卡号', color: '#6a1b9a' },
    ip:       { label: 'IP 地址',  color: '#00838f' },
    plate:    { label: '车牌号',   color: '#827717' },
    address:  { label: '地址',     color: '#5d4037' },
    generic:  { label: '文本',     color: '#546e7a' }
  };

  // —— 私有工具(不依赖 util.js) ——
  function colName(c) { // 0 基列索引 → Excel 字母(A、B、…、AA)
    var s = '', n = c + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function a1(r, c) { return colName(c) + (r + 1); }
  function hexA(hex, alpha) { // '#rrggbb' → 'rgba(r,g,b,a)'
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return 'rgba(84,110,122,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  function normRect(a, b) { // 两格 → 规范矩形(r1<=r2, c1<=c2)
    return {
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c)
    };
  }
  function el(tag, cls) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
  }

  // ============ Grid 构造函数 ============
  function Grid(container, opts) {
    if (typeof document === 'undefined') {
      throw new Error('Encipherer.grid 仅支持浏览器环境(需要 DOM)');
    }
    if (!container || container.nodeType !== 1) {
      throw new Error('Grid 构造失败:container 必须为 DOM 元素');
    }
    opts = opts || {};
    this._cb = {
      sel: typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : null,
      col: typeof opts.onColumnHeaderClick === 'function' ? opts.onColumnHeaderClick : null,
      row: typeof opts.onRowHeaderClick === 'function' ? opts.onRowHeaderClick : null
    };
    this._maxPreviewRows = Math.max(1, (opts.maxPreviewRows | 0) || 2000);

    // 数据状态
    this._rows = null; this._rowCount = 0; this._colCount = 0;
    this._totalRows = 0; this._truncated = false; this._sheetName = '';
    // 选区状态
    this._selections = []; // [{r1,c1,r2,c2}] 已规范
    this._active = null;   // 活动格 {r,c}
    // 覆盖层
    this._colMarks = {}; this._tints = {}; this._preview = {};
    // 渲染状态
    this._st = 0; this._sl = 0; this._vw = 0; this._vh = 0; this._range = null;
    this._raf = 0; this._asRaf = 0; this._drag = null;
    this._alive = true; this._ro = null;
    this._poolCell = []; this._usedCell = {}; // 单元格对象池
    this._colEls = []; this._rowEls = []; this._selEls = [];
    this._bound = [];

    // 绑定好 this 的处理器(便于 destroy 时精确移除)
    this._hScroll = this._onScroll.bind(this);
    this._hDown = this._onMouseDown.bind(this);
    this._hKey = this._onKey.bind(this);
    this._hMove = this._onDragMove.bind(this);
    this._hUp = this._onDragUp.bind(this);
    this._hBlur = this._onWinBlur.bind(this);

    this._buildDom(container);
    this._bind();
    this._layout();
    this._renderWindow();
    this._renderSelection();
    this._updateStatus();
  }

  // ---------- DOM 骨架 ----------
  // .eg-grid
  //   .eg-body(滚动容器)
  //     .eg-canvas(内容坐标系,宽高=全表)
  //       .eg-hrow(sticky top) > .eg-corner(sticky left) + .eg-colhead*
  //       .eg-rheadcol(sticky left) > .eg-rowhead*
  //       .eg-cell* / .eg-selbox* / .eg-activebox
  //     .eg-empty
  //   .eg-status
  Grid.prototype._buildDom = function (container) {
    var root = el('div', 'eg-grid');
    root.setAttribute('tabindex', '0');
    root.setAttribute('role', 'grid');
    var body = el('div', 'eg-body');
    var canvas = el('div', 'eg-canvas');
    var hrow = el('div', 'eg-hrow');
    var corner = el('div', 'eg-corner');
    corner.setAttribute('data-corner', '1');
    corner.title = '全选当前窗口';
    var rcol = el('div', 'eg-rheadcol');
    var empty = el('div', 'eg-empty');
    empty.textContent = '暂无数据';
    var status = el('div', 'eg-status');
    var stAddr = el('span', 'eg-status-item eg-st-addr');
    var stDims = el('span', 'eg-status-item eg-st-dims');
    var stSel = el('span', 'eg-status-item eg-st-sel');
    var stTrunc = el('span', 'eg-status-item eg-st-trunc');
    stTrunc.textContent = '已截断预览,处理不受影响';
    stTrunc.style.display = 'none';
    var activeBox = el('div', 'eg-activebox');

    hrow.appendChild(corner);
    canvas.appendChild(hrow);
    canvas.appendChild(rcol);
    canvas.appendChild(activeBox);
    body.appendChild(canvas);
    body.appendChild(empty);
    status.appendChild(stAddr);
    status.appendChild(stDims);
    status.appendChild(stSel);
    status.appendChild(stTrunc);
    root.appendChild(body);
    root.appendChild(status);
    container.appendChild(root);

    this._root = root; this._body = body; this._canvas = canvas;
    this._hrow = hrow; this._corner = corner; this._rcol = rcol;
    this._activeBox = activeBox; this._empty = empty;
    this._stAddr = stAddr; this._stDims = stDims; this._stSel = stSel; this._stTrunc = stTrunc;
  };

  // ---------- 事件绑定 / 解绑 ----------
  Grid.prototype._bind = function () {
    var B = this._bound, self = this;
    function on(t, ty, fn, opt) { t.addEventListener(ty, fn, opt); B.push([t, ty, fn, opt]); }
    on(this._body, 'scroll', this._hScroll, { passive: true });
    on(this._body, 'mousedown', this._hDown);
    on(this._root, 'keydown', this._hKey);
    // 拖选期间全局监听(常驻 + 空守卫,避免动态增删造成泄漏)
    on(window, 'mousemove', this._hMove);
    on(window, 'mouseup', this._hUp);
    on(window, 'blur', this._hBlur);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { if (self._alive) self._renderWindow(); });
      this._ro.observe(this._root);
    }
  };
  Grid.prototype._unbind = function () {
    var B = this._bound;
    for (var i = B.length - 1; i >= 0; i--) {
      B[i][0].removeEventListener(B[i][1], B[i][2], B[i][3]);
    }
    this._bound = [];
  };

  // ---------- 公开 API ----------
  /** 载入 SheetModel({name,rows,maxCols});超过 windowRows 行仅显示前 windowRows 行。
   *  会重置选区与滚动位置,并清空旧覆盖层(旧坐标属于上一张表)。 */
  Grid.prototype.setData = function (sheetModel, opts) {
    if (!this._alive) return;
    opts = opts || {};
    this._drag = null; // 数据切换时终止未完成拖选
    this._colMarks = {}; this._tints = {}; this._preview = {};

    if (!sheetModel || !sheetModel.rows) {
      this._rows = null; this._rowCount = 0; this._colCount = 0;
      this._totalRows = 0; this._truncated = false; this._sheetName = '';
      this._selections = []; this._active = null;
    } else {
      var windowRows = opts.windowRows != null ? (opts.windowRows | 0) : 1000;
      if (!(windowRows > 0)) windowRows = 1000;
      // maxPreviewRows 是硬上限:调用方传入更大窗口也会被压回
      if (windowRows > this._maxPreviewRows) windowRows = this._maxPreviewRows;
      var rows = sheetModel.rows;
      this._totalRows = rows.length;
      this._truncated = rows.length > windowRows;
      this._rows = this._truncated ? rows.slice(0, windowRows) : rows;
      this._rowCount = this._rows.length;
      var mc = sheetModel.maxCols | 0;
      for (var i = 0; i < this._rowCount; i++) {
        var row = this._rows[i];
        if (row && row.length > mc) mc = row.length;
      }
      this._colCount = Math.max(mc, this._rowCount ? 1 : 0);
      this._sheetName = sheetModel.name || '';
      this._selections = [];
      this._active = this._rowCount ? { r: 0, c: 0 } : null;
    }

    this._body.scrollTop = 0;
    this._body.scrollLeft = 0;
    this._st = 0; this._sl = 0;
    this._releaseAllCells();
    this._layout();
    this._renderWindow();
    this._renderSelection();
    this._updateStatus();
    // 程序化重置不触发 onSelectionChange(与 clearSelection 的行为差异见文档)
  };

  /** 当前选区(深拷贝,0 基、含端点、已规范) */
  Grid.prototype.getSelections = function () {
    var out = [];
    for (var i = 0; i < this._selections.length; i++) {
      var s = this._selections[i];
      out.push({ r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 });
    }
    return out;
  };

  Grid.prototype.clearSelection = function () {
    if (!this._alive) return;
    this._selections = [];
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
    if (this._cb.sel) this._cb.sel([]);
  };

  /** 列头徽标:{colIndex:{type,label,color}} */
  Grid.prototype.setColMarks = function (marks) {
    if (!this._alive) return;
    this._colMarks = marks || {};
    this._renderHeaders();
  };

  /** 检测命中淡色高亮:{'r:c':{type,confidence}} */
  Grid.prototype.setCellTints = function (tints) {
    if (!this._alive) return;
    this._tints = tints || {};
    this._releaseAllCells();
    this._renderWindow();
  };

  /** 预览模式:{'r:c':newText} — 右上角红点 + 悬浮显示替换后文本 */
  Grid.prototype.setPreview = function (preview) {
    if (!this._alive) return;
    this._preview = preview || {};
    this._releaseAllCells();
    this._renderWindow();
  };

  Grid.prototype.clearOverlays = function () {
    if (!this._alive) return;
    this._colMarks = {}; this._tints = {}; this._preview = {};
    this._releaseAllCells();
    this._renderWindow();
    this._renderHeaders();
  };

  /** 滚动到 (r,c),保证该格可见(最小滚动量) */
  Grid.prototype.scrollTo = function (r, c) {
    if (!this._alive || !this._rowCount) return;
    r = Math.max(0, Math.min(this._rowCount - 1, r | 0));
    c = Math.max(0, Math.min(this._colCount - 1, c | 0));
    var sc = this._body;
    var x = ROWHEAD_W + c * COL_W, y = HEAD_H + r * ROW_H;
    var st = sc.scrollTop, sl = sc.scrollLeft, vh = sc.clientHeight, vw = sc.clientWidth;
    if (y - HEAD_H < st) sc.scrollTop = y - HEAD_H;
    else if (y + ROW_H > st + vh) sc.scrollTop = y + ROW_H - vh;
    if (x - ROWHEAD_W < sl) sc.scrollLeft = x - ROWHEAD_W;
    else if (x + COL_W > sl + vw) sc.scrollLeft = x + COL_W - vw;
    // 赋值会触发 scroll 事件 → rAF 重渲染
  };

  /** 销毁:解绑全部事件、断开观察器、移除 DOM */
  Grid.prototype.destroy = function () {
    if (!this._alive) return;
    this._alive = false;
    this._drag = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    if (this._asRaf) { cancelAnimationFrame(this._asRaf); this._asRaf = 0; }
    this._unbind();
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._usedCell = {}; this._poolCell = [];
    this._colEls = []; this._rowEls = []; this._selEls = [];
    this._rows = null; this._selections = []; this._active = null;
    this._tints = null; this._preview = null; this._colMarks = null; this._cb = null;
  };

  // ---------- 布局与渲染 ----------
  Grid.prototype._layout = function () {
    var w = ROWHEAD_W + this._colCount * COL_W;
    var h = HEAD_H + this._rowCount * ROW_H;
    this._canvas.style.width = w + 'px';
    this._canvas.style.height = h + 'px';
    this._root.classList.toggle('eg-empty-mode', this._rowCount === 0);
  };

  Grid.prototype._onScroll = function () {
    if (!this._alive || this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = 0;
      if (self._alive) self._renderWindow();
    });
  };

  /** 计算可视窗口并渲染单元格 + 两端表头 */
  Grid.prototype._renderWindow = function () {
    if (!this._alive) return;
    var sc = this._body;
    this._st = sc.scrollTop; this._sl = sc.scrollLeft;
    this._vw = sc.clientWidth; this._vh = sc.clientHeight;
    var r0 = Math.max(0, Math.floor(this._st / ROW_H) - OVER_R);
    var r1 = Math.min(this._rowCount - 1, Math.ceil((this._st + this._vh) / ROW_H) + OVER_R);
    var c0 = Math.max(0, Math.floor((this._sl - ROWHEAD_W) / COL_W) - OVER_C);
    var c1 = Math.min(this._colCount - 1, Math.ceil((this._sl + this._vw - ROWHEAD_W) / COL_W) + OVER_C);
    this._range = { r0: r0, r1: r1, c0: c0, c1: c1 };
    this._renderCells(r0, r1, c0, c1);
    this._renderHeaders();
  };

  Grid.prototype._releaseAllCells = function () {
    var used = this._usedCell;
    for (var k in used) {
      var d = used[k];
      if (d.parentNode) d.parentNode.removeChild(d);
      this._poolCell.push(d);
    }
    this._usedCell = {};
  };

  Grid.prototype._mkCell = function () {
    var d = el('div', 'eg-cell');
    d.appendChild(el('span', 'eg-t'));   // 文本(textContent,防 XSS)
    d.appendChild(el('i', 'eg-badge'));  // 类型角标(右上小三角)
    d.appendChild(el('i', 'eg-pdot'));   // 预览红点
    return d;
  };

  Grid.prototype._cellAt = function (r, c) {
    var row = this._rows ? this._rows[r] : null;
    var cell = row ? row[c] : null;
    return cell || null;
  };

  Grid.prototype._fillCell = function (d, r, c) {
    var cell = this._cellAt(r, c);
    var txt = '';
    if (cell) txt = cell.display != null ? String(cell.display)
      : (cell.v != null ? String(cell.v) : '');
    d.style.left = (ROWHEAD_W + c * COL_W) + 'px';
    d.style.top = (HEAD_H + r * ROW_H) + 'px';
    d.setAttribute('data-r', r);
    d.setAttribute('data-c', c);
    d.className = 'eg-cell' +
      ((cell && cell.t === 'n') ? ' eg-num' : '') +
      ((r & 1) ? ' eg-zebra' : '');
    d.firstChild.textContent = txt; // 安全写入
    d.title = '';

    var badge = d.firstChild.nextSibling, pdot = badge.nextSibling;
    var tint = this._tints ? this._tints[r + ':' + c] : null;
    if (tint) {
      var meta = TYPE_META[tint.type] || TYPE_META.generic;
      d.style.backgroundColor = hexA(meta.color, 0.16);
      d.classList.add('eg-tint');
      d.title = '类型:' + meta.label +
        (tint.confidence != null ? '(置信度 ' + (+tint.confidence).toFixed(2) + ')' : '');
      badge.style.borderTopColor = meta.color;
      badge.style.borderRightColor = meta.color;
      badge.style.display = 'block';
    } else {
      d.style.backgroundColor = '';
      badge.style.display = 'none';
    }
    var pv = this._preview ? this._preview[r + ':' + c] : null;
    if (pv != null) {
      var pvTxt = String(pv);
      d.classList.add('eg-preview');
      pdot.style.display = 'block';
      pdot.title = '替换后:' + pvTxt;
      d.title = (d.title ? d.title + '\n' : '') + '替换后:' + pvTxt;
    } else {
      pdot.style.display = 'none';
      pdot.title = '';
    }
  };

  Grid.prototype._renderCells = function (r0, r1, c0, c1) {
    var used = this._usedCell, pool = this._poolCell, canvas = this._canvas;
    var keep = {}, r, c, k, d;
    for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) keep[r + ':' + c] = 1;
    // 回收滑出窗口的格子
    for (k in used) {
      if (!keep[k]) {
        d = used[k];
        if (d.parentNode) d.parentNode.removeChild(d);
        pool.push(d);
        delete used[k];
      }
    }
    // 补齐窗口内的格子(复用对象池)
    for (r = r0; r <= r1; r++) {
      for (c = c0; c <= c1; c++) {
        k = r + ':' + c;
        d = used[k];
        if (!d) {
          d = pool.pop() || this._mkCell();
          used[k] = d;
          canvas.appendChild(d);
          this._fillCell(d, r, c);
        } else {
          // 已渲染:位置同步(数据未变无需重填)
          d.style.left = (ROWHEAD_W + c * COL_W) + 'px';
          d.style.top = (HEAD_H + r * ROW_H) + 'px';
        }
      }
    }
  };

  Grid.prototype._renderHeaders = function () {
    if (!this._alive) return;
    var rg = this._range || { r0: 0, r1: -1, c0: 0, c1: -1 };
    // 列头(整块重建,数量少)
    while (this._colEls.length) {
      d = this._colEls.pop();
      if (d.parentNode) d.parentNode.removeChild(d);
    }
    var frag = document.createDocumentFragment(), d, c, r;
    for (c = rg.c0; c <= rg.c1; c++) {
      d = el('div', 'eg-colhead');
      d.setAttribute('data-c', c);
      d.style.left = (ROWHEAD_W + c * COL_W) + 'px';
      var lt = el('span', 'eg-cl');
      lt.textContent = colName(c);
      d.appendChild(lt);
      if (this._colSelected(c)) d.classList.add('eg-on');
      if (this._active && this._active.c === c) d.classList.add('eg-cur');
      var mk = this._colMarks ? this._colMarks[c] : null;
      if (mk) {
        var meta = TYPE_META[mk.type];
        var chip = el('span', 'eg-cmark');
        chip.style.background = mk.color || (meta && meta.color) || '#546e7a';
        chip.textContent = mk.label || (meta && meta.label) || mk.type || '';
        chip.title = '已设规则:' + chip.textContent;
        d.appendChild(chip);
        d.classList.add('eg-marked');
      }
      frag.appendChild(d);
      this._colEls.push(d);
    }
    this._hrow.appendChild(frag);
    // 行号头
    while (this._rowEls.length) {
      d = this._rowEls.pop();
      if (d.parentNode) d.parentNode.removeChild(d);
    }
    frag = document.createDocumentFragment();
    for (r = rg.r0; r <= rg.r1; r++) {
      d = el('div', 'eg-rowhead');
      d.setAttribute('data-r', r);
      d.style.top = (r * ROW_H) + 'px';
      d.textContent = String(r + 1);
      if (this._rowSelected(r)) d.classList.add('eg-on');
      if (this._active && this._active.r === r) d.classList.add('eg-cur');
      frag.appendChild(d);
      this._rowEls.push(d);
    }
    this._rcol.appendChild(frag);
  };

  /** 选区覆盖块 + 活动格粗边框(均在内容坐标系,随原生滚动移动) */
  Grid.prototype._renderSelection = function () {
    if (!this._alive) return;
    while (this._selEls.length) {
      var d = this._selEls.pop();
      if (d.parentNode) d.parentNode.removeChild(d);
    }
    var i, s, b;
    for (i = 0; i < this._selections.length; i++) {
      s = this._selections[i];
      b = el('div', 'eg-selbox');
      b.style.left = (ROWHEAD_W + s.c1 * COL_W) + 'px';
      b.style.top = (HEAD_H + s.r1 * ROW_H) + 'px';
      b.style.width = ((s.c2 - s.c1 + 1) * COL_W) + 'px';
      b.style.height = ((s.r2 - s.r1 + 1) * ROW_H) + 'px';
      this._canvas.appendChild(b);
      this._selEls.push(b);
    }
    var a = this._active;
    if (a) {
      this._activeBox.style.display = 'block';
      this._activeBox.style.left = (ROWHEAD_W + a.c * COL_W) + 'px';
      this._activeBox.style.top = (HEAD_H + a.r * ROW_H) + 'px';
    } else {
      this._activeBox.style.display = 'none';
    }
  };

  // ---------- 状态条 ----------
  Grid.prototype._updateStatus = function () {
    if (!this._alive) return;
    this._stAddr.textContent = this._active
      ? '当前 ' + a1(this._active.r, this._active.c)
      : '当前 —';
    if (!this._rowCount) {
      this._stDims.textContent = '暂无数据';
      this._stSel.textContent = '选区:无';
    } else {
      var prefix = this._sheetName ? this._sheetName + ' · ' : '';
      this._stDims.textContent = prefix + (
        this._truncated
          ? '显示前 ' + this._rowCount + ' / 共 ' + this._totalRows + ' 行 × ' + this._colCount + ' 列'
          : this._totalRows + ' 行 × ' + this._colCount + ' 列'
      );
      var n = this._selections.length;
      if (!n) this._stSel.textContent = '选区:无';
      else {
        var desc = (n === 1) ? this._selDesc(this._selections[0]) : n + ' 个选区';
        this._stSel.textContent = '选区:' + desc + ' · 共 ' + this._selCount() + ' 格';
      }
    }
    this._stTrunc.style.display = this._truncated ? '' : 'none';
  };

  Grid.prototype._selDesc = function (s) {
    return (s.r1 === s.r2 && s.c1 === s.c2)
      ? a1(s.r1, s.c1)
      : a1(s.r1, s.c1) + ':' + a1(s.r2, s.c2);
  };

  /** 多块选区去重后的格数(按行区间合并求并集) */
  Grid.prototype._selCount = function () {
    var byRow = {}, i, s, r;
    for (i = 0; i < this._selections.length; i++) {
      s = this._selections[i];
      for (r = s.r1; r <= s.r2; r++) {
        (byRow[r] = byRow[r] || []).push([s.c1, s.c2]);
      }
    }
    var total = 0, k, pairs, curS, curE, j;
    for (k in byRow) {
      pairs = byRow[k].sort(function (a, b) { return a[0] - b[0]; });
      curS = pairs[0][0]; curE = pairs[0][1];
      for (j = 1; j < pairs.length; j++) {
        if (pairs[j][0] <= curE + 1) { if (pairs[j][1] > curE) curE = pairs[j][1]; }
        else { total += curE - curS + 1; curS = pairs[j][0]; curE = pairs[j][1]; }
      }
      total += curE - curS + 1;
    }
    return total;
  };

  Grid.prototype._colSelected = function (c) {
    for (var i = 0; i < this._selections.length; i++) {
      var s = this._selections[i];
      if (s.c1 <= c && c <= s.c2 && s.r1 === 0 && s.r2 === this._rowCount - 1) return true;
    }
    return false;
  };
  Grid.prototype._rowSelected = function (r) {
    for (var i = 0; i < this._selections.length; i++) {
      var s = this._selections[i];
      if (s.r1 <= r && r <= s.r2 && s.c1 === 0 && s.c2 === this._colCount - 1) return true;
    }
    return false;
  };

  // ---------- 鼠标交互 ----------
  Grid.prototype._clampRC = function (r, c) {
    if (r < 0) r = 0; if (c < 0) c = 0;
    if (r > this._rowCount - 1) r = this._rowCount - 1;
    if (c > this._colCount - 1) c = this._colCount - 1;
    return { r: r, c: c };
  };

  Grid.prototype._onMouseDown = function (e) {
    if (!this._alive || e.button !== 0 || !this._rowCount) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var cornerEl = t.closest('.eg-corner');
    var colEl = t.closest('.eg-colhead');
    var rowEl = t.closest('.eg-rowhead');
    var cellEl = t.closest('.eg-cell');
    try { this._root.focus({ preventScroll: true }); } catch (_) { this._root.focus(); }

    if (cornerEl) { e.preventDefault(); this._selectAllWindow(); return; }

    if (colEl) {
      e.preventDefault();
      var c = +colEl.getAttribute('data-c');
      if (this._cb.col) this._cb.col(c);
      if (e.shiftKey && this._active) {
        this._replaceLast({ r1: 0, r2: this._rowCount - 1,
          c1: Math.min(this._active.c, c), c2: Math.max(this._active.c, c) });
        return;
      }
      this._active = { r: 0, c: c };
      this._beginDrag('col', 0, c, e);
      return;
    }

    if (rowEl) {
      e.preventDefault();
      var r = +rowEl.getAttribute('data-r');
      if (this._cb.row) this._cb.row(r);
      if (e.shiftKey && this._active) {
        this._replaceLast({ r1: Math.min(this._active.r, r), r2: Math.max(this._active.r, r),
          c1: 0, c2: this._colCount - 1 });
        return;
      }
      this._active = { r: r, c: 0 };
      this._beginDrag('row', r, 0, e);
      return;
    }

    if (cellEl) {
      e.preventDefault();
      var rr = +cellEl.getAttribute('data-r'), cc = +cellEl.getAttribute('data-c');
      var rc = this._clampRC(rr, cc);
      if (e.shiftKey && this._active) { this._extendTo(rc.r, rc.c); return; }
      this._active = { r: rc.r, c: rc.c };
      this._beginDrag('cell', rc.r, rc.c, e);
      return;
    }

    // 空白处:清除选区
    e.preventDefault();
    this.clearSelection();
  };

  Grid.prototype._beginDrag = function (mode, ar, ac, e) {
    var additive = !!(e.ctrlKey || e.metaKey);
    this._drag = {
      mode: mode, ar: ar, ac: ac, cr: ar, cc: ac,
      additive: additive,
      base: additive ? this._selections.slice() : [],
      lastX: e.clientX, lastY: e.clientY
    };
    this._liveDrag();
    if (!this._asRaf) {
      var self = this;
      this._asRaf = requestAnimationFrame(function () { self._asTick(); });
    }
  };

  Grid.prototype._onDragMove = function (e) {
    if (!this._drag) return;
    this._drag.lastX = e.clientX;
    this._drag.lastY = e.clientY;
    this._dragUpdate();
  };

  /** 由最后鼠标位置换算拖选目标格(越界收敛到边界格) */
  Grid.prototype._dragUpdate = function () {
    var d = this._drag;
    if (!d) return;
    var rect = this._body.getBoundingClientRect();
    var x = d.lastX - rect.left + this._body.scrollLeft - ROWHEAD_W;
    var y = d.lastY - rect.top + this._body.scrollTop - HEAD_H;
    var rc = this._clampRC(Math.floor(y / ROW_H), Math.floor(x / COL_W));
    if (rc.r !== d.cr || rc.c !== d.cc) {
      d.cr = rc.r; d.cc = rc.c;
      this._liveDrag();
    }
  };

  /** 拖选中:实时更新最后一块(base ∪ 当前块)并刷新覆盖层(不触发回调) */
  Grid.prototype._liveDrag = function () {
    var d = this._drag, b;
    if (d.mode === 'cell') b = normRect({ r: d.ar, c: d.ac }, { r: d.cr, c: d.cc });
    else if (d.mode === 'col') b = { r1: 0, r2: this._rowCount - 1,
      c1: Math.min(d.ac, d.cc), c2: Math.max(d.ac, d.cc) };
    else b = { r1: Math.min(d.ar, d.cr), r2: Math.max(d.ar, d.cr), c1: 0, c2: this._colCount - 1 };
    this._selections = d.base.concat([b]);
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
  };

  /** 拖选靠近边缘时自动滚动 */
  Grid.prototype._asTick = function () {
    if (!this._drag) { this._asRaf = 0; return; }
    var EDGE = 30, STEP = 16, moved = false;
    var rect = this._body.getBoundingClientRect();
    var x = this._drag.lastX, y = this._drag.lastY;
    if (x < rect.left + ROWHEAD_W + EDGE) { this._body.scrollLeft -= STEP; moved = true; }
    else if (x > rect.right - EDGE) { this._body.scrollLeft += STEP; moved = true; }
    if (y < rect.top + HEAD_H + EDGE) { this._body.scrollTop -= STEP; moved = true; }
    else if (y > rect.bottom - EDGE) { this._body.scrollTop += STEP; moved = true; }
    if (moved) this._dragUpdate();
    var self = this;
    this._asRaf = requestAnimationFrame(function () { self._asTick(); });
  };

  Grid.prototype._onDragUp = function () { this._finishDrag(); };
  Grid.prototype._onWinBlur = function () {
    if (this._drag) this._finishDrag();
  };

  /** 结束拖选:提交最后一块(Ctrl 下重复块=切换移除)并触发回调 */
  Grid.prototype._finishDrag = function () {
    var d = this._drag;
    if (!d) return;
    this._drag = null;
    var b = this._selections.length ? this._selections[this._selections.length - 1] : null;
    this._selections = d.base.slice();
    if (b) {
      var idx = -1;
      for (var i = 0; i < this._selections.length; i++) {
        var s = this._selections[i];
        if (s.r1 === b.r1 && s.r2 === b.r2 && s.c1 === b.c1 && s.c2 === b.c2) { idx = i; break; }
      }
      if (idx >= 0) this._selections.splice(idx, 1);
      else this._selections.push(b);
    }
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
    if (this._cb.sel) this._cb.sel(this.getSelections());
  };

  /** Shift+点击:把最后一块替换为 活动格→目标 的矩形 */
  Grid.prototype._extendTo = function (r, c) {
    var b = normRect(this._active, { r: r, c: c });
    this._replaceLast(b);
  };

  Grid.prototype._replaceLast = function (b) {
    var sels = this._selections.length
      ? this._selections.slice(0, this._selections.length - 1)
      : [];
    sels.push(b);
    this._selections = sels;
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
    if (this._cb.sel) this._cb.sel(this.getSelections());
  };

  Grid.prototype._selectAllWindow = function () {
    if (!this._rowCount) return;
    this._selections = [{ r1: 0, c1: 0, r2: this._rowCount - 1, c2: this._colCount - 1 }];
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
    if (this._cb.sel) this._cb.sel(this.getSelections());
  };

  // ---------- 键盘交互 ----------
  Grid.prototype._onKey = function (e) {
    if (!this._alive || !this._rowCount || this._drag) return;
    var meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this._selectAllWindow();
      return;
    }
    if (!this._active) this._active = { r: 0, c: 0 };
    var r = this._active.r, c = this._active.c;
    var page = Math.max(1, Math.floor(this._vh / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowUp': r--; break;
      case 'ArrowDown': r++; break;
      case 'ArrowLeft': c--; break;
      case 'ArrowRight': c++; break;
      case 'Home': if (meta) { r = 0; c = 0; } else { c = 0; } break;
      case 'End': if (meta) { r = this._rowCount - 1; c = this._colCount - 1; } else { c = this._colCount - 1; } break;
      case 'PageUp': r -= page; break;
      case 'PageDown': r += page; break;
      case 'Escape': this.clearSelection(); return;
      default: return;
    }
    e.preventDefault();
    var rc = this._clampRC(r, c);
    this._active = rc;
    this.scrollTo(rc.r, rc.c);
    this._renderSelection();
    this._renderHeaders();
    this._updateStatus();
  };

  return { grid: Grid };
});
