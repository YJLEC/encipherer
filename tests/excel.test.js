'use strict';

// ============================================================================
// Encipherer.excel 单元测试(node --test tests/excel.test.js)
// 夹具全部用 SheetJS / ExcelJS 现场生成,无外部文件。
// 加载顺序模拟经典 script:先挂全局 XLSX / ExcelJS(window.XLSX 等),再加载模块。
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

globalThis.XLSX = require('../vendor/xlsx.full.min.js');
globalThis.ExcelJS = require('../vendor/exceljs.min.js');

const { excel } = require('../src/js/excel.js');

// —— 夹具与断言工具 ————————————————————————————————————————————————

// 用 SheetJS 生成多 sheet 工作簿字节(ArrayBuffer)
function buildFile(sheets, bookType) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
  }
  const out = XLSX.write(wb, { type: 'array', bookType: bookType || 'xlsx' });
  return out instanceof ArrayBuffer ? out : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function abOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// 取模型某格 display(自动处理行/格空洞)
function T(wb, sheet, r, c) {
  const sh = wb.sheets[sheet];
  const row = sh && sh.rows[r];
  return excel.cellText(row ? row[c] : null);
}

// 全表 display 快照(规整为 maxCols 宽;去掉尾部全空行,避免引擎间行尾差异)
function snapshot(wb) {
  return wb.sheets.map((sh) => {
    const rows = [];
    for (let r = 0; r < sh.rows.length; r++) {
      const row = [];
      for (let c = 0; c < sh.maxCols; c++) row.push(T(wb, wb.sheets.indexOf(sh), r, c));
      rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
    return rows;
  });
}

// 补丁后重新加载并返回快照(命中格替换为期望新文本)
async function reloadPatched(blob, fileName, before, patches) {
  const buf = await blob.arrayBuffer();
  const wb2 = await excel.loadFile(buf, fileName);
  const after = snapshot(wb2);
  for (const p of patches) {
    assert.equal(after[p.sheet][p.r][p.c], p.text, `补丁格 (${p.sheet},${p.r},${p.c}) 应为新文本`);
  }
  for (const p of patches) after[p.sheet][p.r][p.c] = before[p.sheet][p.r][p.c];
  assert.deepEqual(after, before, '除补丁格外,其余格 display 应与第一轮完全一致');
  return wb2;
}

// —— 基础 ————————————————————————————————————————————————————————

test('SUPPORTED 常量与不支持类型的拒绝', async () => {
  assert.deepEqual(excel.SUPPORTED, ['xlsx', 'xlsm', 'xls', 'csv']);
  const buf = buildFile([{ name: 'S', aoa: [['a']] }]);
  await assert.rejects(() => excel.loadFile(buf, 'x.txt'), /不支持的文件类型/);
  await assert.rejects(() => excel.loadFile(buf, 'x.pdf'), /不支持的文件类型/);
});

// —— 1. xlsx 往返(SheetJS 生成 → ExcelJS 引擎读取)———————————————————

test('xlsx 往返:多 sheet 模型正确,补丁只改命中格', async () => {
  const fixture = [
    {
      name: '人员',
      aoa: [
        ['姓名', '手机号', '备注'],
        ['张三', '13812345678', '备注一'],
        ['李四', 42, null],                 // 数字 + 格空洞
        ['王五', 0.25, '含,逗号']
      ]
    },
    {
      name: '计算',
      aoa: [
        ['合计', { t: 'n', f: 'SUM(1,2)', v: 3 }, null],                        // 公式(带缓存结果)
        ['日期', { t: 'n', v: 45292.5, z: 'yyyy-mm-dd hh:mm:ss' }, { t: 'n', v: 45292, z: 'yyyy-mm-dd' }],
        ['大数', 1234567890123456, '尾']
      ]
    }
  ];
  const wb = await excel.loadFile(buildFile(fixture, 'xlsx'), 'demo.xlsx');

  assert.equal(wb.engine, 'exceljs');
  assert.equal(wb.ext, 'xlsx');
  assert.equal(wb.lossy, false);
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, '人员');
  assert.equal(wb.sheets[1].name, '计算');
  assert.ok(wb.id && String(wb.id).startsWith('wb_'));

  // display 规则
  assert.equal(T(wb, 0, 1, 1), '13812345678');       // 字符串
  assert.equal(T(wb, 0, 2, 1), '42');                 // 数字
  assert.equal(T(wb, 0, 2, 2), '');                   // 格空洞
  assert.equal(T(wb, 0, 3, 1), '0.25');
  assert.equal(T(wb, 0, 3, 2), '含,逗号');
  assert.equal(T(wb, 1, 0, 1), '3');                  // 公式取结果文本
  assert.equal(T(wb, 1, 1, 1), '2024-01-01 12:00:00');// 日期含时分秒
  assert.equal(T(wb, 1, 1, 2), '2024-01-01');         // 纯日期只给日期部分
  assert.equal(T(wb, 1, 2, 1), '1234567890123456');   // 大数字不做科学计数法
  assert.equal(wb.sheets[0].rows.length, 4);

  // 补丁:一个字符串格 + 一个原为数字的格
  const before = snapshot(wb);
  const patches = [
    { sheet: 0, r: 1, c: 1, text: '139****0000' },
    { sheet: 0, r: 2, c: 1, text: '四十二' }
  ];
  const blob = await excel.patchAndExport(wb, patches);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await reloadPatched(blob, 'demo.xlsx', before, patches);

  // 模型同步:补丁后模型里也应是新文本
  assert.equal(T(wb, 0, 1, 1), '139****0000');
  assert.equal(wb.sheets[0].rows[2][1].t, 's');
});

