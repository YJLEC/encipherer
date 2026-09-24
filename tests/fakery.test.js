'use strict';
/**
 * fakery.test.js — Encipherer.fakery 单元测试(node:test)
 * 覆盖:确定性 / 唯一性 / 格式保真 / detect 正反例 / normalize / suggest 弱建议
 * 运行:node --test tests/fakery.test.js
 * 注意:校验算法(idcard GB11643、Luhn)在测试侧独立实现,避免与实现同源。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const fakery = require('../src/js/fakery.js').fakery;

/* ===================== 测试侧工具(独立实现) ===================== */

/** 由标签+序号派生 64 hex 种子(确定性) */
function seedOf(tag, i) {
  return crypto.createHash('sha256').update('encipherer|' + tag + '|' + i).digest('hex');
}

/** GB11643 身份证校验位(前 17 位 → '0'-'9'|'X') */
function idcardCheck(body17) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const M = '10X98765432';
  let s = 0;
  for (let i = 0; i < 17; i++) s += Number(body17[i]) * W[i];
  return M[s % 11];
}

/** Luhn 校验位(不含校验位的数字串 → 应追加的数字) */
function luhnCheckDigit(body) {
  let s = 0, dbl = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = Number(body[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    s += d;
    dbl = !dbl;
  }
  return String((10 - (s % 10)) % 10);
}
function luhnValid(n) { return /^\d+$/.test(n) && luhnCheckDigit(n.slice(0, -1)) === n.slice(-1); }
function luhnComplete(b) { return b + luhnCheckDigit(b); }

/** 某年某月天数(含闰年) */
function daysInMonth(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/* ===================== 测试数据 ===================== */

const ORIG = {
  phone: ['13812345678', '15901234567', '18687654321', '19912345678', '13566667777'],
  idcard: [
    '11010119900307851' + idcardCheck('11010119900307851'), // 110101199003078515
    '44030120021130456' + idcardCheck('44030120021130456'),
    '33010219951230563' + idcardCheck('33010219951230563'),
    '51010719880229152' + idcardCheck('51010719880229152'),
    '32010619900101234' + idcardCheck('32010619900101234')
  ],
  email: [
    'zhangsan@qq.com', 'Li.Na@163.com', 'user_01@gmail.com', 'wangfang2020@outlook.com',
    'chenjj@126.com', 'linyue@gmail.com', 'wanghai@163.com', 'sunli@126.com',
    'zhaomin@sina.com', 'zhoujie@foxmail.com'
  ],
  bankcard: [luhnComplete('622202123456'), luhnComplete('622202123456789'), luhnComplete('622202123456789012')], // 13/16/19 位
  studentid: ['2024123456', '241234567', 'G2024001'], // 4位年份 / 2位年份 / 非常规编号
  ip: ['192.168.1.23', '10.0.0.1', '172.16.254.3', '8.8.8.8', '2001:db8::1', 'fe80::1a2b:3c4d:5e6f:7a8b', '::1', '2607:f8b0:4005:80a::200e'],
  plate: ['京A12345', '粤B·12345', '沪C6K92B', '川A12345挂', '苏B·88888'],
  address: [
    '北京市海淀区中关村大街1号', '广东省佛山市禅城区汾江路216号', '上海市浦东新区世纪大道100号',
    '成都市锦江区春熙路8号', '杭州市西湖区文三路25号'
  ],
  generic: ['AB-2024-001', '备注栏', '某某数据123'],
  name: ['张伟', '王小明', '欧阳靖雯', 'Michael Johnson']
};

/* ===================== 1. API 表面 ===================== */

test('TYPES 与 TYPE_META 结构完整', () => {
  assert.deepEqual(fakery.TYPES, ['phone', 'idcard', 'email', 'name', 'bankcard', 'ip', 'plate', 'address', 'studentid', 'generic']);
  for (const k of fakery.TYPES) {
    const meta = fakery.TYPE_META[k];
    assert.ok(meta, '缺少 TYPE_META.' + k);
    assert.ok(typeof meta.label === 'string' && meta.label.length >= 2, k + ' label 应为中文');
    assert.match(meta.label, /[\u4e00-\u9fff]/, k + ' label 应含中文');
    assert.match(meta.color, /^#[0-9a-fA-F]{6}$/, k + ' color 应为 #rrggbb');
  }
  assert.equal(Object.keys(fakery.TYPE_META).length, 10);
});

/* ===================== 2. 确定性 ===================== */

test('确定性:同 (type, seedHex, originalStr, options) 两次生成完全一致', () => {
  for (const type of fakery.TYPES) {
    for (let i = 0; i < 3; i++) {
      const seed = seedOf('det-' + type, i);
      const orig = ORIG[type][i % ORIG[type].length];
      // 缺省 options、显式空对象、两种显式选项组合,均须逐位一致
      const optSets = [undefined, {}, { genericStyle: 'prefix', keepEmailDomain: false }];
      for (const opts of optSets) {
        const a = fakery.generate(type, seed, orig, opts);
        const b = fakery.generate(type, seed, orig, opts);
        assert.equal(a, b, type + ' #' + i + ' 同参两次结果不一致');
      }
    }
  }
});

test('确定性:options 语义生效(generic 前缀样式 / email 域名保留)', () => {
  const seed = seedOf('opt', 1);
  assert.match(fakery.generate('generic', seed, 'AB-2024-001'), /^[A-HJ-KM-NP-Z2-9]{5}$/);
  assert.match(fakery.generate('generic', seed, 'AB-2024-001', { genericStyle: 'short' }), /^[A-HJ-KM-NP-Z2-9]{5}$/);
  assert.match(fakery.generate('generic', seed, 'AB-2024-001', { genericStyle: 'prefix' }), /^T-[A-HJ-KM-NP-Z2-9]{5}$/);
  // 默认(不传第 4 参)保留原域名
  const keepDef = fakery.generate('email', seed, 'Zhang.San@QQ.com');
  assert.equal(keepDef.split('@')[1], 'qq.com');
  const keepOn = fakery.generate('email', seed, 'Zhang.San@QQ.com', { keepEmailDomain: true });
  assert.equal(keepOn.split('@')[1], 'qq.com');
});

/* ===================== 3. 唯一性 ===================== */

test('唯一性:不同 seed 生成 5000 个占位符无重复,且不与原值池冲突', () => {
  const N = 5000;
  for (const type of ['phone', 'idcard', 'email', 'bankcard', 'ip', 'plate', 'address', 'generic']) {
    const seen = new Set();
    const origs = ORIG[type];
    for (let i = 0; i < N; i++) {
      const ph = fakery.generate(type, seedOf('uniq-' + type, i), origs[i % origs.length]);
      assert.ok(!origs.includes(ph), type + ' 占位符与原值冲突: ' + ph);
      assert.ok(!seen.has(ph), type + ' 第 ' + i + ' 个占位符重复: ' + ph);
      seen.add(ph);
    }
    assert.equal(seen.size, N, type + ' 去重后数量不足');
  }
});

// 说明:中文姓名的"自然池"输出空间受生日界硬约束(2 字名 ≈ 姓数×字数 ≈ 10 万),
// 5000 采样必然碰撞;ARCHITECTURE §2.3 规定冲突由 workspace 以 counter 重派生 seed 兜底。
// 故 name 按长度分桶取安全规模:2 字 30 / 3 字 1200 / 4 字 1000,共 2230。
test('唯一性:name 按长度分桶无重复且不与原值冲突(规模受生日界限制,见注释)', () => {
  const buckets = [
    { origs: ['张伟', '李雷'], n: 30 },
    { origs: ['王小明', '陈静怡', '刘志强', '周婷亭', '吴桂芳', '郑晓明'], n: 1200 },
    { origs: ['欧阳靖雯', '司马建国', '上官云舒', '诸葛明月'], n: 1000 }
  ];
  const seen = new Set();
  const allOrig = buckets.flatMap(b => b.origs);
  for (const { origs, n } of buckets) {
    for (let i = 0; i < n; i++) {
      const ph = fakery.generate('name', seedOf('uniq-name-' + origs[0].length, i), origs[i % origs.length]);
      assert.ok(!allOrig.includes(ph), 'name 占位符与原值冲突: ' + ph);
      assert.ok(!seen.has(ph), 'name 占位符重复: ' + ph);
      seen.add(ph);
    }
  }
  assert.ok(seen.size >= 2200, 'name 唯一性样本量应达 2200+');
});

/* ===================== 4. 格式保真 ===================== */

test('格式保真:phone — 11 位,1 开头,第二位为真实号段(3/5/7/8/9)', () => {
  for (let i = 0; i < 100; i++) {
    const ph = fakery.generate('phone', seedOf('fmt-phone', i), ORIG.phone[i % 5]);
    assert.match(ph, /^1[3-9]\d{9}$/, '手机号格式: ' + ph);
    assert.ok('35789'.includes(ph[1]), '第二位应为真实号段: ' + ph);
    assert.ok(fakery.validatePlaceholder('phone', ph));
  }
});

test('格式保真:idcard — 18 位、出生日期合法(1900-2010)、GB11643 校验位正确(可为 X)', () => {
  let xCount = 0;
  for (let i = 0; i < 200; i++) {
    const ph = fakery.generate('idcard', seedOf('fmt-idcard', i), ORIG.idcard[i % 5]);
    assert.match(ph, /^\d{17}[\dX]$/, '身份证格式: ' + ph);
    assert.equal(ph.length, 18);
    assert.equal(idcardCheck(ph.slice(0, 17)), ph[17], '校验位错误: ' + ph);
    const y = Number(ph.substr(6, 4)), mo = Number(ph.substr(10, 2)), da = Number(ph.substr(12, 2));
    assert.ok(y >= 1900 && y <= 2010, '出生年份超界: ' + ph);
    assert.ok(mo >= 1 && mo <= 12 && da >= 1 && da <= daysInMonth(y, mo), '出生日期非法: ' + ph);
    if (ph[17] === 'X') xCount++;
    assert.ok(fakery.validatePlaceholder('idcard', ph));
  }
  // 区划码池规模(≥40):200 个样本应覆盖大量不同区划码
  const areas = new Set();
  for (let i = 0; i < 2000; i++) areas.add(fakery.generate('idcard', seedOf('pool-idcard', i), ORIG.idcard[0]).slice(0, 6));
  assert.ok(areas.size >= 40, '行政区划码池应 ≥40,实际覆盖 ' + areas.size);
});

test('格式保真:bankcard — 62 开头、Luhn 通过、长度与原值相同(13/16/19)', () => {
  const lens = [13, 16, 19];
  for (let L = 0; L < lens.length; L++) {
    const orig = ORIG.bankcard[L];
    assert.equal(orig.length, lens[L], '测试数据长度准备错误');
    for (let i = 0; i < 50; i++) {
      const ph = fakery.generate('bankcard', seedOf('fmt-bank-' + lens[L], i), orig);
      assert.ok(ph.startsWith('62'), '应 62 开头: ' + ph);
      assert.equal(ph.length, lens[L], '长度应与原值相同: ' + ph);
      assert.ok(luhnValid(ph), 'Luhn 校验失败: ' + ph);
      assert.ok(fakery.validatePlaceholder('bankcard', ph));
    }
  }
});

test('格式保真:email — 正则匹配、本地长度同量级、域名策略正确', () => {
  const RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  for (const orig of ORIG.email) {
    const origLocal = orig.split('@')[0];
    for (let i = 0; i < 20; i++) {
      const ph = fakery.generate('email', seedOf('fmt-email', i), orig);
      assert.match(ph, RE, '邮箱格式: ' + ph);
      const [local, domain] = ph.split('@');
      assert.ok(Math.abs(local.length - origLocal.length) <= 5, '本地部分长度应同量级: ' + orig + ' -> ' + ph);
      assert.equal(domain, orig.split('@')[1].toLowerCase(), '默认应保留原域名: ' + ph);
      assert.ok(fakery.validatePlaceholder('email', ph));
    }
    // 关闭域名保留:至少出现一个与原域名不同的结果(且全部合法)
    let diff = 0;
    for (let i = 0; i < 30; i++) {
      const ph = fakery.generate('email', seedOf('fmt-email-nd', i), orig, { keepEmailDomain: false });
      assert.match(ph, RE, '邮箱格式(换域名): ' + ph);
      if (ph.split('@')[1] !== orig.split('@')[1].toLowerCase()) diff++;
    }
    assert.ok(diff > 0, 'keepEmailDomain=false 应能产生不同域名: ' + orig);
  }
  // 域名池规模(≥5)行为验证
  const doms = new Set();
  for (let i = 0; i < 300; i++) doms.add(fakery.generate('email', seedOf('pool-email', i), 'a@b-c.de', { keepEmailDomain: false }).split('@')[1]);
  assert.ok(doms.size >= 5, '常见域名池应 ≥5,实际 ' + doms.size);
});

test('格式保真:name — 输出长度严格等于原值长度(中文/西文),字符集正确', () => {
  const cn = [['张伟'], ['李秀英'], ['王小明'], ['欧阳靖雯'], ['司马建国']];
  for (const [orig] of cn) {
    for (let i = 0; i < 20; i++) {
      const ph = fakery.generate('name', seedOf('fmt-name-cn-' + orig.length, i), orig);
      assert.equal(ph.length, orig.length, '中文姓名长度应等于原值: ' + orig + ' -> ' + ph);
      assert.match(ph, /^[\u4e00-\u9fff]+$/, '中文姓名应全为 CJK: ' + ph);
      assert.ok(fakery.validatePlaceholder('name', ph));
    }
  }
  const en = ['Michael Johnson', 'Emma Watson', 'John Smith', 'Li Na', 'JOHN SMITH'];
  for (const orig of en) {
    for (let i = 0; i < 20; i++) {
      const ph = fakery.generate('name', seedOf('fmt-name-en', i), orig);
      assert.equal(ph.length, orig.length, '西文姓名长度应等于原值: ' + orig + ' -> ' + ph);
      assert.match(ph, /^[A-Za-z][A-Za-z .'\-]*$/, '西文姓名字符集: ' + ph);
    }
  }
  // 全大写风格保持
  const up = fakery.generate('name', seedOf('fmt-name-up', 1), 'JOHN SMITH');
  assert.equal(up, up.toUpperCase(), '原值全大写时输出应保持大写: ' + up);
  // 池规模行为验证:单姓池 ≥100、名字用字池 ≥200、复姓池 ≥20
  const firsts = new Set(), givens = new Set();
  for (let i = 0; i < 3000; i++) {
    const p = fakery.generate('name', seedOf('pool-name', i), '张伟');
    firsts.add(p[0]); givens.add(p[1]);
  }
  assert.ok(firsts.size >= 100, '姓氏池应 ≥100,实际 ' + firsts.size);
  assert.ok(givens.size >= 200, '名字用字池应 ≥200,实际 ' + givens.size);
  const compounds = new Set();
  for (let i = 0; i < 2500; i++) compounds.add(fakery.generate('name', seedOf('pool-name4', i), '欧阳靖雯').slice(0, 2));
  assert.ok(compounds.size >= 20, '复姓池应 ≥20,实际 ' + compounds.size);
});

test('格式保真:ip — IPv4 各段 1-254;IPv6 生成合法全格式', () => {
  for (let i = 0; i < 100; i++) {
    const ph = fakery.generate('ip', seedOf('fmt-ip4', i), '192.168.1.23');
    const segs = ph.split('.');
    assert.equal(segs.length, 4, '应为四段: ' + ph);
    for (const s of segs) {
      const n = Number(s);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 254, 'IPv4 段应 1-254: ' + ph);
    }
    assert.ok(fakery.validatePlaceholder('ip', ph));
  }
  for (let i = 0; i < 100; i++) {
    const ph = fakery.generate('ip', seedOf('fmt-ip6', i), 'fe80::1a2b:3c4d:5e6f:7a8b');
    assert.match(ph, /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}$/, '应为合法 IPv6 全格式: ' + ph);
    assert.ok(fakery.validatePlaceholder('ip', ph));
  }
});

test('格式保真:plate — 符合规范正则,分隔符与特殊尾字保真', () => {
  const RE = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][·]?[A-HJ-NP-Z0-9]{4,5}[挂学警港澳]?$/;
  for (const orig of ORIG.plate) {
    for (let i = 0; i < 30; i++) {
      const ph = fakery.generate('plate', seedOf('fmt-plate', i), orig);
      assert.match(ph, RE, '车牌格式: ' + orig + ' -> ' + ph);
      assert.ok(fakery.validatePlaceholder('plate', ph));
      if (/[挂学警港澳]$/.test(orig)) assert.match(ph, /[挂学警港澳]$/, '原值带特殊尾字应保留: ' + ph);
    }
  }
  // 原值含"·"与空格分隔:生成值保留同样分隔
  for (let i = 0; i < 20; i++) {
    assert.equal(fakery.generate('plate', seedOf('fmt-plate-dot', i), '粤B·12345')[2], '·');
    const sp = fakery.generate('plate', seedOf('fmt-plate-sp', i), '京A 12345');
    assert.equal(sp[2], ' ', '空格分隔应保留: ' + sp);
    assert.ok(fakery.validatePlaceholder('plate', sp));
  }
});

test('格式保真:address — 长度同量级(±30%),含路名与中文', () => {
  for (const orig of ORIG.address) {
    const t = orig.length;
    for (let i = 0; i < 30; i++) {
      const ph = fakery.generate('address', seedOf('fmt-addr', i), orig);
      assert.ok(ph.length >= Math.ceil(t * 0.7) && ph.length <= Math.floor(t * 1.3),
        '地址长度应同量级(±30%): ' + orig + '(' + t + ') -> ' + ph + '(' + ph.length + ')');
      assert.match(ph, /[\u4e00-\u9fff]/, '地址应含中文: ' + ph);
      assert.match(ph, /[路街道]/, '地址应含路名: ' + ph);
      assert.ok(fakery.validatePlaceholder('address', ph));
    }
  }
  // 短地址(8 字)也应落在 ±30% 内
  for (let i = 0; i < 30; i++) {
    const ph = fakery.generate('address', seedOf('fmt-addr-s', i), '春熙路8号院');
    assert.ok(ph.length >= 5 && ph.length <= 10, '短地址长度: ' + ph + '(' + ph.length + ')');
  }
});

test('格式保真:generic — 5 位无歧义字符集(无 I/L/O/0/1),prefix 样式加 T-', () => {
  const RE = /^[A-HJ-KM-NP-Z2-9]{5}$/;
  for (let i = 0; i < 100; i++) {
    const ph = fakery.generate('generic', seedOf('fmt-generic', i), 'AB-2024-001');
    assert.match(ph, RE, 'generic 格式: ' + ph);
    assert.ok(!/[ILO01]/.test(ph), '不应含歧义字符: ' + ph);
    assert.ok(fakery.validatePlaceholder('generic', ph));
    const pf = fakery.generate('generic', seedOf('fmt-generic', i), 'AB-2024-001', { genericStyle: 'prefix' });
    assert.match(pf, /^T-[A-HJ-KM-NP-Z2-9]{5}$/, 'prefix 样式: ' + pf);
    assert.ok(fakery.validatePlaceholder('generic', pf));
  }
});

/* ===================== 5. detect 正反例 ===================== */

test('detect:phone — 正例(含分隔符/国际前缀)与反例', () => {
  const pos = ['13812345678', '+8615987654321', '158 8888 9999', '186-1234-5678', '138.1234.5678', '8613612345678'];
  for (const v of pos) {
    const r = fakery.detect(v);
    assert.ok(r && r.type === 'phone', '应检出手机号: ' + v);
    assert.ok(r.confidence > 0.5);
  }
  // 11 位且 Luhn 也通过 → 仍归 phone(优先级)
  assert.ok(luhnValid('13812340001'), '测试前提:该手机号应通过 Luhn');
  assert.equal(fakery.detect('13812340001').type, 'phone', 'Luhn 通过的 11 位手机号应归 phone');
  // 反例:号段不合法 / 长度不对 / 空值
  for (const v of ['12345678901', '23812345678', '1381234567', '138123456789', '', '   ']) {
    assert.equal(fakery.detect(v), null, '不应检出: "' + v + '"');
  }
  assert.equal(fakery.detect(null), null);
  assert.equal(fakery.detect(undefined), null);
});

test('detect:idcard — 正例(校验位正确,含 X)与反例(校验错不检出)', () => {
  for (const v of ORIG.idcard) {
    const r = fakery.detect(v);
    assert.ok(r && r.type === 'idcard', '应检出身份证: ' + v);
  }
  assert.equal(fakery.detect('33010219951230563X').type, 'idcard'); // 含 X 的合法证号
  // 反例:校验位错误(结尾 X 与正确数字不符 → 不满足任何强类型)
  assert.equal(fakery.detect('11010119900307851X'), null, '校验位错误不应检出');
  assert.equal(fakery.detect('110101199003078512'), null, '校验位错误且非 Luhn 不应检出');
  assert.equal(fakery.detect('110101199013078515'), null, '月份 13 非法不应检出');
  assert.equal(fakery.detect('110101199002308515'), null, '2 月 30 日不应检出');
});

test('detect:bankcard — 正例(Luhn 13-19 位)与优先级(idcard > phone > bankcard)', () => {
  for (const v of ORIG.bankcard) {
    const r = fakery.detect(v);
    assert.ok(r && r.type === 'bankcard', '应检出银行卡: ' + v);
  }
  // 18 位、Luhn 通过但身份证校验错 → bankcard(idcard 优先不命中)
  const luhnOnly = '110101199003078511'; // = body + luhn 校验位 1,身份证校验位应为 5
  assert.ok(luhnValid(luhnOnly) && idcardCheck(luhnOnly.slice(0, 17)) !== luhnOnly[17], '测试前提');
  assert.equal(fakery.detect(luhnOnly).type, 'bankcard', 'Luhn 通过的非身份证 18 位应归 bankcard');
  // 合法身份证即使在前 → idcard 优先
  assert.equal(fakery.detect(ORIG.idcard[0]).type, 'idcard');
  // 反例:非 Luhn、位数不足
  assert.equal(fakery.detect('6222021234560'), null, '13 位但 Luhn 不通过');
  assert.equal(fakery.detect('622202123456'), null, '12 位不足');
});

test('detect:email — 正例与反例', () => {
  const pos = ['a@b.com', 'zhang.san@qq.com', 'user_name+tag@sub.example.org', 'LI.NA@163.COM'];
  for (const v of pos) assert.equal(fakery.detect(v).type, 'email', '应检出邮箱: ' + v);
  for (const v of ['a@b', '@qq.com', 'a b@c.com', 'a@.com', 'plain text']) {
    assert.equal(fakery.detect(v), null, '不应检出邮箱: "' + v + '"');
  }
});

test('detect:ip — IPv4/IPv6 正例与反例', () => {
  const pos = ['192.168.1.23', '10.0.0.1', '255.255.255.255', '2001:db8::1', '::1', '::',
    'fe80:0:0:0:0:0:0:1', '2001:0db8:0000:0000:0000:ff00:0042:8329'];
  for (const v of pos) assert.equal(fakery.detect(v).type, 'ip', '应检出 IP: ' + v);
  for (const v of ['256.1.1.1', '1.2.3', '192.168.01.1', '1.2.3.4.5', '2001:db8::1::2', 'gg::1', '192.168.1']) {
    assert.equal(fakery.detect(v), null, '不应检出 IP: "' + v + '"');
  }
});

test('detect:plate — 正例与反例', () => {
  const pos = ['京A12345', '粤B·12345', '沪C6K92B', '使A12345', '川A12345挂', '京A1234'];
  for (const v of pos) assert.equal(fakery.detect(v).type, 'plate', '应检出车牌: ' + v);
  for (const v of ['京a12345', '京A123', 'A京12345', '京I12345', '京A123456', '冀O12345']) {
    assert.equal(fakery.detect(v), null, '不应检出车牌: "' + v + '"');
  }
});

test('detect:优先级顺序 idcard > phone > bankcard > email > ip > plate(结构性抽验)', () => {
  // 各类型典型值互不干扰
  assert.equal(fakery.detect(ORIG.idcard[0]).type, 'idcard');
  assert.equal(fakery.detect(ORIG.phone[0]).type, 'phone');
  assert.equal(fakery.detect(ORIG.bankcard[1]).type, 'bankcard');
  assert.equal(fakery.detect('a@b.com').type, 'email');
  assert.equal(fakery.detect('192.168.1.1').type, 'ip');
  assert.equal(fakery.detect('京A12345').type, 'plate');
});

/* ===================== 6. normalize ===================== */

test('normalize:各类型规范键', () => {
  // phone/idcard/bankcard 仅留数字
  assert.equal(fakery.normalize('phone', '138-1234 5678'), '13812345678');
  assert.equal(fakery.normalize('phone', '+86 138 1234 5678'), '8613812345678');
  assert.equal(fakery.normalize('idcard', ' 110101 1990 0307 851X '), '11010119900307851');
  assert.equal(fakery.normalize('bankcard', '6222 0212 3456 7890'), '6222021234567890');
  // email 去空格 + 小写
  assert.equal(fakery.normalize('email', '  Zhang.San@QQ.COM '), 'zhang.san@qq.com');
  // 其余 trim + 压缩连续空白
  assert.equal(fakery.normalize('name', '  张   三 '), '张 三');
  assert.equal(fakery.normalize('address', '北京市\r\n海淀区  中关村大街1号'), '北京市 海淀区 中关村大街1号');
  assert.equal(fakery.normalize('generic', '  a  b '), 'a b');
  assert.equal(fakery.normalize('unknown-type', ' x  y '), 'x y');
});

/* ===================== 7. suggest 弱建议 ===================== */

test('suggest:name/address 弱建议', () => {
  // 中文姓名:2-4 个 CJK、无数字
  for (const v of ['张伟', '李秀英', '欧阳靖雯']) {
    const s = fakery.suggest(v);
    assert.ok(s.some(x => x.type === 'name'), '应给出姓名建议: ' + v);
    assert.ok(s.every(x => x.confidence > 0 && x.confidence < 1));
  }
  // 单字 / 含数字 / 拉丁 → 不给姓名建议
  for (const v of ['张', '张伟1', 'Zhang', '张伟李赵钱']) {
    assert.ok(!fakery.suggest(v).some(x => x.type === 'name'), '不应给姓名建议: ' + v);
  }
  // 地址:含省市区县路街号栋单元室等关键词且长度 ≥6
  for (const v of ['北京市海淀区中关村大街1号', '广东省佛山市禅城区', '汾江路216号', '3栋2单元501室']) {
    assert.ok(fakery.suggest(v).some(x => x.type === 'address'), '应给地址建议: ' + v);
  }
  for (const v of ['汾江路', '区', 'hello world']) {
    assert.ok(!fakery.suggest(v).some(x => x.type === 'address'), '不应给地址建议: ' + v);
  }
});

test('suggest:强检测排最前,不与弱建议混淆', () => {
  const s1 = fakery.suggest('13812345678');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].type, 'phone');
  const s2 = fakery.suggest('110101199003078515');
  assert.equal(s2[0].type, 'idcard');
  // 无任何建议 → 空数组
  assert.deepEqual(fakery.suggest('abc123'), []);
  assert.deepEqual(fakery.suggest(''), []);
});

