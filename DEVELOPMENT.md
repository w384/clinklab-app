# ClinkLab 付费报名 V0.1 —— 开发说明

> 本文档是项目的事实来源之一：领域定义、硬性规则、API 契约、状态流转、真机测试清单、
> 以及从沙箱参考实现到生产目标（NestJS + PostgreSQL）的迁移路径。

---

## 1. 项目定位与两层落地

**一句话**：一个微信小程序「活动付费报名」系统——主办方发布活动与报名类型，用户报名并
微信支付，凭「报名凭证二维码」或「手机号后四位」现场签到，后台管理活动与报名数据。

**两层落地的总原则（不可动摇）**：

> 沙箱限制只影响「当前怎么跑」，不能影响「项目最终是什么」。

- **生产目标（最终是什么）**：
  - 客户端：**微信小程序**（WeChat 原生，TypeScript）；
  - 服务端：**NestJS**（TypeScript）；
  - 数据库：**PostgreSQL**（见 `server/schema.postgres.sql`）；
  - 管理后台：**Next.js / React / Ant Design**。
- **DSH 沙箱（当前怎么跑）**：一套**可运行参考实现**，用于在受限环境里打通并验证
  业务正确性：
  - 运行时：**Node 原生 type-stripping**（`node --experimental-strip-types`）+ **Fastify** + **SQLite** + 静态浏览器联调页。

**为什么沙箱里不是 NestJS**：NestJS 依赖装饰器（`@Injectable` / `@Controller` 等）与
IoC 容器，装饰器是「非擦除语法」，Node 的 type-stripping 无法运行；同时沙箱不允许
`child_process` 管道 stdio，会阻断大量依赖的安装脚本。因此沙箱用 Fastify 承担 HTTP 层。
但**这不是架构降级**：所有业务逻辑都在 `server/src/services/*` 里以纯函数/类编写，
路由层（`server/src/routes.ts`）只做「参数校验 + 鉴权 + 调用 service」。未来切 NestJS 时
**只换实现层**——把 service 搬进 `@Injectable()`，把路由搬进 `@Controller`，API 路径与
JSON 契约**一字不改**（见 §7 迁移 TODO）。

**沙箱运行约束（记牢）**：
- 必须用 `node --experimental-strip-types` 运行 `.ts`；
- 代码里**不能有** `enum`、参数属性（`constructor(private x)`）、装饰器，只能用可擦除语法；
- 本地 import 必须写**字面 `.ts` 扩展名**（Node 不会把 `.js` 重写成 `.ts`）；
- 不能强迫模拟生产环境、不能把正式架构写死成沙箱形态。

---

## 2. §44 统一领域定义

领域对象与数据库表一一对应，全部以英文命名，状态用大写枚举字符串。

| 对象 | 表 | 含义 | 关键字段 |
|---|---|---|---|
| **Event** | `events` | 活动 | `title / start_time / end_time / registration_start_time / registration_end_time / status / capacity / refund_rule` |
| **RegistrationOption** | `registration_options` | 报名类型（身份/价格/权益） | `name / price(分) / status(ACTIVE/INACTIVE) / sort_order` |
| **Registration** | `registrations` | **报名（核心业务对象）** | `registration_no / name / phone / form_data / amount(分) / status / qr_token / checked_in_at` |
| **Payment** | `payments` | 支付记录 | `out_trade_no / wechat_transaction_id / amount / status` |
| **Refund** | `refunds` | 退款记录 | `out_refund_no / amount / status` |
| **CheckIn** | `checkins` | 签到记录 | `method(QR/PHONE_LAST4) / operator_* / checked_in_at` |
| 用户/会话 | `users` / `sessions` | 微信登录态 | `openid / session_key`（仅服务端） |
| 管理端 | `admin_users` / `admin_sessions` | 后台登录态 | `username / password_hash` |

**核心不变式（§44）**：

- **Registration 是核心对象，不是 Ticket**。系统没有「出票」「票务库存」「锁库存」「候补」
  「多商户」这些概念。
- **名额不是库存**：`events.capacity` 是**可空整数**，判定规则只有一条——
  「有效已支付人数（`status='PAID'` 的 Registration 数）< `capacity`」。为 NULL 表示不限。