// —— 2. ExcelJS 引擎明确触发(ExcelJS API 直接构造)———————————————————

test('ExcelJS 引擎:布尔/富文本/超链接/无缓存公式/日期,补丁往返', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.getCell('A1').value = '键';
  ws.getCell('B1').value = 3.5;
  ws.getCell('C1').value = true;
  ws.getCell('D1').value = 45292.5;
  ws.getCell('D1').numFmt = 'yyyy-mm-dd hh:mm:ss';          // 序列值 + 日期格式
  ws.getCell('E1').value = { richText: [{ text: '你好' }, { text: '世界' }] };
  ws.getCell('F1').value = { text: '站点', hyperlink: 'https://example.com/x' };
  ws.getCell('G1').value = { formula: 'SUM(B1,1)' };        // 无缓存结果
  ws.getCell('A2').value = '第二行';
  const out = await wb.xlsx.writeBuffer();
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);

  const model = await excel.loadFile(buf, 'js.xlsx');
  assert.equal(model.engine, 'exceljs');

  assert.equal(T(model, 0, 0, 0), '键');
  assert.equal(T(model, 0, 0, 1), '3.5');
  assert.equal(T(model, 0, 0, 2), 'TRUE');                   // 布尔
  assert.equal(T(model, 0, 0, 3), '2024-01-01 12:00:00');    // 日期
  assert.equal(T(model, 0, 0, 4), '你好世界');                // 富文本拼接
  assert.equal(T(model, 0, 0, 5), '站点');                    // 超链接取 text
  assert.equal(T(model, 0, 0, 6), '=SUM(B1,1)');              // 无结果 → '=公式'
  assert.equal(model.sheets[0].rows[0][2].t, 'b');

  const before = snapshot(model);
  const patches = [
    { sheet: 0, r: 0, c: 2, text: '否' },       // 原为布尔
    { sheet: 0, r: 0, c: 1, text: '三点五' }    // 原为数字
  ];
  const blob = await excel.patchAndExport(model, patches);
  const wb2 = await reloadPatched(blob, 'js.xlsx', before, patches);
  assert.equal(wb2.engine, 'exceljs');
});

// —— 3. xls 往返(SheetJS 生成,lossy)———————————————————————————————