/* ===================== 8. validatePlaceholder 反例 ===================== */

test('validatePlaceholder:非法结构返回 false', () => {
  assert.equal(fakery.validatePlaceholder('phone', '138'), false);
  assert.equal(fakery.validatePlaceholder('phone', '23812345678'), false);
  assert.equal(fakery.validatePlaceholder('idcard', '110101199003078512'), false); // 校验位错
  assert.equal(fakery.validatePlaceholder('bankcard', '6222021234567890'), false); // Luhn 错
  assert.equal(fakery.validatePlaceholder('email', 'a@b'), false);
  assert.equal(fakery.validatePlaceholder('ip', '999.1.1.1'), false);
  assert.equal(fakery.validatePlaceholder('plate', '京a12345'), false);
  assert.equal(fakery.validatePlaceholder('address', 'abc'), false); // 无中文
  assert.equal(fakery.validatePlaceholder('generic', 'AB1CD'), false); // 含 1
  assert.equal(fakery.validatePlaceholder('generic', 'ABCDEF'), false); // 6 位
  assert.equal(fakery.validatePlaceholder('unknown', 'x'), false);
  assert.equal(fakery.validatePlaceholder('phone', null), false);
  assert.equal(fakery.validatePlaceholder('phone', ''), false);
});

/* ==================== v1.1 学号(studentid) ==================== */
const f2 = require('../src/js/fakery.js');
const fak = f2.fakery || f2;

