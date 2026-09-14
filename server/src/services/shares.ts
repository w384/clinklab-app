// 分享内容（「分享」tab）：现场录制视频 / 线上网课 / 知识文字。
import { db } from '../db.ts';
import { HttpError, nowIso } from '../util.ts';
import { API_BASE_URL } from '../config.ts';
import { likeCount, likedSet, isLiked } from './likes.ts';

type Row = Record<string, any>;

const SHARE_TYPES = ['VIDEO', 'COURSE', 'TEXT'];
const SHARE_STATUS = ['PUBLISHED', 'DRAFT', 'OFFLINE'];

/** 封面相对路径 → 绝对 URL（小程序 <image> 需要绝对地址）。 */
function absolutizeCover(url: unknown): string | null {
  if (!url) return null;
  const s = String(url);
  return s.startsWith('http') ? s : `${API_BASE_URL}${s.startsWith('/') ? '' : '/'}${s}`;
}

function serialize(row: Row): Row {
  const out: Row = { ...row, cover_image: absolutizeCover(row.cover_image) };
  out.like_count = Number(out.like_count ?? 0);
  out.comment_count = Number(out.comment_count ?? 0);
  out.view_count = Number(out.view_count ?? 0);
  return out;
}

const STAT_SELECT = `
  (SELECT COUNT(*) FROM likes l WHERE l.target_type='SHARE' AND l.target_id=s.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.target_type='SHARE' AND c.target_id=s.id) AS comment_count`;

/** 公开列表：仅已发布，按 sort_order 升序、id 倒序。 */
export function listShares(userId = 0): Row[] {
  const rows = db
    .prepare(`SELECT s.*, ${STAT_SELECT} FROM shares s WHERE s.status='PUBLISHED' ORDER BY s.sort_order ASC, s.id DESC`)
    .all() as Row[];
  const liked = likedSet(userId, 'SHARE', rows.map((r) => Number(r.id)));
  return rows.map((r) => ({ ...serialize(r), liked: liked.has(Number(r.id)) }));
}

/** 公开详情：仅已发布。 */
export function getShare(id: number, userId = 0): Row | null {
  const row = db
    .prepare(`SELECT s.*, ${STAT_SELECT} FROM shares s WHERE s.id=? AND s.status='PUBLISHED'`)
    .get(id) as Row | null;
  return row ? { ...serialize(row), liked: isLiked(userId, 'SHARE', id) } : null;
}

/** 浏览 +1（静默，失败不影响）。 */
export function incrementView(id: number): void {
  db.prepare('UPDATE shares SET view_count = view_count + 1 WHERE id=?').run(id);
}

/** 后台列表：全部（含草稿/下架）。 */
export function adminListShares(): Row[] {
  const rows = db
    .prepare(`SELECT s.*, ${STAT_SELECT} FROM shares s ORDER BY s.sort_order ASC, s.id DESC`)
    .all() as Row[];
  return rows.map((r) => ({ ...serialize(r), like_count: likeCount('SHARE', Number(r.id)) }));
}

function normalizeShareInput(input: Record<string, any>): Row {
  const type = String(input.type || 'TEXT').toUpperCase();
  if (!SHARE_TYPES.includes(type)) throw new HttpError(400, '分享类型必须是 VIDEO/COURSE/TEXT');
  const title = String(input.title || '').trim();
  if (!title) throw new HttpError(400, '请填写分享标题');
  const status = String(input.status || 'PUBLISHED').toUpperCase();
  if (!SHARE_STATUS.includes(status)) throw new HttpError(400, '状态必须是 PUBLISHED/DRAFT/OFFLINE');
  return {
    type,
    title,
    summary: input.summary != null ? String(input.summary).trim().slice(0, 300) : null,
    cover_image: input.coverImage != null ? String(input.coverImage).trim() : null,
    video_url: input.videoUrl != null ? String(input.videoUrl).trim().slice(0, 2000) : null,
    content: input.content != null ? String(input.content).trim().slice(0, 50_000) : null,
    sort_order: input.sortOrder == null ? 0 : Number(input.sortOrder),
    status,
  };
}

export function createShare(input: Record<string, any>): Row {
  const v = normalizeShareInput(input);
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO shares (type, title, summary, cover_image, video_url, content, sort_order, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(v.type, v.title, v.summary, v.cover_image, v.video_url, v.content, v.sort_order, v.status, now, now);
  const row = db.prepare(`SELECT * FROM shares WHERE id=?`).get(Number(r.lastInsertRowid)) as Row;
  return serialize(row);
}

export function updateShare(id: number, patch: Record<string, any>): Row {
  const existing = db.prepare(`SELECT * FROM shares WHERE id=?`).get(id) as Row | null;
  if (!existing) throw new HttpError(404, '分享不存在');
  const merged = { ...existing, ...patch };
  const v = normalizeShareInput(merged);
  const now = nowIso();
  db.prepare(
    `UPDATE shares SET type=?, title=?, summary=?, cover_image=?, video_url=?, content=?, sort_order=?, status=?, updated_at=? WHERE id=?`
  ).run(v.type, v.title, v.summary, v.cover_image, v.video_url, v.content, v.sort_order, v.status, now, id);
  const row = db.prepare(`SELECT * FROM shares WHERE id=?`).get(id) as Row;
  return serialize(row);
}

export function deleteShare(id: number): void {
  const r = db.prepare(`DELETE FROM shares WHERE id=?`).run(id);
  if (Number(r.changes) === 0) throw new HttpError(404, '分享不存在');
}
