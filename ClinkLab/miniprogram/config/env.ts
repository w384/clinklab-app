// 环境配置（§28：API 基址按环境切换，客户端不在业务里硬编码死值）。
// 小程序无法在"第一次请求之前"从服务端拿基址，因此基址是唯一的构建期配置；
// 其余环境信息（env / mockPayEnabled）在启动时由 GET /config 拉取，驱动 UI。
export type AppEnv = 'development' | 'production';

export const APP_ENV: AppEnv = 'development';

const BASE: Record<AppEnv, string> = {
  // 本地联调：DSH 沙箱的可运行参考实现（需 DevTools 勾选"不校验合法域名"）
  development: 'http://127.0.0.1:3050',
  // 生产：腾讯云轻量服务器（Nginx + HTTPS + 备案域名 api.clinkai.cn）
  production: 'https://api.clinkai.cn',
};

export const API_BASE_URL: string = BASE[APP_ENV] || BASE.development;
// 仅信息用途：小程序实际支付模式由服务端 GET /config 的 mockPayEnabled 驱动
export const MOCK_PAY_ENABLED_DEFAULT: boolean = (APP_ENV as AppEnv) === 'development';

// 订阅消息模板 ID（B⑤）：微信公众平台 → 功能 → 订阅消息 → 选用模板后把 ID 填进数组。
// 空数组 = 开发期不弹授权窗、不发订阅（等备案 + 模板就绪后填入再启用）。
export const SUBSCRIBE_TEMPLATE_IDS: string[] = [];

export interface ServerConfig {
  env: string;
  apiBaseUrl: string;
  mockPayEnabled: boolean;
}
