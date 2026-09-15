// 论坛帖子：登录用户发帖（标题 + 正文，正文可含图片富文本 HTML），公开浏览/点赞/评论（评论/点赞复用 comments/likes 的 POST 目标）。
import { db } from '../db.ts';
import { HttpError, nowIso, nextDayIso } from '../util.ts';
import { API_BASE_URL } from '../config.ts';
import { findBadWord } from './badwords.ts';
import { likedSet, isLiked } from './likes.ts';

type Row = Record<string, any>;

/** 正文 HTML 里 /uploads/… 的图片 src → 绝对 URL（小程序 rich-text 无法解析相对地址）。 */
function absolutizeContent(html: string): string {
  if (!html || html.indexOf('/uploads/') < 0) return html;
  return html.replace(/src="\/(uploads\/[^"]+)"/g, (m, p) => `src="${API_BASE_URL}/${p}"`);
}

function serialize(row: Row): Row {
  const out: Row = { ...row };
  out.like_count = Number(out.like_count ?? 0);
  out.comment_count = Number(out.comment_count ?? 0);
  out.view_count = Number(out.view_count ?? 0);
  out.content = out.content ? absolutizeContent(String(out.content)) : '';
  out.author = { id: out.user_id, nickname: String(out.nickname || '匿名用户').slice(0, 20), avatar: out.avatar || null };
  delete out.nickname;
  delete out.avatar;
  return out;
}

const STAT_SELECT = `
  (SELECT COUNT(*) FROM likes l WHERE l.target_type='POST' AND l.target_id=p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.target_type='POST' AND c.target_id=p.id) AS comment_count`;

/** 公开列表：已发布帖子，按时间倒序，带作者 + 浏览/点赞/评论数 + 当前用户已赞。 */
export function listPosts(userId = 0): Row[] {
  const rows = db
    .prepare(
      `SELECT p.*, u.nickname, u.avatar, ${STAT_SELECT}
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.status = 'PUBLISHED'
       ORDER BY p.created_at DESC, p.id DESC LIMIT 100`
    )
    .all() as Row[];
  const liked = likedSet(userId, 'POST', rows.map((r) => Number(r.id)));
  return rows.map((r) => ({ ...serialize(r), liked: liked.has(Number(r.id)) }));
}

/** 公开详情（归档帖用户端不可见）。 */
export function getPost(id: number, userId = 0): Row {
  const row = db
    .prepare(
      `SELECT p.*, u.nickname, u.avatar, ${STAT_SELECT}
       FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id=? AND p.status='PUBLISHED'`
    )
    .get(id) as Row | null;
  if (!row) throw new HttpError(404, '帖子不存在');
  return { ...serialize(row), liked: isLiked(userId, 'POST', id) };
}

/** 浏览 +1（静默）。 */
export function incrementView(id: number): void {
  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id=?').run(id);
}

/** 发帖：标题必填，正文可为纯文本或富文本 HTML（含图片）；标题/正文均过违禁词过滤。 */
export function createPost(userId: number, input: { title: string; content?: string }): Row {
  const title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw new HttpError(400, '请填写帖子标题');
  const content = String(input.content || '').trim().slice(0, 50_000);
  const hit = findBadWord(title);
  if (hit) throw new HttpError(400, `标题包含违禁词「${hit}」，请修改后再发布`);
  if (content) {
    const text = content.replace(/<[^>]+>/g, ' ');
    const hit2 = findBadWord(text);
    if (hit2) throw new HttpError(400, `内容包含违禁词「${hit2}」，请修改后再发布`);
  }
  const now = nowIso();
  const r = db
    .prepare('INSERT INTO posts (user_id, title, content, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(userId, title, content, now, now);
  return getPost(Number(r.lastInsertRowid));
}

/** 删帖：作者本人可删；管理员可删任意；连带删其评论与点赞。 */
export function deletePost(userId: number, isAdmin: boolean, id: number): void {
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id) as Row | null;
  if (!row) throw new HttpError(404, '帖子不存在');
  if (!isAdmin && Number(row.user_id) !== userId) throw new HttpError(403, '只能删除自己的帖子');
  db.prepare('DELETE FROM posts WHERE id=?').run(id);
  db.prepare("DELETE FROM comments WHERE target_type='POST' AND target_id=?").run(id);
  db.prepare("DELETE FROM likes WHERE target_type='POST' AND target_id=?").run(id);
}

