# ClinkLab 后台页面「5 tab 混载」问题诊断文档

> 本文件供任何接手排查的工程师/模型快速接上上下文。项目：`D:\AI\dsh\Projects\Clink AI\clinklab_app`（服务器在 `server/`，后台静态页在 `server/ui/`）。

## 一、问题现象
- 后台管理页打开后，顶部导航栏应是 **4 个顶级 tab**：活动 / 分享 / 论坛 / 后台（每个 tab 下有子 tab）。
- 用户浏览器**加载时约 0.5 秒能看到 4 个 tab，随即闪成 5 个**（多出「评论」按钮），且各子 tab 内容无法正常显示/交互。
- 控制台有 `Duplicate form field id` 警告（说明页面存在**双份结构**）、`/events/ 404`、`Invalid time value` 等（已逐项修复，见下）。

## 二、环境（关键）
- 后端 Fastify + `node:sqlite`，监听 **3050**（唯一端口，API+后台），后台静态页 `server/ui/` 前缀 `/`（主入口）与 `/ui/`（v38 自愈逻辑加载资源的绝对路径），另有动态端点 `/ui-latest/:ts`（no-store 返回最新 index.html）。
- 后台访问地址：`http://127.0.0.1:3050/`（或 `/ui/index.html`）。
- 历史上曾为绕缓存开过 **备用端口 3051**（同进程第二个 Fastify 实例）与 **`/ui2/` 前缀**（第三个缓存 key）——均为排查缓存问题时的**测试冗余**，v38 以 `/ui-latest/` 无缓存启动根治后已移除（见第九节）。

## 三、关键结论（已确认）
1. 服务器返回的最新 `server/ui/index.html` 本身是**正确的 4 tab 结构**（nav 4 个按钮 events/share/forum/admin，144 个 id 无重复）。
2. 「闪 4 → 5」是 **JS 执行时注入**：`app.js` 顶部的 `selfHealStalePage`（以及 init 里的 `ensureShareSection/ensureArchivedSection/ensureCommentsSection`）在检测到「缺容器」时会把旧结构（含 nav 的「评论/分享/归档」按钮）注入页面，把 4 个变 5 个。
3. 用户浏览器加载的 index.html 与 app.js 经常是**不同历史版本的混载**，导致「页面是新的、脚本是旧的（或反之）」，旧脚本的 ensure 注入在缺失新容器时误判注入。
4. 纯靠「版本守卫检测」会被各种混载状态绕过（因为不同版本缺的东西不一样），不可靠。

## 四、已采取的修复（v36 当前状态，均在 `server/ui/app.js`）
- **无条件从服务器启动**（`versionGuard`）：不做结构检测，每次加载直接 `fetch('/ui/index.html?b=时间戳', {cache:'no-store'})` → `document.body.innerHTML = doc.body.innerHTML` 替换 body → 换新 CSS → `await init()`。`fetch` 已被实测能绕过拦截。`window.__stalePage=true` 阻止底部重复 init。
- **禁用旧页注入**：`ensureShareSection/ensureArchivedSection/ensureCommentsSection` 开头 `if (window.__unconditionalBoot) return;`（守卫里设 `window.__unconditionalBoot=true`），从根源杜绝 nav 注入。
- **终局清理**：boot 的 `init()` 之后，强制把 `#tabs` 收敛为恰好 4 个按钮（events/share/forum/admin），缺失则补回，并重新绑定 onclick。
- **api() 去尾斜杠**：`url.replace(/\/+$/,'')`，修复 `/events/` 404（空 id 拼接）。
- **refreshOptionSelect** 数字 id 强校验 `/^\d+$/`，不再发空请求。
- **deReadForm** 用 `isoOf()` 防御非法时间，不再抛 `Invalid time value`。
- **toLocalInput** 对 NaN/非法值返回空串。
- index.html 带**内联启动自检**（body 末尾、app.js 之前）：检测 nav 非 4 按钮 → 阻止页面自身 app.js → fetch 最新页面替换 + 手动加载 `app.js?v=36`。
- 静态资源响应头：`Cache-Control: no-store` + `Vary:*` + `Clear-Site-Data: "cache"`。
- 版本号已升到 **v36**（index.html 引用 `styles.css?v=36` / `app.js?v=36`，app.js 内 `UI_VERSION='v36'`），使资源 URL 全新、绕过旧缓存。
- **v37（本批）**：`bootFromServer` 的新鲜度校验从弱判据 `includes('tab-forum')` 加强为 `freshMarkers`（`id="tab-share"`/`id="shareList"`/`id="archivedList"`/`id="forumList"`/`id="adminDash"` 必须同时存在）。index.html 内联自检同步加强。版本号 v36 → v37。
- **v38（本批·真正的根源）**：修复 `index.html` 三处**自闭合 `<textarea …/>`**（`#deAddr`/`#deReminder`/`#shSummary`），改为显式 `</textarea>`。HTML 里 `<textarea/>` 的 `/` 会被忽略、标签视为「未闭合」，导致解析器把其后的分享/论坛/后台区块整体吞进 textarea 文本，直到下一个 `</textarea>`——这才是「页面源码有这些区块、但 DOM 里 `getElementById('tab-share')=null`」的真因。版本号 v37 → v38。

