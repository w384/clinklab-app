// 接真实微信 —— 全链路端到端（development-only，无真实商户、无外网）。
// 起两个进程：微信模拟器（扮演微信平台）+ 被测服务端（真实模式，指向模拟器）。
// 验证：登录 code2Session / 统一下单 / 回调验签+AES 解密 → PAID+qr_token / 退款 / 非法回调被拒。
// 这是"接真实微信"在沙箱内可证明的最大范围；接真实商户只需替换凭据 + 公网回调地址。
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realpay-'));
const SIM_PORT = 3060;
const SRV_PORT = 3051;
const SIM = `http://127.0.0.1:${SIM_PORT}`;
const SRV = `http://127.0.0.1:${SRV_PORT}`;
const dbFile = path.join(tmp, 'realpay.sqlite');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('  \u2713', n)) : (fail++, console.log('  \u2717', n, extra)); };

// 1) 生成一套测试凭据：平台(微信)密钥对 + 商户密钥对 + APIv3 密钥
const platform = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const apiV3Key = randomBytes(32).toString('hex').slice(0, 32); // 32 ASCII 字节
fs.writeFileSync(path.join(tmp, 'platform_pub.pem'), platform.publicKey);
fs.writeFileSync(path.join(tmp, 'platform_key.pem'), platform.privateKey);
fs.writeFileSync(path.join(tmp, 'merchant_key.pem'), merchant.privateKey);

// 2) 起微信模拟器（stdio:'inherit' —— 沙箱禁止 pipe stdio 的子进程 spawn，inherit 可）
const sim = spawn(process.execPath, ['scripts/wechat-sim.mjs'], {
  cwd: serverRoot,
  env: { ...process.env, SIM_PORT: String(SIM_PORT), API_V3_KEY: apiV3Key, OUT_OPENID: 'sim_openid_user1', PLATFORM_PRIVATE_KEY_PATH: path.join(tmp, 'platform_key.pem') },
  stdio: 'inherit',
});

// 3) 起被测服务端（真实模式，指向模拟器）
const srv = spawn(process.execPath, ['--experimental-strip-types', 'src/app.ts'], {
  cwd: serverRoot,
  env: {
    ...process.env,
    APP_ENV: 'development', DB_PATH: dbFile, PORT: String(SRV_PORT), HOST: '127.0.0.1',
    WX_USE_REAL: 'true', WX_APPID: 'sim_appid', WX_APPSECRET: 'sim_secret',
    WX_API_BASE: SIM, WX_PAY_BASE: SIM, WX_MCH_ID: 'sim_mch', WX_MCH_SERIAL_NO: 'SIMMCHSERIAL',
    WX_API_V3_KEY: apiV3Key, WX_MCH_PRIVATE_KEY_PATH: path.join(tmp, 'merchant_key.pem'), WX_PLATFORM_CERT_PATH: path.join(tmp, 'platform_pub.pem'),
    WX_PAY_NOTIFY_URL: `${SRV}/pay/notify`,
  },
  stdio: 'inherit',
});

async function waitFor(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待服务就绪超时: ' + url);
}

