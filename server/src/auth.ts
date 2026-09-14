import { randomBytes, createHash } from 'node:crypto';
import { db } from './db.ts';
import { nowIso, HttpError, hashAdminPassword } from './util.ts';
import { APP_ENV, WX_USE_REAL, WX_APPID, WX_APPSECRET, WX_API_BASE, SESSION_TTL_SEC, ADMIN_SESSION_TTL_SEC } from './config.ts';

type Row = Record<string, any>;
type FastifyReq = { headers?: Record<string, any> };

/** 从 Authorization: Bearer <token> 解析 token。 */
export function bearerToken(req: FastifyReq): string | null {
  const h = req.headers?.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 签发一个系统登录态 token（opaque，随机）。客户端只持有此 token（§32）。 */
export function issueSession(userId: number): string {
  const token = `sess_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(token, userId, expiresAt, nowIso());
  return token;
}

/** 用 token 换出当前用户。无效/过期返回 null。 */
export function getSessionUser(token: string | null): Row | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.user_id, u.nickname, u.phone, u.avatar, u.openid, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, nowIso()) as Row;
  if (!row) return null;
  return { userId: row.user_id, nickname: row.nickname, phone: row.phone, avatar: row.avatar, openid: row.openid, isAdmin: Boolean(row.is_admin) };
}

export function destroySession(token: string | null): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}

/**
 * 开发环境模拟 code2Session：无真实 AppID/Secret 时，用 code 派生稳定 openid，
 * 使"wx.login → 服务端建用户 → 登录态"链路可在真机/开发者工具中跑通（§41 第一条验证链）。
 */
function mockCode2Session(code: string): { openid: string; sessionKey: string } {
  const openid = 'mock_' + createHash('sha256').update(code || 'anon').digest('base64url').slice(0, 24);
  const sessionKey = randomBytes(16).toString('base64url');
  return { openid, sessionKey };
}

/** 生产路径：调用微信 code2Session（Node 18+ 全局 fetch）。 */
async function realCode2Session(code: string): Promise<{ openid: string; sessionKey: string }> {
  const url =
    `${WX_API_BASE}/sns/jscode2session` +
    `?appid=${encodeURIComponent(WX_APPID)}&secret=${encodeURIComponent(WX_APPSECRET)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = (await res.json()) as { errcode?: number; openid?: string; session_key?: string; unionid?: string; errmsg?: string };
  if (data.errcode || !data.openid) throw new HttpError(401, `微信登录失败：${data.errcode || 'no_openid'} ${data.errmsg || ''}`);
  return { openid: data.openid, sessionKey: data.session_key || '' };
}

/**
 * 微信登录（§32/§33）：
 *   wx.login() 的 code 交服务端 → code2Session 得 openid/session_key → 建立系统登录态。
 * 客户端只拿到系统 token；openid 是服务端内部身份（客户端不得自行声明），session_key 绝不出服务端。
 */
export async function wxLogin(code: string): Promise<{ token: string; user: Row }> {
  if (!code || typeof code !== 'string') throw new HttpError(400, '缺少微信登录 code');
  const { openid, sessionKey } = WX_USE_REAL ? await realCode2Session(code) : mockCode2Session(code);
  const now = nowIso();

  let user = db.prepare('SELECT * FROM users WHERE openid=?').get(openid) as Row;
  let isNew = false;
  if (!user) {
    isNew = true;
    const nickname = APP_ENV === 'development' ? `微信用户_${openid.slice(-6)}` : '微信用户';
    const r = db.prepare('INSERT INTO users (openid, nickname, phone, created_at, updated_at) VALUES (?,?,?,?,?)').run(openid, nickname, null, now, now);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(r.lastInsertRowid)) as Row;
  }
  // session_key 只落服务端（生产应加密存储），绝不返回客户端（§33）
  if (sessionKey) db.prepare('UPDATE users SET session_key=?, updated_at=? WHERE id=?').run(sessionKey, nowIso(), user.id);

  const token = issueSession(user.id);
  return {
    token,
    user: { userId: user.id, nickname: user.nickname, phone: user.phone, avatar: user.avatar, isNew, isAdmin: Boolean((user as Row).is_admin) },
  };
}

/**
 * 完善/更新当前用户资料（§ 首次登录补全昵称/手机/头像）。
 * 仅接受白名单字段；avatar 为 base64 data URL（chooseAvatar 得到），限制 1MB 防止塞爆库。
 */
export function updateProfile(userId: number, patch: { nickname?: unknown; phone?: unknown; avatar?: unknown }): Row {
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  if (patch.nickname !== undefined) {
    const nickname = String(patch.nickname || '').trim();
    if (nickname.length > 64) throw new HttpError(400, '昵称过长');
    sets.push('nickname=?'); args.push(nickname);
  }
  if (patch.phone !== undefined) {
    const phone = String(patch.phone || '').trim();
    if (phone && !/^\d{7,15}$/.test(phone)) throw new HttpError(400, '手机号格式不正确');
    sets.push('phone=?'); args.push(phone || null);
  }
  if (patch.avatar !== undefined) {
    const avatar = String(patch.avatar || '').trim();
    if (avatar && avatar.length > 1_200_000) throw new HttpError(400, '头像过大（>1MB）');
    sets.push('avatar=?'); args.push(avatar || null);
  }
  if (!sets.length) throw new HttpError(400, '没有可更新的字段');
  sets.push('updated_at=?'); args.push(nowIso());
  args.push(userId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args);

  // 同步该用户"已有报名"的姓名/手机快照：用户在后台名单里看到的是报名时的快照，
  // 若只改 users 不改 registrations，名单会一直显示旧昵称（§ ⑦ 昵称/手机同步）。
  const sync: string[] = [];
  const syncArgs: Array<string | number> = [];
  if (patch.nickname !== undefined) {
    const v = String(patch.nickname || '').trim();
    if (v) { sync.push('name=?'); syncArgs.push(v); }
  }
  if (patch.phone !== undefined) {
    const v = String(patch.phone || '').trim();
    if (v) { sync.push('phone=?'); syncArgs.push(v); }
  }
  if (sync.length) {
    syncArgs.push(userId);
    db.prepare(`UPDATE registrations SET ${sync.join(', ')} WHERE user_id=?`).run(...syncArgs);
  }

  return { userId, nickname: (db.prepare('SELECT nickname FROM users WHERE id=?').get(userId) as { nickname: string | null })?.nickname ?? null, phone: (db.prepare('SELECT phone FROM users WHERE id=?').get(userId) as { phone: string | null })?.phone ?? null, avatar: (db.prepare('SELECT avatar FROM users WHERE id=?').get(userId) as { avatar: string | null })?.avatar ?? null };
}

// ───────── 微信手机号一键获取（getPhoneNumber → code → 服务端解密） ─────────
// access_token 缓存（WeChat 2h 有效；提前 60s 过期刷新）
let tokenCache: { token: string; expiresAt: number } | null = null;
export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const url = `${WX_API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(WX_APPID)}&secret=${encodeURIComponent(WX_APPSECRET)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!data.access_token) throw new HttpError(400, `获取 access_token 失败：${data.errcode || 'unknown'} ${data.errmsg || ''}`);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000 };
  return data.access_token;
}

/**
 * 解密 getPhoneNumber 返回的 code → 手机号，并落到当前用户（§ 微信一键获取）。
 * 仅在配置了 AppID+AppSecret 时可用（真实微信能力）；开发模式未配置则引导手动输入。
 */
export async function wxPhoneDecrypt(userId: number, code: string): Promise<{ userId: number; phone: string }> {
  if (!code || typeof code !== 'string') throw new HttpError(400, '缺少手机号 code');
  if (!WX_APPID || !WX_APPSECRET) throw new HttpError(400, '当前未配置微信 AppID/AppSecret，请手动输入手机号');
  const token = await getAccessToken();
  const res = await fetch(`${WX_API_BASE}/wxa/phonenumber/get?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json()) as { errcode?: number; errmsg?: string; phone_info?: { phoneNumber?: string; purePhoneNumber?: string } };
  if (data.errcode) throw new HttpError(400, `微信手机号解析失败：${data.errcode} ${data.errmsg || ''}`);
  const phone = String(data.phone_info?.purePhoneNumber || data.phone_info?.phoneNumber || '').trim();
  if (!/^\d{7,15}$/.test(phone)) throw new HttpError(400, '未获取到有效手机号，请手动输入');
  db.prepare('UPDATE users SET phone=?, updated_at=? WHERE id=?').run(phone, nowIso(), userId);
  return { userId, phone };
}

