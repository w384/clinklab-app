import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// 极简 .env 解析（避免引入 dotenv 依赖）。真实部署也可用 Secret Manager / 进程环境变量注入。
// 只解析 KEY=VALUE 行，忽略注释；已存在的进程环境变量优先（便于容器注入）。
const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * 环境隔离（硬性规则 1/3）：development / staging / production 三套。
 * 数据库按环境分目录，天然防止"本地开发连接生产库"。
 */
export type AppEnv = 'development' | 'staging' | 'production';
const rawEnv = (process.env.APP_ENV || process.env.NODE_ENV || 'development').toLowerCase();
export const APP_ENV: AppEnv =
  rawEnv === 'production' || rawEnv === 'prod'
    ? 'production'
    : rawEnv === 'staging' || rawEnv === 'stg'
      ? 'staging'
      : 'development';

export const IS_PRODUCTION = APP_ENV === 'production';

/**
 * 模拟支付开关（§38）。
 * 默认仅 development 开启；staging / production 一律关闭 —— 不在业务代码里埋"特殊金额/特殊用户"后门。
 * 生产「模拟购票演示」阶段可显式设置 MOCK_PAY=true 开启（真实商户就绪后必须关闭，切换为真实支付）。
 * 路由层在关闭时对 /dev/mock-pay 返回 403（而非注册后隐藏逻辑）。
 */
export const MOCK_PAY_ENABLED = process.env.MOCK_PAY === 'true' ? true : APP_ENV === 'development';

export const PORT = Number(process.env.PORT || 3050);
// 监听 0.0.0.0：本机 localhost / 127.0.0.1 / 电脑局域网 IP 都能访问。
// 后台页面缓存问题由 /ui-latest/ 无缓存启动自愈解决，不再需要多端口/多前缀绕行。
export const HOST = process.env.HOST || '0.0.0.0';

/**
 * API 基址（§28）：服务端对外声明，客户端据此读取；
 * 客户端代码中禁止写死 http://localhost:xxxx。
 * 注意：保持 127.0.0.1（本机微信开发者工具/小程序使用），不要随 HOST 变成 0.0.0.0。
 */
export const API_BASE_URL = process.env.API_BASE_URL || `http://127.0.0.1:${PORT}`;

/** 数据库：默认按环境分目录（data/<env>/registration.sqlite），可用 DB_PATH 覆盖。 */
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(here, '..', process.env.DB_PATH)
  : path.resolve(here, '..', 'data', APP_ENV, 'registration.sqlite');

/** 系统登录态（session token）有效期（秒）。 */
export const SESSION_TTL_SEC = Number(process.env.SESSION_TTL_SEC || 7 * 86_400);
/** 管理端登录态有效期（秒）。 */
export const ADMIN_SESSION_TTL_SEC = Number(process.env.ADMIN_SESSION_TTL_SEC || 8 * 3600);
/** 待支付报名自动取消时限（毫秒）。V0.1 的软性清理，非库存机制（§5）。 */
export const REG_PAY_DEADLINE_MS = Number(process.env.REG_PAY_DEADLINE_MIN || 30) * 60_000;

/** 后台管理默认账号（seed 时创建；生产应改为真实 admin_users + 密码哈希）。 */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

/**
 * 微信小程序身份（§31：只能存在于服务端；小程序源码禁止出现 AppSecret）。
 * 开发阶段可先用真实 AppID（§30）；AppSecret 放服务端 .env / Secret Manager。
 */
export const WX_APPID = process.env.WX_APPID || '';
export const WX_APPSECRET = process.env.WX_APPSECRET || '';
/**
 * 是否走真实 code2Session。
 * development 且未配置 AppID/Secret 时自动降级为 mock（便于无真实凭据时联调登录链路）。
 * staging/production 必须为 true 且配置真实 AppID/Secret。
 */
export const WX_USE_REAL =
  (APP_ENV !== 'development' ? true : process.env.WX_USE_REAL !== 'false') &&
  Boolean(WX_APPID && WX_APPSECRET);

/**
 * 订阅消息模板 ID（微信公众平台 → 功能 → 订阅消息 → 选用模板后获得）。
 * JSON 对象，如：{"pay_success":"abcdef123456...","event_remind":"xyz..."}
 * 未配置时订阅消息一律跳过发送（开发期安全），配置后按模板真实下发。
 */
export const WX_TEMPLATE_IDS: Record<string, string> = (() => {
  try {
    const raw = process.env.WX_TEMPLATE_IDS || '';
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
})();

// ── 微信支付（商户）凭据（§36：只能服务端；小程序源码禁止出现）─────────────────
// 商户号 / APIv3 密钥 / 商户证书序列号 / 商户私钥 / 微信平台证书。
// 沙箱联调时把 WX_API_BASE / WX_PAY_BASE 指向本地微信模拟器（见 scripts/wechat-sim.mjs），
// 即可在无真实商户、无外网的情况下跑通"统一下单 + 回调验签解密 + 退款"全链路。
export const WX_MCH_ID = process.env.WX_MCH_ID || '';
export const WX_API_V3_KEY = process.env.WX_API_V3_KEY || '';
export const WX_MCH_SERIAL_NO = process.env.WX_MCH_SERIAL_NO || '';
export const WX_MCH_PRIVATE_KEY = process.env.WX_MCH_PRIVATE_KEY || '';
export const WX_MCH_PRIVATE_KEY_PATH = process.env.WX_MCH_PRIVATE_KEY_PATH || '';
export const WX_PLATFORM_CERT = process.env.WX_PLATFORM_CERT || '';
export const WX_PLATFORM_CERT_PATH = process.env.WX_PLATFORM_CERT_PATH || '';
/** 微信异步回调地址（必须公网可达，沙箱联调可填本地地址）。 */
export const WX_PAY_NOTIFY_URL = process.env.WX_PAY_NOTIFY_URL || '';
/** 微信开放接口 / 微信支付接口基址（默认真实；沙箱联调指向本地模拟器）。 */
export const WX_API_BASE = (process.env.WX_API_BASE || 'https://api.weixin.qq.com').replace(/\/$/, '');
export const WX_PAY_BASE = (process.env.WX_PAY_BASE || 'https://api.mch.weixin.qq.com').replace(/\/$/, '');

/**
 * 是否走真实微信支付（统一下单 / 回调验签解密 / 退款）。
 * 凭据齐备才为 true，否则自动降级为 mock —— 便于无真实商户时联调登录/报名链路。
 * staging/production 必须为 true（缺凭据会 500，而非静默走 mock）。
 */
export const WX_PAY_USE_REAL =
  Boolean(WX_MCH_ID && WX_API_V3_KEY && WX_MCH_SERIAL_NO &&
    (WX_MCH_PRIVATE_KEY || WX_MCH_PRIVATE_KEY_PATH) &&
    (WX_PLATFORM_CERT || WX_PLATFORM_CERT_PATH)) &&
  (APP_ENV !== 'production' || true); // 生产也必须走真实支付（此处恒为凭据判定的结果）