- 金额一律**服务端**依据报名类型计算，单位**分**；时间一律 **UTC**（SQLite 为 TEXT ISO-8601，
  PostgreSQL 为 timestamptz）。
- 签到状态（`checked_in_at`）与支付状态（`status`）**分离**，互不混用。

---

## 3. 15 条硬性规则

每条规则都给出「规则内容」与「代码落点」，证明它不是纸面要求而是已实现的约束。

1. **客户端不决定金额/状态**。金额在 `registrations.createRegistration` 里取
   `option.price` 计算，客户端传入的 `price` 一律不可信；所有状态跃迁只发生在 service 层。
2. **服务端是唯一事实源**。`status`、`qr_token`、`checked_in_at` 全部由服务端写入，
   客户端从不写订单/报名状态。
3. **`wx.requestPayment` 成功 ≠ 最终状态**。支付后必须重新查询 `GET /registrations/:id`，
   以服务端 `status='PAID'` 为准（§36）。
4. **模拟支付仅限开发环境**。`MOCK_PAY_ENABLED = APP_ENV === 'development'`；路由层在
   非 development 下**不注册** `POST /dev/registrations/:id/mock-pay`，并额外注册一个
   403 兜底。**禁止**用「特殊金额/特殊用户」在业务代码里隐藏模拟支付后门（§38）。
5. **session_key 与 openid 仅服务端持有**。`/auth/wechat-login` 只回 `{ token, user }`；
   `openid` 是服务端内部身份，`session_key` 写库但**绝不返回**；客户端只持有系统
   `Bearer token`，且**不得**自行声明 openid/user_id（§32/§33，`auth.ts`）。
6. **金额用分、时间用 ISO-8601 UTC**。`util.fmtCents` / `util.nowIso`；schema 里
   `amount/price` 为 INTEGER（分），时间列 lexicographic = chronological（§9）。
7. **`qr_token` 随机不可预测、唯一、支付成功时生成**。格式 `c1k_` + base64url(24 字节随机)，
   `UNIQUE` 约束；二维码编码的是 **token 而非自增 id**；二维码只用于「快速定位」，资格由
   服务端判定（§12，`util.genQrToken`、`registrations.payRegistration`）。
8. **手机号后四位查询严格限域**。范围 = `event_id` + `status='PAID'` + 后四位匹配；
   只返回 `masked_phone`（`138****5678`，`util.maskPhone`），**绝不返回完整手机号**；
   命中多条时返回**候选列表**；**绝不自动签到**，必须工作人员确认后提交（§15/§16/§17/§20，
   `checkin.searchByPhoneLast4`）。
9. **二维码与手机号共用同一签到端点 + 同一原子防重**。两者都走
   `POST /registrations/:id/checkin`，执行同一条
   `UPDATE registrations SET checked_in_at=? WHERE id=? AND checked_in_at IS NULL AND status='PAID'`，
   并发下**恰好一个成功**，其余幂等返回「已签到」（§19，`checkin.performCheckin`）。
10. **退款规则 + 已签到禁止退款 + 幂等**。`NO_SELF_REFUND` 直接拒绝；`BEFORE_24H/48H` 校验
    窗口；`ALLOW_ANY` 仅限活动结束前；`checked_in_at` 非空拒绝；状态机
    `PAID → REFUNDING → REFUNDED`，重复退款幂等返回（§22，`registrations.refundRegistration`）。
11. **归属校验**。用户路由一律 `assertOwner`：`registrations.user_id` 必须等于登录态
    `userId`，否则 403（`routes.ts`）。
12. **签到需工作人员**。`requireStaff` = **被标记为工作人员的用户**（`users.is_admin=1`）
    **或**管理端登录态（`admin_users` 会话）；**普通用户一律 403**（`routes.ts`）。
    身份来源是服务端登录态，客户端不声明、不可伪造（§25）。
13. **`GET /config` 下发环境与基址**。返回 `{ env, apiBaseUrl, mockPayEnabled }`，客户端
    据此读取，**任何地方不得写死** `http://localhost:xxxx`（§28）。
