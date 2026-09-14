// 本地微信模拟器（development-only）—— 在无真实商户、无外网时，跑通真实微信支付的
// "登录 code2Session + 统一下单 + 回调验签/解密 + 退款"全链路。
// 它扮演"微信平台"：
//   - GET/POST /sns/jscode2session            → 返回固定 openid/session_key
//   - POST /v3/pay/transactions/jsapi          → 返回 prepay_id（模拟统一下单成功）
//   - POST /v3/refund/domestic/refunds         → 返回 refund_id（模拟退款受理）
//   - POST /__sim/make-notify                  → 用平台私钥签名 + AES-256-GCM 加密，产出合法微信回调（headers+body）
// 被测对象 = 报名服务端的 verifyNotify（验签+解密）与 jsapiPrepay/requestRefund（签名请求）。
//
// 凭据（由测试脚本生成并传入）：
//   PLATFORM_PRIVATE_KEY_PATH  平台私钥 PEM（模拟微信签名回调用）
//   API_V3_KEY                 32 字节 APIv3 密钥（模拟微信加密回调用；与服务端一致）
//   OUT_OPENID                jscode2session 返回的 openid
//   SIM_PORT                  监听端口（默认 3060）
import http from 'node:http';
import { createSign, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.SIM_PORT || 3060);
const API_V3_KEY = process.env.API_V3_KEY || '';
const OUT_OPENID = process.env.OUT_OPENID || 'sim_openid_user1';
const PLATFORM_KEY_PEM = process.env.PLATFORM_PRIVATE_KEY_PATH ? readFileSync(process.env.PLATFORM_PRIVATE_KEY_PATH, 'utf8') : '';
if (API_V3_KEY.length !== 32) console.error('[wechat-sim] 警告：API_V3_KEY 应为 32 字节');
if (!PLATFORM_KEY_PEM) console.error('[wechat-sim] 警告：缺少 PLATFORM_PRIVATE_KEY_PATH');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function hex(n) {
  return randomBytes(n).toString('hex');
}

/** 用平台私钥签名 + AES-256-GCM 加密，生成合法微信回调（供测试投递到服务端 /pay/notify）。 */
function makeNotify({ out_trade_no, trade_state = 'SUCCESS', transaction_id = 'sim_tx_' + hex(6) }) {
  const plain = JSON.stringify({
    appid: 'sim_appid', mchid: 'sim_mch', transaction_id, out_trade_no,
    trade_type: 'JSAPI', trade_state: trade_state,
    success_time: new Date().toISOString(), amount: { total: 9900, payer_total: 9900, currency: 'CNY' },
  });
  // AES-256-GCM 加密 resource
  const aesIv = randomBytes(12);
  const aesNonceB64 = aesIv.toString('base64');
  const aad = aesNonceB64;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), aesIv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const cipherData = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 字节
  const ciphertext = Buffer.concat([cipherData, tag]).toString('base64');
  // 外层 body
  const body = JSON.stringify({
    id: 'sim_notify_' + hex(8),
    create_time: new Date().toISOString(),
    resource_type: 'encrypt-resource',
    event_type: trade_state === 'SUCCESS' ? 'transaction.SUCCESS' : 'transaction.FAIL',
    summary: '支付回调',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce: aesNonceB64, associated_data: aad, type: 'encrypt-resource' },
  });
  // 平台私钥签名：message = timestamp\nsigNonce\nbody\n
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigNonce = hex(16);
  const message = `${timestamp}\n${sigNonce}\n${body}\n`;
  const signature = createSign('RSA-SHA256').update(message, 'utf8').sign(PLATFORM_KEY_PEM, 'base64');
  return {
    headers: {
      'Content-Type': 'application/json',
      'WechatPay-Timestamp': timestamp,
      'WechatPay-Nonce': sigNonce,
      'WechatPay-Signature': signature,
      'WechatPay-Serial': 'SIMPLATFORMSERIAL',
    },
    body,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  console.log(`[wechat-sim] ${req.method} ${p}`);
  try {
    if (p === '/health') return send(res, 200, { ok: true, sim: 'wechat-sim' });

    if (p === '/sns/jscode2session') {
      return send(res, 200, { openid: OUT_OPENID, session_key: 'sim_session_key', unionid: 'sim_unionid' });
    }

    if (p === '/v3/pay/transactions/jsapi' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const prepay_id = 'sim_prepay_' + hex(10);
      console.log(`[wechat-sim] jsapi out_trade_no=${parsed.out_trade_no} amount=${parsed.amount?.total} → prepay_id=${prepay_id}`);
      return send(res, 200, { prepay_id, appid: parsed.appid, mchid: parsed.mchid });
    }

    if (p === '/v3/refund/domestic/refunds' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const refund_id = 'sim_refund_' + hex(10);
      console.log(`[wechat-sim] refund out_trade_no=${parsed.out_trade_no} refund=${parsed.amount?.refund} → ${refund_id}`);
      return send(res, 200, { refund_id, status: 'PROCESSING', out_refund_no: parsed.out_refund_no, out_trade_no: parsed.out_trade_no });
    }

    if (p === '/__sim/make-notify' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (!parsed.out_trade_no) return send(res, 400, { error: '缺少 out_trade_no' });
      return send(res, 200, makeNotify(parsed));
    }

    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    console.error('[wechat-sim] 错误:', e);
    return send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=== 微信模拟器 v0.1（127.0.0.1:${PORT}）===`);
  console.log(`  jscode2session → openid=${OUT_OPENID}`);
});

process.on('SIGTERM', () => { try { server.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { server.close(); } catch {} process.exit(0); });
