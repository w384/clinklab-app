// 评价（C⑨）：付费用户对参加过的活动打分（1-5 星）+ 留言；同用户同活动限一条（可改）。
// 资格：有该活动 PAID（非候补）报名，且「已核销」或「活动已结束」。
import { db } from '../db.ts';
import { nowIso, HttpError } from '../util.ts';
import { findBadWord } from './badwords.ts';

type Row = Record<string, any>;

function getEventRow(id: number): Row | null {
  return db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | null;
}

/** 评价是否开放：该用户对该活动有已支付报名，且（已核销 或 活动已结束）。 */
export function assertReviewable(userId: number, eventId: number): Row {
  const ev = getEventRow(eventId);
  if (!ev) throw new HttpError(404, '活动不存在');
  const now = nowIso();
  const ended = Boolean(ev.end_time && ev.end_time <= now);
  const reg = db
    .prepare(
      `SELECT r.*, o.option_type FROM registrations r
       JOIN registration_options o ON o.id = r.registration_option_id
       WHERE r.user_id=? AND r.event_id=? AND r.status='PAID' AND o.option_type != 'WAITLIST'
       ORDER BY r.id DESC LIMIT 1`
    )
    .get(userId, eventId) as Row | null;
  if (!reg) throw new HttpError(403, '需先报名并支付后才可评价');
  if (!reg.checked_in_at && !ended) throw new HttpError(403, '活动结束或核销后才可评价');
  return reg;
}

export interface ReviewInput {
  eventId: number;
  rating: number;
  comment?: string;
}

/** 创建 / 更新我的评价（同用户同活动 upsert）。 */
export function upsertReview(userId: number, input: ReviewInput): Row {
  const reg = assertReviewable(userId, Number(input.eventId));
  const rating = Math.round(Number(input.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, '评分必须是 1-5 星');
  const comment = input.comment ? String(input.comment).trim().slice(0, 500) : null;
  if (comment) {
    const hit = findBadWord(comment);
    if (hit) throw new HttpError(400, `内容包含违禁词「${hit}」，请修改后再发布`);
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO reviews (user_id, event_id, registration_id, rating, comment, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, event_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment, updated_at=excluded.updated_at`
  ).run(userId, Number(input.eventId), Number(reg.id), rating, comment, now, now);
  const row = db.prepare('SELECT * FROM reviews WHERE user_id=? AND event_id=?').get(userId, Number(input.eventId)) as Row;
  return {
    ...row,
    rating,
    comment,
    created_at_display: now,
  };
}

/** 活动评价列表（公开，详情页展示；昵称随报名时快照）。 */
export function listEventReviews(eventId: number): Row[] {
  return (
    db
      .prepare(
        `SELECT rv.id, rv.rating, rv.comment, rv.created_at, u.nickname
         FROM reviews rv JOIN users u ON u.id = rv.user_id
         WHERE rv.event_id=?
         ORDER BY rv.created_at DESC, rv.id DESC LIMIT 50`
      )
      .all(eventId) as Row[]
  ).map((r) => ({
    id: r.id,
    rating: Number(r.rating),
    comment: r.comment,
    created_at: r.created_at,
    nickname: String(r.nickname || '匿名用户').slice(0, 20),
  }));
}

/** 我的评价列表（带活动标题）。 */
export function listMyReviews(userId: number): Row[] {
  return (
    db
      .prepare(
        `SELECT rv.*, e.title AS event_title
         FROM reviews rv JOIN events e ON e.id = rv.event_id
         WHERE rv.user_id=?
         ORDER BY rv.created_at DESC, rv.id DESC LIMIT 100`
      )
      .all(userId) as Row[]
  ).map((r) => ({
    id: r.id,
    event_id: r.event_id,
    event_title: r.event_title,
    rating: Number(r.rating),
    comment: r.comment,
    created_at: r.created_at,
  }));
}

/** 后台：全部评价（带活动标题 + 用户昵称）。 */
export function listAllReviews(): Row[] {
  return (
    db
      .prepare(
        `SELECT rv.id, rv.rating, rv.comment, rv.created_at, rv.event_id, e.title AS event_title, u.nickname
         FROM reviews rv
         JOIN events e ON e.id = rv.event_id
         JOIN users u ON u.id = rv.user_id
         ORDER BY rv.created_at DESC, rv.id DESC LIMIT 200`
      )
      .all() as Row[]
  ).map((r) => ({
    id: r.id,
    event_id: r.event_id,
    event_title: r.event_title,
    nickname: String(r.nickname || '匿名'),
    rating: Number(r.rating),
    comment: r.comment,
    created_at: r.created_at,
  }));
}

/** 活动评价统计（详情页头部展示）。 */
export function eventReviewStats(eventId: number): { count: number; avg: number } {
  const r = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(AVG(rating),0) AS a FROM reviews WHERE event_id=?`)
    .get(eventId) as { n: number; a: number } | undefined;
  const avg = Number(r?.a ?? 0);
  return { count: Number(r?.n ?? 0), avg: Math.round(avg * 10) / 10 };
}