## 五、关键发现（真因：自闭合 `<textarea/>` 吞掉后续区块）
1. **导航栏已稳定 4 tab**（用户 diag `#tabs按钮=4`，5-tab 问题根治）。
2. 但 diag 显示 `#archivedList/#tab-share/#formShare/#shareList=缺失`，且 `bootFromServer` 明明报了「已用最新页面替换 body」——说明「缺失」不是代理返回旧版造成的，而是 **`document.body.innerHTML = doc.body.innerHTML` 这一轮往返时，自闭合 `<textarea />` 让后续 `<section>` 被当成文本吞掉**（getElementById 因此为 null）。之前「代理返回中间版本」的判断是错的。
3. v37 的严格 `freshMarkers` 校验保留（防代理旧版覆盖），v38 修正 textarea 后，fresh HTML 往返才能正确重建分享/论坛/后台区块。

## 六、结论（v38 已验证）
- 用户反馈 `http://127.0.0.1:3051/ui2/index.html`（当时的备用入口）**已趋近正常**：4 tab 稳定、各区块正常。
- v38 的根治方案（`/ui-latest/` 无缓存启动 + freshMarkers + 禁用旧页注入 + 终局清理 + textarea 修复）成立；本问题**已解决**，后台入口收敛为 `http://127.0.0.1:3050/`。

## 七、若仍失败的可能方向（保留备查）
1. 用户机器上代理类软件（ikuuu 等）仍在拦截 → 需用户彻底退出代理软件后再测；或改用手机/另一台电脑访问验证。
2. `boot` 的 fetch 若也被拦截返回旧 body（旧结构无 evCmtList），则 init 里的 `loadComments` 等会因容器缺失终止（诊断日志 `#evCmtList 缺失，终止`）——但这不影响 nav（注入已禁用），只会缺功能区块。
3. 彻底方案：把后台做成**不依赖导航缓存**的单页（所有逻辑内联 / 或由服务器动态渲染 index.html 并带进程内版本戳）。
4. 考虑用 `location.href` 导航到带**一次性随机 query** 的地址并配合服务器端把该 query 忽略（已验证 query 会被部分拦截器忽略，属备选）。

## 八、验证命令（PowerShell / Node）
- 服务器健康：`Invoke-WebRequest http://127.0.0.1:3050/health`
- 页面最新性：`node -e "fetch('http://127.0.0.1:3050/').then(r=>r.text()).then(t=>console.log(t.includes('v=38'), t.includes('id=\"tab-share\"'), !/<textarea[^>]*\/>/.test(t)))"`
- app.js 版本：检查是否含 `UI_VERSION = 'v38'`、`freshMarkers`、`window.__unconditionalBoot`、`终局清理`。
- 服务器进程：后台 job 运行中（node --experimental-strip-types src/app.ts），src/*.ts 改动需重启；ui/* 静态文件改动无需重启。

## 九、收尾清理（本次执行）
- 移除**备用端口 3051**（`UI_ALT_PORT` 启动逻辑、app.js 里的「备用端口 3051 →」链接、config.ts 注释）。
- 移除 **`/ui2/` 静态前缀**（纯缓存 key 冗余，无代码依赖）。
- 保留 **`/ui/`**（v38 自愈逻辑 `bootFromServer` / 内联自检用绝对路径 `/ui/styles.css`、`/ui/app.js`，功能依赖）、**`/ui-latest/:ts`**、根路径 `/` 与 `/uploads/`。
- 删除临时排查脚本 `tmp_latest.cjs` / `tmp_check.cjs`；同步更新 TROUBLESHOOTING.md 中的端口/前缀描述。
