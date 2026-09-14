# ClinkLab 付费报名 V0.1

一个微信小程序「活动付费报名」系统：主办方发布活动与报名类型，用户报名并微信支付，
凭**报名凭证二维码**或**手机号后四位**现场签到，后台管理活动与报名数据。

**两层落地总原则**：

> 沙箱限制只影响「当前怎么跑」，不能影响「项目最终是什么」。

- **生产目标**：微信小程序（原生 TS）+ NestJS（TS）+ PostgreSQL + Next.js/React/Ant Design 后台。
- **沙箱参考实现（本仓库 `server/` 可跑）**：Node type-stripping 运行器 + Fastify + SQLite +
  静态浏览器联调页，用于在受限环境里打通并验证业务正确性，**不强迫模拟生产、不改写正式架构**。

---

## 目录结构

```
clinklab_app/
├─ ClinkLab/                   # ★ 微信开发者工具工程（AppID wx647d9b743be896fc，标准 webview，无 Skyline）
│  ├─ miniprogram/             # 小程序源码（8 页面 + services + utils + config）
│  │  ├─ app.ts / app.json / app.wxss
│  │  ├─ config/env.ts         # API 基址（development→http://127.0.0.1:3050 / production）
│  │  ├─ services/             # request / auth / event / registration / payment / checkin
│  │  ├─ utils/util.ts         # fmtCents / maskPhone / STATUS_ZH / toast
│  │  └─ pages/                # index / detail / register / pay-result / my / credential / checkin / profile
│  ├─ typings/                 # 官方 miniprogram-api-typings
│  └─ project.config.json      # AppID + 标准 webview（skylineRenderEnable=false）
├─ miniprogram/                # 原始/参考小程序（touristappid 游客号；ClinkLab 由它移植而来）
├─ asset1/                     # 原型参考图（页面设计的参考，非逐页对应）
├─ server/                     # 沙箱可运行参考实现（Fastify + SQLite + 浏览器联调页）
│  ├─ src/
│  │  ├─ schema.sql            # SQLite 逻辑 schema（与生产 PostgreSQL 契约一致）
│  │  ├─ schema.postgres.sql   # ★ 生产目标 schema（PostgreSQL 16+）
│  │  ├─ routes.ts             # 全部 API 端点（无 /api 前缀）
│  │  ├─ auth.ts               # 微信登录 + 用户/管理端会话（openid/session_key 仅服务端）
│  │  ├─ config.ts             # 环境隔离、API 基址、mock-pay 开关、管理账号
│  │  ├─ db.ts / util.ts       # SQLite 事务封装 / 通用工具（分、ISO-8601、qr_token、脱敏）
│  │  └─ services/             # events / registrations / checkin / admin / qr / wxpay（纯业务；wxpay=真实微信支付）
│  ├─ scripts/                 # smoke-test.mjs / check.mjs / live-flow.mjs / wechat-sim.mjs / real-pay-flow.mjs
│  └─ ui/                      # 浏览器联调页（本地测试工具，非生产客户端）
├─ DEVELOPMENT.md              # ★ 领域定义、15 条硬性规则、API 契约、状态流转、迁移 TODO
└─ README.md                   # 本文档
```

---

## 快速开始

> 依赖安装（沙箱环境）：沙箱禁止 lifecycle 脚本的 piped stdio，且写入限制在工作区内，
> 因此用本地缓存 + 跳过脚本：

```bash
cd server
npm install --cache "./.npm-cache" --ignore-scripts
# 生产 / 正常环境直接：npm install
```

初始化并运行：

```bash
npm run setup      # 建库 + 重置种子（管理账号 admin/admin123 + 2 个活动共 5 个报名类型 + 6 条各状态演示报名）
npm run dev        # node --experimental-strip-types --watch src/app.ts
```

打开联调页：<http://127.0.0.1:3050/>（API 基址 `http://127.0.0.1:3050`）。

管理端默认账号（**仅 development 环境**，可用 `GET /admin/credentials` 查看）：
`admin / admin123`。

测试：

```bash
npm run check      # 注入式快速冒烟：/health、/config、未登录访问 /me 应 401
npm run smoke      # 端到端冒烟（临时库）：两条验证链 + 名额/退款/幂等/并发防重复签到
npm run live       # 真实 HTTP 冒烟（需先 npm run dev，走 127.0.0.1:3050）
npm run real-pay   # 接真实微信全链路：起本地微信模拟器，走真实登录/统一下单/回调验签+AES 解密/退款（14 断言）
npm run typecheck  # tsc --noEmit
```

小程序类型检查（`ClinkLab/` 工程；官方 `miniprogram-api-typings` 在 `ClinkLab/typings/`，
无独立 `node_modules`，复用根 `miniprogram` 的依赖里的 `tsc`）：

```bash
"miniprogram/node_modules/.bin/tsc.cmd" --noEmit -p "ClinkLab/tsconfig.json"
```

---

## 在微信开发者工具中运行小程序

1. 微信开发者工具 → **导入项目** → 目录选 `ClinkLab/`（AppID `wx647d9b743be896fc`，标准 webview，Skyline 已关）。
2. 详情 → 本地设置 → 勾选 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**（本地 API 是 `http://127.0.0.1:3050`，非 HTTPS）。
3. 先 `npm run dev` 起服务，再在工具里编译。首页应看到 2 个已发布活动。

