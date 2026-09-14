import { db } from '../db.ts';
import { HttpError, fmtTime, maskPhone } from '../util.ts';

type Row = Record<string, any>;

/** 报名名单：按活动 / 姓名 / 手机号 / 报名编号 / 票种 / 支付状态 / 核销进度 / 支付时间 筛选（§23）。 */
export function listRegistrations(filter: {
  eventId?: number;
  name?: string;
  phone?: string;
  registrationNo?: string;
  optionType?: string; // 票种：SINGLE/DOUBLE/INVITE/WAITLIST
  paymentStatus?: string;
  checkinStatus?: string;
  minAttend?: number; // 参加次数 ≥ N（回头客筛选，§ ②）
  paidFrom?: string; // 支付时间 ≥ 该日期（ISO 前缀，字典序 = 时间序）
  page?: number;
  pageSize?: number;
}): Row {
  const where: string[] = [];
  const vals: any[] = [];
  const add = (sql: string, v?: any) => {
    where.push(sql);
    if (v !== undefined) vals.push(v); // NULL / NOT NULL 过滤不绑定参数
  };
  if (filter.eventId) add('r.event_id = ?', filter.eventId);
  if (filter.name) add('r.name LIKE ?', `%${filter.name}%`);
  if (filter.phone) add('r.phone LIKE ?', `%${filter.phone}`);
  if (filter.registrationNo) add('r.registration_no LIKE ?', `%${filter.registrationNo}%`);
  if (filter.optionType) add('o.option_type = ?', filter.optionType);
  if (filter.paymentStatus) add('r.status = ?', filter.paymentStatus);
  if (filter.checkinStatus === 'CHECKED_IN') add('r.checked_in_at IS NOT NULL');
  else if (filter.checkinStatus === 'NOT_CHECKED_IN') add('r.checked_in_at IS NULL');
  // 参加次数 ≥ N（回头客）：该用户「已签到(核验)」的不同活动数 ≥ N（§ ②）
  if (filter.minAttend) {
    where.push('(SELECT COUNT(DISTINCT r2.event_id) FROM registrations r2 WHERE r2.user_id = r.user_id AND r2.checked_in_at IS NOT NULL) >= ?');
    vals.push(Number(filter.minAttend));
  }
  if (filter.paidFrom) add('r.paid_at >= ?', `${String(filter.paidFrom).slice(0, 10)}T00:00:00.000Z`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM registrations r
         LEFT JOIN registration_options o ON o.id = r.registration_option_id
         ${whereSql}`
      )
      .get(...vals) as { n: number })?.n ?? 0
  );
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filter.pageSize) || 15)); // 后台每页默认 15 条
  const offset = (page - 1) * pageSize;
  const attendMap = attendanceByUser();

  const rows = (
    db
      .prepare(
        `SELECT r.*, e.title AS event_title, o.name AS option_name, o.option_type
         FROM registrations r
         LEFT JOIN events e ON e.id = r.event_id
         LEFT JOIN registration_options o ON o.id = r.registration_option_id
         ${whereSql}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...vals, pageSize, offset) as Row[]
  ).map((r) => ({
    ...r,
    checked_in: Boolean(r.checked_in_at),
    checked_in_2: Boolean(r.checked_in_at_2),
    checked_count: (r.checked_in_at ? 1 : 0) + (r.checked_in_at_2 ? 1 : 0),
    seats: r.option_type === 'DOUBLE' ? 2 : 1,
    option_type: r.option_type || 'SINGLE',
    all_checked_in: ((r.checked_in_at ? 1 : 0) + (r.checked_in_at_2 ? 1 : 0)) === (r.option_type === 'DOUBLE' ? 2 : 1),
    attend_event_count: attendMap.get(r.user_id) ?? 0,
    paid_at_display: fmtTime(r.paid_at),
    checked_in_at_display: fmtTime(r.checked_in_at),
  }));
  return { total, page, pageSize, items: rows };
}