/** 受保护路由守卫：解析登录态，未登录抛 401。返回当前用户（含 token）。 */
export function requireAuth(req: FastifyReq): Row {
  const token = bearerToken(req);
  const user = getSessionUser(token);
  if (!user) throw new HttpError(401, '未登录或登录态已失效');
  (user as Row).token = token as string;
  return user;
}

/* ---------------- 管理端登录态（§24 admin_users） ---------------- */

export function issueAdminSession(adminId: number): string {
  const token = `admin_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SEC * 1000).toISOString();
  db.prepare('INSERT INTO admin_sessions (token, admin_id, expires_at, created_at) VALUES (?,?,?,?)').run(token, adminId, expiresAt, nowIso());
  return token;
}

export function getAdminSession(token: string | null): Row | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT a.id AS admin_id, a.username
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, nowIso()) as Row;
  if (!row) return null;
  return { adminId: row.admin_id, username: row.username };
}

export function destroyAdminSession(token: string | null): void {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token=?').run(token);
}

/** 管理端路由守卫：解析管理登录态，未登录抛 401。 */
export function requireAdmin(req: FastifyReq): Row {
  const token = bearerToken(req);
  const admin = getAdminSession(token);
  if (!admin) throw new HttpError(401, '未登录管理端或登录态已失效');
  (admin as Row).token = token as string;
  return admin;
}

/** 管理端登录（§24 admin_users）。校验口令哈希，签发管理会话。 */
export function adminLogin(username: string, password: string): Row {
  const u = db.prepare('SELECT * FROM admin_users WHERE username=?').get(username) as Row;
  if (!u) throw new HttpError(401, '账号或密码错误');
  if (u.password_hash !== hashAdminPassword(username, password)) throw new HttpError(401, '账号或密码错误');
  const token = issueAdminSession(u.id);
  return { token, admin: { adminId: u.id, username: u.username } };
}
