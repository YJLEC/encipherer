# Encipherer · 表格隐私卫士 — 架构与模块 API 规范

> 本文件是所有开发子代理的**契约**。各模块 API 以此为准;如需变更,必须在代码注释中说明并在最终汇报中提出。
> 应用名:**Encipherer(表格隐私卫士)** v1.0.0。中文界面。

## 0. 总体形态

- **核心产物**:`dist/Encipherer.html` — 单个 HTML 文件,内嵌全部 JS/CSS/依赖,双击在任意现代浏览器打开即用(Windows/macOS/Linux)。**零网络请求、零安装**。
- **桌面产物**(可选层):Electron 封装 → Windows 便携 exe 等。
- **构建**:`build/build.js`(Node)把 `src/` + `vendor/` 内联成单文件。
- **开发约定**:
  - **不用 ES modules**(file:// 下 Chrome 禁止模块加载)。全部使用**经典 script + 全局命名空间 `Encipherer`**,每个文件用 UMD 包装使其也能在 Node 测试中 `require`。
  - Node ≥ 18 有 `globalThis.crypto`(WebCrypto),测试直接用。
  - 所有用户可见文案为**简体中文**;代码标识符英文;注释中文。
  - 不引入未列出的第三方依赖。`vendor/` 仅两个:`xlsx.full.min.js`(SheetJS 0.20.3)、`exceljs.min.js`(4.4.0),均为 UMD 全局 `XLSX` / `ExcelJS`。

### UMD 包装模板

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Encipherer = root.Encipherer || {}; var m = factory(root.Encipherer);
    for (var k in m) root.Encipherer[k] = m[k]; }
})(typeof self !== 'undefined' ? self : this, function (E) { E = E || {};
  // ... 实现,返回 { 模块名: 对象 }
  return { MyModule: MyModule };
});
```

浏览器中各模块把导出项**合并挂到 `window.Encipherer`** 下(如 `Encipherer.crypto`、`Encipherer.fakery`、`Encipherer.excel`、`Encipherer.workspace`、`Encipherer.ui.*`、`Encipherer.util`)。

## 1. 数据模型(核心)

### 1.1 PII 类型(`Encipherer.fakery.TYPES`)

`'phone' | 'idcard' | 'email' | 'name' | 'bankcard' | 'ip' | 'plate' | 'address' | 'generic'`

| key | 中文 | 自动检测 |
|---|---|---|
| phone | 手机号 | 强(中国大陆手机号) |
| idcard | 身份证号 | 强(18 位+校验) |
| email | 邮箱 | 强 |
| bankcard | 银行卡号 | 强(Luhn) |
| ip | IP 地址 | 强(IPv4/IPv6) |
| plate | 车牌号 | 强(中国大陆车牌) |
| name | 姓名 | 弱(仅扫描建议,不自动脱敏) |
| address | 地址 | 弱(仅扫描建议) |
| generic | 通用文本 | 兜底(手动指定) |

### 1.2 工作簿模型(`Encipherer.excel`)

```js
Workbook = {
  id: 'wb_xxx', name: '原始文件名.xlsx', ext: 'xlsx'|'xlsm'|'xls'|'csv',
  engine: 'exceljs'|'sheetjs'|'csv',
  sheets: [SheetModel],        // sheets[i]
  _raw: <引擎句柄,不序列化>
}
SheetModel = {
  name: 'Sheet1',
  rows: (Cell|null)[][],       // rows[r][c],r/c 从 0 开始
  maxCols: number
}
Cell = { v: string|number|boolean|null, t: 's'|'n'|'b', display: string }
// display 永远是可直接给用户看/参与检测的字符串(数字不做科学计数法)
```

### 1.3 规则模型(工作台内部,由 UI 层持有)

```js
Rule = {
  id: 'rule_xxx',
  fileIds: ['wb_1'] | '*',            // 通常为当前文件
  sheet: 0,                            // sheet 索引
  target: { kind:'col', c: 3 }                       // 整列
        | { kind:'range', r1:1, c1:2, r2:99, c2:2 },  // 矩形区域(含端点)
  pii: 'auto' | TYPES,                 // auto=逐格强检测,命中才替换
  enabled: true, note: '手机号列'
}
```

### 1.4 工作区(`Encipherer.workspace`)— 对应需求"一次工作"

- 由 **名称 + 主密码** 创建。同一工作区内,`某类型下同一原值 → 同一占位符`,跨文件、跨次运行稳定;**唯一性有冲突检测兜底**。
- 持久化为 `.ecw` 文件(加密) + IndexedDB 本地自动副本(仅存加密 blob)。localStorage 只存最近列表元数据(名称/时间/盐/校验子,无明文秘密)。
- 文件格式 `.ecw`:第一行 JSON 头(明文,`{v:1, kdf:{salt,iter}, verifier, name, updatedAt}`)+ `\n` + base64(AES-GCM 密文,内含完整工作区 JSON)。

## 2. 模块 API

### 2.1 `Encipherer.util`(已完成,可直接用)

```js
util.uid(prefix)                 // 'xxx_随机'
util.b64(buf|Uint8Array) -> str  // ArrayBuffer/TypedArray → base64
util.unb64(str) -> Uint8Array
util.hex(buf) -> str
util.download(blob, filename)    // 触发浏览器下载(Electron 下也走保存)
util.esc(s)                      // HTML 转义
util.el(tag, attrs, children)    // 快速建 DOM: attrs 含 class/text/html/on{Event}
util.debounce(fn, ms)
util.fmtBytes(n) / util.fmtTime(ts) / util.nowIso()
util.toast(msg, kind)            // kind: 'info'|'ok'|'warn'|'err',右下角浮层
util.confirmDialog({title, body, danger, confirmText}) -> Promise<bool> // 模态确认
util.a1(r, c)                    // 0基索引 → 'A1' 式地址(列字母+行号)
util.parseCSVLine(line)          // 引号感知切分
util.crc32(u8) -> number
util.zipStore(files:[{name, data:Uint8Array}]) -> Uint8Array  // 仅 STORE 的极简 zip(供"全部下载")
util.bus                        // {on(evt,fn), off, emit(evt,data)} 全局事件总线
```

事件(全局 bus):`'workspace:locked'`、`'workspace:unlocked'`、`'theme:change'`、`'files:changed'`。

### 2.2 `Encipherer.crypto`(已完成)

```js
crypto.DEFAULT_ITER = 600000          // PBKDF2-HMAC-SHA256 迭代
crypto.randomSaltB64() -> Promise<str>           // 16B base64
crypto.deriveKeys(password, saltB64, iter) -> Promise<Keys>
// Keys = { kMap: CryptoKey(HMAC-SHA256, 不可导出), kStore: CryptoKey(AES-GCM),
//          kCheck: CryptoKey(HMAC-SHA256) }
crypto.hmacHex(key, messageStr) -> Promise<hexStr>
crypto.encryptJSON(kStore, obj) -> Promise<{n: b64, c: b64}>     // 96bit 随机 nonce
crypto.decryptJSON(kStore, {n, c}) -> Promise<obj>               // 失败抛错
crypto.VERIFIER_MSG = 'encipherer-v1-verify'
```

### 2.3 `Encipherer.fakery`(子代理 A 实现)

纯逻辑、无 DOM、无 IO。**确定性**:同 `(type, seedHex, 原值)` → 同占位符。

```js
fakery.TYPES            // 上述 9 个 key 数组
fakery.TYPE_META        // { phone: {label:'手机号', color:'#e65100'}, ... } color 用于 UI 徽标
fakery.detect(valueStr) -> { type, confidence } | null
// 只做强检测(idcard>phone>bankcard>email>ip>plate 优先级);valueStr 已是 display 字符串
fakery.suggest(valueStr) -> [{type, confidence}]  // 含弱建议(name/address),供"扫描建议"
fakery.normalize(type, valueStr) -> string
// phone/idcard/bankcard:仅保留数字;email:去空格+转小写;其余:trim+压缩空白
fakery.generate(type, seedHex, originalStr, options) -> string
// options = { genericStyle:'short'|'prefix' (默认'short'),
//             keepEmailDomain:true|false (默认 true) }
// 必须保证:长度/字符集/格式与原值同族,人眼看起来自然;见 §3
fakery.validatePlaceholder(type, placeholder) -> bool  // 结构合法(供测试)
```

**seedHex** 是 64 hex 字符串;内部用 sfc32 等 PRNG 从 seed 派生随机流。**冲突处理不在 fakery**(由 workspace 负责:占位符已存在时以 `counter` 重新派生 seed)。

### 2.4 `Encipherer.excel`(子代理 B 实现)

```js
excel.SUPPORTED = ['xlsx','xlsm','xls','csv']
excel.loadFile(arrayBuffer, fileName) -> Promise<Workbook>   // 按扩展名选引擎
// xlsx→ExcelJS(保样式);xlsm/xls→SheetJS;csv→内置解析(编码自适应 UTF-8/BOM/GBK)
excel.cellText(cell|null) -> string                          // display
excel.patchAndExport(workbook, patches) -> Promise<Blob>
// patches: [{sheet, r, c, text}]  —— 只改命中的格,其余原样保留(样式尽量保真)
// xlsx: ExcelJS 直接改 cell.value=text 后 writeBuffer;xlsm/xls: SheetJS 改后原 bookType 写回
// csv: 序列化(加 \uFEFF BOM,\r\n 行尾,含逗号引号时加引号)
excel.exportCSVFromModel(rows) -> Blob     // 供映射表明文导出等
```

注意:
- 数字单元格 patch 成文本时,ExcelJS 直接赋字符串即可;SheetJS 置 `{t:'s', v:text}`。
- 读取时 display:日期给 `YYYY-MM-DD HH:mm:ss`;富文本拼接;公式给其计算结果文本;布尔给 'TRUE'/'FALSE';错误值原样。
- 超大表不裁剪模型(处理需要全量),预览裁剪由 UI 层做(grid.setWindow)。
- `.xls`/`.xlsm` 写回后样式/宏可能降级,workbook.lossy=true 标注,UI 显示"将降级"提示。

### 2.5 `Encipherer.grid`(子代理 C1 实现,UI 组件)

可视化预览 + 选区,`src/js/ui/grid.js` + `src/css/grid.css`。

```js
new Grid(container, opts)
opts = { onSelectionChange(sel), onColumnHeaderClick(c), onRowHeaderClick(r), maxPreviewRows: 2000 }
grid.setData(sheetModel, {windowRows: 1000})   // 超 windowRows 截断并 status 提示
grid.getSelections() -> [{r1,c1,r2,c2}]        // 0 基,含端点,已按 drag/ctrl 累积
grid.clearSelection()
grid.setColMarks({colIndex: {type, label, color}})   // 列头徽标:已设规则的列
grid.setCellTints({'r:c': {type, confidence}})       // 检测高亮(淡色底+类型角标)
grid.setPreview({'r:c': newText})                    // 预览:单元格右上角红点+悬浮显示替换后文本
grid.clearOverlays()
grid.scrollTo(r, c); grid.destroy()
```

要求:双向虚拟滚动(仅渲染可视行/列),行高 26px、默认列宽 96px、行号列 48px、表头 sticky;支持鼠标拖选矩形、Ctrl 累积多选、点击列头选整列、Shift 扩展;键盘方向键移动活动格;底部状态条显示 `A1 式地址 + 选区范围与格数`;样式全部走 `grid.css`(类名前缀 `eg-`)。

### 2.6 `Encipherer.workspace`(主代理实现)

```js
workspace.create(name, password) -> Promise<Ws>      // 创建并注册为当前
workspace.openFromBlob(blob, password) -> Promise<Ws>
workspace.openFromLocal(id, password) -> Promise<Ws> // IndexedDB 副本
workspace.current -> Ws | null
workspace.recents() -> [{id, name, updatedAt, hasLocal}]   // localStorage
Ws = {
  id, name, createdAt, updatedAt, iter, saltB64, settings,
  settings = { theme:'auto', autoLockMin:10, genericStyle:'short', keepEmailDomain:true },
  // —— 核心操作 ——
  mask(piiType, valueStr) -> Promise<{placeholder, isNew, type}>
  // normalize→查 map→命中直接返回(稳定);未命中 generate(seed=HMAC(kMap,type+'|'+norm)),
  // 冲突(占位符已被他人占用或==任一原值)则 seed 重派生(counter),登记后返回
  unmask(placeholder) -> {value, type} | null        // 反查
  countHit(placeholder) / 计数:每次 mask 命中已有映射时 occurrences++
  listMappings({type, q, offset, limit}) -> {total, rows:[{type, original, placeholder, count}]}
  stats() -> {entries, byType:{...}, totalHits}
  // —— 生命周期 ——
  lock()                     // 清空内存密钥与映射(仅留加密 blob)
  unlock(password) -> Promise<bool>
  isLocked
  saveLocal() -> Promise     // IndexedDB upsert(加密 blob)
  exportFile() -> Promise<Blob>          // .ecw
  changePassword(old, newPw) -> Promise
  rename(name); destroy() -> Promise     // 清 IndexedDB + recents
  forgetLocal()             // 只清本机副本,保留导出能力
}
```

序列化内容(全部进 AES-GCM 密文):`{v:1, name, createdAt, updatedAt, settings, maps:{type:{norm:placeholder}}, occurrences:{...}}`。

### 2.7 UI 屏幕(`Encipherer.ui.*`,子代理 C2 实现)

hash 路由:`#/home`(未开工作区)/ 锁定时全屏锁屏遮罩覆盖一切。工作区内 tab:`#/workbench`(文件与脱敏)、`#/restore`(还原)、`#/mapping`(映射表)、`#/settings`(设置)、`#/help`(帮助)。各屏暴露 `mount(container)` / `unmount()`。