test('studentid:TYPES/TYPE_META/表头推断', () => {
  assert.ok(fak.TYPES.includes('studentid'));
  assert.equal(fak.TYPE_META.studentid.label, '学号');
  assert.equal(fak.typeFromHeader('学号'), 'studentid');
  assert.equal(fak.typeFromHeader('考生编号'), 'studentid');
  assert.equal(fak.typeFromHeader('手机号码'), 'phone');
  assert.equal(fak.typeFromHeader('订单金额'), null);
});

test('studentid:4 位年份保留 + 其余混淆 + 确定性', () => {
  const seed = 'ab'.repeat(32);
  for (const v of ['2024123456', '2025987654', '1999123456', '20261234567'.slice(0, 10)]) {
    const p = fak.generate('studentid', seed, v);
    const p2 = fak.generate('studentid', seed, v);
    assert.equal(p, p2);                        // 确定性
    assert.equal(p.length, v.length);           // 等长
    assert.equal(p.slice(0, 4), v.slice(0, 4)); // 年份保留
    assert.notEqual(p, v);
    assert.ok(/^\d+$/.test(p));
  }
});

test('studentid:2 位年份保留(24/25/26/99);非年份开头整体混淆', () => {
  const seed = 'cd'.repeat(32);
  for (const v of ['241234567', '251234567', '261234567', '991234567', '001234567']) {
    const p = fak.generate('studentid', seed, v);
    assert.equal(p.slice(0, 2), v.slice(0, 2), v);
    assert.equal(p.length, v.length);
    assert.notEqual(p, v);
  }
  // 9/10 位但非年份开头 → 不保前缀,仅等长数字混淆
  for (const v of ['571234567', '8812345678']) {
    const p = fak.generate('studentid', seed, v);
    assert.equal(p.length, v.length);
    assert.ok(/^\d+$/.test(p));
  }
});

