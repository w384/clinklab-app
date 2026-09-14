# UI 升级工作边界（给负责界面升级的会话/工程师）

> 本文档是备份基线的一部分。本仓库当前提交 = **已验证的正常版本**（v38 后台修复 + 冒烟 54/54 通过 + 后台 4-tab 正常）。
> 你的任务是对**界面层**做效果升级。请严格遵守下面的边界，否则会把已验证的业务弄回归。

## 可以改（界面层）
- 小程序 `ClinkLab/miniprogram/pages/*` 下的 `*.wxml` / `*.wxss`（页面结构与样式）
- 小程序 `ClinkLab/miniprogram/app.wxss`、`app.json`（全局样式/页面注册，仅视觉配置）
- 小程序页面 `*.ts` 中**纯展示逻辑**（如格式化、渲染数据拼装）；**业务请求逻辑不属于这里**
- 后端后台页 `server/ui/*`：`index.html` / `styles.css` / `app.js` 的**视觉与交互呈现**
- 参考图 `asset1/`（原型参考，可对照但不改）

## 禁止改（业务层，一碰就可能回归）
- 后端 `server/src/services/*`（报名/支付/签到/退款/评论/分享等全部业务）
- 后端 `server/src/routes.ts` / `auth.ts` / `db.ts` / `config.ts` / `schema.sql` / `schema.postgres.sql`
- 小程序 `ClinkLab/miniprogram/services/*`（request / auth / event / registration / payment / checkin）
- 小程序 `ClinkLab/miniprogram/config/env.ts`（仅发布前由专人改 APP_ENV，不在本次范围）
- `server/scripts/*` 测试脚本、`server/src/seed.ts`

## 必须保持不变的不变量（迁移硬约束）
- **API 路径、字段名、状态枚举、金额单位（分）、时间语义（UTC）一字不动**
- 报名/支付/退款/签到状态机不变；`/admin/*` 接口契约不变

## 改完后的验收（必须全过）
```bash
cd server
npm run check      # 快速冒烟
npm run smoke      # 端到端冒烟（应 54 项全过）
npm run typecheck  # tsc --noEmit
```
后台页验收：`http://127.0.0.1:3050/` 顶部导航 **4 个 tab**（活动/分享/论坛/后台）且各区块可交互。

## Git 纪律
- 在基线提交**之后**再提交你的改动，一次提交只做一个功能点，提交信息写清楚改了什么。
- 若升级过程中发现需要动业务层，停下来先讨论，不要自己改。
