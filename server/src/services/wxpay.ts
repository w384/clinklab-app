// 微信支付 v3 适配器（统一下单 / 回调验签解密 / 退款），纯 node:crypto 实现，无第三方依赖。
// 关键安全边界（硬性规则）：
//   - session_key / openid / 商户私钥 / APIv3 密钥 / 平台证书 只在服务端；客户端只拿 wx.requestPayment 参数（§32/§33/§36）。
//   - 金额由服务端计算；wx.requestPayment success ≠ 最终状态，最终以服务端 notify 落终态为准（§36）。
//   - 回调必须验签（平台证书 RSA-SHA256）+ 解密（APIv3 密钥 AES-256-GCM），再落业务，绝不信任明文（§36）。
import { createSign, createVerify, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from '../db.ts';
import { nowIso, HttpError, randNonce } from '../util.ts';
import {
  WX_APPID, WX_MCH_ID, WX_API_V3_KEY, WX_MCH_SERIAL_NO,
  WX_MCH_PRIVATE_KEY, WX_MCH_PRIVATE_KEY_PATH,
  WX_PLATFORM_CERT, WX_PLATFORM_CERT_PATH,
  WX_API_BASE, WX_PAY_BASE, WX_PAY_NOTIFY_URL,
} from '../config.ts';

type Row = Record<string, any>;

/* ─────────────────────────── 凭据懒加载（带缓存） ─────────────────────────── */
let _merchantKeyPem: string | null = null;
export function merchantPrivateKey(): string {
  if (_merchantKeyPem) return _merchantKeyPem;
  const pem = WX_MCH_PRIVATE_KEY || (WX_MCH_PRIVATE_KEY_PATH ? readFileSync(WX_MCH_PRIVATE_KEY_PATH, 'utf8') : '');
  if (!pem) throw new HttpError(500, '未配置商户私钥（WX_MCH_PRIVATE_KEY / WX_MCH_PRIVATE_KEY_PATH）');
  _merchantKeyPem = pem;
  return pem;
}
let _platformCertPem: string | null = null;
export function platformCert(): string {
  if (_platformCertPem) return _platformCertPem;
  const pem = WX_PLATFORM_CERT || (WX_PLATFORM_CERT_PATH ? readFileSync(WX_PLATFORM_CERT_PATH, 'utf8') : '');
  if (!pem) throw new HttpError(500, '未配置微信平台证书（WX_PLATFORM_CERT / WX_PLATFORM_CERT_PATH）');
  _platformCertPem = pem;
  return pem;
}

/* ─────────────────────────── 密码学原语 ─────────────────────────── */
/** RSA-SHA256 签名（商户私钥）。返回 base64。 */
export function signRsa(message: string, privateKeyPem: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}
/** RSA-SHA256 验签（平台证书）。失败/异常一律 false。 */
export function verifyRsa(message: string, signatureB64: string, certPem: string): boolean {
  try {
    return createVerify('RSA-SHA256').update(message, 'utf8').verify(certPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}
/**
 * AES-256-GCM 解密回调 resource（§36 回调解密）。
 * key = APIv3 密钥(32 字节)；iv = resource.nonce(base64)；aad = resource.associated_data；
 * ciphertext = base64(密文 ‖ 16 字节 GCM tag)。
 */
export function decryptAesGcm(ciphertextB64: string, nonceB64: string, aad: string, apiV3Key: string): string {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new HttpError(500, 'WX_API_V3_KEY 必须为 32 字节');
  const iv = Buffer.from(nonceB64, 'base64');
  const raw = Buffer.from(ciphertextB64, 'base64');
  const tag = raw.slice(-16);
  const data = raw.slice(0, -16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** 组装微信 v3 请求 Authorization 头：WECHATPAY2-SHA256-RSA2048 … */
function wechatAuthorization(method: string, urlPath: string, body: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = signRsa(message, merchantPrivateKey());
  return `WECHATPAY2-SHA256-RSA2048 mchid="${WX_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${WX_MCH_SERIAL_NO}",signature="${signature}"`;
}

/* ─────────────────────────── 统一下单（jsapi / 小程序） ─────────────────────────── */
export interface PrepayArgs {
  outTradeNo: string;
  amountCents: number;
  description: string;
  openid: string;
}
export interface WxPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

/**
 * 统一下单 → 得 prepay_id → 用商户私钥签出 wx.requestPayment 五参数（§36）。
 * 返回 { prepayId, wxPayParams }。wxPayParams 直接交给小程序 wx.requestPayment。
 */
export async function jsapiPrepay(args: PrepayArgs): Promise<{ prepayId: string; wxPayParams: WxPayParams }> {
  const urlPath = '/v3/pay/transactions/jsapi';
  const body = JSON.stringify({
    appid: WX_APPID,
    mchid: WX_MCH_ID,
    description: args.description,
    out_trade_no: args.outTradeNo,
    notify_url: WX_PAY_NOTIFY_URL,
    amount: { total: args.amountCents, currency: 'CNY' },
    payer: { openid: args.openid },
  });
  const res = await fetch(`${WX_PAY_BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: wechatAuthorization('POST', urlPath, body) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { prepay_id?: string; code?: string; message?: string };
  if (!res.ok || !data.prepay_id) throw new HttpError(502, `微信统一下单失败：${data.code || res.status} ${data.message || ''}`.trim());

  // 用 prepay_id 生成小程序支付参数（待签名串：appId\ntimeStamp\nnonceStr\npackage\n，商户私钥签）
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomBytes(16).toString('hex');
  const pkg = `prepay_id=${data.prepay_id}`;
  const paySign = signRsa(`${WX_APPID}\n${timeStamp}\n${nonceStr}\n${pkg}\n`, merchantPrivateKey());
  return { prepayId: data.prepay_id, wxPayParams: { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign } };
}

/* ─────────────────────────── 异步回调：验签 + 解密 ─────────────────────────── */
export interface NotifyInfo {
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
}
/**
 * 验签（平台证书）+ 解密（APIv3 密钥）回调。返回交易信息。
 * 任何验签/解密失败都抛错 —— 绝不信任未验证的回调（§36）。
 */
export function verifyNotify(headers: Record<string, any>, rawBody: string): NotifyInfo {
  const h: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  const timestamp = String(h['wechatpay-timestamp'] || '');
  const nonce = String(h['wechatpay-nonce'] || '');
  const signature = String(h['wechatpay-signature'] || '');
  if (!timestamp || !nonce || !signature || !rawBody) throw new HttpError(401, '回调缺少验签头（WechatPay-*）');
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  if (!verifyRsa(message, signature, platformCert())) throw new HttpError(401, '回调验签失败');

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, '回调 body 非 JSON');
  }
  const resource = parsed?.resource;
  if (!resource?.ciphertext || resource.type !== 'encrypt-resource' && resource.algorithm !== 'AEAD_AES_256_GCM') {
    // 兼容：仅当存在 ciphertext 才继续
    if (!resource?.ciphertext) throw new HttpError(400, '回调缺少 resource.ciphertext');
  }
  const plainText = decryptAesGcm(resource.ciphertext, resource.nonce || '', resource.associated_data || '', WX_API_V3_KEY);
  let plain: any;
  try {
    plain = JSON.parse(plainText);
  } catch {
    throw new HttpError(400, '回调 resource 解密后非 JSON');
  }
  if (!plain.out_trade_no) throw new HttpError(400, '回调缺少 out_trade_no');
  return { outTradeNo: plain.out_trade_no, transactionId: plain.transaction_id || '', tradeState: plain.trade_state || '' };
}

/* ─────────────────────────── 退款 ─────────────────────────── */
export interface RefundArgs {
  outTradeNo: string;
  outRefundNo: string;
  totalCents: number;
  refundCents: number;
  reason?: string;
}
export interface RefundResult {
  refundId: string;
  outRefundNo: string;
  status: string;
}
/**
 * 发起退款（§22）。V0.1 以退款接口的同步 2xx 视为"受理成功"，
 * 生产还应校验微信退款结果异步通知（refund/notify）后再最终落 REFUNDED（见 DEVELOPMENT.md §7）。
 */
export async function requestRefund(args: RefundArgs): Promise<RefundResult> {
  const urlPath = '/v3/refund/domestic/refunds';
  const body = JSON.stringify({
    out_trade_no: args.outTradeNo,
    out_refund_no: args.outRefundNo,
    amount: { refund: args.refundCents, total: args.totalCents, currency: 'CNY' },
    reason: args.reason ? String(args.reason).slice(0, 80) : undefined,
  });
  const res = await fetch(`${WX_PAY_BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: wechatAuthorization('POST', urlPath, body) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { refund_id?: string; status?: string; out_refund_no?: string; code?: string; message?: string };
  if (!res.ok) throw new HttpError(502, `微信退款失败：${data.code || res.status} ${data.message || ''}`.trim());
  return { refundId: data.refund_id || '', outRefundNo: data.out_refund_no || args.outRefundNo, status: data.status || 'PROCESSING' };
}

/* ─────────────────────────── 预支付单落库（out_trade_no 幂等） ─────────────────────────── */
/**
 * 统一下单成功后，落一条 PENDING 支付单（out_trade_no 唯一），供 notify 反查报名。
 * 幂等：同一报名已有支付单则直接返回（避免重复下单）。
 */
export function createPrepay(regId: number, prepayId: string): Row {
  const reg = db.prepare('SELECT id, registration_no, amount FROM registrations WHERE id=?').get(regId) as Row | null;
  if (!reg) throw new HttpError(404, '报名不存在');
  const outTradeNo = 'PAY' + String(reg.registration_no).slice(3);
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM payments WHERE registration_id=? ORDER BY id DESC LIMIT 1').get(regId) as Row | null;
  if (existing) return existing;
  // prepay 阶段暂存 prepay_id 于 wechat_transaction_id；notify 后覆盖为真实 transaction_id
  db.prepare(
    `INSERT INTO payments (registration_id, out_trade_no, wechat_transaction_id, amount, status, raw_notify_data, created_at, updated_at)
     VALUES (?,?,?,?, 'PENDING', ?, ?, ?)`
  ).run(regId, outTradeNo, prepayId, Number(reg.amount), JSON.stringify({ source: 'prepay', prepay_id: prepayId }), now, now);
  const lastId = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number } | undefined;
  return db.prepare('SELECT * FROM payments WHERE id=?').get(Number(lastId?.id ?? 0)) as Row;
}
