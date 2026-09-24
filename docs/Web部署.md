# Web 部署指南(GitHub 仓库 + Cloudflare Pages)

单文件版 `dist/Encipherer.html` 是**纯静态单文件**,放到任何静态托管上都可用——GitHub Pages、Cloudflare Pages、Vercel、内网文件服务器,甚至直接挂在对象存储上。本文以 GitHub + Cloudflare Pages 为例。

## 一、可行性结论

**完全可行**,而且非常合适:

- 应用运行时零网络请求(CSP `connect-src 'none'` 限死),托管平台只负责"把这一个 HTML 文件发给浏览器";
- 无构建步骤、无服务端、无数据库,Cloudflare Pages 免费额度(不限请求数、单文件 25 MB 上限)绰绰有余(文件仅约 2.1 MB);
- **额外收益**:HTTPS 源下浏览器存储(IndexedDB)完整可用,本地自动保存体验比 `file://` 双击打开更好(file:// 下会降级到 localStorage)。

## 二、部署步骤(GitHub → Cloudflare Pages)

1. **推送到 GitHub 仓库**(只需提交 `dist/Encipherer.html`,建议改名为 `index.html` 放仓库根目录或 `docs/` 目录):

   ```bash
   mkdir web && cp dist/Encipherer.html web/index.html
   git init && git add web/index.html && git commit -m "Encipherer v1.1.0"
   git remote add origin https://github.com/<你>/encipherer.git
   git push -u origin main
   ```

2. **Cloudflare Pages**:控制台 → Workers & Pages → Create → Pages → **Connect to Git** 选择该仓库:
   - Framework preset: `None`
   - Build command: **留空**
   - Build output directory: `web`
   - 部署完成后得到 `https://<项目>.pages.dev`,访问即用。

3. **不想要 Git 集成?** 也可以 `npx wrangler pages deploy web --project-name=encipherer` 直接上传(或控制台拖拽上传)。

> GitHub Pages 同理:仓库 Settings → Pages → Deploy from branch,目录选 `web`(或根目录放 `index.html`)。

## 三、隐私注意事项(重要)

把工具放到公网后,隐私模型有一个新增信任假设:**用户必须信任你部署的这个版本没有被篡改**。缓解措施:

1. **同时提供本地版下载**:在仓库 Release 里附上 `Encipherer.html`,并在页面显著位置给出 SHA-256 校验值,让高敏感用户可以"下载后本地双击使用";
2. **可审计**:单文件版全部逻辑(含 SheetJS/ExcelJS)都在这一个 HTML 里,任何人可以保存后全文检查有没有多余的对外请求;
3. **存储隔离**:浏览器 IndexedDB/localStorage 按**域名**隔离——公用部署域名上留下的加密工作区副本,会被同域名下的其他用户隔离(不同浏览器配置文件/隐私模式也会隔离),但仍建议高敏感场景自建部署或用本地版;
4. **别加统计脚本**:一旦接入任何分析/统计/在线字体,就破坏了"零网络"承诺,请在fork改造时保持克制;
5. 中国大陆访问 `*.pages.dev` 不稳定,面向大陆用户可同时提供 GitHub Release 下载 + 自有域名绑定(Cloudflare 自定义域)。

## 四、版本更新流程

改代码 → `npm run build` → 复制 `dist/Encipherer.html` 到 `web/index.html` → 提交推送,Pages 自动重新部署;同时在 GitHub Release 附上带版本号的文件与校验值。