test('xls 往返:engine=sheetjs 且 lossy=true,补丁保留未命中格', async () => {
  const fixture = [{
    name: 'S1',
    aoa: [
      ['a', 1234567890123456, true],
      ['b', { t: 'n', f: 'SUM(1,2)', v: 3 }, 0.5],
      ['c', '纯文本', null]
    ]
  }];
  const wb = await excel.loadFile(buildFile(fixture, 'xls'), '旧版.xls');
  assert.equal(wb.engine, 'sheetjs');
  assert.equal(wb.ext, 'xls');
  assert.equal(wb.lossy, true); // xls 写回降级

  assert.equal(T(wb, 0, 0, 1), '1234567890123456'); // SheetJS w 为科学计数法 → 展开修正
  assert.equal(T(wb, 0, 0, 2), 'TRUE');
  assert.equal(T(wb, 0, 1, 1), '3');
  assert.equal(T(wb, 0, 1, 2), '0.5');
  assert.equal(T(wb, 0, 2, 1), '纯文本');

  const before = snapshot(wb);
  const patches = [
    { sheet: 0, r: 0, c: 1, text: '已脱敏' },   // 原为大数字
    { sheet: 0, r: 1, c: 0, text: 'B2新' }
  ];
  const blob = await excel.patchAndExport(wb, patches);
  assert.equal(blob.type, 'application/vnd.ms-excel');
  const wb2 = await reloadPatched(blob, '旧版.xls', before, patches);
  assert.equal(wb2.engine, 'sheetjs');
  assert.equal(wb2.lossy, true);
});

test('xlsm 走 SheetJS 引擎且 lossy=true,补丁往返', async () => {
  const fixture = [{ name: '宏表', aoa: [['k1', 'v1'], ['k2', 'v2']] }];
  const wb = await excel.loadFile(buildFile(fixture, 'xlsm'), '宏.xlsm');
  assert.equal(wb.engine, 'sheetjs');
  assert.equal(wb.ext, 'xlsm');
  assert.equal(wb.lossy, true);

  const before = snapshot(wb);
  const patches = [{ sheet: 0, r: 1, c: 1, text: 'MASKED' }];
  const blob = await excel.patchAndExport(wb, patches);
  // 注意:Blob type 按 Fetch 规范被浏览器/Node 统一小写化
  assert.equal(blob.type, 'application/vnd.ms-excel.sheet.macroenabled.12');
  await reloadPatched(blob, '宏.xlsm', before, patches);
});

// —— 4. CSV —————————————————————————————————————————————————————————

test('csv:UTF-8 往返、空行跳过、BOM 写出与补丁', async () => {
  const text = '姓名,手机号\r\n张三,13812345678\r\n\r\n李四,42\r\n'; // 含完全空行
  const wb = await excel.loadFile(abOf(utf8(text)), '名单.csv');
  assert.equal(wb.engine, 'csv');
  assert.equal(wb.ext, 'csv');
  assert.equal(wb.lossy, false);
  assert.equal(wb.sheets.length, 1);
  assert.equal(wb.sheets[0].name, '名单');
  assert.equal(wb.sheets[0].rows.length, 3); // 空行被跳过
  assert.equal(wb.sheets[0].maxCols, 2);
  assert.equal(T(wb, 0, 0, 0), '姓名');
  assert.equal(T(wb, 0, 1, 1), '13812345678');
  assert.equal(T(wb, 0, 2, 1), '42');

  const before = snapshot(wb);
  const patches = [
    { sheet: 0, r: 1, c: 1, text: '139****0000' },
    { sheet: 0, r: 2, c: 1, text: '四十二' }   // 原为数字文本
  ];
  const blob = await excel.patchAndExport(wb, patches);
  assert.equal(blob.type, 'text/csv;charset=utf-8');

  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0xEF); assert.equal(bytes[1], 0xBB); assert.equal(bytes[2], 0xBF); // BOM
  const outText = new TextDecoder('utf-8').decode(bytes.subarray(3));
  assert.ok(outText.indexOf('\r\n') !== -1, '行尾应为 CRLF');
  assert.ok(outText.indexOf('\n张三,139****0000\r') !== -1 || outText.indexOf('张三,139****0000') !== -1);
  await reloadPatched(blob, '名单.csv', before, patches);
});

