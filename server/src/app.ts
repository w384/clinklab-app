import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerRoutes } from './routes.ts';
import { closeExpiredRegistrations } from './services/registrations.ts';
import { db } from './db.ts';
import { nowIso, hashAdminPassword } from './util.ts';
import { PORT, HOST, APP_ENV, API_BASE_URL, MOCK_PAY_ENABLED, ADMIN_USERNAME, ADMIN_PASSWORD } from './config.ts';

/** 演示用户（浏览器联调 harness 用；小程序用户走 wx-login 自建）。 */
function ensureDemoUser(): void {
  const now = nowIso();
  const u = db.prepare(`SELECT id FROM users WHERE openid='demo_user'`).get();
  if (!u) db.prepare(`INSERT INTO users (openid, nickname, phone, created_at, updated_at) VALUES ('demo_user','演示用户','13800000000',?,?)`).run(now, now);
}

/** 管理端默认账号（§24 admin_users；口令哈希存储，生产建议更强哈希 + 真实账号体系）。 */
function ensureAdmin(): void {
  const now = nowIso();
  const a = db.prepare(`SELECT id FROM admin_users WHERE username=?`).get(ADMIN_USERNAME);
  if (!a) {
    db.prepare(`INSERT INTO admin_users (username, password_hash, created_at) VALUES (?,?,?)`).run(ADMIN_USERNAME, hashAdminPassword(ADMIN_USERNAME, ADMIN_PASSWORD), now);
  }
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  // 联调期轻量请求日志：打印 方法 路径 → 状态码，便于确认小程序/浏览器真实调用
  app.addHook('onResponse', (req, reply, done) => {
    const ip = (req.headers && (req.headers as any)['x-real-ip']) || req.ip;
    console.log(`[req] ${req.method} ${req.url} -> ${reply.statusCode}  ${ip}`);
    done();
  });
  // 容忍空 JSON body（很多客户端对无 body 的 POST 也会带上 Content-Type: application/json，
  // 例如"模拟支付""取消""签到"这类无参动作；这里把空 body 归一为 {}）。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: string, done: any) => {
    req.rawBody = body == null ? '' : String(body); // 供微信回调验签（必须用原始字节，不能重新序列化）
    if (!body || body.trim().length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (e) {
      const err: any = new Error('JSON 解析失败');
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  // 动态"最新页面"端点：/ui-latest/<任意时间戳> 每次都返回服务器当前 index.html。
  // 路径段每次唯一 → 任何按 URL 缓存的代理/拦截器都无法命中旧缓存，必定拿到最新版。
  app.get('/ui-latest/:ts', async (_req, reply) => {
    try {
      const html = await fs.promises.readFile(path.join(uiRoot, 'index.html'), 'utf8');
      reply.type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .header('Pragma', 'no-cache')
        .header('Expires', '0')
        .header('Vary', '*')
        .send(html);
    } catch (e) {
      reply.status(500).send('index.html 读取失败: ' + (e as Error).message);
    }
  });
  // 无前缀：根路径 / 提供后台（主入口）
  app.register(fastifyStatic, {
    root: uiRoot,
    index: ['index.html'],
    // 联调阶段：页面/脚本/样式一律禁止缓存，避免浏览器持有旧版 index.html 导致新元素缺失
    cacheControl: false,
    setHeaders(res, p) {
      if (/\/index\.html$|\.(html?|js|css)$/i.test(p)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        // Vary:* 与 Clear-Site-Data 进一步阻止本地代理/拦截器把 HTML 缓存成旧版
        res.setHeader('Vary', '*');
        res.setHeader('Clear-Site-Data', '"cache"');
      }
    },
  });
  // /ui/ 前缀：同一份后台。v38 启动自愈逻辑（bootFromServer / index.html 内联自检）
  // 用绝对路径 /ui/styles.css、/ui/app.js 加载资源，该前缀是功能依赖，必须保留。
  app.register(fastifyStatic, {
    root: uiRoot,
    prefix: '/ui/',
    index: ['index.html'],
    decorateReply: false,
    cacheControl: false,
    setHeaders(res, p) {
      if (/\/index\.html$|\.(html?|js|css)$/i.test(p)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Vary', '*');
        res.setHeader('Clear-Site-Data', '"cache"');
      }
    },
  });
  const uploadsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', APP_ENV, 'uploads');
  try { fs.mkdirSync(uploadsRoot, { recursive: true }); } catch (e) { /* 忽略 */ }
  app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: '/uploads/',
    decorateReply: false, // 已注册过一次，跳过重复装饰器（sendFile 等）
    cacheControl: false,
  });
  ensureDemoUser();
  ensureAdmin();
  registerRoutes(app);
  return app;
}

// 直接 `node --experimental-strip-types src/app.ts` 时启动（导入本模块则不自动启动）
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // 定时清理超时未支付的 PENDING 报名（幂等；V0.1 软性清理，非库存机制）
  const sweeper = setInterval(() => {
    try {
      const n = closeExpiredRegistrations();
      if (n > 0) console.log(`[sweeper] 取消 ${n} 个超时未支付报名`);
    } catch {
      /* ignore */
    }
  }, 5000);
  sweeper.unref?.();

  // 订阅消息：每小时扫描一次 24h 内开始的活动，给已授权用户发提醒（未配置模板自动跳过）
  const remind = setInterval(async () => {
    try {
      const { remindUpcomingRegistrants } = await import('./services/subscribe.ts');
      const n = await remindUpcomingRegistrants();
      if (n > 0) console.log(`[remind] 发送 ${n} 条活动开始提醒`);
    } catch {
      /* ignore */
    }
  }, 3600_000);
  remind.unref?.();

  const app = buildApp();
  app
    .listen({ port: PORT, host: HOST })
    .then(async () => {
      console.log(`\n=== ClinkLab 付费报名 V0.1（env=${APP_ENV}，mockPay=${MOCK_PAY_ENABLED ? '开' : '关'}）===`);
      console.log(`  本地联调页面: http://127.0.0.1:${PORT}/`);
      console.log(`  API 基址:     ${API_BASE_URL}`);
      console.log(`  健康检查:     http://127.0.0.1:${PORT}/health`);
      if (MOCK_PAY_ENABLED) console.log(`  管理端账号:   ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}${APP_ENV === 'development' ? '（仅 development）' : '（演示环境，正式部署请改 ADMIN_PASSWORD）'}\n`);
    })
    .catch((e) => {
      console.error('启动失败:', e);
      process.exit(1);
    });

  const shutdown = () => {
    console.log('\n正在关闭…');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
