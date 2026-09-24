/**
 * fakery.js — PII 类型检测 + 确定性格式保真占位符生成
 *
 * 职责(ARCHITECTURE.md §2.3 / §3):
 *   - detect(valueStr)      强检测(idcard>phone>bankcard>email>ip>plate)
 *   - suggest(valueStr)     扫描建议(含 name/address 弱建议)
 *   - normalize(type, v)    规范键
 *   - generate(type, seedHex, originalStr, options)
 *       确定性:同 (type, seedHex, originalStr, options) 永远产出同一字符串。
 *       内部用 sfc32 PRNG;seedHex(64 个 hex 字符)切成 4 个 32 位整数作为种子,
 *       再混入 type 与原值的 FNV-1a 哈希,保证不同原值即使同 seed 也得到不同随机流。
 *   - validatePlaceholder(type, ph) 结构合法性校验(供测试/还原侧使用)
 *
 * 纯逻辑:无 DOM、无 IO、无第三方依赖、零网络;所有池数据内嵌本文件。
 * UMD:Node 测试中 require;浏览器中挂到全局命名空间 Encipherer.fakery。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Encipherer = root.Encipherer || {}; var m = factory(root.Encipherer);
    for (var k in m) root.Encipherer[k] = m[k]; }
})(typeof self !== 'undefined' ? self : this, function (E) { 'use strict'; E = E || {};

  var fakery = {};

  // ==================== 1. 类型元数据 ====================

  /** 支持的 PII 类型 key(顺序即展示顺序) */
  fakery.TYPES = ['phone', 'idcard', 'email', 'name', 'bankcard', 'ip', 'plate', 'address', 'studentid', 'generic'];

  /** UI 徽标元数据:label 为中文标签,color 为十六进制色 */
  fakery.TYPE_META = {
    phone:     { label: '手机号',   color: '#e65100' },
    idcard:    { label: '身份证号', color: '#b71c1c' },
    email:     { label: '邮箱',     color: '#1565c0' },
    name:      { label: '姓名',     color: '#2e7d32' },
    bankcard:  { label: '银行卡号', color: '#6a1b9a' },
    ip:        { label: 'IP地址',   color: '#00695c' },
    plate:     { label: '车牌号',   color: '#f9a825' },
    address:   { label: '地址',     color: '#5d4037' },
    studentid: { label: '学号',     color: '#0277bd' },
    generic:   { label: '通用文本', color: '#546e7a' }
  };

  /** 表头关键词 → 类型(用于"表头识别"建议;命中即建议,不自动脱敏) */
  fakery.HEADER_HINTS = [
    { re: /学号|考生号|考生编号|学生编号|考号/, type: 'studentid' },
    { re: /身份证|证件号|证件号码/, type: 'idcard' },
    { re: /银行卡|卡号|储蓄卡|信用卡/, type: 'bankcard' },
    { re: /手机|电话|联系|手机号|联系方式/, type: 'phone' },
    { re: /邮箱|邮件|e-?mail/i, type: 'email' },
    { re: /地址|住址|通讯地址/, type: 'address' },
    { re: /姓名|名字|学员|客户名|收件人|联系人/, type: 'name' },
    { re: /车牌|车牌号/, type: 'plate' },
    { re: /(^|[^a-z])ip([^a-z]|$)|ip地址|IP地址/i, type: 'ip' }
  ];

  /** 由表头文本推断类型(无命中返回 null) */
  fakery.typeFromHeader = function (headerText) {
    if (typeof headerText !== 'string') return null;
    var t = headerText.trim();
    if (!t) return null;
    for (var i = 0; i < fakery.HEADER_HINTS.length; i++) {
      if (fakery.HEADER_HINTS[i].re.test(t)) return fakery.HEADER_HINTS[i].type;
    }
    return null;
  };

  // ==================== 2. 内部工具 ====================

  /** 字符串去重(保持顺序) */
  function dedupeArr(a) {
    var seen = {}, out = [], i;
    for (i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
    return out;
  }

  /** 逐字符去重(用于单字池,保证池内无重复字) */
  function dedupeChars(s) {
    var seen = {}, out = [], i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); if (!seen[c]) { seen[c] = 1; out.push(c); } }
    return out;
  }

  /** FNV-1a 32 位字符串哈希(确定性,用于把 type/原值混入 PRNG 状态) */
  function fnv1a(str) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** 32 位循环左移 */
  function rotl(x, n) { x >>>= 0; return ((x << n) | (x >>> (32 - n))) >>> 0; }

  /**
   * sfc32 PRNG(返回 [0,1) 浮点)。
   * a/b/c/d 为 4 个 32 位整数种子;输出周期长、质量高,且跨平台确定。
   */
  function sfc32(a, b, c, d) {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    return function () {
      var t;
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      t = (a + b) >>> 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) >>> 0;
      c = ((c << 21) | (c >>> 11)) >>> 0;
      d = (d + 1) >>> 0;
      t = (t + d) >>> 0;
      c = (c + t) >>> 0;
      return (t >>> 0) / 4294967296;
    };
  }

  /**
   * 由 (type, seedHex, originalStr) 构造确定性随机流。
   * seedHex 为 64 个 hex 字符(256bit):切成 4 段,每段 16 个 hex(64bit)
   * 折半异或成 1 个 32 位整数,共得 sfc32 的 4 个 32 位种子;
   * 再异或 type/原值的哈希并预热 12 轮,避免弱种子导致的早期相关。
   */
  function makeRng(type, seedHex, originalStr) {
    var h = String(seedHex == null ? '' : seedHex).toLowerCase().replace(/[^0-9a-f]/g, '');
    while (h.length < 64) h += '0';
    h = h.slice(0, 64);
    var s = [0, 0, 0, 0], i, part;
    for (i = 0; i < 4; i++) {
      part = h.substr(i * 16, 16);
      s[i] = ((parseInt(part.substr(0, 8), 16) >>> 0) ^ (parseInt(part.substr(8, 8), 16) >>> 0)) >>> 0;
    }
    var th = fnv1a(String(type)), oh = fnv1a(originalStr);
    s[0] = (s[0] ^ th) >>> 0;
    s[1] = (s[1] ^ oh) >>> 0;
    s[2] = (s[2] ^ rotl(th, 13)) >>> 0;
    s[3] = (s[3] ^ rotl(oh, 19)) >>> 0;
    var rng = sfc32(s[0], s[1], s[2], s[3]);
    for (i = 0; i < 12; i++) rng(); // 预热
    return rng;
  }

  /** [min,max] 闭区间整数 */
  function ri(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
  /** 从数组随机取一项 */
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  /** 数字左补零到定宽(生成定长数字段用,避免前导零丢失) */
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  /** 某年某月的天数(含闰年,纯算术无 Date 依赖) */
  function daysInMonth(y, m) {
    if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // ==================== 3. 校验算法(检测与生成共用) ====================

  /** GB11643 身份证校验位:前 17 位数字 → '0'-'9' 或 'X' */
  var ID_W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var ID_MAP = '10X98765432';
  function idcardCheckDigit(body17) {
    var sum = 0, i;
    for (i = 0; i < 17; i++) sum += (body17.charCodeAt(i) - 48) * ID_W[i];
    return ID_MAP.charAt(sum % 11);
  }

  /** Luhn 校验位:不含校验位的数字串 → 应追加的数字 */
  function luhnCheckDigit(body) {
    var sum = 0, dbl = true, i, d; // 从右往左,紧邻校验位的一侧先翻倍
    for (i = body.length - 1; i >= 0; i--) {
      d = body.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return (10 - (sum % 10)) % 10;
  }

  /** 整串是否通过 Luhn */
  function luhnValid(numStr) {
    if (!/^\d+$/.test(numStr)) return false;
    return String(luhnCheckDigit(numStr.slice(0, -1))) === numStr.slice(-1);
  }

  /** 标准 IPv4(不允许前导零) */
  function isIPv4(s) {
    return /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(s);
  }

  /** IPv6 合法性(支持 :: 压缩与 IPv4 结尾映射,如 ::ffff:192.168.1.1) */
  function isIPv6(str) {
    var s = String(str);
    if (s.indexOf(':') < 0) return false;
    // 结尾若为 IPv4 点分形式,先换算成两个 16 进制组
    var li = s.lastIndexOf(':');
    if (s.indexOf('.', li + 1) >= 0) {
      var tail = s.slice(li + 1);
      if (!isIPv4(tail)) return false;
      var q = tail.split('.');
      s = s.slice(0, li + 1) + (Number(q[0]) * 256 + Number(q[1])).toString(16) + ':' +
          (Number(q[2]) * 256 + Number(q[3])).toString(16);
    }
    var HEX = /^[0-9a-fA-F]{1,4}$/;
    if (s.indexOf('::') >= 0) {
      if (s.indexOf('::', s.indexOf('::') + 1) >= 0) return false; // '::' 只能出现一次
      var head = s.slice(0, s.indexOf('::'));
      var rear = s.slice(s.indexOf('::') + 2);
      var hs = head === '' ? [] : head.split(':');
      var rs = rear === '' ? [] : rear.split(':');
      for (var a = 0; a < hs.length; a++) if (!HEX.test(hs[a])) return false;
      for (var b = 0; b < rs.length; b++) if (!HEX.test(rs[b])) return false;
      return hs.length + rs.length <= 7;
    }
    var parts = s.split(':');
    if (parts.length !== 8) return false;
    for (var c = 0; c < 8; c++) if (!HEX.test(parts[c])) return false;
    return true;
  }

  // ==================== 4. 检测用的正则 ====================

  var RE_PHONE = /^(\+?86)?1[3-9]\d{9}$/;
  var RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  var PLATE_PROV_CLASS = '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领]';
  var RE_PLATE = new RegExp('^' + PLATE_PROV_CLASS + '[A-HJ-NP-Z][·]?[A-HJ-NP-Z0-9]{4,5}[挂学警港澳]?$');
  // 生成的占位符可能带空格分隔(原值带空格时保真),校验放宽允许空格分隔
  var RE_PLATE_GEN = new RegExp('^' + PLATE_PROV_CLASS + '[A-HJ-NP-Z][· ]?[A-HJ-NP-Z0-9]{4,5}[挂学警港澳]?$');

  /** 去掉空格/横线/全角横线(手机号、银行卡常见书写分隔)。
   * 注意:不剥点号——带点更可能是 IP/版本号,否则 3+3+3+2 位数字的 IP 会被误判成手机号 */
  function stripSeparators(s) { return s.replace(/[\s\-\uFF0D]/g, ''); }

  /** 18 位身份证完整合法性(格式+出生日期+校验位) */
  function isIdcard(v) {
    if (!/^\d{17}[\dXx]$/.test(v)) return false;
    var y = Number(v.substr(6, 4)), mo = Number(v.substr(10, 2)), da = Number(v.substr(12, 2));
    if (y < 1900 || y > 2099) return false;
    if (mo < 1 || mo > 12) return false;
    if (da < 1 || da > daysInMonth(y, mo)) return false;
    return idcardCheckDigit(v.substr(0, 17)) === v.charAt(17).toUpperCase();
  }

  // ==================== 5. detect / suggest / normalize ====================

  /**
   * 强检测:只做高置信判定,优先级 idcard > phone > bankcard > email > ip > plate。
   * @returns {{type:string, confidence:number}|null}
   */
  fakery.detect = function (valueStr) {
    if (typeof valueStr !== 'string') return null;
    var v = valueStr.trim();
    if (!v) return null;
    if (isIdcard(v)) return { type: 'idcard', confidence: 0.99 };
    // 点号仅在排除 IP 形态后才允许作为手机号分隔(否则 3+3+3+2 位 IP 会被误判)
    var notIP = !(isIPv4(v) || isIPv6(v));
    var dPhone = notIP ? v.replace(/[\s.\-\uFF0D]/g, '') : stripSeparators(v);
    if (RE_PHONE.test(dPhone)) return { type: 'phone', confidence: 0.95 };
    var d = stripSeparators(v);
    if (/^\d{13,19}$/.test(d) && luhnValid(d)) return { type: 'bankcard', confidence: 0.9 };
    if (RE_EMAIL.test(v)) return { type: 'email', confidence: 0.98 };
    if (isIPv4(v) || isIPv6(v)) return { type: 'ip', confidence: 0.95 };
    if (RE_PLATE.test(v)) return { type: 'plate', confidence: 0.9 };
    return null;
  };

  /**
   * 扫描建议:强检测结果(若有)排最前,再附加弱建议:
   *   name    —— 2~4 个 CJK 字符、无数字(置信 0.5)
   *   address —— 长度 ≥6 且含 省/市/区/县/路/街/镇/乡/村/道/巷/号/栋/单/元/室 等关键词(置信 0.55)
   * @returns {{type:string, confidence:number}[]}
   */
  fakery.suggest = function (valueStr) {
    var out = [];
    var strong = fakery.detect(valueStr);
    if (strong) out.push(strong);
    if (typeof valueStr === 'string') {
      var v = valueStr.trim();
      if (/^[\u4e00-\u9fff]{2,4}$/.test(v)) out.push({ type: 'name', confidence: 0.5 });
      if (v.length >= 6 && /[省市区县路街镇乡村道巷号栋单元室]/.test(v)) {
        out.push({ type: 'address', confidence: 0.55 });
      }
      // 9/10 位纯数字:疑似学号/编号(弱建议,交由用户确认)
      if (/^\d{9,10}$/.test(v)) out.push({ type: 'studentid', confidence: 0.4 });
    }
    return out;
  };

  /**
   * 规范键:同类型下同一原值归一为同一键。
   *   phone/idcard/bankcard 仅留数字;email 去空白+小写;其余 trim+连续空白压成单空格。
   */
  fakery.normalize = function (type, valueStr) {
    var v = (valueStr == null) ? '' : String(valueStr);
    if (type === 'phone' || type === 'idcard' || type === 'bankcard') return v.replace(/\D/g, '');
    if (type === 'email') return v.replace(/\s+/g, '').toLowerCase();
    if (type === 'studentid') return v.replace(/\s+/g, ''); // 保留字母,仅去空白
    return v.trim().replace(/\s+/g, ' ');
  };

  // ==================== 6. 数据池(全部内嵌,不外联) ====================

  /** 身份证行政区划码池(真实区划码,≥40 个) */
  var AREA_POOL = [
    '110101', '110102', '110105', '110106', '110107', '110108', '110109', '110111', '110113', '110114',
    '120101', '120102', '120103', '120104', '120105',
    '130102', '130203', '140105', '150102',
    '210102', '210202', '210302', '220102', '230102',
    '310101', '310104', '310105', '310106', '310107', '310109', '310110', '310112', '310115',
    '320102', '320205', '320506', '330102', '330106', '330203',
    '340102', '340111', '350102', '350203', '350205', '350206',
    '360102', '360103', '370102', '370203', '410102', '410105',
    '420102', '420106', '420111', '430102', '430104', '430105',
    '440103', '440104', '440105', '440106', '440111',
    '440303', '440304', '440305', '440306', '440307', '440308',
    '450102', '450103', '460105',
    '500101', '500103', '500104', '500105', '500106', '500107', '500108',
    '510104', '510105', '510106', '510107', '510108',
    '520102', '520103', '530102', '530103', '540102',
    '610102', '610103', '610104', '610113', '620102', '620103',
    '630102', '640102', '650102', '650104'
  ];

  /** 单字姓氏池(≥100,已去重) */
  var SURNAME_POOL = dedupeChars(
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明佘池查麻苑迟邝'
  );

  /** 复姓池(长度 2) */
  var COMPOUND_POOL = dedupeArr([
    '欧阳', '司马', '上官', '诸葛', '皇甫', '长孙', '宇文', '司徒', '鲜于', '司空',
    '慕容', '尉迟', '公孙', '令狐', '端木', '南宫', '西门', '东郭', '独孤', '夏侯',
    '赫连', '澹台', '呼延', '申屠', '公冶', '钟离', '闾丘', '轩辕', '拓跋', '夹谷',
    '段干', '百里', '左丘', '东门', '南门', '第五', '梁丘', '公祖', '宰父', '谷梁',
    '巫马', '漆雕', '乐正', '壤驷', '公良', '即墨', '达奚', '仲孙', '子车', '亓官',
    '司寇', '公西', '颛孙', '宗政', '濮阳', '公羊', '太史', '尔朱', '斛律', '乌雅'
  ]);

  /** 名字用字池(≥200,已去重) */
  var GIVEN_POOL = dedupeChars(
    '伟芳娜秀敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂华玉兰婷怡欣悦佳俊宇浩然子轩雨嘉晓春燕萍红梅玲竹菊芝建国栋鑫淼森晨辰泽涵梦洁倩文博昊天瑞雪楠睿昕溪岚峰川洲润澜潇湘沂沛沫津河海波潮汐池沅沁泓清淇渊源溢滔滨漪澈' +
    '灿炫焕烽焰煜炜烨熠曦光辉耀晖暄暖阳晴晶智慧巧娴灵蕙颖秋月星云虹霖霏露青碧翠丹紫彤彩珊珍珠琼瑶琳琪瑛婕妍媛嫣婧婉宁安宸寰展帆帼庆康彦彬彪心志忠恩慈才承振挺政敬敦斐斯新旭旻昂晋晟朗朝' +
    '木本林榕槿樾杉松柏梓枫桐杨柳桃棠楚楷槐檀蔚萌蕾薇苗茂菲蓝蕊蕴若英茗茜荃荷菱萱葵薰苇荻莞菁萤允元兆先克免黎齐' +
    '端笃维纲纶绮绫纬绅' +
    '至致臻舜衔衡裕言誉谨谦豁贝贤贵贺贻越跃迎运近逍遥逸邈郎郁钧铭锐锦键镜长门闰阁雅雁雄雯霄霜音韵页项顺须颂颜风飞驰骁' +
    '默龄鼎圣桥歌毅泰淳添淞港游溶澄澍濂瀚灏炅炳熙燃爽玺珂珑珞琛琚琮璇璐璞环珉玑玖玛玥珐' +
    '甫律彻徽循德悌情惟意慷憬懿攸敖' +
    '昱晔晗暮曼曲更' +
    '枚荣蓉蒙蒲蓟蓓蔓虞衍觉' +
    '轼辙逵逢郡都鉴钦铢隆霈霭靓韧颀颐' +
    '馥馨骞骥鹏鹤鹭鹰麒麓龙翔翼耘'
  );

  /** 英文的名池(含 2 字母短名,便于凑长度) */
  var EN_FIRST = [
    'James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles',
    'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen',
    'Lisa', 'Nancy', 'Betty', 'Emma', 'Olivia', 'Sophia', 'Isabella', 'Charlotte', 'Amelia', 'Mia',
    'Harper', 'Evelyn', 'Abigail', 'Ella', 'Avery', 'Scarlett', 'Grace', 'Chloe', 'Liam', 'Noah',
    'Oliver', 'Elijah', 'Lucas', 'Mason', 'Logan', 'Ethan', 'Jacob', 'Jackson', 'Alexander', 'Aiden',
    'Daniel', 'Henry', 'Wyatt', 'Sebastian', 'Jack', 'Owen', 'Levi', 'Julian', 'Luke', 'Kevin',
    'Li', 'Mei', 'Yu', 'An', 'Bo', 'Wu', 'He', 'Fa', 'Jo', 'Ed'
  ];

  /** 英文的姓池(含 2 字母短姓) */
  var EN_LAST = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
    'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
    'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
    'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
    'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
    'Turner', 'Phillips', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Morris', 'Murphy', 'Cook',
    'Rogers', 'Morgan', 'Peterson', 'Cooper', 'Reed', 'Bailey', 'Bell', 'Howard', 'Ward', 'Cox',
    'Richardson', 'Wood', 'Watson', 'Brooks', 'Bennett', 'Gray', 'Hughes', 'Price', 'Sanders', 'Rose',
    'Na', 'Lin', 'Ma', 'Ho', 'Su', 'Vo', 'Kim', 'Qi'
  ];

  /** 邮箱本地部分音节池(含大量 2-3 字母短音节,保证小空间时的熵) */
  var SYLLABLES = dedupeArr([
    'an', 'bo', 'cai', 'chen', 'dan', 'dong', 'fang', 'gang', 'hao', 'hua',
    'jian', 'jing', 'jun', 'kai', 'lang', 'lei', 'li', 'lin', 'ling', 'lan',
    'mei', 'ming', 'nan', 'ning', 'pei', 'qi', 'qing', 'qiu', 'ran', 'rong',
    'ruo', 'shan', 'shao', 'shen', 'shi', 'song', 'su', 'sun', 'tao', 'ting',
    'tong', 'wan', 'wei', 'wen', 'xia', 'xiang', 'xin', 'xing', 'xue', 'yan',
    'yang', 'yi', 'yin', 'ying', 'yun', 'ze', 'zhan', 'zhao', 'zhen', 'zhi',
    'zhou', 'zhu',
    'ai', 'ba', 'bi', 'bu', 'ca', 'ci', 'cu', 'da', 'de', 'di',
    'du', 'fa', 'fu', 'ge', 'gu', 'ha', 'he', 'hu', 'ji', 'ju',
    'ka', 'ke', 'ku', 'la', 'le', 'lu', 'ma', 'mi', 'mo', 'mu',
    'na', 'ni', 'nu', 'pa', 'pi', 'po', 'pu', 'qu', 'ru', 'sa',
    'se', 'si', 'ti', 'tu', 'wa', 'wo', 'wu', 'xi', 'xu', 'ya',
    'ye', 'yo', 'yu', 'za', 'ze', 'zi', 'zu',
    'bai', 'bao', 'bei', 'ben', 'bie', 'bin', 'cha', 'che', 'chu', 'cui',
    'dai', 'deng', 'die', 'ding', 'dou', 'duo', 'er', 'fei', 'fen', 'feng',
    'gao', 'gong', 'gua', 'guo', 'hai', 'han', 'hang', 'heng', 'hong', 'huai',
    'huan', 'jiang', 'jie', 'jin', 'jue', 'kan', 'kong', 'lai', 'lao', 'liang',
    'liao', 'lie', 'liu', 'long', 'lou', 'luan', 'luo', 'mai', 'mang',
    'mao', 'meng', 'mian', 'miao', 'nie', 'niu', 'nou', 'pai', 'pang',
    'pei', 'pen', 'pian', 'piao', 'pin', 'qian', 'qiang', 'qiao', 'qin',
    'que', 'ren', 'ri', 'rou', 'ruan', 'rui', 'sai', 'sao', 'sen', 'sha',
    'she', 'shou', 'shu', 'shua', 'shun', 'shuo', 'sui', 'tan', 'tang',
    'teng', 'tian', 'tiao', 'tie', 'tui', 'tun', 'tuo', 'wai', 'wang',
    'weng', 'xian', 'xiao', 'xie', 'xiong',
    'yao', 'you', 'yuan', 'zao', 'zei', 'zen', 'zeng', 'zha',
    'zhei', 'zong', 'zou', 'zuan', 'zui', 'zun', 'zuo',
    'cou', 'cuan', 'fou', 'gun', 'jia', 'kuo', 'nai', 'nuo', 'rao', 're',
    'sang', 'shai', 'yong', 'zhai', 'zhua', 'zhuo',
    'bing', 'cang', 'cong', 'dun', 'huo', 'jiao', 'kao', 'mou', 'nian',
    'pao', 'qie', 'rang', 'zhong', 'zhe'
  ]);

  /** 常见邮箱域名池(keepEmailDomain=false 时使用) */
  var DOMAINS = [
    'gmail.com', 'outlook.com', '163.com', 'qq.com', '126.com',
    'hotmail.com', 'sina.com', 'yeah.net', 'foxmail.com', 'aliyun.com'
  ];

  /** 车牌省份简称池(31 个省级行政区,不含使/领) */
  var PLATE_PROV = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼';
  /** 车牌字符池(大写字母去 I/O,数字去 0/1 —— 去歧义) */
  var PLATE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  /** 发牌机关字母池(大写去 I/O) */
  var PLATE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  /** 地址:省级池(真实) */
  var ADDR_PROVS = [
    '北京市', '天津市', '上海市', '重庆市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省',
    '黑龙江省', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省',
    '湖南省', '广东省', '广西壮族自治区', '海南省', '四川省', '贵州省', '云南省', '西藏自治区',
    '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区'
  ];
  var ADDR_MUN = ['北京市', '天津市', '上海市', '重庆市']; // 直辖市

  /** 地址:城市池(真实地级市) */
  var ADDR_CITIES = [
    '石家庄市', '唐山市', '秦皇岛市', '太原市', '大同市', '沈阳市', '大连市', '鞍山市', '长春市', '吉林市',
    '哈尔滨市', '齐齐哈尔市', '南京市', '苏州市', '无锡市', '常州市', '杭州市', '宁波市', '温州市', '嘉兴市',
    '合肥市', '芜湖市', '蚌埠市', '福州市', '厦门市', '泉州市', '南昌市', '九江市', '济南市', '青岛市',
    '烟台市', '潍坊市', '郑州市', '洛阳市', '开封市', '武汉市', '宜昌市', '襄阳市', '长沙市', '株洲市',
    '衡阳市', '广州市', '深圳市', '珠海市', '汕头市', '佛山市', '东莞市', '中山市', '南宁市', '柳州市',
    '海口市', '三亚市', '成都市', '绵阳市', '自贡市', '贵阳市', '六盘水市', '昆明市', '大理市', '拉萨市',
    '日喀则市', '西安市', '宝鸡市', '咸阳市', '兰州市', '天水市', '西宁市', '银川市', '吴忠市', '乌鲁木齐市',
    '克拉玛依市'
  ];

  /** 地址:区县池(真实区县名) */
  var ADDR_DISTS = dedupeArr([
    '东城区', '西城区', '朝阳区', '海淀区', '丰台区', '石景山区', '通州区', '顺义区', '昌平区', '大兴区',
    '和平区', '河东区', '河西区', '南开区', '河北区', '红桥区',
    '黄浦区', '徐汇区', '长宁区', '静安区', '普陀区', '虹口区', '杨浦区', '闵行区', '宝山区', '嘉定区', '浦东新区',
    '玄武区', '秦淮区', '鼓楼区', '建邺区', '姑苏区', '虎丘区', '吴中区',
    '上城区', '拱墅区', '西湖区', '滨江区', '余杭区',
    '瑶海区', '蜀山区', '包河区', '庐阳区',
    '思明区', '湖里区', '集美区', '海沧区',
    '东湖区', '青云谱区', '青山湖区', '红谷滩区',
    '历下区', '市中区', '槐荫区', '天桥区',
    '中原区', '二七区', '金水区', '管城回族区',
    '江岸区', '江汉区', '硚口区', '汉阳区', '武昌区', '洪山区',
    '岳麓区', '芙蓉区', '天心区', '开福区', '雨花区',
    '罗湖区', '福田区', '南山区', '宝安区', '龙岗区', '盐田区', '龙华区',
    '秀英区', '锦江区', '青羊区', '金牛区', '武侯区', '成华区', '双流区',
    '南明区', '云岩区', '花溪区', '五华区', '盘龙区', '官渡区', '西山区',
    '城关区', '七里河区', '新城区', '碑林区', '莲湖区', '灞桥区', '未央区', '雁塔区'
  ]);

  /** 地址:路名池 */
  var ADDR_ROADS = [
    '中山路', '人民路', '解放路', '建设路', '和平路', '朝阳路', '光明路', '幸福路', '长江路', '黄河路',
    '珠江路', '文化路', '科技路', '创新路', '振兴路', '迎宾路', '滨河路', '望江路', '学府路', '青年路',
    '胜利路', '长安街', '南京路', '淮海路', '汾江路', '天河北路', '体育路', '育才路', '新华路', '永乐路',
    '永安路', '康乐路', '祥和路', '锦绣路', '梧桐路', '香樟路', '银杏路', '枫林路', '桃园路', '牡丹路',
    '玫瑰路', '芙蓉路', '梅花路', '兰花路', '竹林路', '春晖路', '星光路', '阳光路', '彩虹路', '白云路',
    '青山路', '红叶路', '东湖路', '南湖路', '北湖路', '环城路', '城南路', '城北路', '中心街', '步行街',
    '世纪大道', '滨江大道', '望江大道', '天府大道', '中山大道', '解放大道', '建设大道', '和平大道', '人民大道', '长安大道'
  ];

  /** generic 占位符字符集:31 个无歧义字符(去掉 I/L/O/0/1,统一大写) */
  var B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // ==================== 7. 各类型生成器 ====================

  /** 手机号:1 + 真实号段第二位(3/5/7/8/9)+ 9 位随机数字,共 11 位 */
  function genPhone(rng) {
    var s = '1' + '35789'.charAt(ri(rng, 0, 4));
    for (var i = 0; i < 9; i++) s += String(ri(rng, 0, 9));
    return s;
  }

  /** 身份证:区划码 + 合法出生日期(1900-2010)+ 3 位顺序码 + 正确校验位(GB11643,可为 X) */
  function genIdcard(rng) {
    var y = ri(rng, 1900, 2010), mo = ri(rng, 1, 12), da = ri(rng, 1, daysInMonth(y, mo));
    var body = pick(rng, AREA_POOL) + pad(y, 4) + pad(mo, 2) + pad(da, 2) + pad(ri(rng, 0, 999), 3);
    return body + idcardCheckDigit(body);
  }

  /** 银行卡:62 开头,长度与原值相同(13-19),通过 Luhn */
  function genBankcard(rng, orig) {
    var digits = orig.replace(/\D/g, '');
    var L = (digits.length >= 13 && digits.length <= 19) ? digits.length : 16;
    var body = '62';
    for (var i = 0; i < L - 3; i++) body += String(ri(rng, 0, 9));
    return body + String(luhnCheckDigit(body));
  }

  /** 音节按长度分桶(2-6 字母),供本地部分拼装 */
  var SYL_BY_LEN = { 2: [], 3: [], 4: [], 5: [], 6: [] };
  (function () {
    var i, ln;
    for (i = 0; i < SYLLABLES.length; i++) {
      ln = SYLLABLES[i].length;
      if (SYL_BY_LEN[ln]) SYL_BY_LEN[ln].push(SYLLABLES[i]);
    }
  })();

  /** partW(rem):恰好 rem 个字母的"音节串"总数(组合计数,浮点即可) */
  var PART_W = [1];
  function partW(rem) {
    if (PART_W[rem] != null) return PART_W[rem];
    var t = 0, p;
    for (p = 2; p <= 6; p++) {
      if (SYL_BY_LEN[p].length && p <= rem && (rem - p === 0 || rem - p >= 2)) {
        t += SYL_BY_LEN[p].length * partW(rem - p);
      }
    }
    PART_W[rem] = t;
    return t;
  }

  /**
   * 用完整音节拼出恰好 L 个字母的本地部分(不截断)。
   * 按组合数加权选段长,保证在所有等长音节串上**均匀分布**(组合熵最大化)。
   */
  function lettersExact(rng, L) {
    var out = '', rem = L, i, p, total, w, r, chosen;
    while (rem > 0) {
      total = 0;
      w = [];
      for (p = 2; p <= 6; p++) {
        if (SYL_BY_LEN[p].length && p <= rem && (rem - p === 0 || rem - p >= 2)) {
          var weight = SYL_BY_LEN[p].length * partW(rem - p);
          w.push([p, weight]);
          total += weight;
        }
      }
      if (!w.length) { rem = 0; break; } // 理论不可达,防御
      r = rng() * total;
      chosen = w[w.length - 1][0];
      for (i = 0; i < w.length; i++) { r -= w[i][1]; if (r <= 0) { chosen = w[i][0]; break; } }
      out += pick(rng, SYL_BY_LEN[chosen]);
      rem -= chosen;
    }
    return out;
  }

  /**
   * 邮箱:本地部分=完整音节(+可选 . _ - 分隔)+ 2-4 位数字,长度与原值同量级(±3);
   * keepDomain=true(默认)保留原域名,否则从常见域名池挑选。
   */
  function genEmail(rng, orig, keepDomain) {
    var m = /^([^@]*)@([^\s@]+)$/.exec(orig.trim());
    var origLocal = m ? m[1] : '';
    var origDomain = m ? m[2].toLowerCase() : '';
    var target = Math.min(24, Math.max(6, origLocal.length || 8)); // 本地部分目标长度
    var digitCount = ri(rng, 2, 4);
    // 字母为主体(≥4,占 target-数字位数 及以上),数字 2-4 位,总长与原值同量级(≤+4)
    var letterTarget = Math.max(4, target - digitCount) + (target < 8 ? ri(rng, 0, 1) : ri(rng, 0, 2));
    var letters = lettersExact(rng, letterTarget);
    var r = rng(), sep = '';
    if (r < 0.12) sep = '.';
    else if (r < 0.2) sep = '_';
    else if (r < 0.26) sep = '-';
    var digits = '';
    for (var i = 0; i < digitCount; i++) digits += String(ri(rng, 0, 9));
    var domainOK = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(origDomain) &&
      /\.[a-z]{2,}$/.test(origDomain);
    var domain = (keepDomain && domainOK) ? origDomain : pick(rng, DOMAINS);
    return letters + sep + digits + '@' + domain;
  }

  /** 中文姓名:长度严格等于原值(2=姓1+名1;3=姓1+名2 或 复姓2+名1;4=复姓2+名2) */
  function genChineseName(rng, t) {
    if (t <= 1) return pick(rng, SURNAME_POOL); // 退化:单字
    var compound;
    if (t === 2) compound = false;
    else if (t === 3) compound = rng() < 0.03; // 复姓在真实人口中占比很低,也避免小空间碰撞聚集
    else compound = true;
    var surname = compound ? pick(rng, COMPOUND_POOL) : pick(rng, SURNAME_POOL);
    var s = surname, i, n = t - surname.length;
    for (i = 0; i < n; i++) s += pick(rng, GIVEN_POOL);
    return s;
  }

  /** 合成指定长度的英文单词(兜底用) */
  function synthWord(rng, n) {
    var s = '', i;
    for (i = 0; i < n; i++) s += String.fromCharCode(97 + ri(rng, 0, 25));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** 西文姓名:长度等于原值,分隔符(空格/点/横线)与原值一致 */
  function genWestern(rng, orig, t) {
    var upper = orig === orig.toUpperCase() && /[A-Z]/.test(orig);
    var sep = orig.indexOf(' ') >= 0 ? ' ' : (orig.indexOf('.') >= 0 ? '.' : (orig.indexOf('-') >= 0 ? '-' : ''));
    var out;
    if (!sep) {
      // 单词名:从名池找等长者,否则截断/合成
      var w = null, j;
      for (j = 0; j < EN_FIRST.length; j++) {
        if (EN_FIRST[j].length === t) { w = EN_FIRST[j]; break; }
      }
      if (!w) w = synthWord(rng, t);
      out = w;
    } else if (t <= 4) {
      out = synthWord(rng, 1) + sep + synthWord(rng, t - 2); // 极短原值的兜底
    } else {
      out = null;
      // 先随机凑 240 次,寻找 (名+分隔+姓) 恰好等长的组合
      for (var k = 0; k < 240; k++) {
        var f = pick(rng, EN_FIRST), l = pick(rng, EN_LAST);
        if (f.length + 1 + l.length === t) { out = f + sep + l; break; }
      }
      if (!out) {
        // 兜底:先取名,再按剩余长度配姓(池内等长优先,否则截断/补足)
        var f2 = pick(rng, EN_FIRST), need = t - f2.length - 1, l2 = null, m2;
        if (need < 2) { f2 = 'Li'; need = t - 3; }
        for (m2 = 0; m2 < EN_LAST.length; m2++) {
          if (EN_LAST[m2].length === need) { l2 = EN_LAST[m2]; break; }
        }
        if (!l2) {
          l2 = pick(rng, EN_LAST);
          if (l2.length > need) l2 = l2.slice(0, need);
          while (l2.length < need) l2 += String.fromCharCode(97 + ri(rng, 0, 25));
        }
        out = f2 + sep + l2;
      }
    }
    return upper ? out.toUpperCase() : out;
  }

  /** 姓名分派:含 CJK 走中文;含拉丁无 CJK 走西文 */
  function genName(rng, orig) {
    var v = orig.replace(/\s+/g, ' ').trim();
    var t = Math.max(2, v.length);
    if (/[\u4e00-\u9fff]/.test(v)) return genChineseName(rng, t);
    if (/[A-Za-z]/.test(v)) return genWestern(rng, v, t);
    return genChineseName(rng, Math.min(4, t)); // 其他文字兜底
  }

  /** IP:原值 IPv6 则生成合法全格式 IPv6;否则生成各段 1-254 的 IPv4 */
  function genIp(rng, orig) {
    if (isIPv6(orig.trim())) {
      var groups = [], i;
      for (i = 0; i < 8; i++) groups.push(ri(rng, 0, 0xFFFF).toString(16));
      return groups.join(':');
    }
    var seg = [], j;
    for (j = 0; j < 4; j++) seg.push(String(ri(rng, 1, 254)));
    return seg.join('.');
  }

  /** 车牌:省简称 + 发牌字母 + 分隔符(与原值一致:·/空格/无)+ 5 位 + 可选特殊尾字 */
  function genPlate(rng, orig) {
    var v = orig.trim();
    var sep = v.indexOf('·') >= 0 ? '·' : (/\s/.test(v) ? ' ' : '');
    var s = PLATE_PROV.charAt(ri(rng, 0, PLATE_PROV.length - 1)) +
            PLATE_LETTERS.charAt(ri(rng, 0, PLATE_LETTERS.length - 1)) + sep;
    for (var i = 0; i < 5; i++) s += PLATE_CHARS.charAt(ri(rng, 0, PLATE_CHARS.length - 1));
    if (/[挂学警港澳]$/.test(v)) s += '挂学警港澳'.charAt(ri(rng, 0, 4));
    return s;
  }

  /** 地址后缀段(用于把过短地址加长到同量级,按自然顺序递进:栋→单元→室→院) */
  function addrSuffix(rng, maxLen, idx) {
    var cands = [
      ri(rng, 1, 99) + '栋',
      ri(rng, 1, 30) + '单元',
      ri(rng, 101, 2999) + '室',
      '院'
    ];
    var first = cands[idx % cands.length], small = first, i;
    if (first.length <= maxLen) return first;
    for (i = 0; i < cands.length; i++) {
      if (cands[i].length <= maxLen) return cands[i];
      if (cands[i].length < small.length) small = cands[i];
    }
    return small;
  }

  /** 按目标长度挑结构组装一次地址 */
  function buildAddrOnce(rng, t) {
    var prov = pick(rng, ADDR_PROVS);
    var city = pick(rng, ADDR_CITIES);
    var dist = pick(rng, ADDR_DISTS);
    var road = pick(rng, ADDR_ROADS);
    var num = String(ri(rng, 1, 999)) + '号';
    if (t <= 9) return road + num;                                  // 路名+门牌
    if (t <= 12) return dist + road + num;                          // 区+路+门牌
    if (t <= 16) return prov + dist + road + num;                   // 省(市)+区+路+门牌
    return prov + city + dist + road + num;                         // 全结构
  }

  /** 地址:长度与原值同量级(±30%),结构随长度自适应 */
  function genAddress(rng, orig) {
    var t = Math.max(6, orig.replace(/\s+/g, '').length);
    var lo = Math.ceil(t * 0.7), hi = Math.floor(t * 1.3);
    var best = null, bestD = Infinity, a, s;
    for (a = 0; a < 24; a++) {
      s = buildAddrOnce(rng, t);
      if (s.length >= lo && s.length <= hi) return s;
      if (Math.abs(s.length - t) < bestD) { bestD = Math.abs(s.length - t); best = s; }
    }
    var out = best, guard = 0;
    while (out.length < lo && guard++ < 8) out += addrSuffix(rng, hi - out.length, guard);
    if (out.length > hi) out = out.slice(0, hi); // 极端兜底:截断
    return out;
  }

  /** 学号占位符:
   *  默认规则 —— 9/10 位纯数字且以年份开头(4 位 19xx/20xx,或 2 位疑似年份)→ 保留年份前缀,其余位随机数字;
   *  兜底规则 —— 不符合上述格式时仍按学号处理,做"同长度字符集保真"混淆(数字→数字、字母→字母、分隔符原样)。
   *  两种规则都保持长度与原值一致,且绝不等于原值。 */
  function studentidKeepLen(orig) {
    if (!/^\d{9,10}$/.test(orig)) return 0;
    if (/^(19|20)\d{2}/.test(orig)) return 4;                    // 4 位年份
    var yy = Number(orig.slice(0, 2));
    if ((yy >= 0 && yy <= 32) || (yy >= 90 && yy <= 99)) return 2; // 2 位疑似年份(近现代)
    return 0;                                                     // 9/10 位但不像年份开头 → 整体混淆
  }
  function genStudentid(rng, orig) {
    var keep = studentidKeepLen(orig);
    if (keep > 0) {
      var tail = '', i;
      for (i = keep; i < orig.length; i++) tail += String(ri(rng, 0, 9));
      var out1 = orig.slice(0, keep) + tail;
      if (out1 === orig) { // 极小概率整体相同:重掷尾段
        out1 = orig.slice(0, keep) + String(ri(rng, 0, 9)) + tail.slice(1);
      }
      return out1;
    }
    // 兜底:逐字符同字符集混淆
    var L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', out = '', ch, j, guard = 0;
    for (j = 0; j < orig.length; j++) {
      ch = orig.charAt(j);
      if (ch >= '0' && ch <= '9') out += String(ri(rng, 0, 9));
      else if (ch >= 'a' && ch <= 'z') out += String.fromCharCode(97 + ri(rng, 0, 25));
      else if (ch >= 'A' && ch <= 'Z') out += L.charAt(ri(rng, 0, L.length - 1));
      else out += ch; // 分隔符等原样保留
    }
    if (out === orig && orig.length) { // 同值兜底重掷
      j = orig.search(/[0-9a-zA-Z]/);
      if (j >= 0) out = out.slice(0, j) + (orig.charAt(j) >= '0' && orig.charAt(j) <= '9' ? String(ri(rng, 0, 9)) : L.charAt(ri(rng, 0, L.length - 1))) + out.slice(j + 1);
    }
    return out;
  }

  /** 通用占位符:5 位无歧义字符;genericStyle='prefix' 时加 "T-" 前缀 */
  function genGeneric(rng, style) {
    var s = '', i;
    for (i = 0; i < 5; i++) s += B32.charAt(ri(rng, 0, B32.length - 1));
    return style === 'prefix' ? 'T-' + s : s;
  }

  // ==================== 8. generate / validatePlaceholder ====================

  /**
   * 生成占位符(确定性)。
   * @param {string} type        fakery.TYPES 之一(未知类型按 generic 处理)
   * @param {string} seedHex     64 个 hex 字符的种子
   * @param {string} originalStr 原值
   * @param {{genericStyle:'short'|'prefix', keepEmailDomain:boolean}} [options]
   *        genericStyle 默认 'short';keepEmailDomain 默认 true
   * @returns {string}
   */
  fakery.generate = function (type, seedHex, originalStr, options) {
    options = options || {};
    var orig = (originalStr == null) ? '' : String(originalStr);
    var rng = makeRng(type, seedHex, orig);
    switch (type) {
      case 'phone':    return genPhone(rng);
      case 'idcard':   return genIdcard(rng);
      case 'bankcard': return genBankcard(rng, orig);
      case 'email':    return genEmail(rng, orig, options.keepEmailDomain !== false);
      case 'name':     return genName(rng, orig);
      case 'ip':       return genIp(rng, orig);
      case 'plate':    return genPlate(rng, orig);
      case 'address':  return genAddress(rng, orig);
      case 'studentid': return genStudentid(rng, orig);
      default:         return genGeneric(rng, options.genericStyle === 'prefix' ? 'prefix' : 'short');
    }
  };

  /** 占位符结构合法性(供测试与还原侧核对) */
  fakery.validatePlaceholder = function (type, placeholder) {
    if (typeof placeholder !== 'string') return false;
    var v = placeholder.trim();
    if (!v) return false;
    switch (type) {
      case 'phone':    return /^1[3-9]\d{9}$/.test(v);
      case 'idcard':   return isIdcard(v);
      case 'email':    return RE_EMAIL.test(v);
      case 'name':     return /^[\u4e00-\u9fff]{1,20}$/.test(v) || /^[A-Za-z][A-Za-z .'\-]{1,39}$/.test(v);
      case 'bankcard': return /^\d{13,19}$/.test(v) && luhnValid(v);
      case 'ip':       return isIPv4(v) || isIPv6(v);
      case 'plate':    return RE_PLATE_GEN.test(v);
      case 'address':  return v.length >= 4 && v.length <= 200 && /[\u4e00-\u9fff]/.test(v);
      case 'studentid': return /^[\dA-Za-z][\dA-Za-z\-]{0,29}$/.test(v);
      case 'generic':  return /^(T-)?[A-HJ-KM-NP-Z2-9]{5}$/.test(v);
      default:         return false;
    }
  };

  return { fakery: fakery };
});
