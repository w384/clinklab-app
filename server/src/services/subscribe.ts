// 订阅消息（B⑤）：用户授权记录 + 模板消息发送 + 活动开始前 24h 提醒扫描。
// 微信订阅消息为"一次性授权"：用户每次 requestSubscribeMessage 授权成功 = 1 次发送额度。
// 未配置模板 ID / 未配置真实 AppID 时一律安全跳过（开发期不发、不报错）。
import { db } from '../db.ts';
import { nowIso, HttpError } from '../util.ts';
import { WX_TEMPLATE_IDS, WX_USE_REAL, WX_API_BASE, APP_ENV } from '../config.ts';
import { getAccessToken } from '../auth.ts';

type Row = Record<string, any>;

/** 记录一次用户订阅授权（幂等；同用户同模板只记一条，openid 用最新）。 */
export function recordSubscribe(userId: number, openid: string, templateId: string): { ok: boolean; templateId: string } {
  if (!templateId) return { ok: false, templateId: '' };
  const now = nowIso();
  db.prepare(
    `INSERT INTO subscribe_records (user_id, openid, template_id, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, template_id) DO UPDATE SET openid=excluded.openid, updated_at=excluded.updated_at`
  ).run(userId, openid, templateId, now, now);
  return { ok: true, templateId };
}

/**
 * 发送一条订阅消息。
 * @param templateKey 配置键（如 pay_success / event_remind），对应 WX_TEMPLATE_IDS
 * @param data 模板字段（thing1/time1/… 等，须与公众平台模板关键字对齐）
 * @returns skipped=true 表示未配置/环境不允许（不算失败）
 */
export async function sendSubscribe(
  userId: number,
  templateKey: string,
  data: Record<string, { value: string }>,
  page?: string
): Promise<{ skipped: boolean; sent?: boolean; reason?: string }> {
  const templateId = WX_TEMPLATE_IDS[templateKey];
  if (!templateId) return { skipped: true, reason: '未配置模板 ID' };
  if (!WX_USE_REAL) return { skipped: true, reason: 'mock 登录环境（未配置真实 AppID/Secret）' };
  const u = db.prepare('SELECT openid FROM users WHERE id=?').get(userId) as { openid: string } | undefined;
  if (!u || !u.openid || !String(u.openid).startsWith('wx')) return { skipped: true, reason: '无真实 openid' };
  const token = await getAccessToken();
  const res = await fetch(
    `${WX_API_BASE}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: String(u.openid),
        template_id: templateId,
        page: page || '',
        data,
        miniprogram_state: APP_ENV === 'production' ? 'formal' : 'trial',
      }),
      signal: AbortSignal.timeout(8000),
    }
  );
  const d = (await res.json()) as { errcode?: number; errmsg?: string };
  if (d.errcode) return { skipped: false, sent: false, reason: `${d.errcode} ${d.errmsg || ''}` };
  return { skipped: false, sent: true };
}

/** 是否已给某报名发送过某模板（去重，防止定时任务重复提醒）。 */
function alreadySent(registrationId: number, templateKey: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM subscribe_sent WHERE registration_id=? AND template_key=?').get(registrationId, templateKey));
}

/**
 * 报名支付成功 → 发送「报名成功」订阅消息（fire-and-forget，调用方负责捕获异常）。
 * 字段名与公众平台模板关键字对应（thing1=活动、time1=时间、thing2=提示），如模板不同需按实际调整。
 */
export async function notifyPaySuccess(reg: Row): Promise<{ skipped: boolean; sent?: boolean; reason?: string }> {
  const templateKey = 'pay_success';
  if (!WX_TEMPLATE_IDS[templateKey]) return { skipped: true, reason: '未配置模板 ID' };
  const ev = db.prepare('SELECT title, start_time FROM events WHERE id=?').get(reg.event_id) as Row | undefined;
  if (!ev) return { skipped: true, reason: '活动不存在' };
  const start = new Date(String(ev.start_time));
  const startText = start.toISOString().slice(0, 16).replace('T', ' ');
  const res = await sendSubscribe(
    Number(reg.user_id),
    templateKey,
    {
      thing1: { value: String(ev.title).slice(0, 20) || '活动报名' },
      time1: { value: startText },
      thing2: { value: '报名成功，请准时到场，凭证在「我的报名」查看' },
    },
    `pages/credential/credential?id=${reg.id}`
  );
  return res;
}

/**
 * 活动开始前 24h 提醒扫描（定时任务）：找出 24h 内开始的活动下、已支付、
 * 且授权过 event_remind 模板的用户报名，逐个发送（去重：同报名同模板只发一次）。
 * 未配置模板 / mock 环境时安全跳过并返回 0。
 */
export async function remindUpcomingRegistrants(): Promise<number> {
  const templateKey = 'event_remind';
  const templateId = WX_TEMPLATE_IDS[templateKey];
  if (!templateId || !WX_USE_REAL) return 0;
  const now = nowIso();
  const windowEnd = new Date(Date.now() + 24 * 3600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT r.id AS reg_id, r.user_id, e.title, e.start_time, e.location_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       JOIN subscribe_records s ON s.user_id = r.user_id AND s.template_id = ?
       WHERE r.status='PAID' AND e.start_time > ? AND e.start_time <= ?
       ORDER BY e.start_time ASC`
    )
    .all(templateId, now, windowEnd) as Row[];
  let sent = 0;
  for (const row of rows) {
    if (alreadySent(Number(row.reg_id), templateKey)) continue;
    const start = new Date(String(row.start_time));
    const startText = start.toISOString().slice(0, 16).replace('T', ' ');
    try {
      const res = await sendSubscribe(
        Number(row.user_id),
        templateKey,
        {
          thing1: { value: String(row.title).slice(0, 20) || '活动即将开始' },
          time1: { value: startText },
          thing2: { value: String(row.location_name || '现场见').slice(0, 20) },
        },
        `pages/detail/detail?id=${row.event_id}`
      );
      if (res.sent) {
        db.prepare('INSERT INTO subscribe_sent (registration_id, template_key, created_at) VALUES (?,?,?)').run(Number(row.reg_id), templateKey, nowIso());
        sent += 1;
      }
    } catch {
      /* 单条失败不影响其他 */
    }
  }
  return sent;
}

/** 校验：模板 ID 必须存在（供 /me/subscribe 使用）。 */
export function assertTemplateId(templateId: string): string {
  const id = String(templateId || '').trim();
  if (!id) throw new HttpError(400, '缺少 templateId');
  return id;
}
