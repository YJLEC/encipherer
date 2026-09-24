/* eslint-disable */
// ============================================================================
// Encipherer · 表格隐私卫士 — Excel/CSV 读写模块(挂载为 Encipherer.excel)
// 见 docs/ARCHITECTURE.md §1.2 / §2.4。
//
// 职责:
//   1. 读取 xlsx / xlsm / xls / csv → 统一工作簿模型(Workbook/SheetModel/Cell);
//   2. 按坐标补丁单元格后导出(未命中格原样保留,样式尽量保真)。
//
// 引擎路由(按扩展名,大小写不敏感):
//   xlsx → ExcelJS(样式保真);xlsm / xls → SheetJS(写回降级,lossy=true);csv → 内置。
//
// 依赖通过 globalThis.XLSX / globalThis.ExcelJS 取用(经典 script 下即 window 上的全局,
// 由 vendor/xlsx.full.min.js 与 vendor/exceljs.min.js 提供;Node 测试先挂到 globalThis)。
//
// 日期说明:两个引擎读出的 Date 均按 UTC 语义构造(Excel 序列值本身无时区),
// 因此 display 统一用 UTC 分量格式化,保证任何时区下结果一致。
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Encipherer = root.Encipherer || {}; var m = factory(root.Encipherer);
    for (var k in m) root.Encipherer[k] = m[k]; }
})(typeof self !== 'undefined' ? self : this, function (E) { E = E || {};

  'use strict';

  // —— 常量 ———————————————————————————————————————————————————————————————

  var SUPPORTED = ['xlsx', 'xlsm', 'xls', 'csv'];

  var MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv;charset=utf-8'
  };

  // 工作簿 id 序号(同毫秒多次创建时防撞)
  var SEQ = 0;

  // —— 小工具 ————————————————————————————————————————————————————————————

  // 取扩展名(小写);'DATA.XLSX' → 'xlsx'
  function extOf(fileName) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(fileName || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // 取不含路径与扩展名的基名(csv 的 sheet 名用)
  function baseName(fileName) {
    var s = String(fileName || 'CSV');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i >= 0) s = s.slice(i + 1);
    return s.replace(/\.[A-Za-z0-9]+$/, '') || 'CSV';
  }

  function wbId() {
    return 'wb_' + Date.now().toString(36) + '_' + (SEQ++).toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  function p2(n) { return n < 10 ? '0' + n : '' + n; }

  // Date → 'YYYY-MM-DD HH:mm:ss';无时分秒(纯日期)时只给日期部分。
  // 用 UTC 分量:引擎把 Excel 序列值按 UTC 语义还原(见文件头说明)。
  function fmtDate(d) {
    var y = d.getUTCFullYear(), mo = p2(d.getUTCMonth() + 1), da = p2(d.getUTCDate());
    var h = d.getUTCHours(), mi = d.getUTCMinutes(), se = d.getUTCSeconds();
    if (h || mi || se || d.getUTCMilliseconds()) {
      return y + '-' + mo + '-' + da + ' ' + p2(h) + ':' + p2(mi) + ':' + p2(se);
    }
    return y + '-' + mo + '-' + da;
  }

  // 数字 → 无科学计数法的字符串。
  // 约定:|v| 在 1e-6 ~ 1e15 之间直接 String(JS 在该区间不会产生科学计数法);
  // 超界时 String 可能给出 1e+21 / 1.5e-7 形式,手工展开为定点表示;整数不带小数点。
  function fmtNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n); // NaN / Infinity
    var a = Math.abs(n);
    if (a === 0 || (a >= 1e-6 && a < 1e15)) return String(n);
    var s = String(n);
    var m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
    if (!m) return s; // 超界但 String 仍给出定点形式(如 1e16)则原样返回
    var sign = m[1], digits = m[2] + (m[3] || ''), point = m[2].length + parseInt(m[4], 10);
    var out;
    if (point <= 0) out = '0.' + new Array(1 - point).join('0') + digits;
    else if (point >= digits.length) out = digits + new Array(point - digits.length + 1).join('0');
    else out = digits.slice(0, point) + '.' + digits.slice(point);
    if (out.indexOf('.') !== -1) out = out.replace(/0+$/, '').replace(/\.$/, ''); // 去尾随零
    return sign + out;
  }

  // Cell.display:永不为 undefined;空格返回 ''
  function cellText(cell) {
    return cell && typeof cell.display === 'string' ? cell.display : '';
  }

  // ——————————————————————————————————————————————————————————————————————
  // ExcelJS 路径(.xlsx)
  // ——————————————————————————————————————————————————————————————————————

  // ExcelJS 单元格值 → Cell|null(display 规则见 ARCHITECTURE.md §2.4)
  function cellFromExcelJS(cell) {
    var v = cell ? cell.value : null;
    if (v === null || v === undefined) return null;
    if (v instanceof Date) { var d = fmtDate(v); return { v: d, t: 's', display: d }; }
    if (typeof v === 'number') return { v: v, t: 'n', display: fmtNumber(v) };
    if (typeof v === 'boolean') return { v: v, t: 'b', display: v ? 'TRUE' : 'FALSE' };
    if (typeof v === 'string') return { v: v, t: 's', display: v };
    if (typeof v === 'object') {
      // 错误值(如 #DIV/0!):原样字符串
      if (v.error !== undefined && v.error !== null) {
        var es = String(v.error); return { v: es, t: 's', display: es };
      }
      // 公式:优先计算结果文本,无缓存结果则给 '=公式'
      if (v.formula !== undefined || v.sharedFormula !== undefined) {
        var f = v.formula !== undefined ? v.formula : v.sharedFormula;
        var r = v.result;
        var disp = (r === null || r === undefined) ? '=' + f : String(r);
        var pv = (typeof r === 'number' || typeof r === 'boolean' || typeof r === 'string') ? r : disp;
        var pt = typeof r === 'number' ? 'n' : (typeof r === 'boolean' ? 'b' : 's');
        return { v: pv, t: pt, display: disp };
      }
      // 富文本:拼接各段 text
      if (v.richText && v.richText.length) {
        var txt = '';
        for (var i = 0; i < v.richText.length; i++) {
          txt += v.richText[i] && v.richText[i].text != null ? String(v.richText[i].text) : '';
        }
        return { v: txt, t: 's', display: txt };
      }
      // 超链接:显示文本(无文本则显示地址)
      if (v.hyperlink !== undefined) {
        var t = v.text != null ? String(v.text) : String(v.hyperlink);
        return { v: t, t: 's', display: t };
      }
      // 其余对象兜底:尽力字符串化
      try { var s2 = String(v); return { v: s2, t: 's', display: s2 }; } catch (e) { return null; }
    }
    return null;
  }

  async function loadExcelJS(arrayBuffer, fileName, ext) {
    var ExcelJS = globalThis.ExcelJS;
    if (!ExcelJS || !ExcelJS.Workbook) throw new Error('ExcelJS 依赖未加载');
    var ewb = new ExcelJS.Workbook();
    // Node 下 load 需要 Buffer;浏览器下直接给 ArrayBuffer(两者此打包版都支持)
    var data = arrayBuffer;
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      try { data = Buffer.from(arrayBuffer); } catch (e) { /* 保持原样传入 */ }
    }
    await ewb.xlsx.load(data);

    var sheets = [];
    ewb.worksheets.forEach(function (ws) {
      var rows = [];   // (Cell|null)[][],行空洞为空数组,格空洞为 null
      var maxCols = 0;
      ws.eachRow({ includeEmpty: true }, function (row, rowNumber) {
        while (rows.length < rowNumber - 1) rows.push([]); // 行空洞
        var cells = [];
        var rowMax = 0;
        row.eachCell({ includeEmpty: true }, function (cell, colNumber) {
          while (cells.length < colNumber - 1) cells.push(null); // 列空洞
          cells[colNumber - 1] = cellFromExcelJS(cell);
          if (colNumber > rowMax) rowMax = colNumber;
        });
        rows[rowNumber - 1] = cells;
        if (rowMax > maxCols) maxCols = rowMax;
      });
      sheets.push({ name: ws.name, rows: rows, maxCols: maxCols });
    });

    return {
      id: wbId(), name: String(fileName), ext: ext, engine: 'exceljs',
      sheets: sheets, lossy: false, _raw: ewb
    };
  }

  // ——————————————————————————————————————————————————————————————————————
  // SheetJS 路径(.xls / .xlsm,写回降级 → lossy)
  // ——————————————————————————————————————————————————————————————————————

  // SheetJS 底格 + sheet_to_json 的 display → Cell|null
  function cellFromSheetJS(sc, disp) {
    var noDisp = disp === null || disp === undefined || disp === '';
    if (!sc || sc.t === 'z' || sc.v === null || sc.v === undefined) {
      return noDisp ? null : { v: String(disp), t: 's', display: String(disp) };
    }
    // 日期(cellDates:true 时 v 为 Date,UTC 语义)→ 统一 'YYYY-MM-DD HH:mm:ss'
    if (sc.t === 'd' || sc.v instanceof Date) {
      var d = fmtDate(sc.v); return { v: d, t: 's', display: d };
    }
    if (sc.t === 'b') {
      var bd = typeof disp === 'string' && disp !== '' ? disp : (sc.v ? 'TRUE' : 'FALSE');
      return { v: !!sc.v, t: 'b', display: bd };
    }
    if (sc.t === 'n') {
      // 优先用引擎格式化结果;若出现科学计数法(如 1.23457E+15)则用原始数值展开
      var nd;
      if (typeof disp === 'string' && disp !== '' && !/[eE]/.test(disp)) nd = disp;
      else nd = fmtNumber(sc.v);
      return { v: sc.v, t: 'n', display: nd };
    }
    if (sc.t === 'e') {
      var ev = String(noDisp ? sc.v : disp); return { v: ev, t: 's', display: ev };
    }
    // 字符串格
    var sv = String(noDisp ? sc.v : disp);
    return { v: sv, t: 's', display: sv };
  }

  function sheetFromSheetJS(ws, name) {
    var XLSX = globalThis.XLSX;
    var range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref'])
                           : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    // 基础 display 走 sheet_to_json(raw:false → 引擎格式化文本;defval:null → 空洞为 null;
    // blankrows:true → 保留空行),再对日期/科学计数法数字逐格修正
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: true }) || [];
    var rows = [], R, C;
    for (R = 0; R <= range.e.r; R++) {
      var src = aoa[R] || [];
      var cells = [];
      for (C = 0; C <= range.e.c; C++) {
        var disp = src[C] === undefined ? null : src[C];
        cells.push(cellFromSheetJS(ws[XLSX.utils.encode_cell({ r: R, c: C })], disp));
      }
      rows.push(cells);
    }
    // 去掉尾部整行皆空的行(模型只保留到最后一个有内容的行)
    while (rows.length && !rows[rows.length - 1].some(Boolean)) rows.pop();
    return { name: name, rows: rows, maxCols: range.e.c + 1 };
  }

  function loadSheetJS(arrayBuffer, fileName, ext) {
    var XLSX = globalThis.XLSX;
    if (!XLSX) throw new Error('SheetJS 依赖未加载');
    var u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    // cellDates:true → 日期为 Date;bookVBA:true → xlsm 尽量保留宏(写回仍可能降级)
    var wb = XLSX.read(u8, { type: 'array', cellDates: true, bookVBA: true });
    wb._enciphererBookType = ext; // 记住原 bookType,导出时按原格式写回
    var sheets = [];
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var name = wb.SheetNames[i];
      sheets.push(sheetFromSheetJS(wb.Sheets[name], name));
    }
    return {
      id: wbId(), name: String(fileName), ext: ext, engine: 'sheetjs',
      sheets: sheets,
      // xls/xlsm 写回会降级样式/宏 → 标注 lossy,UI 提示"将降级"
      lossy: true,
      _raw: wb
    };
  }

  // ——————————————————————————————————————————————————————————————————————
  // CSV 路径(内置解析:编码自适应 UTF-8 / BOM / GBK)
  // ——————————————————————————————————————————————————————————————————————

  // 字节 → 文本。顺序:UTF-8 BOM → utf-8;否则 utf-8 试解码统计 U+FFFD 占比,
  // >1% 再用 GBK 解(GBK 仍失败则按 utf-8 用);TextDecoder('gbk') 构造本身抛错
  // (极旧 Node)则回退 latin1 并在首格 display 上标注。
  function decodeBytes(u8) {
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), enc: 'utf-8' }; // BOM 已剥离
    }
    var utf8 = new TextDecoder('utf-8').decode(u8); // 非严格:坏字节 → U+FFFD
    var bad = 0, i;
    for (i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xFFFD) bad++;
    if (!(utf8.length > 0 && bad > utf8.length * 0.01)) return { text: utf8, enc: 'utf-8' };
    try {
      var gbk = new TextDecoder('gbk').decode(u8);
      if (gbk.indexOf('\uFFFD') === -1) return { text: gbk, enc: 'gbk' };
    } catch (e) {
      // 回退 latin1:加中文标注前缀(会落在首行首格 display 上,提示编码识别失败)
      var l1 = utf8;
      try { l1 = new TextDecoder('latin1').decode(u8); } catch (e2) { /* 保持 utf-8 结果 */ }
      return { text: '[编码识别失败,已按 latin1 解码] ' + l1, enc: 'latin1' };
    }
    return { text: utf8, enc: 'utf-8' }; // GBK 解仍有替换符 → 按 utf-8 用
  }

  // 引号感知 CSV 解析:支持 \r\n / \n 行尾、字段内换行、双写引号转义。
  // 完全空行(整行无逗号且无内容)统一跳过。
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    function endRow() { row.push(field); field = ''; rows.push(row); row = []; }
    while (i < n) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; } // 双写引号 → 字面引号
          else { inQ = false; i++; }
        } else { field += ch; i++; }
      } else if (ch === '"') { inQ = true; i++; }
      else if (ch === ',') { row.push(field); field = ''; i++; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i += 2; else i++;
        endRow();
      } else { field += ch; i++; }
    }
    if (field !== '' || row.length > 0 || inQ) endRow(); // 收尾(无行尾换行时)
    return rows.filter(function (r) {
      return !(r.length === 0 || (r.length === 1 && r[0] === '')); // 跳过完全空行
    });
  }

  function loadCSV(arrayBuffer, fileName) {
    var u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var dec = decodeBytes(u8);
    var fields = parseCSV(dec.text);
    var rows = [], maxCols = 0;
    fields.forEach(function (fs) {
      var cells = [];
      for (var c = 0; c < fs.length; c++) {
        cells.push(fs[c] === '' ? null : { v: fs[c], t: 's', display: fs[c] });
      }
      if (cells.length > maxCols) maxCols = cells.length;
      rows.push(cells);
    });
    return {
      id: wbId(), name: String(fileName), ext: 'csv', engine: 'csv',
      sheets: [{ name: baseName(fileName), rows: rows, maxCols: maxCols }],
      lossy: false, encoding: dec.enc, _raw: null
    };
  }

  // ——————————————————————————————————————————————————————————————————————
  // 导出(补丁 → Blob)
  // ——————————————————————————————————————————————————————————————————————

  // 把补丁同步写回模型(保持模型与导出一致;csv 的导出直接序列化模型)
  function applyToModel(workbook, p) {
    var sh = workbook.sheets[p.sheet];
    while (sh.rows.length <= p.r) sh.rows.push([]);
    var rw = sh.rows[p.r];
    while (rw.length <= p.c) rw.push(null);
    rw[p.c] = { v: p.text, t: 's', display: p.text };
    if (p.c + 1 > sh.maxCols) sh.maxCols = p.c + 1;
  }

  // CSV 字段序列化:含 , " \r \n 时用双引号包裹并转义内部引号;null/undefined → 空
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // 模型行序列化(\uFEFF BOM + \r\n 行尾)
  function serializeModelRows(sheet) {
    var lines = [];
    for (var r = 0; r < sheet.rows.length; r++) {
      var rw = sheet.rows[r] || [];
      var fields = [];
      for (var c = 0; c < sheet.maxCols; c++) fields.push(csvEscape(cellText(rw[c])));
      lines.push(fields.join(','));
    }
    return '\uFEFF' + (lines.length ? lines.join('\r\n') + '\r\n' : '');
  }

  async function patchAndExport(workbook, patches) {
    if (!workbook || !workbook.sheets) throw new Error('工作簿对象非法');
    patches = patches || [];
    // 先整体校验补丁坐标,避免产生"半应用"状态
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i];
      if (!p || typeof p.sheet !== 'number' || typeof p.r !== 'number' || typeof p.c !== 'number' ||
          !isFinite(p.sheet) || !isFinite(p.r) || !isFinite(p.c) ||
          p.sheet < 0 || p.sheet >= workbook.sheets.length || p.r < 0 || p.c < 0) {
        throw new Error('补丁坐标非法(需为 0 基且落在已有 sheet 内)');
      }
      if (typeof p.text !== 'string') throw new Error('补丁 text 必须是字符串');
    }
    if (workbook.engine === 'exceljs') return exportExcelJS(workbook, patches);
    if (workbook.engine === 'sheetjs') return exportSheetJS(workbook, patches);
    return exportCSVWorkbook(workbook, patches); // engine === 'csv'
  }

  // ExcelJS:xlsx 直接改 cell.value 后 writeBuffer(未命中格样式原样保留)
  async function exportExcelJS(workbook, patches) {
    var ewb = workbook._raw;
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i];
      var ws = ewb.worksheets[p.sheet]; // worksheets 数组顺序即文件内 sheet 顺序
      ws.getCell(p.r + 1, p.c + 1).value = p.text; // 1 基;数字格补丁成字符串
      applyToModel(workbook, p);
    }
    var buf = await ewb.xlsx.writeBuffer();
    return new Blob([buf], { type: MIME.xlsx });
  }

  // SheetJS:xls / xlsm 按原 bookType 写回(样式/宏可能降级 → lossy 已在读取时标注)
  function exportSheetJS(workbook, patches) {
    var XLSX = globalThis.XLSX;
    var wb = workbook._raw;
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i];
      var ws = wb.Sheets[wb.SheetNames[p.sheet]];
      var addr = XLSX.utils.encode_cell({ r: p.r, c: p.c });
      var nc = { t: 's', v: p.text };
      var old = ws[addr];
      if (old && old.z) nc.z = old.z; // 原格有数字格式则拷贝,尽量保真
      ws[addr] = nc;
      // 补丁越界时扩展 !ref
      if (ws['!ref']) {
        var rg = XLSX.utils.decode_range(ws['!ref']);
        if (p.r < rg.s.r) rg.s.r = p.r; if (p.r > rg.e.r) rg.e.r = p.r;
        if (p.c < rg.s.c) rg.s.c = p.c; if (p.c > rg.e.c) rg.e.c = p.c;
        ws['!ref'] = XLSX.utils.encode_range(rg);
      } else {
        ws['!ref'] = addr + ':' + addr;
      }
      applyToModel(workbook, p);
    }
    var bookType = wb._enciphererBookType || 'xlsx';
    var out = XLSX.write(wb, { type: 'array', bookType: bookType });
    return Promise.resolve(new Blob([out], { type: MIME[bookType] || MIME.xls }));
  }

  // CSV:补丁直接改模型,再序列化
  function exportCSVWorkbook(workbook, patches) {
    for (var i = 0; i < patches.length; i++) applyToModel(workbook, patches[i]);
    return Promise.resolve(new Blob([serializeModelRows(workbook.sheets[0])], { type: MIME.csv }));
  }

  // 字符串二维数组 → CSV Blob(供映射表明文导出等;null/undefined 序列化为空)
  function exportCSVFromModel(rows) {
    var lines = [];
    var src = rows || [];
    for (var r = 0; r < src.length; r++) {
      var rw = src[r] || [];
      var fields = [];
      for (var c = 0; c < rw.length; c++) fields.push(csvEscape(rw[c]));
      lines.push(fields.join(','));
    }
    return new Blob(['\uFEFF' + (lines.length ? lines.join('\r\n') + '\r\n' : '')], { type: MIME.csv });
  }

  // ——————————————————————————————————————————————————————————————————————
  // 入口
  // ——————————————————————————————————————————————————————————————————————

  // 按扩展名选引擎读取文件(arrayBuffer 可为 ArrayBuffer / TypedArray)
  async function loadFile(arrayBuffer, fileName) {
    var ext = extOf(fileName);
    if (SUPPORTED.indexOf(ext) === -1) {
      throw new Error('不支持的文件类型 ".' + ext + '"(支持:' + SUPPORTED.join(' / ') + ')');
    }
    try {
      if (ext === 'xlsx') return await loadExcelJS(arrayBuffer, fileName, ext);
      if (ext === 'xlsm' || ext === 'xls') return loadSheetJS(arrayBuffer, fileName, ext);
      return loadCSV(arrayBuffer, fileName);
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      throw new Error('文件解析失败(' + fileName + '):' + msg);
    }
  }

  var Excel = {
    SUPPORTED: SUPPORTED,
    loadFile: loadFile,
    cellText: cellText,
    patchAndExport: patchAndExport,
    exportCSVFromModel: exportCSVFromModel
  };

  return { excel: Excel };
});
