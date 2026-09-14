// 评论区：分享内容 + 参加过的活动，支持楼层式回复（根评论 + 回复平铺在根评论下）。
// 回复的回复（平铺@式）：parentId 仍指向根评论，reply_to_user_id 记录被回复对象，展示时前缀"回复 @昵称"。
// 资格：分享评论需登录；活动评论需该用户对该活动有已支付（非候补）报名。
import { db } from '../db.ts';
import { nowIso, HttpError } from '../util.ts';
import { findBadWord } from './badwords.ts';
import { likeCount, likedSet } from './likes.ts';

type Row = Record<string, any>;

const TARGET_TYPES = ['SHARE', 'EVENT', 'POST'];

function targetExists(type: string, id: number): boolean {
  if (type === 'SHARE') return !!db.prepare('SELECT id FROM shares WHERE id=?').get(id);
  if (type === 'EVENT') return !!db.prepare('SELECT id FROM events WHERE id=?').get(id);
  if (type === 'POST') return !!db.prepare('SELECT id FROM posts WHERE id=?').get(id);
  return false;
}

/** 活动评论资格：该用户对该活动有 PAID（非候补）报名（参加过）。 */
function assertCanCommentEvent(userId: number, eventId: number): void {
  const reg = db
    .prepare(
      `SELECT r.id FROM registrations r
       JOIN registration_options o ON o.id = r.registration_option_id
       WHERE r.user_id=? AND r.event_id=? AND r.status='PAID' AND o.option_type != 'WAITLIST'
       LIMIT 1`
    )
    .get(userId, eventId);
  if (!reg) throw new HttpError(403, '参加过的活动才能评论（需已支付报名）');
}

export interface CommentInput {
  type: 'SHARE' | 'EVENT' | 'POST';
  id: number;
  content: string;
  parentId?: number; // 根评论 id（回复/回复的回复都指向根）
  replyToId?: number; // 回复的回复：被回复的那条回复 id
}

