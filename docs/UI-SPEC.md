# Encipherer UI 详细规范(C2 子代理契约)

先读 `docs/ARCHITECTURE.md`(模块 API/数据模型),再读本文件。实现全部界面到指定文件。所有界面中文。风格:现代、克制、专业安全感;绿色主色 `#1a7f5a`(隐私/安全),浅色为主、支持深色模式。

## 你负责的文件(不得改动其他文件)

- `src/css/app.css` — 全局样式与设计系统(类名前缀 `ec-`)
- `src/js/ui/app.js` — 应用外壳/路由/主题/锁定遮罩/启动
- `src/js/ui/home.js` — 首页(新建/打开工作区)
- `src/js/ui/workbench.js` — 文件与脱敏(核心屏)
- `src/js/ui/restore.js` — 还原
- `src/js/ui/mapping.js` — 映射表
- `src/js/ui/settings.js` — 设置
- `src/js/ui/lock.js` — 锁屏遮罩
- `src/js/ui/help.js` — 帮助/关于

已有可依赖的模块(已完成,读源码了解细节):`src/js/util.js`、`src/js/crypto.js`、`src/js/workspace.js`;并行开发中(按 ARCHITECTURE.md 契约调用,如签名有出入以源码为准并汇报):`src/js/fakery.js`、`src/js/excel.js`、`src/js/ui/grid.js`。

**UMD 挂载**:每个 ui 文件用规范模板把 `Encipherer.ui.home` 等挂到全局(浏览器 only,UMD 的 Node 分支导出空对象即可)。**禁止 innerHTML 拼接任何用户数据**(XSS),一律 textContent / util.el。

## 设计系统(app.css)

- CSS 变量:`--ec-bg、--ec-fg、--ec-muted、--ec-line、--ec-card、--ec-primary(#1a7f5a)、--ec-primary-weak、--ec-danger(#c0392b)、--ec-warn、--ec-radius(10px)`;`html.dark` 下定义深色值。
- 组件类:`.btn .btn-primary .btn-ghost .btn-danger .btn-sm`、`.card`、`.input .select`(统一高 34px)、`.tabs .tab(.active)`、`.chip`、`.badge`、`.table`(数据表:表头淡底、行 hover)、`.ec-empty`(空状态)、`.progress > i`、`.modal-*`(util 的 confirmDialog 已用 `ec-modal-overlay/ec-modal/ec-modal-btns`,需定义样式)、`.ec-toasts/.ec-toast(.show .-ok .-warn .-err)`、`.ec-dragover`(全屏拖放高亮)。
- 布局:外壳 `header.ec-topbar`(logo/标题/导航/右侧按钮)+ 主区;工作台三栏:左 260px 文件栏、中间自适应表格区、右 300px 规则栏;小屏(<1100px)右栏折叠为可开关抽屉。
- 字体栈:system-ui, "Segoe UI", "Microsoft YaHei", sans-serif。

## app.js — 外壳

- `Encipherer.ui.app.boot()`:注入基础 DOM(`#app` 内:topbar + `<main id="ec-main">`),注册 hash 路由 `#/home|workbench|restore|mapping|settings|help`;监听 `util.bus`:
  - `workspace:locked` → 显示 lock 遮罩(lock.js)
  - `theme:change` → 切 `html.dark`
- 路由守卫:无 `workspace.current`(或已锁定且无遮罩逻辑)时强制 `#/home`;有工作区时默认跳 `#/workbench`。切屏时调旧屏 `unmount()`、新屏 `mount(mainEl)`。
- topbar:左:盾形 logo(inline SVG)+ `Encipherer 表格隐私卫士` + 当前工作区名徽标;中:导航(文件与脱敏/还原/映射表/设置/帮助,当前项高亮);右:主题按钮(🌞/🌙 循环 auto→light→dark)、锁定按钮、关闭工作区按钮(confirm 后 `ws.lock()`、`workspace.current=null`、回首页)。无工作区时只显示 logo+主题。
- `boot()` 里调用 `workspace.startAutoLock()`。
- 全局拖放:文件拖到窗口任意处(工作台/还原屏激活时)触发上传;`.ec-dragover` 全屏虚线高亮。
- 版本:`window.__EC_BUILD__.version` 显示于帮助页。

## home.js — 首页

无工作区时呈现。三块:

1. **英雄区**:大标题 + 一句副标("把含隐私的表格安全地交给第三方或 AI——脱敏发出,处理后一键还原")+ 三条隐私承诺卡(完全离线·零网络请求 / AES-GCM 加密·PBKDF2 60 万次派生 / 数据不出本机,密钥只在内存)。
2. **新建工作区**(卡片表单):名称、密码、确认密码、密码强度条(弱/中/强:长度与字符类别)、"显示密码"眼睛按钮、高级折叠(PBKDF2 迭代次数,默认 600000,≥100000)。校验:名称非空 ≤40 字,两次一致,密码 ≥8 字符。提交 → 按钮 loading → `workspace.create()` → toast 成功 → `#/workbench`。失败 toast err。
3. **打开工作区**:最近列表(`workspace.recents()`:名称、时间 util.fmtTime、`本机有副本`/`仅文件` 徽标;点击有副本项 → 密码弹窗 → `openFromLocal(id,pw)`,null 时 toast"密码错误";仅文件项 → 提示选择 .ecw)+ "打开 .ecw 文件"按钮(input file accept=".ecw")+ 拖放 .ecw 到窗口亦可(读 File → `openFromBlob`)。打开成功进入工作台。
4. 底部:三步使用说明(① 新建工作区并上传表格 ② 框选敏感区域生成脱敏副本 ③ 处理完后回传,智能还原)。

