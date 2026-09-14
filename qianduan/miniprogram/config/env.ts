// 环境配置（§28：API 基址按环境切换，客户端不在业务里硬编码死值）。
// 小程序无法在"第一次请求之前"从服务端拿基址，因此基址是唯一的构建期配置；
// 其余环境信息（env / mockPayEnabled）在启动时由 GET /config 拉取，驱动 UI。
export type AppEnv = 'development' | 'production';

export const APP_ENV: AppEnv = 'development';

const BASE: Record<AppEnv, string> = {
  // 本地联调：DSH 沙箱的可运行参考实现（需 DevTools 勾选"不校验合法域名"）
  development: 'http://127.0.0.1:3050',
  // 生产目标：NestJS + PostgreSQL 网关（后续阶段）
  production: 'https://api.clinklab.example.com',
};

export const API_BASE_URL: string = BASE[APP_ENV] || BASE.development;
export const MOCK_PAY_ENABLED_DEFAULT: boolean = APP_ENV === 'development';

export interface ServerConfig {
  env: string;
  apiBaseUrl: string;
  mockPayEnabled: boolean;
}
