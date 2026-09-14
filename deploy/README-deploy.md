# ClinkLab 上线部署手册（模拟购票演示版）

> 目标：把「模拟购票」的完整闭环（浏览活动 → 报名 → 模拟支付 → 凭证 → 签到）部署到公网，
> 用**微信小程序体验版**真机测试，无需微信认证、无需个体户、无需商户号。
> 真实购票等个体户 + 商户号就绪后再切换（见文末「真实购票切换」）。

---

## 一、你需要准备（与部署并行办）

| 项 | 怎么拿 | 费用 | 耗时 |
|---|---|---|---|
| **域名** | 阿里云/腾讯云买一个，如 `clinklab.cn` | ~30-100 元/年 | 当天 |
| **ICP 备案** | 云厂商控制台提交（主体+域名），**必须完成**才能开放 80/443 | 免费 | 2-3 周 |
| **服务器** | 腾讯云轻量/CVM 或阿里云 ECS，Ubuntu 22.04/24.04，2核2G | 免费试用或 ~100-200 元/年 | 当天 |
| **DNS 解析** | 域名控制台加 A 记录：`api` → 服务器公网 IP | 免费 | 10 分钟 |
| **AppID/AppSecret** | mp.weixin.qq.com → 开发 → 开发设置（AppID 已有 `wx647d9b743be896fc`，AppSecret 点「生成」）| 免费 | 10 分钟 |

> ⚠️ **备案是关键路径**：未备案，域名 80/443 端口会被拦截（服务器在中国大陆必须备案）。
> 备案期间可以先部署（用服务器 IP 或改端口自测），备案通过后域名即可用。

---

## 二、部署后端（我给的一键脚本）

在**你的本地电脑**上，把项目传到服务器：

```bash
# 本机（Windows PowerShell 或 WSL）
scp -r "D:\AI\dsh\Projects\Clink AI\clinklab_app" root@你的服务器IP:/opt/
# 如果嫌整个目录大，可只传 server/ 和 deploy/：
#   scp -r "...\server" "...\deploy" root@IP:/opt/clinklab_app/
```

在**服务器**上：

```bash
cd /opt/clinklab_app
sudo bash deploy/deploy.sh api.你的域名.com
```

脚本会自动：装 Node 24 → 装依赖 → 生成 .env（生产 + MOCK_PAY=true + 随机管理密码）→
初始化数据库（含演示活动）→ 注册 systemd 服务 → 启动并健康检查。

接着配 Nginx + HTTPS：

```bash
apt-get install -y nginx certbot python3-certbot-nginx
cp deploy/nginx.conf.example /etc/nginx/sites-available/clinklab.conf
sed -i s/api.YOURDOMAIN.com/你的域名/g /etc/nginx/sites-available/clinklab.conf
ln -s /etc/nginx/sites-available/clinklab.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d api.你的域名.com     # 自动签免费 HTTPS 证书
```

验证：
```bash
curl https://api.你的域名.com/health
# 应返回 {"ok":true,...,"env":"production","mockPayEnabled":true}
```

> **重要**：把 `server/.env` 里的 `ADMIN_PASSWORD` 记下来（管理后台登录用，脚本随机生成的）。

---

## 三、微信后台配置（mp.weixin.qq.com）

1. **登录** → 开发管理 → 开发设置 → 服务器域名 → 「request 合法域名」→ 添加：
   `https://api.你的域名.com`
2. 点「校验域名」：微信会给一个校验文件（如 `MP_verify_xxxx.txt`）。按提示下载，
   放到服务器：
   ```bash
   mkdir -p /var/www/wechat-verify
   # 把 MP_verify_xxxx.txt 传进去（文件名原样）
   ```
   然后回微信后台点「确认保存」（Nginx 已配置好该路径）。
3. **成员管理** → 添加体验成员：加你自己的微信号（个人主体体验成员上限约 15 人）。

---

## 四、小程序端配置（上传前改一行）

编辑 `ClinkLab/miniprogram/config/env.ts`：

```ts
export const APP_ENV: AppEnv = 'production';   // ← 从 development 改成 production
// production 基址改成你的域名（就是 env.ts 里 BASE.production）
production: 'https://api.你的域名.com',
```

> 本地联调还想用开发版时改回 `development` 即可。上传体验版必须用 `production`。

---

## 五、上传体验版

**方式 A（推荐，图形界面）：**
1. 用微信开发者工具打开 `ClinkLab` 项目（AppID 用 `wx647d9b743be896fc`）
2. 右上角「上传」→ 填版本号 `0.1.0`、备注「模拟购票演示」
3. 上传后到微信后台「版本管理」→ 开发版本 → 设为**体验版** → 生成体验版二维码
4. 用手机微信扫码（被加为体验成员的那个号）→ 打开即真机测试

**方式 B（命令行 CLI，本机已装）：**
```powershell
cd "D:\AI\dsh\Projects\Clink AI\clinklab_app\ClinkLab"
& "D:\AI\微信web开发者工具\cli.bat" login          # 首次需扫码登录
& "D:\AI\微信web开发者工具\cli.bat" upload `
    --project "D:\AI\dsh\Projects\Clink AI\clinklab_app\ClinkLab" `
    --version 0.1.0 --desc "模拟购票演示版" --info-output upload-info.json
```

---

## 六、真机测试流程

扫码打开体验版 → 完整走一遍：

1. 微信一键登录（若配了 AppSecret 则真实登录）
2. 首页看到演示活动（种子数据）
3. 进详情 → 报名 → 选票种 → 提交
4. **支付**：因 `MOCK_PAY=true`，prepay 返回模拟模式 → 点「模拟支付」→ 状态变已支付
5. 「我的」→ 查看报名凭证（二维码 + 报名号）
6. 签到：用另一台设备（或后台签到页）扫描/输入核验

> 管理后台 `https://api.你的域名.com/admin`（admin / 随机密码）：可以建活动、看报名、
> 核销签到、导出 CSV、归档/删除活动。

---

## 七、真实购票切换（个体户下来后）

1. 办个体户执照 + 微信认证（300 元/年）
2. pay.weixin.qq.com 申请商户号，**关联小程序 AppID**，拿 API v3 密钥 + 商户证书
3. 把商户凭据填进 `server/.env`（模板见 `.env.production.example` 注释段），`MOCK_PAY=false`
4. `systemctl restart clinklab`，用 `npm run real-pay` 在本地验一遍真实支付链路
5. 小程序代码无需改（已按接口自动切换真实支付）
6. 微信后台提交审核 → 发布正式版

---

## 八、常见问题

| 问题 | 处理 |
|---|---|
| 真机请求 `url not in domain list` | 合法域名没配好 / 校验文件没过 / 域名没备案 |
| 域名能开但一直 301/拒绝 | ICP 备案未完成，大陆服务器拦截 80/443 |
| 体验版能打开但登录/报名报错 | 看服务器日志 `journalctl -u clinklab -n 100` |
| 想换管理密码 | 改 `server/.env` 的 `ADMIN_PASSWORD` 后 `systemctl restart clinklab` |
| 数据备份 | 备份 `server/data/production/registration.sqlite` 单文件即可 |
| 升级代码 | 重新 scp server/ 后 `sudo bash deploy/deploy.sh 域名`（不会清数据）|