test('csv:含逗号/引号/字段内换行的往返', async () => {
  const fields = ['a,b', 'say "hi"', '第一行\n第二行', '带"引号,逗号', '普通'];
  const quoted = fields.map((f) => '"' + f.replace(/"/g, '""') + '"').join(',');
  const src = quoted + '\r\n' + '"尾部,""x"\r\n'; // 第二行:字段本身含逗号与双写引号(值:尾部,"x)
  const wb = await excel.loadFile(abOf(utf8(src)), 'special.csv');
  assert.equal(T(wb, 0, 0, 0), 'a,b');
  assert.equal(T(wb, 0, 0, 1), 'say "hi"');
  assert.equal(T(wb, 0, 0, 2), '第一行\n第二行');
  assert.equal(T(wb, 0, 0, 3), '带"引号,逗号');
  assert.equal(T(wb, 0, 0, 4), '普通');
  assert.equal(T(wb, 0, 1, 0), '尾部,"x');

  // 导出再读回:值不变
  const before = snapshot(wb);
  const blob = await excel.patchAndExport(wb, []);
  await reloadPatched(blob, 'special.csv', before, []);
});

test('csv:GBK 编码检测', async () => {
  // 固定字节:GBK 的 "中文" = D6 D0 CE C4,后接 ascii ",abc\r\n"
  const bytes = Buffer.concat([Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]), Buffer.from(',abc\r\n')]);
  const wb = await excel.loadFile(abOf(bytes), 'gbk.csv');
  assert.equal(wb.engine, 'csv');
  assert.equal(wb.encoding, 'gbk');
  assert.equal(T(wb, 0, 0, 0), '中文');
  assert.equal(T(wb, 0, 0, 1), 'abc');
});

test('csv:UTF-8 BOM 存在时正确去除', async () => {
  const src = '\uFEFF姓,名\r\n甲,乙\r\n';
  const wb = await excel.loadFile(abOf(utf8(src)), 'bom.csv');
  assert.equal(T(wb, 0, 0, 0), '姓'); // 首格不应残留 BOM 字符
  assert.equal(T(wb, 0, 1, 1), '乙');
});

test('csv:exportCSVFromModel 序列化(BOM/CRLF/引号转义/null 为空)', async () => {
  const rows = [
    ['a,b', 'say "hi"', 'line1\nline2'],
    ['plain', null, '123']
  ];
  const blob = excel.exportCSVFromModel(rows);
  assert.equal(blob.type, 'text/csv;charset=utf-8');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, '应写入 UTF-8 BOM');
  // ignoreBOM:true 让解码器把 U+FEFF 当内容保留,便于整体比对
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
  const expected =
    '"a,b","say ""hi""","line1\nline2"\r\n' +
    'plain,,123\r\n';
  assert.equal(text, expected);
});

// —— 5. cellText ——————————————————————————————————————————————————————

test('cellText:各类型与空值', () => {
  assert.equal(excel.cellText(null), '');
  assert.equal(excel.cellText(undefined), '');
  assert.equal(excel.cellText({ v: 'x', t: 's', display: 'x' }), 'x');
  assert.equal(excel.cellText({ v: 1, t: 'n', display: '1.00' }), '1.00');
  assert.equal(excel.cellText({ v: true, t: 'b', display: 'TRUE' }), 'TRUE');
  assert.equal(excel.cellText({ v: null, t: 's', display: '' }), '');
  assert.equal(excel.cellText({ v: 'a', t: 's' }), ''); // 缺 display 视为空
});

// —— 6. 扩展名大小写 ————————————————————————————————————————————————

test('扩展名大小写不敏感(.XLSX / .CSV)', async () => {
  const xbuf = buildFile([{ name: 'S', aoa: [['a', 1]] }], 'xlsx');
  const wb = await excel.loadFile(xbuf, 'DATA.XLSX');
  assert.equal(wb.ext, 'xlsx');
  assert.equal(wb.engine, 'exceljs');
  assert.equal(T(wb, 0, 0, 1), '1');

  const wb2 = await excel.loadFile(abOf(utf8('a,b\r\n')), 'LIST.CSV');
  assert.equal(wb2.ext, 'csv');
  assert.equal(wb2.engine, 'csv');
});

// —— 补丁坐标非法 ————————————————————————————————————————————————————

test('patchAndExport:非法坐标拒绝', async () => {
  const wb = await excel.loadFile(buildFile([{ name: 'S', aoa: [['a']] }]), 'x.xlsx');
  await assert.rejects(() => excel.patchAndExport(wb, [{ sheet: 5, r: 0, c: 0, text: 'x' }]), /坐标非法/);
  await assert.rejects(() => excel.patchAndExport(wb, [{ sheet: 0, r: -1, c: 0, text: 'x' }]), /坐标非法/);
  await assert.rejects(() => excel.patchAndExport(null, []), /工作簿/);
});
