# 经验积累 · 踩坑记录与快速鉴别手册

> 目标读者：未来的工程师 / 新模型 / 小模型（如 dsv4f）。
> 用法：先看「现象」匹配哪条 → 再看「一句话鉴别」快速定位根因 → 最后照「解决过程」动手。
> 每条统一格式：**现象 → 根因 → 发现过程 → 解决过程 → 一句话鉴别**。
>
> 与本文件并列的权威文档：`README.md`（结构/快速开始）、`DEVELOPMENT.md`（领域定义·15 条硬规则·API 契约·迁移）、`DIAGNOSIS.md`（后台 5-tab 专项诊断）。本文是它们的「踩坑速查版」。

---

## 0. 必读：项目环境硬事实（先记住，别在这些上浪费时间）

- 沙箱后端运行方式：`cd server && node --experimental-strip-types src/app.ts`（要求 Node ≥ 23.6，`package.json` engines 写了）。
- **代码硬约束**：不能用 `enum` / 装饰器 / 参数属性 `constructor(private x)`；本地 import 必须写字面 `.ts` 扩展名（Node 不会把 `.js` 重写成 `.ts`）。
- 后端：Fastify + `node:sqlite`；监听 **3050**（唯一端口，API+后台）；后台静态页在 `server/ui/`，前缀 `/`（主入口）与 `/ui/`（v38 自愈逻辑加载资源的绝对路径，功能依赖）服务同一目录，另有动态端点 `/ui-latest/:ts`（每次返回磁盘上最新的 `index.html`，no-store）。历史上曾有备用端口 3051 与 `/ui2/` 前缀，均为缓存绕行用的测试冗余，已移除。
- 生产目标（不是沙箱形态）：微信小程序 + NestJS + PostgreSQL + Next/AntD 后台。**API 路径、状态枚举、字段名、金额单位（分）、时间语义（UTC）迁移时不得变**。
- 沙箱禁止 `child_process` 的管道 stdio（`spawn/exec` 默认 `pipe` 会 EPERM），要用 `stdio: 'inherit'` / `'ignore'`；PowerShell 自己的管道不受影响。
- `npm run smoke` 用**独立临时库**（`server/data/smoke-test/`），安全可跑；`npm run live` 走 `127.0.0.1:3050` **真实运行库**，会动演示数据。

---

## 一、浏览器后台页 `server/ui/` 的坑

### 1. ⭐ 自闭合 `<textarea />` 吞掉后续整个 DOM（本次最隐蔽的根因）

- **现象**：HTML 源码里明明有某区块（`grep 'id="tab-share"'` 能命中），但运行时 `document.getElementById('tab-share')` 返回 **null**；「分享/论坛/后台」点进去空白；`bootFromServer: 已用最新页面替换 body` 都打出来了，区块却仍显示「缺失」。
- **根因**：HTML 里 `<textarea>` **不是 void 元素**。`<textarea … />` 的 `/` 会被解析器**忽略**，标签被视为「未闭合」；解析器随即进入 RCDATA 文本模式，把其后的**所有标记**（分享/论坛/后台 section）当成 textarea 的**文本内容**吞掉，直到文档里遇到的第一个 `</textarea>` 才结束。
- **发现过程**：
  1. 先确认「服务器返回的最新页是对的」——`fetch('/ui-latest/<ts>')` 或用 `grep` 能在源码里看到这些 section；
  2. 但用户 diag 里 `bootFromServer: 已用最新页面替换 body` 与 `#tab-share=缺失` **同时成立**——矛盾点指向「innerHTML 往返丢内容」；
  3. 排除「代理返回旧版」后，grep 自闭合非 void 标签 `<textarea[^>]*/>`，命中 `index.html` 三处（`#deAddr`、`#deReminder`、`#shSummary`）。
- **解决过程**：三处 `<textarea …/>` 全部改成显式 ` <textarea …></textarea>`；版本号 +1 强制重载（本项目 v38）。
- **一句话鉴别**：**「源码有 / DOM 无」+「经过 innerHTML 往返」→ 先 grep `<textarea[^>]*/>`（以及 `<select|div|span|button…/>` 这类自闭合非 void 标签）。** 这是最容易被小模型忽略的 HTML 语法坑。

