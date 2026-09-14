# 碰杯LAB 小程序 · 上线前检查清单（PRE-LAUNCH）

按顺序逐项打勾，全部完成后才能提审发布。

## 0. 域名 / HTTPS / 备案
- [ ] 备案已通过（短信核验 → 工信部审核 → 备案号下发；已提交，约 2-3 周）
- [ ] Nginx 已配 HTTPS（certbot 签发证书，自动续期）
- [ ] 访问 https://api.clinkai.cn/health 返回 `ok`
- [ ] 服务器生产代码已更新为最新（含本批功能），并重新 seed 生产库

## 1. 小程序后台（微信公众平台 mp.weixin.qq.com）
- [ ] 「开发管理 → 开发设置 → 服务器域名」→ request 合法域名添加 `https://api.clinkai.cn`（需 https 且已备案）
- [ ] （如用到图片外链）downloadFile 合法域名：`https://api.clinkai.cn`
- [ ] 订阅消息：功能 → 订阅消息 → 选用 2 个模板：
      「报名成功通知」（活动/时间/提示）→ 记下模板 ID 填入 server `.env` 的 `WX_TEMPLATE_IDS={"pay_success":"xxx"}`
      「活动开始提醒」（活动/时间/地点）→ 记下模板 ID 填入 `WX_TEMPLATE_IDS={"event_remind":"yyy"}`（两个可一起填）
      同步把两个模板 ID 填入小程序 `miniprogram/config/env.ts` 的 `SUBSCRIBE_TEMPLATE_IDS` 数组
      ⚠️ 模板字段（thing1/time1/thing2）需与所选模板的关键字顺序对应，选模板时尽量选「活动名称/活动时间/地点」类

## 2. 微信支付（如需真实收款）
- [ ] 主体升级为企业/个体工商户（个人主体小程序无法开通微信支付）
- [ ] 商户号申请通过，把商户凭据填 server `.env`：WX_MCH_ID / WX_API_V3_KEY / WX_MCH_SERIAL_NO / 商户私钥 / 平台证书
- [ ] server `.env` 设置 `MOCK_PAY=false`，生产不再走模拟支付
- [ ] 支付回调域名：商户平台配置 支付通知地址 = `https://api.clinkai.cn/api/wechat/pay/notify`（按实际路由）

## 3. 代码配置翻转（发布前最后一步）
- [ ] `ClinkLab/miniprogram/config/env.ts`：`APP_ENV` 从 `'development'` 改为 `'production'`（API 自动指向 https://api.clinkai.cn）
- [ ] 微信开发者工具重新编译 → 真机预览自测一遍（见第 5 节）→ 上传代码 → 设为体验版
- [ ] 提审：版本描述写清楚，选择服务类目（如「教育 > 在线教育」或「生活服务 > 活动票务」按实际）

## 4. 服务器 .env 生产配置核对（server/.env）
- [ ] `API_BASE_URL=https://api.clinkai.cn`
- [ ] `ADMIN_USERNAME` / `ADMIN_PASSWORD` 改为强密码
- [ ] `WX_APPID` / `WX_APPSECRET`（已配）
- [ ] `WX_TEMPLATE_IDS`（订阅消息，见第 1 节）
- [ ] 商户凭据（见第 2 节）

## 5. 本批新功能真机自测清单
| 功能 | 自测步骤 | 预期 |
|---|---|---|
| A① 分享 | 详情页点「分享」/右上角菜单 | 卡片带封面，好友点开直达详情 |
| A② 导航 | 详情页地址行点「导航」 | 有坐标调起微信地图；无坐标复制地址 |
| B⑤ 订阅消息 | 支付成功后弹授权 → 允许 | 后台显示授权记录；活动开始前 24h 收到提醒（需模板就绪） |
| B⑥ 超时取消 | 报名后 30 分钟不支付 | 订单自动取消，结果页提示可重新报名 |
| C⑦ 自定义字段 | 后台给活动配「所在行业/公司/话题」→ 小程序报名 | 报名页出现必填/选填字段，后台报名列表+CSV 可见 |
| C⑨ 评价 | 核销后详情页写评价 | 1-5 星 + 留言展示，后台「评价」可见 |

## 6. 常见坑提示
- 支付成功后**不要**立刻杀进程：以服务端状态为准（结果页轮询 GET 报名详情）
- 双人票出 2 个凭证码，各扫各核销
- 报名页昵称/手机号来自「我的」资料，不重复填写；邀请票需输入后台配置的邀请码
- 修改 env.ts 后**必须重新编译上传**，体验版才会更新
