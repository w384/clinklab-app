// 环境配置（§28：API 基址按环境切换，客户端不在业务里硬编码死值）。
// 生产环境由构建注入 / 发布前替换；这里给出 development / production 两套。
// 注意：小程序无法在"第一次请求之前"从服务端拿基址，因此基址是唯一的构建期配置；
// 其余环境信息（env / mockPayEnabled）在启动时由 GET /config 拉取，驱动 UI（如是否显示"模拟支付"）。

export type AppEnv = 'development' | 'production';

export const APP_ENV: AppEnv = 'development';

const BASE: Record<AppEnv, string> = {
  // DSH 沙箱：Node type-stripping + Fastify + SQLite 的"可运行参考实现"
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