> 沙箱默认 mock 登录（`WX_APPID` 为空 → 自动 mock 微信登录），无需真实 AppSecret 即可跑通全流程。

---

## 角色与权限（普通用户 vs 工作人员）

核心隔离原则：**普通用户只能看用户端；后台/管理只对「被设为管理员」的身份开放。**

| 能力 | 普通用户 | 工作人员（`users.is_admin=1`） | 管理端（`admin_users`） |
| --- | --- | --- | --- |
| 浏览活动 / 报名 / 支付 / 查凭证 / 取消 / 退款 | ✅ | ✅ | — |
| 现场签到（扫码 / 手机号后四位） | ❌ 403 | ✅ 小程序「我的 → 工作人员入口」 | ✅ 浏览器后台 |
| 活动 CRUD / 名单 / 统计 / 参加次数统计 / 导出 | ❌ | ❌ | ✅ 浏览器后台 `http://127.0.0.1:3050/` |

- 身份来自**服务端登录态**（`is_admin` / 管理会话），客户端不声明、不可伪造。
- 小程序内「工作人员入口」仅当 `/me` 返回 `isAdmin=true` 时显示；非工作人员点「开通工作人员权限」（仅 development 的 `POST /dev/auth/make-admin`）后可用。
- 活动的新建 / 编辑 / 上下架在**浏览器后台**完成；App 内后台 = 现场签到（按约定，不做活动管理）。
- 签到由 `requireStaff` 统一校验（工作人员用户 **或** 管理端登录态），普通用户一律 403 —— 冒烟测试已覆盖该断言（`npm run smoke`）。
- **参加次数统计**：后台「参加次数统计」视图（`GET /admin/attendance`）按用户统计全平台「已报名且已签到核验」的**不同活动数**（`COUNT(DISTINCT event_id) WHERE checked_in_at IS NOT NULL`），并按次数降序标记「回头客（≥2 场）」；报名名单每行也带 `attend_event_count` 列。供后台按参加次数分档设置折扣票。

---

## 核心对象与状态

- 领域：`Event → RegistrationOption → Registration`（**Registration 是核心对象，不是 Ticket**），
  `Payment / Refund / CheckIn` 独立。
- 无票务库存/锁库存/候补/多商户；名额只有 `events.capacity`（可空，判定 = 有效已支付人数 < capacity）。
- **Registration**：`PENDING → PAID → (REFUNDING → REFUNDED)`；`PENDING → CANCELLED`；
  签到状态 `checked_in_at` 与支付状态分离。
- **Payment**：`PENDING → SUCCESS / FAILED`；`SUCCESS → REFUNDED`。
- **金额单位分**（cents）、**时间 UTC**（SQLite TEXT ISO-8601，PostgreSQL timestamptz）。

---

## 优先级

报名数据正确 > 微信支付正确 > 报名状态正确 > 报名凭证正确 > 二维码签到 > 手机号后四位签到
> 退款 > 后台便利性 > UI。

---

## 开发约定与迁移

- **开发约定**（领域定义 / 15 条硬性规则 / API 契约 / 状态流转 / §37 真机清单）见
  [`DEVELOPMENT.md`](DEVELOPMENT.md)。
- **踩坑记录 / 快速鉴别手册**（历史问题：现象→根因→发现→解决→一句话鉴别）见
  [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)；后台 5-tab 专项见 [`DIAGNOSIS.md`](DIAGNOSIS.md)。
- **生产目标 schema** 见 [`server/schema.postgres.sql`](server/schema.postgres.sql)
  （与 `server/src/schema.sql` 逻辑契约一致，SQLite → PostgreSQL 的机械映射）。
- **迁移 TODO**（NestJS / PostgreSQL）见 `DEVELOPMENT.md` 第 7 节。

## 沙箱 mock 说明 & 接真实微信

沙箱默认 **mock 登录 / mock 支付**（`/dev/...` 仅 development，staging/production 为 403/404），
只用于本地联调。但**真实微信的三条链路已落地为可切换适配器**（不再只是占位）：

- 真实登录：`server/src/auth.ts` 的 `realCode2Session`（配置 `WX_APPID/WX_APPSECRET` 即走真实 code2Session）；
- 真实支付：`server/src/services/wxpay.ts`（统一下单签名 / 回调验签 / **AES-256-GCM 解密** / 退款，纯 `node:crypto`）；
- 是否走真实路径由 `WX_PAY_USE_REAL` 凭据判定**自动切换**，缺凭据自动降级 mock，**API 契约不变**。

**沙箱内已证明（无需真实商户、无外网）**：`npm run real-pay` 起一个本地微信模拟器
（`scripts/wechat-sim.mjs`），让被测服务端走真实适配器，跑通「登录 → 统一下单 →
模拟微信回调（平台私钥签名 + AES 加密）→ 服务端验签+解密 → PAID → 退款 → 非法回调被拒」
全链路（14 项断言）。详见 `DEVELOPMENT.md` §4.1 凭据清单。

接真实商户 = 填 6 项凭据（AppID/AppSecret、商户号、APIv3 密钥、商户证书序列号、商户私钥、
微信平台证书）+ 1 个公网回调地址（均服务端 `.env`，客户端不接触），然后在真机走 §4 清单。