14. **关键页面 `onShow` 刷新**。支付结果页、我的报名、报名详情、报名凭证在 `onShow` 重新
    拉取服务端数据，保证返回前台即是最新状态（§35）。
15. **无库存锁定**。只有 `capacity` 的「有效已支付人数 < capacity」软性判断，**没有**
    锁库存/预占/回补（§5）。

---

## 4. §37 真机测试清单（微信）

上线前必须逐项在**真机**验证，开发者工具只用于联调：

- [ ] **登录**：真机 `wx.login()` → `/auth/wechat-login`，走**真实** `code2Session`
      （`WX_USE_REAL=true` 且已配置 `WX_APPID/WX_APPSECRET`）；确认拿到系统 token。
- [ ] **真实支付**：`wx.requestPayment` + `POST /registrations/:id/pay/prepay`（统一下单）+
      `POST /pay/notify`（回调验签）→ 支付后重查 `GET /registrations/:id` 确认 `PAID`。
- [ ] **扫码签到**：真机 `wx.scanCode` 扫描凭证二维码 → `GET /checkin/resolve` 核对 →
      `POST /registrations/:id/checkin`（method=QR）→ 成功；**第二台设备再扫 → 已签到**。
- [ ] **手机号后四位签到**：录入 4 位 → `GET /events/:id/checkin/search` 得脱敏候选 →
      工作人员确认 → `POST /registrations/:id/checkin`（method=PHONE_LAST4）。
- [ ] **网络异常 / 401**：断网、超时、token 过期（401 → 自动重新 `wx.login`）。
- [ ] **onShow 刷新**：支付返回、切后台再回来，关键页数据即时刷新。
- [ ] **dev-mock → real 切换点**：确认非 development 下 `/dev/...` 404/403、`/config` 的
      `mockPayEnabled=false`，且客户端走真实支付分支。

### 4.1 接真实微信（已完成沙箱内实现 + 凭据清单）

真实微信的三条链路（登录 / 支付 / 退款）**已在沙箱参考实现中落地为可切换适配器**，
不再只是占位：`server/src/services/wxpay.ts`（统一下单签名 / 回调验签 / AES-256-GCM 解密 / 退款）+
`server/src/auth.ts` 的 `realCode2Session`。是否走真实路径由 `WX_PAY_USE_REAL` 凭据判定自动切换，
**缺凭据自动降级 mock**（沙箱联调不受影响），API 契约不变。

**沙箱内证明（无需真实商户、无外网）**：起一个本地微信模拟器
（`server/scripts/wechat-sim.mjs`，扮演微信平台），让被测服务端走真实适配器：

```
cd server && npm run real-pay        # 14/14 通过
```

覆盖：真实 code2Session 登录 → 统一下单（服务端用商户私钥签名请求，模拟器回 `prepay_id`，
服务端再签出 `wx.requestPayment` 五参数）→ **模拟微信回调（平台私钥签名 + AES-256-GCM 加密）→
服务端验签 + 解密 → PAID + qr_token** → 退款（服务端签名 → 模拟器受理 → REFUNDED）→
**非法签名回调被 401 拒绝** → 重复回调幂等 → 落库校验真实 `transaction_id`（非 mock）。

**接真实商户只需 6 项凭据 + 1 个公网回调地址**（全部服务端 `.env`，客户端不接触）：

| 变量 | 含义 | 来源 |
|---|---|---|
| `WX_APPID` / `WX_APPSECRET` | 小程序 AppID / AppSecret | 小程序后台（AppSecret 仅服务端） |
| `WX_MCH_ID` | 商户号 | 微信支付商户平台 |
| `WX_API_V3_KEY` | APIv3 密钥（32 字节） | 商户平台 API 安全设置 |
| `WX_MCH_SERIAL_NO` | 商户证书序列号 | 商户平台（apiclient 证书） |
| `WX_MCH_PRIVATE_KEY[_PATH]` | 商户私钥（apiclient_key.pem） | 商户平台下载 |
| `WX_PLATFORM_CERT[_PATH]` | 微信平台证书（验签用） | 商户平台下载 / API 证书下载工具 |
| `WX_PAY_NOTIFY_URL` | 异步回调公网地址（如 `https://api.xxx.com/pay/notify`） | 自有域名，指向本服务 `/pay/notify` |

