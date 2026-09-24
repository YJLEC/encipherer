# Encipherer · 表格隐私卫士

**把含隐私的 Excel/CSV 表格安全地交给第三方或 AI:发出去之前一键脱敏,拿回来之后一键还原。**

Encipherer 是一个**完全离线**运行的表格脱敏/还原工具。它把表格中的手机号、身份证号、姓名等敏感信息替换成格式保真的假数据(假手机号仍是合法手机号、假身份证号能通过校验位),你把脱敏副本交给外部处理;对方处理完回传,你再用同一工作区把占位符一键换回真实值——**对方增删行列、改动表格都不影响还原**。

---

## 核心特性

| 特性 | 说明 |
|---|---|
| 🔒 完全离线 | 零网络请求、零遥测、零 CDN/字体外链(CSP 层面禁死),可断网使用,数据不出本机 |
| 🕵️ 智能脱敏 | 10 种类型:手机号、身份证号、邮箱、银行卡号、IP、车牌、姓名、地址、**学号**、通用编码;支持逐格自动检测与整列/区域规则 |
| 🎓 学号脱敏 | 保留入学年份(4 位 `2024…` / 2 位 `24…` 开头),其余位混淆;不符合年份格式的编号仍按学号处理,做同长度字符集保真混淆 |
| 🧭 表头识别(多行) | 上传后自动识别表头行,支持**复选多行表头**(带行内容预览),勾选行一律不参与脱敏;扫描时还会按表头关键词(学号/姓名/手机号…)给出类型建议 |
| ↩️ 智能还原 | 按**值**而非位置匹配占位符,第三方改表(增删行列、调列序)后仍可全量还原 |
| 🎭 格式保真占位符 | 占位符与原值同族同长:假手机号仍是合法号段、假身份证号校验位正确、假银行卡号通过 Luhn——人眼看自然,业务逻辑不报错 |
| 🗄 工作区加密 | 名称 + 主密码创建工作区;PBKDF2(600,000 次)派生密钥,映射表 AES-256-GCM 加密持久化(`.ecw` 文件);同一原值 → 同一占位符,跨文件、跨次运行稳定 |
| 🤖 自动扫描 | 一键扫描每列:值强检测(手机号/身份证等 6 类)+ 值弱建议(姓名/地址/学号)+ 表头关键词建议,命中率高的列一键应用 |
| 🔲 可视化选区 | Excel 式虚拟滚动表格预览,拖选/Ctrl 多选/点列头选整列,检测高亮 + 替换预览(红点悬浮查看) |
| 📊 多格式支持 | `.xlsx` · `.xlsm` · `.xls` · `.csv`(读取自适应 UTF-8/GBK);只改命中格,未命中内容与样式原样保留 |
| 🌙 深色模式 | 浅色为主的专业安全感设计,支持 auto/light/dark 三态主题 |
| 📦 零安装 | 核心产物是一个 HTML 文件,双击即用;另有 Electron 桌面版 |

## 三种使用形态