test('studentid:非常规编号按字符集保真混淆(字母→字母/数字→数字/分隔符保留)', () => {
  const seed = 'ef'.repeat(32);
  for (const v of ['G2024001', 'S2024-123', 'W20240012']) {
    const p = fak.generate('studentid', seed, v);
    assert.equal(p.length, v.length, v);
    assert.notEqual(p, v);
    for (let i = 0; i < v.length; i++) {
      const oc = v[i], pc = p[i];
      if (/[0-9]/.test(oc)) assert.ok(/[0-9]/.test(pc), v + '→' + p);
      else if (/[a-zA-Z]/.test(oc)) assert.ok(/[a-zA-Z]/.test(pc), v + '→' + p);
      else assert.equal(pc, oc);
    }
  }
});

test('studentid:唯一性(与 validatePlaceholder;规模受生日界限制,最终唯一性由 workspace 冲突重派生保证)', () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) {
    const v = '20' + String(20 + (i % 6)) + String(100000 + i * 37).slice(0, 6);
    const seed = ('a1'.repeat(31) + '0123456789abcdef'[i % 16] + (i % 16).toString(16)).slice(0, 64);
    const p = fak.generate('studentid', seed, v);
    assert.ok(!set.has(p), '重复: ' + p);
    set.add(p);
    assert.ok(fak.validatePlaceholder('studentid', p));
  }
});

test('studentid:normalize 去空白保留字母;suggest 弱建议 9/10 位数字', () => {
  assert.equal(fak.normalize('studentid', ' 2024 123456 '), '2024123456');
  assert.equal(fak.normalize('studentid', 'G 2024 001'), 'G2024001');
  const sug = fak.suggest('2024123456');
  assert.ok(sug.some(s => s.type === 'studentid' && s.confidence < 0.6));
  assert.ok(!fak.detect('2024123456')); // 学号不做强检测(避免误伤一般数字)
});