> 真机验证仍须逐项走 §4 清单（开发者工具可先联调）；**`npm run real-pay` 已把最难验证的
> 「验签 + 解密 + 状态落终态」在沙箱内证明正确**，真实商户接入的剩余风险只剩凭据与网络环境。

---

## 5. API 契约速览

沙箱参考实现 `server/src/routes.ts` 的全部端点（**无 `/api` 前缀**），生产 NestJS 版本
必须**保持完全相同的路径与 JSON 契约**。鉴权列：公开 / 用户（`requireAuth`）/ 工作人员
（`requireStaff`，`is_admin` 用户或管理端；普通用户 403）/ 管理端（`requireAdmin`）/ 开发（仅 development）。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查 + env + mockPayEnabled |
| GET | `/config` | 公开 | 环境 + API 基址 + 模拟支付开关（§28） |
| POST | `/auth/wechat-login` | 公开 | `code` → 系统 token（§32） |
| GET | `/events` | 公开 | 活动列表（含 `registrationOptions`） |
| GET | `/events/:id` | 公开 | 活动详情 + 报名类型 |
| GET | `/me` | 用户 | 当前用户 |
| POST | `/me/logout` | 用户 | 退出登录 |
| POST | `/events/:id/registrations` | 用户 | 创建报名（金额服务端计算） |
| GET | `/me/registrations` | 用户 | 我的报名列表 |
| GET | `/registrations/:id` | 用户 | 报名详情 + 凭证二维码（PAID 时 `qr_data_url`） |
| POST | `/registrations/:id/cancel` | 用户 | 取消待支付报名 |
| POST | `/registrations/:id/refund` | 用户 | 申请退款 |
| POST | `/registrations/:id/pay/prepay` | 用户 | 预支付（生产微信统一下单占位） |
| POST | `/pay/notify` | 公开 | 微信支付异步回调（验签后复用同一 pay 逻辑） |
| POST | `/dev/registrations/:id/mock-pay` | 开发 | 模拟支付（仅 development，生产 403/404） |
| GET | `/checkin/resolve` | 工作人员 | `qrToken` 定位报名（脱敏摘要） |
| GET | `/events/:eventId/checkin/search` | 工作人员 | 手机号后四位查询（脱敏候选） |
| POST | `/registrations/:id/checkin` | 工作人员 | 统一签到（QR / PHONE_LAST4） |
| POST | `/admin/auth/login` | 公开 | 管理端登录 |
| GET | `/admin/me` | 管理端 | 管理端当前账号 |
| POST | `/admin/auth/logout` | 管理端 | 管理端退出 |
| POST | `/admin/events` | 管理端 | 创建活动 |
| PUT | `/admin/events/:id` | 管理端 | 编辑活动 |
| POST | `/admin/events/:id/options` | 管理端 | 添加报名类型 |
| PUT | `/admin/events/:id/options/:optionId` | 管理端 | 编辑报名类型 |
| POST | `/admin/events/:id/status` | 管理端 | 设置活动状态 |
| GET | `/admin/registrations` | 管理端 | 报名名单（搜索/筛选/分页） |
| GET | `/admin/checkins` | 管理端 | 签到记录 |
| GET | `/admin/stats` | 管理端 | 统计 |
| GET | `/admin/attendance` | 管理端 | 用户参加次数统计（已报名且已核验的活动数，供后台按次数设折扣票） |
| GET | `/admin/export` | 管理端 | 导出报名 CSV |
| GET | `/admin/credentials` | 开发 | 默认管理账号（仅 development） |

---

## 6. 核心状态流转

**Registration（核心）**：

