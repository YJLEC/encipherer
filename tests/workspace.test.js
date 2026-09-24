/* workspace 单元测试:node --test tests/workspace.test.js
 * 覆盖:确定性(跨实例/跨文件稳定)、唯一性、还原、锁定/解锁、持久化往返、改密码 */
const test = require('node:test');
const assert = require('node:assert');
const wsapi = require('../src/js/workspace.js');

// Node 无 localStorage/indexedDB → workspace 内部已回退内存存储

const PW = '测试密码-Passw0rd!';

test('create + mask 确定性:同值两次调用 → 同占位符且 isNew 只在第一次', async () => {
  const ws = await wsapi.create('测试工作区', PW);
  const r1 = await ws.mask('phone', '13812345678');
  const r2 = await ws.mask('phone', '13812345678');
  assert.equal(r1.isNew, true);
  assert.equal(r2.isNew, false);
  assert.equal(r1.placeholder, r2.placeholder);
  assert.match(r1.placeholder, /^1[3-9]\d{9}$/);
  assert.notEqual(r1.placeholder, '13812345678');
  // 同类型不同值 → 不同占位符(唯一性)
  const r3 = await ws.mask('phone', '13998887777');
  assert.notEqual(r3.placeholder, r1.placeholder);
});

test('规范化归一:带分隔符手机号与纯数字视为同一原值', async () => {
  const ws = await wsapi.create('归一测试', PW);
  const a = await ws.mask('phone', '138-1234-5678');
  const b = await ws.mask('phone', '138 1234 5678');
  assert.equal(a.placeholder, b.placeholder);
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, false);
});

test('unmask 还原:返回首见原值(保留书写格式)', async () => {
  const ws = await wsapi.create('还原测试', PW);
  const m = await ws.mask('name', '张伟');
  const back = ws.unmask(m.placeholder);
  assert.ok(back);
  assert.equal(back.value, '张伟');
  assert.equal(back.type, 'name');
  assert.equal(ws.unmask('不存在的占位符'), null);
});

test('锁定/解锁:锁定后映射与密钥清空,解锁后恢复', async () => {
  const ws = await wsapi.create('锁定测试', PW);
  const m = await ws.mask('email', 'zhang.san@example.com');
  await ws.saveLocal();
  ws.lock();
  assert.ok(ws.isLocked());
  assert.equal(ws.unmask(m.placeholder), null);
  await assert.rejects(() => ws.mask('phone', '13812345678'));
  const ok = await ws.unlock(PW);
  assert.ok(ok);
  assert.ok(!ws.isLocked());
  assert.equal(ws.unmask(m.placeholder).value, 'zhang.san@example.com');
  // 错误密码
  ws.lock();
  assert.equal(await ws.unlock('错误密码'), false);
});

test('持久化往返:导出 .ecw → 重新打开,映射与确定性保持', async () => {
  const ws1 = await wsapi.create('往返测试', PW);
  const m1 = await ws1.mask('idcard', '110101199003077758');
  const blob = await ws1.exportFile();
  const ws2 = await wsapi.openFromBlob(blob, PW);
  assert.ok(ws2);
  assert.equal(ws2.name, '往返测试');
  assert.equal(ws2.unmask(m1.placeholder).value, '110101199003077758');
  // 新实例上继续 mask 同值 → 同占位符(跨会话稳定)
  const m2 = await ws2.mask('idcard', '110101199003077758');
  assert.equal(m1.placeholder, m2.placeholder);
  assert.equal(m2.isNew, false);
  // 错误密码打开失败
  assert.equal(await wsapi.openFromBlob(blob, 'wrong'), null);
});

test('本地副本往返 openFromLocal', async () => {
  const ws1 = await wsapi.create('本地副本', PW);
  const m = await ws1.mask('bankcard', '6222021234567890123');
  await ws1.saveLocal();
  wsapi.current = null;
  const ws2 = await wsapi.openFromLocal(ws1.id, PW);
  assert.ok(ws2);
  assert.equal(ws2.unmask(m.placeholder).value, '6222021234567890123');
});

test('changePassword:旧密码失效,新密码可用,映射保留', async () => {
  const ws = await wsapi.create('改密测试', PW);
  const m = await ws.mask('email', 'a@b.com');
  assert.equal(await ws.changePassword('错的', 'newPw123'), false);
  assert.equal(await ws.changePassword(PW, 'newPw123'), true);
  await ws.saveLocal();
  const blob = await ws.exportFile();
  assert.equal(await wsapi.openFromBlob(blob, PW), null);
  const ws2 = await wsapi.openFromBlob(blob, 'newPw123');
  assert.ok(ws2);
  assert.equal(ws2.unmask(m.placeholder).value, 'a@b.com');
});

test('listMappings 与 stats', async () => {
  const ws = await wsapi.create('统计测试', PW);
  await ws.mask('phone', '13800000001');
  await ws.mask('phone', '13800000001'); // 二次命中计数
  await ws.mask('name', '李娜');
  const all = ws.listMappings({});
  assert.equal(all.total, 2);
  const phones = ws.listMappings({ type: 'phone' });
  assert.equal(phones.total, 1);
  assert.equal(phones.rows[0].count, 2);
  assert.equal(phones.rows[0].original, '13800000001');
  const st = ws.stats();
  assert.equal(st.entries, 2);
  assert.equal(st.byType.phone, 1);
  assert.equal(st.byType.name, 1);
  assert.equal(st.totalHits, 3);
  // 搜索
  const q = ws.listMappings({ q: '李' });
  assert.equal(q.total, 1);
  assert.equal(q.rows[0].original, '李娜');
});

test('空值跳过', async () => {
  const ws = await wsapi.create('空值', PW);
  const r = await ws.mask('phone', '   ');
  assert.equal(r.skipped, true);
  assert.equal(r.placeholder, '');
});

test('大量值唯一性(1000 个手机号)', async () => {
  const ws = await wsapi.create('压测', PW);
  const set = new Set();
  for (let i = 0; i < 1000; i++) {
    const r = await ws.mask('phone', '138' + String(10000000 + i * 7919).slice(0, 8));
    assert.ok(!set.has(r.placeholder), '占位符重复: ' + r.placeholder);
    set.add(r.placeholder);
  }
  assert.equal(set.size, 1000);
});