/** 后台列表：状态（ACTIVE=已发布 / ARCHIVED=归档 / ALL=全部）+ 关键词（标题/正文）+ 创建时间范围 + 分页（§ P0）。
 *  返回 { total, page, pageSize, items }，每页默认 15 条（上限 100），与报名名单一致。 */
export function adminListPosts(filter: {
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  keyword?: string;
  from?: string; // 创建时间 ≥ 该日期
  to?: string; // 创建时间 < 该日期次日 00:00（含当天）
  page?: number;
  pageSize?: number;
} = {}): Row {
  const where: string[] = [];
  const vals: any[] = [];
  const status = filter.status || 'ACTIVE';
  if (status === 'ACTIVE') where.push("p.status='PUBLISHED'");
  else if (status === 'ARCHIVED') where.push("p.status='ARCHIVED'");
  if (filter.keyword) {
    where.push('(p.title LIKE ? OR p.content LIKE ?)');
    const k = `%${String(filter.keyword)}%`;
    vals.push(k, k);
  }
  if (filter.from) {
    where.push('p.created_at >= ?');
    vals.push(`${String(filter.from).slice(0, 10)}T00:00:00.000Z`);
  }
  if (filter.to) {
    where.push('p.created_at < ?');
    vals.push(nextDayIso(String(filter.to)));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`).get(...vals) as { n: number })?.n ?? 0
  );
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filter.pageSize) || 15));
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT p.*, u.nickname, u.avatar, ${STAT_SELECT}
       FROM posts p JOIN users u ON u.id = p.user_id
       ${whereSql}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...vals, pageSize, offset) as Row[];
  return { total, page, pageSize, items: rows.map((r) => serialize(r)) };
}

/** 后台导出帖子 CSV（与列表同款状态/关键词过滤；带 BOM，Excel 直接打开不乱码）。 */
export function exportPostsCsv(filter: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; keyword?: string } = {}): { filename: string; csv: string } {
  const where: string[] = [];
  const vals: any[] = [];
  const status = filter.status || 'ACTIVE';
  if (status === 'ACTIVE') where.push("p.status='PUBLISHED'");
  else if (status === 'ARCHIVED') where.push("p.status='ARCHIVED'");
  if (filter.keyword) {
    where.push('(p.title LIKE ? OR p.content LIKE ?)');
    const k = `%${String(filter.keyword)}%`;
    vals.push(k, k);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT p.*, u.nickname, ${STAT_SELECT}
       FROM posts p JOIN users u ON u.id = p.user_id
       ${whereSql} ORDER BY p.created_at DESC, p.id DESC`
    )
    .all(...vals) as Row[];
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const stripHtml = (html: string) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const header = ['ID', '标题', '状态', '作者', '浏览数', '点赞数', '评论数', '创建时间', '正文(纯文本)'];
  const lines = [header.map(esc).join(',')];
  for (const p of rows) {
    lines.push(
      [p.id, p.title, p.status === 'ARCHIVED' ? '已归档' : '已发布', p.nickname || '匿名用户',
        p.view_count ?? 0, p.like_count ?? 0, p.comment_count ?? 0, p.created_at, stripHtml(p.content)].map(esc).join(',')
    );
  }
  const filename = `posts_${new Date().toISOString().slice(0, 10)}.csv`;
  return { filename, csv: '\uFEFF' + lines.join('\r\n') + '\r\n' };
}

/** 归档 / 恢复（后台管理）。 */
export function setPostArchived(id: number, archived: boolean): void {
  const row = db.prepare('SELECT id FROM posts WHERE id=?').get(id) as Row | null;
  if (!row) throw new HttpError(404, '帖子不存在');
  db.prepare("UPDATE posts SET status=?, updated_at=? WHERE id=?").run(archived ? 'ARCHIVED' : 'PUBLISHED', nowIso(), id);
}