| 形态 | 获取方式 | 适用 |
|---|---|---|
| **① 单文件版(推荐)** | `dist/Encipherer.html`(约 2.1 MB,全部代码与依赖内嵌这一个文件) | 任意现代浏览器(Windows/macOS/Linux),双击即用、随 U 盘携带、可整体审计 |
| **② 在线版** | 自行部署:`web/index.html` 放到任意静态托管(GitHub Pages / Cloudflare Pages,见 [docs/Web部署.md](docs/Web部署.md)) | 发个链接就能用;HTTPS 源下浏览器存储完整可用 |
| **③ Windows 桌面版** | [GitHub Releases](https://github.com/YJLEC/encipherer/releases/latest) 下载 `portable`(便携,免安装)/ `setup`(安装向导)exe,约 71 MB | 不依赖浏览器、存储不受 `file://` 限制,适合日常重度使用 |
| **④ macOS / Linux 桌面版** | 需在对应系统上执行 `npm run dist:mac` / `dist:linux` 打包(见 [docs/打包指南.md](docs/打包指南.md)) | mac dmg/zip、Linux AppImage/deb |

> 单文件版在 `file://` 协议下浏览器会限制本地存储,应用会自动降级(localStorage 或纯内存)——重要工作请及时**导出 `.ecw` 文件**,或改用桌面版。

## 快速开始(单文件版,三步)

1. **双击** `dist/Encipherer.html`,在浏览器中打开(建议 Chrome/Edge);
2. 首页**新建工作区**:填名称 + 主密码(密码用于加密映射表,务必牢记,无法找回);
3. 进入工作台,**把表格文件拖进窗口**——点「自动扫描」找敏感列(或在表格上拖选区域),「预览效果」确认后「执行脱敏」,下载脱敏副本即可外发;对方回传后在「还原」页拖入,智能扫描一键还原。

详细图文流程见 **[docs/使用指南.md](docs/使用指南.md)**。

## 安全模型摘要

- **零网络**:不 fetch/XHR/WebSocket,无任何外链;CSP `connect-src 'none'` 双保险。
- **密钥**:主密码 → PBKDF2-HMAC-SHA256(600,000 次迭代,16 字节随机盐)→ HKDF 派生三把用途隔离的子钥(占位符生成 HMAC / 存储加密 AES-GCM / 密码校验);密钥不可导出、只存内存,锁定即丢弃。
- **落盘**:映射表只以 AES-256-GCM 密文形式存在(`.ecw` 文件 / 本机 IndexedDB 副本);明文仅在内存与你显式导出的 CSV。
- **威胁模型**:防第三方看到原始值、防 `.ecw` 被拷走后离线破解、防回传表格被改动;不防主密码被窃取与主动外发明文映射。

完整白皮书:**[docs/PRIVACY.md](docs/PRIVACY.md)**。

## 开发者

```bash
npm install        # 安装 devDependencies(electron、electron-builder)
npm run build      # 构建单文件 dist/Encipherer.html(src/ + vendor/ 内联)
npm test           # 运行 56 个单元/往返测试(node:test)
npm run sample     # 生成样例表格(samples/示例-客户信息表.xlsx/.csv 等)
npm start          # = npm run start:electron,本地起 Electron 壳调试
npm run dist:win   # 打包 Windows 便携版 + NSIS 安装包(产物在 release/)
```

打包(macOS/Linux 版、体积参考、常见问题)详见 **[docs/打包指南.md](docs/打包指南.md)**。

### 目录结构

| 路径 | 内容 |
|---|---|
| `dist/Encipherer.html` | **构建产物**:单文件应用(分发它即可) |
| `src/index.html` | 页面模板(含 `@CSS@`/`@JS@` 注入点) |
| `src/css/` | `app.css` 设计系统 + `grid.css` 表格组件样式 |
| `src/js/` | 核心逻辑:`util` `crypto` `fakery`(占位符生成)`excel`(读写)`workspace`(加密工作区) |
| `src/js/ui/` | 界面:`app`(外壳/路由)`home` `workbench`(脱敏)`restore`(还原)`mapping`(映射表)`settings` `lock` `help` `grid`(表格组件) |
| `vendor/` | SheetJS 0.20.3、ExcelJS 4.4.0(UMD,构建时内联) |
| `electron/main.js` | Electron 桌面壳:app:// 特权协议加载单文件、阻断导航、下载走保存对话框 |
| `build/build.js` | 构建脚本:内联打包为单 HTML |
| `tests/` | node:test 测试套件(56 用例) |
| `samples/` | 样例表格生成脚本与产物 |
| `docs/` | ARCHITECTURE(架构契约)、UI-SPEC、PRIVACY(安全白皮书)、使用指南、打包指南 |
| `release/` | 桌面版打包产物(gitignore) |

## 已知限制

- **`.xls` / `.xlsm` 写回时样式与宏可能降级**(处理前会有「将降级」提示);建议优先转存 `.xlsx`。
- **合并单元格只替换左上角格**的值。
- **公式格按其计算结果脱敏**,公式本身会被替换为占位文本。
- **预览最多显示前 1000 行**(处理始终作用于全量数据,不受影响)。
- CSV 导出统一为带 BOM 的 UTF-8。

## 许可

私有项目,未设开源许可证;内置第三方库 SheetJS(Apache-2.0)与 ExcelJS(MIT)随单文件分发。

## 许可证

[MIT](LICENSE) — 可自由使用、修改与分发。第三方依赖:SheetJS(Apache-2.0)、ExcelJS(MIT),均以原始形式内嵌于 `vendor/`。