### 2. 导航「闪 4 → 5 tab」（旧脚本 ensure 注入）

- **现象**：后台打开后顶部导航先 4 tab，随即闪成 5 tab（多出「评论」按钮），子 tab 内容失效；控制台可能还有 `Duplicate form field id` 警告。
- **根因**：`index.html` 与 `app.js` 跨版本混载；旧 `app.js` 的 `ensureShareSection/ensureArchivedSection/ensureCommentsSection` 检测到「缺容器」就把旧结构（含 nav 的 评论/分享/归档 按钮）注入 DOM。
- **发现过程**：grep 确认服务器最新 `index.html` 是 4 tab、144 个 id 无重复 → 判定「多出的 tab 是 JS 运行时注入」；定位到 `ensure*` 三函数为注入来源。
- **解决过程**（v36）：`versionGuard` 无条件从服务器启动（`fetch` 最新页替换 body）+ 设 `window.__unconditionalBoot` 禁用旧页注入 + boot 后「终局清理」强制 `#tabs` 收敛为恰好 4 个按钮（events/share/forum/admin）。
- **一句话鉴别**：看页面左下角 diag 的 `#tabs按钮=` 是否 =4；若 ≠4，是「旧页」还是「被注入」，看是否有 `ensure*: 已注入…` 日志。

### 3. 代理 / VPN 顽固缓存（ikuuu 等）

- **现象**：换端口、换前缀(`/ui/`)、换 query(`?__fresh=`)、换版本号(`?v=…`) 都仍加载旧内容；但 `fetch(url, {cache:'no-store'})` 能拿到最新。
- **根因**：用户机器上的代理类软件（ikuuu 等）透明缓存 localhost 的 HTML，忽略版本号与缓存头。
- **解决**：服务端对 `html/js/css` 统一 `Cache-Control: no-store` + `Vary:*` + `Clear-Site-Data:"cache"`；客户端用 `/ui-latest/<时间戳>` 动态唯一路径 + `fetch(no-store)` 强制拿最新。
- **一句话鉴别**：`/health` 正常、`fetch(no-store)` 能拿到最新、但浏览器页面还是旧的 → 是代理，**代码无法根治**，需用户彻底退出代理/换设备/开隐私窗口。

### 4. `/events/` 404（尾斜杠空 id）

- **现象**：请求 `/events/` 返回 404。
- **根因**：`api()` 拼 URL 时留着尾斜杠，导致末尾出现空 id 段。
- **解决**：`api()` 内 `url.replace(/\/+$/,'')` 去尾斜杠。
- **一句话鉴别**：看请求 URL 是否带尾斜杠 + 空路径段。

### 5. `Invalid time value` / 非法时间抛错

- **现象**：读取非法时间字段时抛 `Invalid time value`。
- **根因**：`new Date(非法值)`。
- **解决**：`deReadForm` 用 `isoOf()` 防御；`toLocalInput` 对 NaN/非法值返回空串。
- **一句话鉴别**：报 `Invalid time value` → 定位所有 `new Date(...)`，加 NaN 防御。

---

## 二、服务端 TypeScript `server/src/` 的坑（`npm run typecheck`）

### 6. `buildApp().then(...)` 报「then 不存在」

- **现象**：`tsc --noEmit` 报 `Property 'then' does not exist on type 'FastifyInstance…'`，连带 `.then` 回调里 `app`/`e` 隐式 any。
- **根因**：`buildApp()` 同步返回 FastifyInstance；运行时实例其实是 thenable（`typeof app.then === 'function'`），但 TS 类型不认 `.then`。
- **解决**：改成 `const app = buildApp(); app.listen({…}).then(async () => {…}).catch(…)`。
- **一句话鉴别**：`.then` 挂在非 Promise 类型上 → 改用 `.listen().then()` 或 `await`。

### 7. 枚举/联合类型漏分支（评论 target 缺 'POST'）

