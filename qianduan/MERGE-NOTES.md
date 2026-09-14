# Clink Lab 前端视觉副本

本目录是碰杯实验室小程序的隔离美化副本，源目录 `ClinkLab/miniprogram` 未修改。

## 合并范围

- `miniprogram/app.wxss`
- `miniprogram/pages/*/*.wxml`
- `miniprogram/pages/*/*.wxss`
- `miniprogram/assets/home-hero.png`
- `miniprogram/assets/event-cover.png`
- `miniprogram/assets/clink-logo.jpg`

## 设计方向

- 品牌：`Clink Lab 碰杯实验室`
- 主色：皇室蓝，关键动作使用金色
- 结构：深蓝品牌头部、雾灰页面底、白色信息卡、轻量阴影
- 首页和详情页使用参考图视觉资源作为 Hero / 活动封面

## 合并注意

- `miniprogram/pages/*/*.ts` 仅复制用于核验，未做任何改动，不需要合并。
- `app.json`、`app.ts`、服务和工具文件未做改动。
- 事件绑定、`wx:` 指令、data 字段和方法名保持原样。
- 资源引用位于 `miniprogram/assets/`，合并 WXML/WXSS 时需一并带入。
