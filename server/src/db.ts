import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.ts';

// 确保数据目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// 应用 schema（幂等：全部 IF NOT EXISTS）
const schemaPath = new URL('./schema.sql', import.meta.url);
db.exec(fs.readFileSync(schemaPath, 'utf8'));

// 迁移：老库补列（幂等）
const userCols = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
if (!userCols.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('avatar')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
}

// 迁移：报名类型 4 类票（单人/双人/邀请/候补）
const optCols = (db.prepare('PRAGMA table_info(registration_options)').all() as Array<{ name: string }>).map((c) => c.name);
if (!optCols.includes('option_type')) {
  db.exec(`ALTER TABLE registration_options ADD COLUMN option_type TEXT NOT NULL DEFAULT 'SINGLE'`);
}
if (!optCols.includes('gate_code')) {
  db.exec(`ALTER TABLE registration_options ADD COLUMN gate_code TEXT`);
}
// 迁移：票种可购票上限（NULL/0=不限；>0 为该票种正票可购数量上限，售罄后自动转候补）
if (!optCols.includes('sold_limit')) {
  db.exec(`ALTER TABLE registration_options ADD COLUMN sold_limit INTEGER`);
}

// 迁移：报名 双码（双人票：座位2 凭证 + 座位2 核销时间）
const regCols = (db.prepare('PRAGMA table_info(registrations)').all() as Array<{ name: string }>).map((c) => c.name);
if (!regCols.includes('qr_token_2')) {
  db.exec(`ALTER TABLE registrations ADD COLUMN qr_token_2 TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_qr_token_2 ON registrations(qr_token_2)`);
if (!regCols.includes('checked_in_at_2')) {
  db.exec(`ALTER TABLE registrations ADD COLUMN checked_in_at_2 TEXT`);
}
// 迁移：候补报名想转的正票（售罄自动转候补时记录意向票种；退票后按序补位到该票种）
if (!regCols.includes('wish_option_id')) {
  db.exec(`ALTER TABLE registrations ADD COLUMN wish_option_id INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_wish ON registrations(event_id, wish_option_id)`);

// 迁移：签到 座号（双人票分别核销 1/2）
const chkCols = (db.prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>).map((c) => c.name);
if (!chkCols.includes('seat_no')) {
  db.exec(`ALTER TABLE checkins ADD COLUMN seat_no INTEGER NOT NULL DEFAULT 1`);
}

// 迁移：活动详情字段（分类标签 / 城市 / 提醒 / 详情图片 / 浏览数），支撑小程序详情页 + 后台所见即所得编辑
const evCols = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name);
if (!evCols.includes('category')) db.exec(`ALTER TABLE events ADD COLUMN category TEXT`);
if (!evCols.includes('location_city')) db.exec(`ALTER TABLE events ADD COLUMN location_city TEXT`);
if (!evCols.includes('reminder')) db.exec(`ALTER TABLE events ADD COLUMN reminder TEXT`);
if (!evCols.includes('detail_images')) db.exec(`ALTER TABLE events ADD COLUMN detail_images TEXT`);
if (!evCols.includes('view_count')) db.exec(`ALTER TABLE events ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`);
// 迁移：活动坐标（可选，用于详情页「打开地图」导航；无坐标时前端复制地址）
if (!evCols.includes('latitude')) db.exec(`ALTER TABLE events ADD COLUMN latitude REAL`);
if (!evCols.includes('longitude')) db.exec(`ALTER TABLE events ADD COLUMN longitude REAL`);
// 迁移：活动自定义报名字段（可选，JSON：[{key,label,required,type}]，报名时收集）
if (!evCols.includes('custom_fields')) db.exec(`ALTER TABLE events ADD COLUMN custom_fields TEXT`);
// 迁移：详情页顶部大图（可选；列表卡片用 cover_image，详情页顶部用 cover_detail_image，独立上传裁切）
if (!evCols.includes('cover_detail_image')) db.exec(`ALTER TABLE events ADD COLUMN cover_detail_image TEXT`);

// 订阅消息：用户授权记录（微信订阅为一次性：1 次授权 = 1 次发送额度）+ 已发送去重
db.exec(`CREATE TABLE IF NOT EXISTS subscribe_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  openid TEXT,
  template_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(user_id, template_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS subscribe_sent (
  registration_id INTEGER NOT NULL,
  template_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (registration_id, template_key)
)`);

// 评价（C⑨）：已核销或活动结束后，付费用户可给活动打分（1-5 星）+ 留言；同用户同活动限一条。
db.exec(`CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  registration_id INTEGER,
  rating INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(user_id, event_id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_event ON reviews(event_id)`);

// 迁移：评论区"回复的回复"（平铺@式）——回复可再回复：记录被回复对象，展示时前缀"回复 @昵称"
const cmtCols = (db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map((c) => c.name);
if (!cmtCols.includes('reply_to_user_id')) {
  db.exec(`ALTER TABLE comments ADD COLUMN reply_to_user_id INTEGER`);
}
// 迁移：评论目标类型支持论坛帖子 POST（SQLite 无法改 CHECK，重建表保留数据）
const cmtSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='comments'").get() as { sql?: string } | null)?.sql || '';
if (cmtSql.indexOf("'POST'") < 0) {
  db.exec(`PRAGMA foreign_keys = OFF;
    CREATE TABLE comments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK (target_type IN ('SHARE','EVENT','POST')),
      target_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reply_to_user_id INTEGER
    );
    INSERT INTO comments_new (id, target_type, target_id, user_id, parent_id, content, created_at, reply_to_user_id)
      SELECT id, target_type, target_id, user_id, parent_id, content, created_at, reply_to_user_id FROM comments;
    DROP TABLE comments;
    ALTER TABLE comments_new RENAME TO comments;
    CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
    PRAGMA foreign_keys = ON;`);
}
// 迁移：分享浏览数（与活动 view_count 对齐）
const shCols = (db.prepare('PRAGMA table_info(shares)').all() as Array<{ name: string }>).map((c) => c.name);
if (!shCols.includes('view_count')) {
  db.exec(`ALTER TABLE shares ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`);
}

// 点赞（活动 / 分享 / 评论）：登录用户对同一对象只赞一次，可取消；liked 状态按用户查询
db.exec(`CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, user_id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id)`);

// 论坛帖子：登录用户发帖（标题 + 正文，正文可含图片富文本 HTML），带浏览数；评论/点赞复用 comments/likes 的 POST 目标
db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PUBLISHED'
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)`);
// 迁移：论坛帖子状态（PUBLISHED 正常 / ARCHIVED 已归档，归档后用户端列表与详情不可见，后台可恢复）
const postCols = (db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((c) => c.name);
if (!postCols.includes('status')) {
  db.exec(`ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'PUBLISHED'`);
}

/**
 * 同步事务封装：
 * node:sqlite 是同步的，事务内没有异步间隙，天然原子；
 * 使用 BEGIN IMMEDIATE 立即拿到写锁，避免并发下的写锁升级死锁（SQLite 常见坑）；
 * 任何异常都会 ROLLBACK，保证"要么全成、要么全不成"。
 */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw e;
  }
}