密码输入弹窗做成通用小组件(本文件内实现即可)。

## workbench.js — 文件与脱敏(最核心)

状态:`files: [Workbook]`、`activeIdx`、`activeSheet`、`rules: [Rule]`、`results: {fileId: {blob, stats, doneAt}}`。

布局:左文件栏 / 中(sheet 标签 + 工具条 + grid 容器 + 底部提示)/ 右规则栏。

### 左:文件栏
- "上传表格"按钮 + 拖放区提示;accept 按 `excel.SUPPORTED`;多选;`input.files` 逐个 `arrayBuffer()` → `excel.loadFile` → push(重名自动加 (2));"正在解析…"遮罩(util.nextFrame 后再重活)。
- 文件卡:名称、大小(util.fmtBytes)、引擎徽标(xlsx 保样式/xls 兼容/csv)、sheet 数、"已脱敏✓"标记(若 results 有)、点击切换 active;×移除(连带其 rules,confirm)。
- 空状态:图示 + "上传或拖入 .xlsx / .xlsm / .xls / .csv"。

### 中:表格预览
- sheet 标签(超出滚动);`new Grid()` 一次,切换 sheet/文件时 `setData`(windowRows 1000)。
- 工具条:
  - 规则类型下拉(自动检测 + fakery.TYPE_META 各项 label)
  - **[对选中区域应用]**:把 grid.getSelections()(可多块)生成 Rule(kind:'range');若选区恰好整列(列头点击产生)则 kind:'col'。pii 取下拉值。无选区时 toast 提示。
  - **[自动扫描]**:对活动 sheet 每列取前 50 个非空 display,fakery.detect;列强命中率 ≥60% → 建议项;弱建议(fakery.suggest 聚合 name/address 命中 ≥60%)也列出但标注"建议"。建议条显示在工具条下方:`B 列 · 手机号 · 38/40 [应用]`。应用=添加 col 规则(pii=检测类型)。全无 → toast"未发现明显敏感列"。
  - **[预览效果]** 开关:开启后对**可视窗口内**且被规则命中的格调 `ws.peek(type,text)`(注意 peek 无副作用,auto 类型先 detect),`grid.setPreview({'r:c':placeholder})`;关闭 clearOverlays。预览中显示说明"预览不写入映射"。
  - **[清除选择]**。
- 规则命中格的即时高亮:每次规则变化,对可视窗口内命中格 `grid.setCellTints`(auto 用 detect 结果,confidence 高=较深色);列规则 `grid.setColMarks({c:{type,label,color}})`。

### 右:规则栏
- 列表:每条规则卡片:范围描述(col → "整列 B";range → "B3:D17",util.a1)、类型徽标(TYPE_META color)、auto 标"自动检测"、启用 checkbox、删除 ×、备注可编辑(input)。
- 规则统计:命中格数合计(实时按可视窗口估计或全量?全量太贵——显示"共 N 条规则");**[全部清除]**。
- **[执行脱敏]** 大按钮 → 确认弹窗(列出将处理的文件与规则数)→ 执行管线(见下)→ 结果弹窗。
- 执行管线(注意逐格 await,每 200 格 `util.nextFrame()` 防卡顿,进度条显示):
  ```
  对每个有规则且未处理的文件:
    patches=[]; stats={masked,byType:{},newMap,skipped}
    遍历每条启用规则的目标格(col: r=0..rows.length-1;range: 双闭区间):
      text=excel.cellText(rows[r][c]); 空白跳过
      type = rule.pii==='auto' ? (fakery.detect(text)||{}).type : rule.pii
      if(!type){stats.skipped++;continue}
      res = await ws.mask(type, text)
      if(res.skipped) continue
      patches.push({sheet:rule.sheet,r,c,text:res.placeholder})
      stats.masked++; stats.byType[type]=(..||0)+1; res.isNew&&stats.newMap++
    blob = await excel.patchAndExport(wb, patches)
    results[fileId]={blob, stats}
  ```
  目标格越界(超 maxCols/rows)自动夹紧;结果弹窗:每文件卡片(名称、各类型格数 chips、新增映射数、跳过数、"下载脱敏文件"按钮——文件名 `原名(去扩展).脱敏.扩展`)、汇总、**[打包下载全部]**(util.zipStore → 下载 `脱敏结果.zip`;文件名重名时加序号)。
  工作区映射有更新 → 自动 `ws.saveLocal()`(静默,失败仅 toast warn)。