**workbench 流程**:左侧文件栏(上传/拖放,文件卡:名称、引擎徽标、移除)→ 中部 sheet 标签 + grid + 工具条(规则类型下拉 + "对选中区域应用"、自动检测扫描、预览开关、规则列表、执行脱敏)→ 结果弹窗(逐文件下载 + 统计:各类型格数/新增映射数)。**执行**:`对每个规则命中的 cell → detect/指定类型 → ws.mask(type, text) → patch`;auto 类型未命中强检测则跳过。完成后标记文件"已脱敏"并允许下载,原文件保留可再次执行。

**restore 流程**:上传脱敏后的文件 → 两种模式:①按选区还原(复用 grid+规则 UI,target 内做 unmask,未命中不动)②智能扫描(全表逐格 `ws.unmask(display)`,命中即还原)。输出还原文件 + 报告(还原格数/未识别占位符数)。

**mapping**:统计卡 + 搜索(原值/占位符模糊)+ 类型筛选 chips + 分页表格 + 导出(加密 .ecw / 明文 CSV,后者需再次输入密码 + 红色警告确认)。

**settings / lock / help / home**:见目标描述。home 含"新建工作区向导"(名称+密码×2+强度条)与最近列表、隐私承诺三条、三步用法说明。

## 3. 占位符格式规范(子代理 A 必须遵守)