/** 发评论 / 回复 / 回复的回复。 */
export function createComment(userId: number, input: CommentInput): Row {
  const type = String(input.type).toUpperCase();
  if (!TARGET_TYPES.includes(type)) throw new HttpError(400, '评论对象类型必须是 SHARE/EVENT/POST');
  const targetId = Number(input.id);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new HttpError(400, '评论对象 id 非法');
  if (!targetExists(type, targetId)) throw new HttpError(404, '评论对象不存在');
  if (type === 'EVENT') assertCanCommentEvent(userId, targetId);
  const content = String(input.content || '').trim().slice(0, 500);
  if (!content) throw new HttpError(400, '评论内容不能为空');
  const hit = findBadWord(content);
  if (hit) throw new HttpError(400, `内容包含违禁词「${hit}」，请修改后再发布`);
  let parentId: number | null = null;
  let replyToUserId: number | null = null;
  if (input.parentId != null) {
    parentId = Number(input.parentId);
    if (!Number.isInteger(parentId) || parentId <= 0) throw new HttpError(400, '回复目标 id 非法');
    const parent = db
      .prepare('SELECT id FROM comments WHERE id=? AND target_type=? AND target_id=? AND parent_id IS NULL')
      .get(parentId, type, targetId);
    if (!parent) throw new HttpError(400, '只能回复根评论');
    // 回复的回复：replyToId 必须是该根评论下的一条回复，且不能回复自己
    if (input.replyToId != null) {
      const replyTo = Number(input.replyToId);
      if (!Number.isInteger(replyTo) || replyTo <= 0) throw new HttpError(400, '回复目标 id 非法');
      if (replyTo === parentId) throw new HttpError(400, '不能回复根评论本身');
      const rt = db
        .prepare('SELECT user_id FROM comments WHERE id=? AND target_type=? AND target_id=? AND parent_id=?')
        .get(replyTo, type, targetId, parentId);
      if (!rt) throw new HttpError(400, '只能回复该根评论下的回复');
      if (Number(rt.user_id) === userId) throw new HttpError(400, '不能回复自己的评论');
      replyToUserId = Number(rt.user_id);
    }
  }
  const now = nowIso();
  const r = db
    .prepare('INSERT INTO comments (target_type, target_id, user_id, parent_id, reply_to_user_id, content, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(type, targetId, userId, parentId, replyToUserId, content, now);
  return db.prepare('SELECT * FROM comments WHERE id=?').get(Number(r.lastInsertRowid)) as Row;
}

/** 输出单条评论（含点赞数；liked 按当前用户）。 */
function pick(c: Row, userId: number): Row {
  const out: Row = {
    id: c.id,
    user_id: c.user_id,
    nickname: String(c.nickname || '匿名用户').slice(0, 20),
    avatar: c.avatar || null,
    content: String(c.content),
    created_at: c.created_at,
    like_count: Number(c._like_count ?? 0),
    liked: !!c._liked,
  };
  if (c.reply_to_user_id != null) {
    out.reply_to_user_id = Number(c.reply_to_user_id);
    out.reply_to_nickname = String(c.reply_to_nickname || '匿名用户').slice(0, 20);
  }
  return out;
}

/** 评论区列表（公开）：根评论按时间正序，回复（含回复的回复，平铺）挂在根评论下；带点赞数/已赞。 */
export function listComments(type: string, id: number, userId = 0): Row[] {
  const targetType = String(type).toUpperCase();
  const targetId = Number(id);
  if (!TARGET_TYPES.includes(targetType)) throw new HttpError(400, '评论对象类型必须是 SHARE/EVENT/POST');
  if (!targetExists(targetType, targetId)) throw new HttpError(404, '评论对象不存在');
  const roots = db
    .prepare(
      `SELECT c.*, u.nickname, u.avatar,
              (SELECT COUNT(*) FROM likes l WHERE l.target_type='COMMENT' AND l.target_id=c.id) AS _like_count
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.target_type=? AND c.target_id=? AND c.parent_id IS NULL
       ORDER BY c.created_at ASC, c.id ASC LIMIT 100`
    )
    .all(targetType, targetId) as Row[];
  const allReplies = db
    .prepare(
      `SELECT c.*, u.nickname, u.avatar, ru.nickname AS reply_to_nickname,
              (SELECT COUNT(*) FROM likes l WHERE l.target_type='COMMENT' AND l.target_id=c.id) AS _like_count
       FROM comments c JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
       WHERE c.target_type=? AND c.target_id=? AND c.parent_id IS NOT NULL
       ORDER BY c.created_at ASC, c.id ASC LIMIT 200`
    )
    .all(targetType, targetId) as Row[];
  const byParent: Record<number, Row[]> = {};
  for (const r of allReplies) (byParent[Number(r.parent_id)] ||= []).push(r);
  const allIds = [...roots.map((r) => Number(r.id)), ...allReplies.map((r) => Number(r.id))];
  const liked = likedSet(userId, 'COMMENT', allIds);
  const mark = (c: Row): Row => ({ ...c, _liked: liked.has(Number(c.id)) });
  return roots.map((root) => {
    const replies = (byParent[Number(root.id)] || []).map((r) => pick(mark(r), userId));
    return { ...pick(mark(root), userId), replies };
  });
}

/** 删除评论：作者本人可删；删根评论时连带其下回复。 */
export function deleteComment(userId: number, isAdmin: boolean, id: number): { ok: true } {
  const row = db.prepare('SELECT * FROM comments WHERE id=?').get(id) as Row | null;
  if (!row) throw new HttpError(404, '评论不存在');
  if (!isAdmin && Number(row.user_id) !== userId) throw new HttpError(403, '只能删除自己的评论');
  db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').run(id, id);
  db.prepare("DELETE FROM likes WHERE target_type='COMMENT' AND target_id=?").run(id);
  return { ok: true };
}

/** 后台看板：全部根评论（含目标标题 + 作者昵称 + reply_count + 点赞数），倒序；回复按 parent 挂在根评论下（时间正序）。 */
export function adminListComments(limit = 300): Row[] {
  const roots = db
    .prepare(
      `SELECT c.id, c.target_type, c.target_id, c.user_id, c.content, c.created_at, u.nickname,
              (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id) AS reply_count,
              (SELECT COUNT(*) FROM likes l WHERE l.target_type='COMMENT' AND l.target_id=c.id) AS like_count,
              CASE c.target_type
                WHEN 'SHARE' THEN (SELECT title FROM shares s WHERE s.id = c.target_id)
                WHEN 'EVENT' THEN (SELECT title FROM events e WHERE e.id = c.target_id)
                WHEN 'POST' THEN (SELECT title FROM posts p WHERE p.id = c.target_id)
              END AS target_title
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.parent_id IS NULL
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`
    )
    .all(limit) as Row[];
  const replies = db
    .prepare(
      `SELECT c.id, c.parent_id, c.user_id, c.content, c.created_at, u.nickname,
              ru.nickname AS reply_to_nickname,
              (SELECT COUNT(*) FROM likes l WHERE l.target_type='COMMENT' AND l.target_id=c.id) AS like_count
       FROM comments c JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
       WHERE c.parent_id IS NOT NULL
       ORDER BY c.created_at ASC, c.id ASC`
    )
    .all() as Row[];
  const byParent: Record<number, Row[]> = {};
  for (const r of replies) {
    const pid = Number(r.parent_id);
    const item: Row = {
      id: r.id,
      user_id: r.user_id,
      nickname: String(r.nickname || '匿名用户').slice(0, 20),
      content: String(r.content),
      created_at: r.created_at,
      like_count: Number(r.like_count || 0),
    };
    if (r.reply_to_user_id != null) {
      item.reply_to_user_id = Number(r.reply_to_user_id);
      item.reply_to_nickname = String(r.reply_to_nickname || '匿名用户').slice(0, 20);
    }
    (byParent[pid] ||= []).push(item);
  }
  return roots.map((r) => ({
    id: r.id,
    target_type: r.target_type,
    target_id: r.target_id,
    target_title: String(r.target_title || '(目标已删除)'),
    user_id: r.user_id,
    nickname: String(r.nickname || '匿名用户').slice(0, 20),
    content: String(r.content),
    created_at: r.created_at,
    reply_count: Number(r.reply_count || 0),
    like_count: Number(r.like_count || 0),
    replies: byParent[Number(r.id)] || [],
  }));
}
