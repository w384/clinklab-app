-- ClinkLab 付费报名 V0.1 —— 可运行 schema（SQLite，按 PostgreSQL 目标设计）
-- 领域模型：Event → RegistrationOption → Registration；Payment / Refund / CheckIn 独立。
-- 不使用 Ticket / TicketType / Inventory / verification_records（§1 / §40 / §44）。
-- 时间统一用 TEXT ISO-8601 (UTC)：字典序 = 时间序，且可被 Date 解析（可平移到 timestamptz）。
-- 金额统一用分（cents）：避免浮点误差，保证"不多收/不少收"（可平移到 numeric(12,2)）。

PRAGMA foreign_keys = ON;

-- 用户：微信登录时服务端创建，openid/session_key 仅服务端持有，绝不外发（§32/§33）
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,               -- 微信 openid：服务端内部身份依据，不作客户端可信声明
  session_key TEXT,                          -- 微信 session_key：仅服务端使用，禁止返回客户端
  nickname TEXT,
  phone TEXT,
  avatar TEXT,                               -- 微信头像（chooseAvatar 得到的 base64 data URL；采集不到则留空，前端回退首字）
  is_admin INTEGER NOT NULL DEFAULT 0,       -- 角色：1=工作人员（可在小程序内签到），0=普通用户（§25）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 系统登录态：客户端只持有 opaque token，服务端据此解析用户（§32）
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 管理员（§24 admin_users）。V0.1 用简单的用户名/口令 + 管理会话。
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 活动（§4）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subtitle TEXT,
  cover_image TEXT,
  description TEXT,
  location_name TEXT,
  location_address TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  registration_start_time TEXT NOT NULL,
  registration_end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ENDED','OFFLINE','CANCELLED')),
  capacity INTEGER,                          -- NULL = 不限名额（§5）
  refund_rule TEXT NOT NULL DEFAULT 'NO_SELF_REFUND'
    CHECK (refund_rule IN ('ALLOW_ANY','BEFORE_24H','BEFORE_48H','NO_SELF_REFUND')),
  contact_info TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 报名类型：身份 / 价格 / 权益，不是库存模型（§6）
CREATE TABLE IF NOT EXISTS registration_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price >= 0),  -- 单位：分
  option_type TEXT NOT NULL DEFAULT 'SINGLE'
    CHECK (option_type IN ('SINGLE','DOUBLE','INVITE','WAITLIST')),  -- 票种：单人/双人/邀请/候补
  gate_code TEXT,                              -- 邀请票的"购买门槛码"（后台人工配置；用户买票时需输入匹配才能购买）
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registration_options_event ON registration_options(event_id);

-- 报名（核心业务对象，§7）
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_no TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  registration_option_id INTEGER REFERENCES registration_options(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  form_data TEXT,                            -- JSON：动态字段（备注等，§8）
  amount INTEGER NOT NULL,                   -- 单位：分，服务端依据报名类型计算（§9）
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PAID','CANCELLED','REFUNDING','REFUNDED')),
  qr_token TEXT UNIQUE,                      -- 座位1 凭证码（支付成功后生成，随机不可预测，§12）
  qr_token_2 TEXT UNIQUE,                    -- 座位2 凭证码（双人票：2 码各扫各核销）
  paid_at TEXT,
  cancelled_at TEXT,
  refunded_at TEXT,
  checked_in_at TEXT,                        -- 座位1 非空 = 已核销（§7：签到状态不混入支付状态）
  checked_in_at_2 TEXT,                      -- 座位2 非空 = 已核销（双人票）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id);
CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_registrations_qr_token ON registrations(qr_token);
-- idx_registrations_qr_token_2 在 db.ts 迁移里创建（老库需先 ALTER 加列再建索引）
CREATE INDEX IF NOT EXISTS idx_registrations_event_status ON registrations(event_id, status);

-- 支付记录（§10）
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  out_trade_no TEXT NOT NULL UNIQUE,
  wechat_transaction_id TEXT,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','REFUNDED')),
  paid_at TEXT,
  raw_notify_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_registration ON payments(registration_id);

-- 退款（§22）
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  out_refund_no TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','SUCCESS','FAILED')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_registration ON refunds(registration_id);

-- 签到记录（§18）
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  operator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  operator_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  operator_name TEXT,
  method TEXT NOT NULL CHECK (method IN ('QR','PHONE_LAST4')),
  seat_no INTEGER NOT NULL DEFAULT 1,        -- 核销的是第几码（1/2；双人票分别核销）
  checked_in_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_event ON checkins(event_id);
CREATE INDEX IF NOT EXISTS idx_checkins_registration ON checkins(registration_id);

-- 分享内容（「分享」tab）：现场录制视频 / 线上网课 / 知识文字
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('VIDEO','COURSE','TEXT')),
  title TEXT NOT NULL,
  summary TEXT,
  cover_image TEXT,                            -- 封面图（列表/播放页）
  video_url TEXT,                              -- 视频直链（mp4 等，video/course 用）
  content TEXT,                                -- 文字/图文正文（TEXT 类型用，支持换行）
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','DRAFT','OFFLINE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status, sort_order);

-- 评论区（分享/活动/论坛帖子，支持回复）：target 指向分享、活动或帖子，parent_id 为空=根评论，非空=回复该根评论
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('SHARE','EVENT','POST')),
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