人眼自然、格式保真、同族长度;**占位符不得包含真实信息**:

| 类型 | 原值示例 | 占位符示例 | 规则 |
|---|---|---|---|
| phone | 13812345678 | 13984261753 | 1 + 真实号段(3/5/7/8/9 开头的两位) + 9 位随机数字,共 11 位 |
| idcard | 110101199003078515 | 440301200211304566 | 真实行政区划码池 + 合法出生日期 + 3 位顺序码 + **正确校验位** |
| bankcard | 6222021234567890 | 6217002938475610 | 62 开头,长度同原值,通过 Luhn |
| email | zhang.san@qq.com | linyue482@163.com | 本地部分音节+数字;域名=原域名(默认保留,可关)或常见域名池 |
| name | 欧阳靖雯 | 邵丽华 | 中文:姓氏池(含复姓)+常用名字池,长度与原值相同(2→2,3→3,4→4);西文:同长度量级的英文姓名 |
| ip | 192.168.1.23 | 172.24.8.114 | 合法 IPv4 各段 1–254;IPv6 同族生成 |
| plate | 京A·12345 | 沪C6K92B | 省份池 + 发牌字母 + 5 位(含字母数字),格式同原值(含·或空格) |
| address | 北京市海淀区中关村大街1号 | 广东省佛山市禅城区汾江路216号 | 真实省市(区)池 + 路名池 + 门牌;长度同量级 |
| generic | AB-2024-001 | 7K2M9 或 T-7K2M9 | base32 无歧义字符集(去 I/L/O/0/1),5 位;prefix 样式加 `T-` |

字符池须**去歧义**(无 I l 1 O 0 混淆);所有池数据写在 fakery.js 内,不外联。

## 4. 隐私红线(所有模块)

1. **零网络**:不 fetch/XHR/WebSocket/CDN/字体外链;CSP meta 限死。
2. 明文映射只存在于内存与用户显式导出的文件;.ecw 恒为 AES-GCM 加密。
3. 锁定/销毁后内存密钥、映射表即刻丢弃(置 null)。
4. 不打印任何原值到 console(测试代码除外,且测试不进 dist)。

## 5. 测试约定

- `tests/*.test.js`,用 `node --test tests/` 运行(node:test + assert)。
- 每个逻辑模块(fakery/excel/crypto/workspace)必须有测试:确定性(同 seed 同输出)、唯一性、往返(mask→unmask 还原)、保格式(长度/字符集/校验位)、Excel 补丁不破坏未命中格。
- E2E:由主代理用浏览器自动化完成(建工作区→上传→选区→脱敏→下载→还原)。
