// 点赞（活动 / 分享 / 评论 / 帖子）：登录用户对同一对象只赞一次，可取消；公开统计点赞数。
import { db } from '../db.ts';
import { nowIso, HttpError } from '../util.ts';

type Row = Record<string, any>;

const TARGETS = ['EVENT', 'SHARE', 'COMMENT', 'POST'];

function targetExists(type: string, id: number): boolean {
  if (type === 'EVENT') return !!db.prepare('SELECT id FROM events WHERE id=?').get(id);
  if (type === 'SHARE') return !!db.prepare('SELECT id FROM shares WHERE id=?').get(id);
  if (type === 'COMMENT') return !!db.prepare('SELECT id FROM comments WHERE id=?').get(id);
  if (type === 'POST') return !!db.prepare('SELECT id FROM posts WHERE id=?').get(id);
  return false;
}

/** 点赞 / 取消点赞（幂等切换）。返回 { liked: 本次操作后是否已赞, count: 最新点赞数 }。 */
export function toggleLike(userId: number, type: string, id: number): { liked: boolean; count: number } {
  const t = String(type).toUpperCase();
  const tid = Number(id);
  if (!TARGETS.includes(t)) throw new HttpError(400, '点赞对象类型必须是 EVENT/SHARE/COMMENT/POST');
  if (!Number.isInteger(tid) || tid <= 0) throw new HttpError(400, '点赞对象 id 非法');
  if (!targetExists(t, tid)) throw new HttpError(404, '点赞对象不存在');
  const row = db.prepare('SELECT id FROM likes WHERE target_type=? AND target_id=? AND user_id=?').get(t, tid, userId) as Row | null;
  if (row) {
    db.prepare('DELETE FROM likes WHERE id=?').run(row.id);
  } else {
    db.prepare('INSERT INTO likes (target_type, target_id, user_id, created_at) VALUES (?,?,?,?)').run(t, tid, userId, nowIso());
  }
  const c = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE target_type=? AND target_id=?').get(t, tid) as Row;
  return { liked: !row, count: Number(c.n || 0) };
}

/** 某对象的点赞数。 */
export function likeCount(type: string, id: number): number {
  const c = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE target_type=? AND target_id=?').get(String(type).toUpperCase(), Number(id)) as Row;
  return Number(c.n || 0);
}

/** 当前用户已点赞的 id 集合（批量，用于列表/评论 liked 状态）。 */
export function likedSet(userId: number, type: string, ids: number[]): Set<number> {
  const t = String(type).toUpperCase();
  const uniq = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
  if (!userId || !uniq.length) return new Set();
  const ph = uniq.map(() => '?').join(',');
  const rows = db.prepare(`SELECT target_id FROM likes WHERE target_type=? AND user_id=? AND target_id IN (${ph})`).all(t, userId, ...uniq) as Row[];
  return new Set(rows.map((r) => Number(r.target_id)));
}

/** 单个对象是否已赞。 */
export function isLiked(userId: number, type: string, id: number): boolean {
  if (!userId) return false;
  return !!db.prepare('SELECT id FROM likes WHERE target_type=? AND target_id=? AND user_id=?').get(String(type).toUpperCase(), Number(id), userId);
}