/** 签到记录（§23）：报名编号 / 姓名 / 活动 / 签到时间 / 操作人员 / 签到方式。 */
export function listCheckins(filter: { eventId?: number; page?: number; pageSize?: number }): Row {
  const where: string[] = [];
  const vals: any[] = [];
  if (filter.eventId) {
    where.push('c.event_id = ?');
    vals.push(filter.eventId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM checkins c ${whereSql}`).get(...vals) as { n: number })?.n ?? 0
  );
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filter.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const rows = (
    db
      .prepare(
        `SELECT c.*, r.name, r.registration_no, r.phone, e.title AS event_title
         FROM checkins c
         JOIN registrations r ON r.id = c.registration_id
         JOIN events e ON e.id = c.event_id
         ${whereSql}
         ORDER BY c.checked_in_at DESC, c.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...vals, pageSize, offset) as Row[]
  ).map((r) => ({ ...r, checked_in_at_display: fmtTime(r.checked_in_at) }));
  return { total, page, pageSize, items: rows };
}

/** 活动报名统计（§23 后台）。 */
export function stats(eventId?: number): Row {
  const vals = eventId ? [eventId] : [];
  const cond = (extra: string) => (eventId ? `event_id=? AND ${extra}` : extra);
  const count = (extra: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE ${cond(extra)}`).get(...vals) as { n: number })?.n ?? 0);
  const sumAmount = (extra: string) => Number((db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM registrations WHERE ${cond(extra)}`).get(...vals) as { s: number })?.s ?? 0);
  return {
    total: count('1=1'),
    pending: count("status='PENDING'"),
    paid: count("status='PAID'"),
    refunded: count("status='REFUNDED'"),
    cancelled: count("status='CANCELLED'"),
    checked_in: count('checked_in_at IS NOT NULL'),
    revenue_cents: sumAmount("status='PAID'"),
    waitlist: Number(
      (db.prepare(
        `SELECT COUNT(*) AS n FROM registrations r
         LEFT JOIN registration_options o ON o.id=r.registration_option_id
         WHERE ${eventId ? 'r.event_id=? AND ' : ''}o.option_type='WAITLIST'`
      ).get(...(eventId ? [eventId] : [])) as { n: number })?.n ?? 0
    ),
  };
}

/** 导出报名名单 CSV（§23）。带 BOM 便于 Excel 正确识别中文。 */
export function exportRegistrationsCsv(eventId?: number): { filename: string; csv: string } {
  const where = eventId ? 'WHERE r.event_id=?' : '';
  const vals = eventId ? [eventId] : [];
  const rows = (
    db
      .prepare(
        `SELECT r.registration_no, r.name, r.phone, r.form_data, e.title AS event_title, o.name AS option_name,
                r.amount, r.paid_at, r.status, r.checked_in_at, r.checked_in_at_2, o.option_type, c.method AS checkin_method,
                (SELECT COUNT(DISTINCT r2.event_id) FROM registrations r2
                 WHERE r2.user_id = r.user_id AND r2.checked_in_at IS NOT NULL) AS attend_event_count
         FROM registrations r
         LEFT JOIN events e ON e.id = r.event_id
         LEFT JOIN registration_options o ON o.id = r.registration_option_id
         LEFT JOIN (SELECT registration_id, MAX(checked_in_at) AS at, method FROM checkins GROUP BY registration_id) c
           ON c.registration_id = r.id
         ${where}
         ORDER BY r.created_at DESC`
      )
      .all(...vals) as Row[]
  );
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['姓名', '参加次数', '手机号', '活动', '报名类型', '票种', '核销进度', '支付金额(元)', '支付时间', '报名状态', '签到状态', '签到时间', '签到方式', '备注', '自定义字段'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    const amountYuan = (Number(r.amount) / 100).toFixed(2);
    let remark = '';
    let customStr = '';
    try {
      const fd = JSON.parse(r.form_data || '{}');
      if (fd && typeof fd === 'object') {
        remark = fd.remark ? String(fd.remark) : '';
        if (fd.custom && typeof fd.custom === 'object') {
          customStr = Object.keys(fd.custom)
            .filter((k) => fd.custom[k])
            .map((k) => `${k}:${String(fd.custom[k])}`)
            .join('；');
        }
      }
    } catch { /* 容错坏数据 */ }
    lines.push(
      [
        esc(r.name),
        esc(r.attend_event_count ?? 0),
        esc(r.phone),
        esc(r.event_title),
        esc(r.option_name),
        esc((({ SINGLE: '单人票', DOUBLE: '双人票', INVITE: '邀请票', WAITLIST: '候补票' } as Record<string, string>)[r.option_type] || '单人票')),
        esc(r.option_type === 'DOUBLE' ? `${(r.checked_in_at ? 1 : 0) + (r.checked_in_at_2 ? 1 : 0)}/2 码` : '—'),
        esc(amountYuan),
        esc(fmtTime(r.paid_at)),
        esc(r.status),
        esc(r.checked_in_at ? '已签到' : '未签到'),
        esc(fmtTime(r.checked_in_at)),
        esc(r.checkin_method),
        esc(remark),
        esc(customStr),
      ].join(',')
    );
  }
  const csv = '\ufeff' + lines.join('\r\n');
  const filename = `registrations_${eventId ? `event${eventId}` : 'all'}_${new Date().toISOString().slice(0, 10)}.csv`;
  return { filename, csv };
}