const J = async (method, url, { token, headers, body } = {}) => {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(SRV + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};

let regId = 0;
try {
  await waitFor(`${SIM}/health`);
  await waitFor(`${SRV}/health`);
  console.log('\n=== 接真实微信 · 全链路（沙箱内对本地微信模拟器）===');
  const DAY = 86_400_000, H = 3_600_000, now = Date.now();

  // ── 管理端 + 活动 + 报名类型 ──
  const adm = (await J('POST', '/admin/auth/login', { body: { username: 'admin', password: 'admin123' } })).body;
  ok('管理端登录', Boolean(adm?.token), JSON.stringify(adm));
  const ev = (await J('POST', '/admin/events', {
    headers: { Authorization: `Bearer ${adm.token}` },
    body: { title: '真实支付活动', locationName: '上海', startTime: new Date(now + 10 * DAY).toISOString(), endTime: new Date(now + 10 * DAY + 4 * H).toISOString(), registrationStartTime: new Date(now - 1 * H).toISOString(), registrationEndTime: new Date(now + 9 * DAY).toISOString(), capacity: null, refundRule: 'ALLOW_ANY', status: 'PUBLISHED' },
  })).body;
  ok('创建活动', ev?.id > 0, JSON.stringify(ev));
  const opt = (await J('POST', `/admin/events/${ev.id}/options`, { headers: { Authorization: `Bearer ${adm.token}` }, body: { name: '标准票', price: 9900 } })).body;
  ok('添加报名类型', opt?.id > 0, JSON.stringify(opt));

  // ── 真实登录（code2Session → 模拟器） ──
  const u = (await J('POST', '/auth/wechat-login', { body: { code: 'real_flow_user_' + Date.now() } })).body;
  ok('真实微信登录（code2Session→openid）', Boolean(u?.token), JSON.stringify(u));

  // ── 创建报名 ──
  const reg = (await J('POST', `/events/${ev.id}/registrations`, { token: u.token, body: { registrationOptionId: opt.id, name: '真实支付', phone: '137' + String(Date.now()).slice(-7) } })).body;
  ok('创建报名（PENDING）', reg?.status === 'PENDING', JSON.stringify(reg));
  regId = reg.id;

  // ── 统一下单（真实 → 模拟器 jsapi） ──
  const prepay = (await J('POST', `/registrations/${reg.id}/pay/prepay`, { token: u.token })).body;
  ok('统一下单成功（返回 wx.requestPayment 参数）', Boolean(prepay?.payment?.paySign) && Boolean(prepay?.out_trade_no), JSON.stringify(prepay));
  const outTradeNo = prepay.out_trade_no;

  // ── 模拟微信回调（平台私钥签名 + AES-256-GCM 加密）→ 投递服务端 ──
  const mk = await fetch(`${SIM}/__sim/make-notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ out_trade_no: outTradeNo, trade_state: 'SUCCESS', transaction_id: 'sim_tx_realflow' }) }).then((r) => r.json());
  const notifyRes = await fetch(`${SRV}/pay/notify`, { method: 'POST', headers: mk.headers, body: mk.body });
  const notifyJson = await notifyRes.json().catch(() => null);
  ok('服务端验签+解密成功（回调被接受）', notifyRes.status === 200 && notifyJson?.code === 'SUCCESS', `status=${notifyRes.status} ${JSON.stringify(notifyJson)}`);

  // ── 终态：PAID + qr_token ──
  const detail = (await J('GET', `/registrations/${reg.id}`, { token: u.token })).body;
  ok('报名终态 PAID', detail?.status === 'PAID', JSON.stringify(detail?.status));
  ok('生成 qr_token（c1k_ 前缀）', String(detail?.qr_token || '').startsWith('c1k_'));

  // ── 幂等：重复回调 ──
  const notify2 = await fetch(`${SRV}/pay/notify`, { method: 'POST', headers: mk.headers, body: mk.body });
  ok('重复回调幂等（仍 200）', notify2.status === 200, `status=${notify2.status}`);

  // ── 非法签名回调被拒 ──
  const badNotify = await fetch(`${SRV}/pay/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'WechatPay-Timestamp': '1', 'WechatPay-Nonce': 'x', 'WechatPay-Signature': 'INVALIDSIG', 'WechatPay-Serial': 'X' },
    body: JSON.stringify({ id: 'x', resource: {} }),
  });
  ok('非法签名回调被拒绝（401）', badNotify.status === 401, `status=${badNotify.status}`);

  // ── 退款（真实 → 模拟器 refund API） ──
  const rf = (await J('POST', `/registrations/${reg.id}/refund`, { token: u.token, body: { reason: '真实退款' } })).body;
  ok('退款 REFUNDED', rf?.status === 'REFUNDED', JSON.stringify(rf?.status));

  // ── 落库校验：真实 transaction_id 已写入支付单（而非 mock） ──
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const pay = db.prepare(`SELECT wechat_transaction_id, status FROM payments WHERE registration_id=?`).get(regId);
  ok('支付单记录真实 transaction_id', pay?.wechat_transaction_id === 'sim_tx_realflow', JSON.stringify(pay));
  const ref = db.prepare(`SELECT status, out_refund_no FROM refunds WHERE registration_id=?`).get(regId);
  ok('退款单落库（SUCCESS）', ref?.status === 'SUCCESS', JSON.stringify(ref));
  db.close();

  console.log(`\nREAL-PAY FLOW: 通过 ${pass} 失败 ${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  fail++;
  console.error('\n[real-pay-flow] 异常:', e?.stack || e);
  process.exitCode = 1;
} finally {
  try { srv.kill('SIGTERM'); } catch { /* */ }
  try { sim.kill('SIGTERM'); } catch { /* */ }
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }, 300);
}