- lossy 文件(xls/xlsm)在文件卡与结果卡提示"将降级:样式/宏可能丢失"。

### 状态细节
- 切换文件/sheet 时规则栏与高亮刷新(规则按 fileId+sheet 过滤)。
- 已脱敏文件再次执行前 confirm"该文件已有脱敏结果,重新执行将基于原始上传内容"。

## restore.js — 还原

需工作区(锁定则由遮罩接管)。上传区(同 workbench,独立 files 列表)+ 两个模式标签:

1. **智能还原(推荐)**:上传文件 → [开始扫描]:全文件全 sheet 逐格 `ws.unmask(display)`,命中即记录 patch;扫描完显示报告卡:每文件(命中格数、涉及类型分布、未命中占位符样式格数[仅 generic prefix 模式可识别:T-开头但不在映射];提示"未识别的占位符将保持原样")+ [下载还原文件](`原名.还原.ext`)+ [打包下载]。扫描大文件有进度条。未上传前显示说明文案(第三方改表也没关系:逐格识别,不依赖行列位置)。
2. **按选区还原**:与 workbench 相同的 grid+规则 UI(复用 grid;本屏自建 rules;pii 固定"任意",即 target 内全部尝试 unmask,未命中不动)。执行同管线但调用 unmask。

## mapping.js — 映射表

- 顶部统计卡:`ws.stats()` → 总条目、总替换次数、各类型 chips(数量)。
- 工具条:搜索框(原值/占位符,防抖 300ms)、类型下拉(全部+9类)、分页(每页 100,上一页/下一页/页码)。
- `.table`:类型徽标 | 原值 | 占位符 | 出现次数。空态:"还没有任何映射——去工作台执行一次脱敏"。
- 导出:
  - [导出加密工作区 .ecw] → ws.exportFile() 下载(建议名 ws.suggestedFileName());toast 提示"妥善保管,泄露=泄露全部映射"。
  - [导出明文映射 CSV] → 密码确认弹窗(重新输入工作区密码,`ws.unlock` 验证思路:用 `crypto.deriveKeys+verifier` 不行——直接要求输入密码后调用 `ws._seal()` 前先比对?简化实现:输入密码 → `wsapi.openFromBlob(await ws.exportFile(), pw)` 验证非 null)+ 红色危险确认("明文 CSV 将包含全部原始隐私数据,确定?")→ excel.exportCSVFromModel([[类型,原值,占位符,出现次数],...]) 下载 `工作区名.映射表.csv`。

## settings.js — 设置

分组卡片(读写 `ws.settings`,保存后 `ws.saveLocal()` + toast):
- 外观:主题(auto/light/dark 单选,change → bus 'theme:change')
- 占位符:通用编码样式(short/prefix 单选+示例)、保留邮箱域名(开关)
- 安全:自动锁定(0/5/10/30/60 分钟下拉,0=不锁定)、PBKDF2 迭代次数(只读展示)、修改密码(旧/新/确认三框 + 强度条,`ws.changePassword` → 成功 toast+自动 saveLocal)
- 数据:[导出工作区文件](同 mapping)[清除本机副本](ws.forgetLocal,confirm:下次只能用 .ecw 文件打开)
- 危险区(红卡):[销毁工作区](输入工作区名称确认,`ws.destroy()` → 回首页)

## lock.js — 锁屏遮罩

`mount()` 时向 `#ec-overlay-root` 注入全屏遮罩(不可关闭):盾牌图标 + 工作区名 + "已自动锁定" + 密码框 + [解锁] + [关闭工作区回首页]。`ws.unlock(pw)` 成功 → unmount + toast"已解锁";失败 → 输入框抖动动画 + "密码错误"。锁定时主界面被遮罩盖住即可(内容仍在 DOM,密钥已清)。bus `workspace:unlocked` 也触发 unmount(容错)。

## help.js — 帮助/关于

静态内容卡片:快速上手四步、典型场景(交给 AI 处理/外包分析/共享测试数据)、隐私与安全说明(离线/加密参数/数据留存位置/建议操作)、快捷键(见表)、已知限制(xls/xlsm 样式降级、合并单元格只改左上格、公式格按计算值脱敏、预览截断 1000 行但处理全量、CSV 编码自适应 UTF-8/GBK)、版本与构建时间(window.__EC_BUILD__)。快捷键:Ctrl/Cmd+O 上传、Ctrl/Cmd+L 锁定、Ctrl/Cmd+A 在表格内全选(grid 已处理)、Esc 关弹窗。

## 通用要求

- 所有 async 操作有 loading 态与错误 toast(util.toast(msg,'err'))。
- 数值/时间一律 util.fmtTime/fmtBytes。
- 每屏 mount 时若 `!workspace.current || workspace.current.isLocked()` 且路由非 home → 跳 home(锁屏遮罩另行处理)。
- 不用外链图片/字体;图标用 inline SVG 或 emoji。