/**
 * 每用户「已报名且已签到(核验)」的不同活动数（参加次数）映射。
 * 判定：`checked_in_at IS NOT NULL` 即代表该报名已报名且已核验（签到仅对已支付生效）。
 * 用 `COUNT(DISTINCT event_id)` 计「参加过的活动次数」，同一活动重复签到/多票只算一次。
 * 供后台据此设置折扣票（§ 需求：按参加次数打折）。
 */
export function attendanceByUser(): Map<number, number> {
  const rows = (
    db
      .prepare(
        `SELECT r.user_id, COUNT(DISTINCT r.event_id) AS n
         FROM registrations r
         WHERE r.checked_in_at IS NOT NULL
         GROUP BY r.user_id`
      )
      .all() as Array<{ user_id: number; n: number }>
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
}

/**
 * 用户参加次数统计（全平台范围）：每个有签到记录的用户，
 * 「已报名且已核验」的活动数（参加次数）+ 已签到报名记录数 + 最近签到时间。
 * 按参加次数降序，便于后台按次数分档设置折扣票。
 */
export function attendanceStats(minAttend?: number): Row {
  const rows = (
    db
      .prepare(
        `SELECT u.id AS userId, u.nickname, u.phone,
                COUNT(DISTINCT r.event_id) AS attend_event_count,
                COUNT(r.id)                AS attend_reg_count,
                MAX(r.checked_in_at)       AS last_attended_at
         FROM users u
         JOIN registrations r ON r.user_id = u.id AND r.checked_in_at IS NOT NULL
         GROUP BY u.id
         ORDER BY attend_event_count DESC, attend_reg_count DESC, u.id ASC`
      )
      .all() as Row[]
  );
  const min = Number(minAttend) || 0;
  const allUsers = rows.map((r) => ({
    userId: Number(r.userId),
    nickname: r.nickname,
    phone: r.phone,
    maskedPhone: r.phone ? maskPhone(r.phone) : null,
    attend_event_count: Number(r.attend_event_count),
    attend_reg_count: Number(r.attend_reg_count),
    last_attended_at_display: fmtTime(r.last_attended_at),
  }));
  const users = min > 0 ? allUsers.filter((u) => u.attend_event_count >= min) : allUsers;
  return {
    total: users.length,
    // 参加 ≥ 2 场活动的回头客数（折扣票的典型筛选档）
    repeat: users.filter((u) => u.attend_event_count >= 2).length,
    min_attend: min > 0 ? min : null,
    users,
  };
}
