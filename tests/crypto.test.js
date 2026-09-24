/* crypto + util 单元测试:node --test tests/crypto.test.js */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('../src/js/crypto.js');
const util = require('../src/js/util.js');

test('deriveKeys:同口令同盐 → 相同密钥(可复现)', async () => {
  const salt = await crypto.randomSaltB64();
  const k1 = await crypto.deriveKeys('correct horse battery', salt, 10000);
  const k2 = await crypto.deriveKeys('correct horse battery', salt, 10000);
  const h1 = await crypto.hmacHex(k1.kCheck, 'x');
  const h2 = await crypto.hmacHex(k2.kCheck, 'x');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('deriveKeys:不同口令 → 不同密钥;不同盐 → 不同密钥', async () => {
  const s1 = await crypto.randomSaltB64();
  const s2 = await crypto.randomSaltB64();
  const a = await crypto.deriveKeys('pw1', s1, 10000);
  const b = await crypto.deriveKeys('pw2', s1, 10000);
  const c = await crypto.deriveKeys('pw1', s2, 10000);
  const ha = await crypto.hmacHex(a.kCheck, 'x'), hb = await crypto.hmacHex(b.kCheck, 'x'), hc = await crypto.hmacHex(c.kCheck, 'x');
  assert.notEqual(ha, hb);
  assert.notEqual(ha, hc);
});

test('encryptJSON / decryptJSON 往返', async () => {
  const k = await crypto.deriveKeys('pw', await crypto.randomSaltB64(), 10000);
  const obj = { name: '测试', list: [1, 2, 3], nested: { ok: true, zh: '中文/emoji🔐' } };
  const sealed = await crypto.encryptJSON(k.kStore, obj);
  const back = await crypto.decryptJSON(k.kStore, sealed);
  assert.deepStrictEqual(back, obj);
});

test('decryptJSON:错误密钥/篡改密文 → 拒绝', async () => {
  const salt = await crypto.randomSaltB64();
  const k1 = await crypto.deriveKeys('pw1', salt, 10000);
  const k2 = await crypto.deriveKeys('pw2', salt, 10000);
  const sealed = await crypto.encryptJSON(k1.kStore, { a: 1 });
  await assert.rejects(() => crypto.decryptJSON(k2.kStore, sealed));
  const tampered = { n: sealed.n, c: sealed.c.slice(0, -4) + (sealed.c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(() => crypto.decryptJSON(k1.kStore, tampered));
});

test('b64/unb64 与 hex 往返', () => {
  const u8 = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.deepStrictEqual(util.unb64(util.b64(u8)), u8);
  assert.equal(util.hex(u8), '000102fafbff');
});

test('colName/a1', () => {
  assert.equal(util.colName(0), 'A');
  assert.equal(util.colName(25), 'Z');
  assert.equal(util.colName(26), 'AA');
  assert.equal(util.colName(701), 'ZZ');
  assert.equal(util.a1(0, 0), 'A1');
  assert.equal(util.a1(5, 27), 'AB6');
});

test('parseCSVLine:引号与转义', () => {
  assert.deepStrictEqual(util.parseCSVLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(util.parseCSVLine('"a,x",b'), ['a,x', 'b']);
  assert.deepStrictEqual(util.parseCSVLine('"say ""hi""",2'), ['say "hi"', '2']);
  assert.deepStrictEqual(util.parseCSVLine(',"",x'), ['', '', 'x']);
});

test('zipStore:结构合法(PK 头尾与 EOCD 条目数)', () => {
  const enc = new TextEncoder();
  const zip = util.zipStore([
    { name: 'a.txt', data: enc.encode('hello') },
    { name: 'b/中文.csv', data: enc.encode('x,y\r\n1,2') }
  ]);
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b); // PK
  const tail = Array.from(zip.slice(-22));
  assert.equal(tail[0], 0x50); assert.equal(tail[1], 0x4b); // EOCD
  const count = tail[10] | (tail[11] << 8);
  assert.equal(count, 2);
  // CRC 校验
  const data = enc.encode('hello');
  assert.equal(util.crc32(data), util.crc32(data));
  assert.notEqual(util.crc32(data), util.crc32(enc.encode('hellp')));
});
