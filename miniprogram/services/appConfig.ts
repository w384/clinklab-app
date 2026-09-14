// 运行时环境配置：启动时从服务端 GET /config 拉取（§28），驱动"是否显示模拟支付"等 UI。
// 独立于 App 实例（小程序 App 的 globalData 类型约定不便扩展），用一个轻量单例 store。
import { request } from './request';
import { APP_ENV, MOCK_PAY_ENABLED_DEFAULT } from '../config/env';

interface Cfg {
  env: string;
  mockPay: boolean;
  ready: boolean;
}

const cfg: Cfg = { env: APP_ENV, mockPay: MOCK_PAY_ENABLED_DEFAULT, ready: false };
const listeners: Array<() => void> = [];

function notify() {
  const ls = listeners.slice();
  listeners.length = 0;
  ls.forEach((cb) => cb());
}

// 在 App.onLaunch 中调用一次
export function initAppConfig(): void {
  if (cfg.ready) return;
  request<{ env: string; mockPayEnabled: boolean }>({ url: '/config', noAuth: true })
    .then((r) => {
      cfg.env = r.env || APP_ENV;
      cfg.mockPay = !!r.mockPayEnabled;
      cfg.ready = true;
      notify();
    })
    .catch(() => {
      cfg.ready = true; // 拉取失败时用默认（development=模拟支付开）
      notify();
    });
}

export function getMockPay(): boolean {
  return cfg.mockPay;
}
export function getEnv(): string {
  return cfg.env;
}
// 订阅配置就绪（支付结果页据此决定展示"模拟支付"还是"去支付"）
export function onConfigReady(cb: () => void): void {
  if (cfg.ready) cb();
  else listeners.push(cb);
}
