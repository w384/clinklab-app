import { randomBytes, createHash } from 'node:crypto';

/** 当前时间的 ISO-8601（UTC）字符串。SQLite 用 TEXT 存时间，ISO 串可按字典序=时间序比较，也可被 Date 解析。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 一个带状态码的 HTTP 错误。路由层统一捕获并转成 { error } JSON。 */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** 服务端生成对外报名编号：时间戳 + 随机段。绝不把数据库自增 ID 直接对外。 */
export function genRegistrationNo(): string {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  return `REG${ts}${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** 报名凭证二维码 token：随机、不可预测（§12）。二维码只用于快速定位，资格由服务端判定。 */
export function genQrToken(bytes = 24): string {
  return `c1k_${randomBytes(bytes).toString('base64url')}`;
}

/** 脱敏手机号：13812345678 → 138****5678。现场查询不返回完整手机号（§17/§20）。 */
export function maskPhone(phone: string): string {
  const p = String(phone || '').trim();
  if (p.length >= 7) return `${p.slice(0, 3)}****${p.slice(-4)}`;
  return '****';
}

/** 随机 nonce（幂等 / 会话 token 等）。 */
export function randNonce(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

/** 管理端口令哈希（V0.1 简单实现；生产建议 bcrypt/argon2 并走真实 admin_users）。 */
export function hashAdminPassword(username: string, password: string): string {
  return createHash('sha256').update(`${username}:${password}:clinklab-admin-v1`).digest('hex');
}

/** 把可能为 null/undefined 的时间值安全格式化。 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 分（cents）转人民币展示串。 */
export function fmtCents(cents: number): string {
  const yuan = Math.floor(cents / 100);
  const fen = cents % 100;
  return fen === 0 ? `¥${yuan}` : `¥${yuan}.${String(fen).padStart(2, '0')}`;
}

/** 「截止日」过滤：把 YYYY-MM-DD 变成次日 00:00:00Z，SQL 用 created_at < 该值（含当天整天）。 */
export function nextDayIso(dateStr: string): string {
  const s = String(dateStr).slice(0, 10);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return `${s}T00:00:00.000Z`;
  return new Date(d.getTime() + 86_400_000).toISOString();
}