```
PENDING ──支付成功──▶ PAID ──退款──▶ REFUNDING ──▶ REFUNDED
   │                    │
   └──取消/超时──▶ CANCELLED
```
- `PENDING → PAID`：唯一支付成功路径，生成 `qr_token`，写 `payments(SUCCESS)`（幂等）。
- `PENDING → CANCELLED`：用户取消，或 `closeExpiredRegistrations` 清理超时（软性，非库存）。
- `PAID → REFUNDING → REFUNDED`：退款状态机，已签到禁止退款，退款规则窗口内，幂等。
- `checked_in_at`（签到）独立于 `status`：仅 `PAID` 且 `checked_in_at IS NULL` 时写入一次。

**Payment**：`PENDING → SUCCESS`（支付成功）/ `PENDING → FAILED`（支付失败）/
`SUCCESS → REFUNDED`（退款时联动）。

**CheckIn（幂等）**：同一报名重复签到返回 `already: true`（「已签到」），不重复写记录；
并发下原子更新保证**恰好一个成功**（§19）。

**两条验证链（§41）**：

1. `wx.login → 服务端建用户 → 读活动 → 创建报名 → 支付 → 生成报名凭证(二维码) →
   真机显示二维码 → 另一台设备扫码 → 完成签到`。
2. `手机号后四位 → 脱敏候选 → 工作人员确认 → 完成签到`。

沙箱端到端脚本：`npm run smoke`（注入式，覆盖两条链 + 名额/退款/幂等/并发防重）、
`npm run live`（真实 HTTP，走 127.0.0.1:3050）、
`npm run real-pay`（接真实微信全链路：起本地微信模拟器，走真实 code2Session / 统一下单 / 回调验签+解密 / 退款，14 项断言）。

---

## 7. NestJS / PostgreSQL 迁移 TODO

按顺序执行，每条都标注「沙箱对应物」：

1. **搭 NestJS 模块骨架**：`auth / events / registrations / payments / checkins / admin` 六个
   module，复用**同一套 zod schema** 与 service 逻辑——把 `server/src/services/*`（纯业务）
   逐一带注释搬进 `@Injectable()`（沙箱：`server/src/services/*.ts`）。
2. **切换持久层**：`node:sqlite` → Postgres 数据访问层（推荐 **Prisma**，schema 来源为
   `server/schema.postgres.sql`；或 TypeORM/Kysely）。金额仍为分，时间仍为 UTC。
   （沙箱：`server/src/db.ts` + `server/src/schema.sql`）。
3. **路由层替换**：Fastify 路由 → NestJS `@Controller` + `AuthGuard / StaffGuard / AdminGuard`，
   **保持相同的路径与 JSON 契约**（沙箱：`server/src/routes.ts` 全部端点，见 §5）。
4. **真实微信登录**：`code2Session` **已在沙箱落地为可切换适配器**（`server/src/auth.ts` 的
    `realCode2Session`），生产只需填 `WX_APPID/WX_APPSECRET` 即走真实登录；把该函数搬进
    `@Injectable()` 服务即可。
5. **真实微信支付**：统一下单 / `wx.requestPayment` / **notify 验签 + AES-256-GCM 解密 / 退款** **均已在沙箱落地**
    （`server/src/services/wxpay.ts`，纯 `node:crypto`，无第三方依赖），并由 `npm run real-pay`
    （本地微信模拟器）在沙箱内证明全链路正确；生产接入 = 填商户凭据 + 公网回调地址（见 §4.1），替换 mock-pay；
   回调与预支付仍复用**同一个 `payRegistration`**（沙箱：`server/src/services/registrations.ts`）。
6. **真实管理后台**：Next.js + Ant Design 对接 admin API（沙箱：`/admin/*` + `server/ui/` 浏览器联调页）。
7. **SQLite 联调页降级为一次性本地工具**：保留 `server/ui/` 与 `--experimental-strip-types`
   仅作本地开发便利，不进生产。
8. **测试移植**：把 `server/scripts/smoke-test.mjs` / `live-flow.mjs` 的断言移植为
   集成测试套件（Jest/Vitest + supertest），覆盖「不超名额 / 幂等 / 防重复签到 / 退款状态机」。
9. **可观测性**：结构化日志 + 请求 ID（`routes.ts` 目前 `logger: false`），接入监控。

> 迁移不变式：**API 路径、状态枚举、字段名、金额单位（分）、时间语义（UTC）在迁移前后完全一致**。