- **现象**：routes 报 `'"POST" | "EVENT" | "SHARE"' is not assignable to '"EVENT" | "SHARE"'`。
- **根因**：评论/点赞后端已支持论坛（POST），但接口类型 `CommentInput.type` 声明漏了 `'POST'`。
- **解决**：补上类型联合；顺带修正 `listComments` 报错文案（`SHARE/EVENT` → `SHARE/EVENT/POST`）。
- **一句话鉴别**：`"A | B | C"` 不能赋给 `"A | B"` → 查是不是枚举/联合类型定义漏了分支，而不是调用方写错。

### 8. `.map()` 里 `...rest` 展开后丢字段

- **现象**：events.ts 报 `Property 'option_type'/'sold_limit'/'id' does not exist on type '{price_display; sold_count; remaining}'`。
- **根因**：`const { gate_code, ...rest } = o`（`o: Record<string,any>`）后 `{ ...rest, price_display… }` 的返回类型被 TS 推断成**只剩显式字段**，index signature 的字段丢了。
- **解决**：显式标注 `const options: Row[] = …`。
- **一句话鉴别**：map 返回对象用了 `...rest` 展开、后续却访问原字段报错 → 给 map 结果显式类型注解。

### 9. 小程序未使用变量 TS6133

- **现象**：`'post' is declared but its value is never read`。
- **根因**：`const post = await createPost(…)` 没用到返回值。
- **解决**：去掉 `const post =`，仅 `await createPost(…)`。
- **一句话鉴别**：TS6133 → 删未用绑定或 `void 变量`。

---

## 三、测试 / 业务模型漂移（`server/scripts` 冒烟）

### 10. 冒烟测试过时（capacity 废弃 → sold_limit + 自动候补）

- **现象**：`npm run smoke` 中「名额已满拒绝创建(409)」失败，`status=200`。
- **根因**：业务已从「活动级 `capacity` 软限制」演进为「票种级 `sold_limit` + 售罄自动转候补」；旧测试仍断言满员 409。
- **解决**：测试改为 `soldLimit:1`：无候补票种 → 409；开放候补 → 自动转候补（PAID/免费）。
- **一句话鉴别**：**测试失败、但类型检查与运行时都正常 → 先对照 `DEVELOPMENT.md` 领域模型判断是「测试过时」还是「代码回归」，别急着改业务代码。**

---

## 四、诊断命令速查（复现 / 自查先跑这些）

```powershell
# 后端健康（唯一端口 3050）
Invoke-WebRequest http://127.0.0.1:3050/health

# 谁在监听 3050（找进程 PID）
netstat -ano | Select-String ':3050'

# 后端类型检查
cd server; npm run typecheck

# 端到端冒烟（独立临时库，安全）
cd server; npm run smoke

# 真实微信全链路（本地起微信模拟器，14 断言）
cd server; npm run real-pay

# 小程序类型检查
& "miniprogram\node_modules\.bin\tsc.cmd" --noEmit -p "ClinkLab\tsconfig.json"

# 页面最新性 + 自闭合 textarea 残留检查（缺一即有问题；后台入口 3050 根路径 / 或 /ui/）
node -e "fetch('http://127.0.0.1:3050/').then(r=>r.text()).then(t=>console.log(t.includes('v=38'), t.includes('id=\"tab-share\"'), !/<textarea[^>]*\/>/.test(t)))"
```

- 浏览器端自检：页面**左下角 diag 面板**（`#__diag`）会滚动打印 `bootFromServer: …`、`init 完成 | #tabs按钮=…`、各容器「存在/缺失」——排查缓存/缺容器/执行中断时先看它，比开控制台更快。
- 改 `server/ui/*`（静态）**无需重启**后端；改 `server/src/*.ts` **需重启**（`node --experimental-strip-types src/app.ts`）。

---

## 五、通用排查方法论（给新模型的三板斧）

1. **先分清「源码对 / 运行时错」在哪一层**：后端（API 返回）→ 网络（代理缓存）→ 浏览器（DOM）。多数疑难是后两层。
2. **遇到「源码有 / DOM 无」**：优先怀疑 HTML 解析问题（自闭合非 void 标签、未闭合 `<script>/<style>/<textarea>`），再怀疑 innerHTML/DOMParser 往返。
3. **遇到「测试挂 / 代码没动过」**：先怀疑测试与领域模型漂移，对照 `DEVELOPMENT.md`，而不是先改业务逻辑。