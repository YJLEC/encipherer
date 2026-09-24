/* Encipherer · util — 通用工具(DOM/编码/事件总线/下载)
 * UMD:浏览器挂到 window.Encipherer.util;Node 供测试 require */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Encipherer = root.Encipherer || {}; root.Encipherer.util = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var hasDom = typeof document !== 'undefined';

  /* ---------- DOM 快速构建 ---------- */
  // el('div', {class:'x', text:'hi', on:{click:fn}}, [children])
  function el(tag, attrs, children) {
    var d = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') d.className = attrs[k];
        else if (k === 'text') d.textContent = attrs[k];
        else if (k === 'html') d.innerHTML = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(d.style, attrs[k]);
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') d.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) d.setAttribute(k, attrs[k]);
      }
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined) return;
      d.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ---------- 编码 ---------- */
  function b64(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function hex(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return Array.prototype.map.call(u8, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  /* ---------- 杂项 ---------- */
  function uid(prefix) {
    var rnd = hasDom && window.crypto ? crypto.getRandomValues(new Uint8Array(8)) : require('crypto').randomBytes(8);
    return (prefix ? prefix + '_' : '') + hex(rnd);
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function nowIso() { return new Date().toISOString(); }
  // 让出一帧(重活前先渲染 loading);页面不可见时 rAF 不触发,以短超时兜底放行
  function nextFrame() {
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (!done) { done = true; resolve(); } }
      if (hasDom && typeof requestAnimationFrame === 'function') {
        try { requestAnimationFrame(fin); } catch (e) { /* 忽略 */ }
      }
      setTimeout(fin, 150);
    });
  }

  // 0 基行列 → 'B7' 式地址
  function a1(r, c) { return colName(c) + (r + 1); }
  function colName(c) {
    var s = '';
    c = c + 1;
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  /* ---------- 表头行智能识别(纯函数,Node 可测) ----------
   * rows[r][c] 为 {display} / 字符串 / null 之一;返回 {row: 0基行号|null, score}
   * 判定:前 maxScan 行里得分最高且 ≥0.6 的行视为表头;
   * "像表头" = 非空格多为短文本(≤15 字符且非纯数字/日期)且互不重复。全数字表等无表头形态返回 null。 */
  function detectHeaderRow(rows, maxScan) {
    maxScan = maxScan || 8;
    if (!rows || !rows.length) return { row: null, score: 0 };
    function textOf(cell) {
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'object') return String(cell.display != null ? cell.display : (cell.v != null ? cell.v : ''));
      return String(cell);
    }
    function scoreRow(r) {
      var texts = [], i;
      for (i = 0; i < (rows[r] || []).length; i++) {
        var t = textOf(rows[r][i]).trim();
        if (t) texts.push(t);
      }
      if (texts.length < 2) return -1; // 至少 2 个非空格才像表头
      var textLike = 0;
      texts.forEach(function (t) {
        if (t.length <= 15 && !/^\d+([.,]\d+)?$/.test(t) && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(t)) textLike++;
      });
      var uniq = {}; texts.forEach(function (t) { uniq[t] = 1; });
      var uniqN = Object.keys(uniq).length;
      return (textLike / texts.length) * 0.65 + (uniqN / texts.length) * 0.35;
    }
    var best = -1, bestScore = -1;
    var limit = Math.min(maxScan, rows.length);
    for (var r = 0; r < limit; r++) {
      var s = scoreRow(r);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (bestScore >= 0.6) return { row: best, score: bestScore };
    return { row: null, score: bestScore < 0 ? 0 : bestScore };
  }

  /* ---------- 下载 ---------- */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 3000);
  }

  /* ---------- 引号感知 CSV 行切分(单行,无内嵌换行) ---------- */
  function parseCSVLine(line) {
    var out = [], cur = '', inQ = false, i = 0;
    while (i < line.length) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cur += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { out.push(cur); cur = ''; i++; continue; }
      cur += ch; i++;
    }
    out.push(cur);
    return out;
  }

  /* ---------- CRC32 与仅 STORE 的极简 zip(供"打包下载") ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // files: [{name, data:Uint8Array}] → zip 字节(不压缩,数据已多为文本,体积可接受)
  function zipStore(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameB = enc.encode(f.name), data = f.data, crc = crc32(data);
      function u16(v) { return [v & 255, (v >> 8) & 255]; }
      function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
      var head = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
      parts.push(new Uint8Array(head), nameB, data);
      central.push({ nameB: nameB, crc: crc, size: data.length, offset: offset });
      offset += head.length + nameB.length + data.length;
    });
    var centParts = [], centLen = 0;
    central.forEach(function (e) {
      function u16(v) { return [v & 255, (v >> 8) & 255]; }
      function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
      var rec = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(e.crc), u32(e.size), u32(e.size), u16(e.nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset));
      centParts.push(new Uint8Array(rec), e.nameB);
      centLen += rec.length + e.nameB.length;
    });
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    var end = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centLen), u32(offset), u16(0));
    var total = offset + centLen + end.length;
    var out = new Uint8Array(total), pos = 0;
    parts.concat(centParts, [new Uint8Array(end)]).forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------- 事件总线 ---------- */
  var bus = (function () {
    var map = {};
    return {
      on: function (evt, fn) { (map[evt] = map[evt] || []).push(fn); },
      off: function (evt, fn) { map[evt] = (map[evt] || []).filter(function (f) { return f !== fn; }); },
      emit: function (evt, data) { (map[evt] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }
    };
  })();

  /* ---------- toast 与确认弹窗(仅浏览器) ---------- */
  function ensureToastHost() {
    var host = document.getElementById('ec-toasts');
    if (!host) {
      host = el('div', { id: 'ec-toasts', class: 'ec-toasts' });
      document.body.appendChild(host);
    }
    return host;
  }
  function toast(msg, kind) {
    if (!hasDom) { console.log('[' + (kind || 'info') + '] ' + msg); return; }
    kind = kind || 'info';
    var t = el('div', { class: 'ec-toast ec-toast-' + kind, text: msg });
    ensureToastHost().appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 350);
    }, kind === 'err' ? 5000 : 2800);
  }

  var confirmSeq = 0;
  function confirmDialog(opts) {
    if (!hasDom) return Promise.resolve(window.confirm(opts.title + '\n' + opts.body));
    opts = opts || {};
    return new Promise(function (resolve) {
      var id = 'ec-confirm-' + (++confirmSeq);
      var overlay = el('div', { class: 'ec-modal-overlay', id: id });
      var box = el('div', { class: 'ec-modal ec-modal-' + (opts.danger ? 'danger' : 'normal') });
      box.appendChild(el('h3', { text: opts.title || '确认' }));
      if (opts.body) box.appendChild(el('div', { class: 'ec-modal-body', html: opts.body }));
      var btns = el('div', { class: 'ec-modal-btns' });
      var cancel = el('button', { class: 'btn', type: 'button', text: opts.cancelText || '取消' });
      var ok = el('button', { class: 'btn btn-' + (opts.danger ? 'danger' : 'primary'), type: 'button', text: opts.confirmText || '确定' });
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(btns); overlay.appendChild(box); document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); });
      function close(v) {
        overlay.classList.remove('show');
        setTimeout(function () { overlay.remove(); }, 200);
        resolve(v);
      }
      cancel.addEventListener('click', function () { close(false); });
      ok.addEventListener('click', function () { close(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
      });
    });
  }

  return {
    el: el, esc: esc, b64: b64, unb64: unb64, hex: hex,
    uid: uid, debounce: debounce, fmtBytes: fmtBytes, fmtTime: fmtTime, nowIso: nowIso, nextFrame: nextFrame,
    a1: a1, colName: colName, detectHeaderRow: detectHeaderRow, download: download,
    parseCSVLine: parseCSVLine, crc32: crc32, zipStore: zipStore,
    bus: bus, toast: toast, confirmDialog: confirmDialog
  };
});
