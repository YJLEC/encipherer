/* 生成演示/测试用样例表格:node samples/make-samples.mjs
 * 产出:samples/示例-客户信息表.xlsx、samples/示例-订单表.csv(UTF-8 BOM) */
import XLSX from '../vendor/xlsx.full.min.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const SURNAMES = ['张','王','李','赵','刘','陈','杨','黄','周','吴','徐','孙','马','朱','胡','郭','何','林','罗','郑'];
const GIVEN = ['伟','芳','娜','敏','静','丽','强','磊','军','洋','勇','艳','杰','娟','涛','明','超','秀英','霞','平','刚','桂英','文','辉','宇','欣','怡','梓','涵','轩'];
const REGIONS = ['110101','310104','440305','330102','510107','420106','320111','610113','500105','120103'];
const ROADS = ['中关村大街','汾江路','深南大道','延安西路','天府二街','长江大道','解放北路','人民南路','幸福路','科技园科苑路'];
const CITIES = [['广东省','佛山市','禅城区'],['北京市','北京市','海淀区'],['上海市','上海市','浦东新区'],['四川省','成都市','武侯区'],['浙江省','杭州市','西湖区'],['湖北省','武汉市','洪山区'],['江苏省','南京市','江宁区'],['陕西省','西安市','雁塔区']];

function rnd(n) { return Math.floor(Math.random() * n); }
function pick(a) { return a[rnd(a.length)]; }

function idChecksum17(id17) {
  const W = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
  const M = '10X98765432';
  let s = 0;
  for (let i = 0; i < 17; i++) s += Number(id17[i]) * W[i];
  return M[s % 11];
}
function makeIdcard() {
  const reg = pick(REGIONS);
  const y = 1960 + rnd(45), m = 1 + rnd(12), d = 1 + rnd(28);
  const p = x => String(x).padStart(2, '0');
  const id17 = reg + y + p(m) + p(d) + String(100 + rnd(900));
  return id17 + idChecksum17(id17);
}
function luhnComplete(prefix, totalLen) {
  let body = prefix;
  while (body.length < totalLen - 1) body += rnd(10);
  let sum = 0, alt = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let n = Number(body[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return body + String((10 - (sum % 10)) % 10);
}
function makeName() { return pick(SURNAMES) + (Math.random() < 0.3 ? pick(GIVEN) + pick(GIVEN) : pick(GIVEN)); }
function makePhone() { return '1' + pick(['38','39','55','87','88','52','76']) + String(10000000 + rnd(89999999)); } // 1 + 2位号段 + 8位 = 11位
function makeEmail(name) {
  const locals = ['zhang.san','li.si','wangwu','user01','chen.j','testuser','liming','xiao.mei','hr.admin','no_reply'];
  return pick(locals) + rnd(100) + '@' + pick(['qq.com','163.com','gmail.com','outlook.com','company.cn']);
}
function makeAddr() { const c = pick(CITIES); return c[0] + c[1] + c[2] + pick(ROADS) + (1 + rnd(999)) + '号'; }
function makePlate() {
  // 标准蓝牌:省简称 + 发牌机关字母 + 5 位序号(去 I/O 防歧义)
  const P = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼';
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const SERIAL = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += SERIAL[rnd(SERIAL.length)];
  return P[rnd(P.length)] + L[rnd(L.length)] + s;
}
function makeIp() { return `${10 + rnd(200)}.${rnd(255)}.${rnd(255)}.${1 + rnd(253)}`; }

const rows = [['客户编号','姓名','手机号','身份证号','邮箱','银行卡号','联系地址','常用IP','车牌号','会员等级','备注']];
for (let i = 1; i <= 40; i++) {
  const name = makeName();
  rows.push([
    'C' + String(i).padStart(4, '0'), name, makePhone(), makeIdcard(), makeEmail(name),
    luhnComplete('62', 19), makeAddr(), makeIp(), makePlate(),
    pick(['普通','银卡','金卡','钻石']), pick(['长期客户','新客','续费提醒','已回访','投诉跟进中'])
  ]);
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!cols'] = [{ wch: 9 }, { wch: 8 }, { wch: 13 }, { wch: 19 }, { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 14 }, { wch: 9 }, { wch: 9 }, { wch: 12 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '客户信息');
const ws2 = XLSX.utils.aoa_to_sheet([
  ['订单号','客户编号','收件人','收件手机','收件地址','金额','日期'],
  ...Array.from({ length: 25 }, (_, i) => [
    'D' + String(1000 + i), 'C' + String(1 + rnd(40)).padStart(4, '0'), makeName(), makePhone(), makeAddr(), (99 + rnd(9000)) / 10, '2026-0' + (1 + rnd(9)) + '-' + String(1 + rnd(28)).padStart(2, '0')
  ])
]);
XLSX.utils.book_append_sheet(wb, ws2, '订单');

fs.writeFileSync(path.join(DIR, '示例-客户信息表.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log('✔ samples/示例-客户信息表.xlsx(2 个工作表,40 客户 + 25 订单)');

// —— 学生名单(学号:4 位年份 10 位 / 2 位年份 9 位 / 非常规编号)——
const COLLEGES = ['计算机学院','外国语学院','机械工程学院','经济管理学院','数学科学学院','人文学院'];
const MAJORS = ['软件工程','英语','机械设计','会计学','应用数学','汉语言文学'];
function makeStudentId(i) {
  const roll = i % 10;
  if (roll < 6) return '20' + (22 + rnd(4)) + String(100000 + rnd(899999));      // 2022-2025 开头,10 位
  if (roll < 9) return String(22 + rnd(5)).padStart(2, '0') + String(1000000 + rnd(8999999)); // 2 位年份,9 位
  return pick(['G', 'S', 'W']) + '2024' + String(1000 + rnd(8999));              // 非常规:字母前缀
}
const stuRows = [['学号', '姓名', '学院', '专业', '手机号', '邮箱']];
for (let i = 1; i <= 30; i++) {
  const name = makeName();
  stuRows.push([
    makeStudentId(i), name, pick(COLLEGES), pick(MAJORS), makePhone(),
    'stu' + String(i).padStart(3, '0') + '@' + pick(['edu.cn', 'univ.edu.cn', '163.com'])
  ]);
}
const ws3 = XLSX.utils.aoa_to_sheet(stuRows);
ws3['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 13 }, { wch: 22 }];
const wb3 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb3, ws3, '学生名单');
fs.writeFileSync(path.join(DIR, '示例-学生名单.xlsx'), XLSX.write(wb3, { type: 'buffer', bookType: 'xlsx' }));
console.log('✔ samples/示例-学生名单.xlsx(30 名学生,学号三种形态)');

const csv = rows.map(r => r.map(f => /[",\r\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f).join(',')).join('\r\n');
fs.writeFileSync(path.join(DIR, '示例-客户信息表.csv'), '\uFEFF' + csv, 'utf8');
console.log('✔ samples/示例-客户信息表.csv(UTF-8 BOM)');
