// 快速冒烟：导入 app（会触发所有 service 导入 + 路由注册 + DB 打开），注入 /health 与 /config。
import { buildApp } from '../src/app.ts';

const app = buildApp();
await app.ready();

const health = await app.inject({ method: 'GET', url: '/health' });
console.log('HEALTH', health.statusCode, health.body);

const config = await app.inject({ method: 'GET', url: '/config' });
console.log('CONFIG', config.statusCode, config.body);

// 未登录访问受保护接口 → 应 401
const me = await app.inject({ method: 'GET', url: '/me' });
console.log('ME(unauth)', me.statusCode, me.body);

await app.close();
console.log('CHECK_OK');
process.exit(0);
