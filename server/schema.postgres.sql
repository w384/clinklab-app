-- ============================================================================
-- ClinkLab 付费报名 V0.1 —— 生产目标 schema（PostgreSQL 16+）
-- ============================================================================
-- 本文件是「生产目标」数据库结构，与沙箱可运行版 server/src/schema.sql（SQLite）
-- 保持【逻辑契约完全一致】：同样 10 张表、同样的领域模型、同样的状态枚举、同样的
-- 外键与唯一约束。沙箱跑 SQLite 只是绕开沙箱对进程/依赖的限制，不影响项目最终形态。
--
-- 迁移路径：见 DEVELOPMENT.md「NestJS / PostgreSQL 迁移 TODO」。
--
-- 两处 schema 共同的关键约定：
--   * 金额统一用 INTEGER（单位：分 / cents），避免浮点误差，保证「不多收/不少收」。
--   * 时间：SQLite 用 TEXT ISO-8601 (UTC)（字典序 = 时间序）；此处替换为真正的
--     TIMESTAMPTZ，仍以 UTC 存储与比较，语义等价且更严格（可用 time zone 操作）。
--   * 主键：BIGSERIAL（自增 BIGINT），对应 SQLite 的 INTEGER PRIMARY KEY AUTOINCREMENT。
--   * 唯一约束（UNIQUE）在 Postgres 下会自动创建唯一索引，故不再重复建索引。
--   * 状态枚举：用 CHECK 约束逐一复刻 SQLite 的枚举清单。
--
-- 领域模型（§44）：Event → RegistrationOption → Registration（核心对象），
-- Payment / Refund / CheckIn 独立。无 Ticket / TicketType / 库存 / 锁库存 / 候补 / 多商户；
-- 名额上限只有 events.capacity（NULL = 不限；判定为「有效已支付人数 < capacity」）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 用户：微信登录时服务端创建；openid / session_key 仅服务端持有，绝不外发（§32/§33）
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id          BIGSERIAL PRIMARY KEY,
  openid      TEXT NOT NULL UNIQUE,   -- 微信 openid：服务端内部身份依据，不作客户端可信声明
  session_key TEXT,                   -- 微信 session_key：仅服务端使用，禁止返回客户端
  nickname    TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 系统登录态：客户端只持有 opaque token，服务端据此解析用户（§32）
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  id         BIGSERIAL PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user_expires ON sessions(user_id, expires_at);

-- ----------------------------------------------------------------------------
-- 管理员（§24 admin_users）。V0.1 用简单的用户名/口令 + 管理会话。
-- ----------------------------------------------------------------------------
CREATE TABLE admin_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id         BIGSERIAL PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  admin_id   BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

-- ----------------------------------------------------------------------------
-- 活动（§4）
-- ----------------------------------------------------------------------------
CREATE TABLE events (
  id                      BIGSERIAL PRIMARY KEY,
  title                   TEXT NOT NULL,
  subtitle                TEXT,
  cover_image             TEXT,
  description             TEXT,
  location_name           TEXT,
  location_address        TEXT,
  start_time              TIMESTAMPTZ NOT NULL,
  end_time                TIMESTAMPTZ NOT NULL,
  registration_start_time TIMESTAMPTZ NOT NULL,
  registration_end_time   TIMESTAMPTZ NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT','PUBLISHED','ENDED','OFFLINE','CANCELLED')),
  capacity                INTEGER,   -- NULL = 不限名额（§5）；判定：有效已支付人数 < capacity，非库存
  refund_rule             TEXT NOT NULL DEFAULT 'NO_SELF_REFUND'
                            CHECK (refund_rule IN ('ALLOW_ANY','BEFORE_24H','BEFORE_48H','NO_SELF_REFUND')),
  contact_info            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 报名类型：身份 / 价格 / 权益，不是库存模型（§6）
-- ----------------------------------------------------------------------------
CREATE TABLE registration_options (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  price       INTEGER NOT NULL CHECK (price >= 0),  -- 单位：分
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_registration_options_event ON registration_options(event_id);

-- ----------------------------------------------------------------------------
-- 报名（核心业务对象，§7）
-- ----------------------------------------------------------------------------
CREATE TABLE registrations (
  id                     BIGSERIAL PRIMARY KEY,
  registration_no        TEXT NOT NULL UNIQUE,
  event_id               BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id                BIGINT REFERENCES users(id) ON DELETE SET NULL,
  registration_option_id BIGINT REFERENCES registration_options(id) ON DELETE SET NULL,
  name                   TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  form_data              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 动态字段（备注等，§8）；SQLite 端以 TEXT(JSON) 存储
  amount                 INTEGER NOT NULL,                     -- 单位：分，服务端依据报名类型计算（§9）
  status                 TEXT NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','PAID','CANCELLED','REFUNDING','REFUNDED')),
  qr_token               TEXT UNIQUE,   -- 支付成功后生成，随机不可预测（§12）
  paid_at                TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  refunded_at            TIMESTAMPTZ,
  checked_in_at          TIMESTAMPTZ,   -- 非空 = 已签到（§7：签到状态不混入支付状态）
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_registrations_event ON registrations(event_id);
CREATE INDEX idx_registrations_user ON registrations(user_id);
CREATE INDEX idx_registrations_status ON registrations(status);
CREATE INDEX idx_registrations_event_status ON registrations(event_id, status);

-- ----------------------------------------------------------------------------
-- 支付记录（§10）
-- ----------------------------------------------------------------------------
CREATE TABLE payments (
  id                    BIGSERIAL PRIMARY KEY,
  registration_id       BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  out_trade_no          TEXT NOT NULL UNIQUE,
  wechat_transaction_id TEXT,
  amount                INTEGER NOT NULL,  -- 单位：分
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','SUCCESS','FAILED','REFUNDED')),
  paid_at               TIMESTAMPTZ,
  raw_notify_data       TEXT,   -- 微信回调原文（验签用），保留原始文本
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_registration ON payments(registration_id);

-- ----------------------------------------------------------------------------
-- 退款（§22）
-- ----------------------------------------------------------------------------
CREATE TABLE refunds (
  id              BIGSERIAL PRIMARY KEY,
  registration_id BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  out_refund_no   TEXT NOT NULL UNIQUE,
  amount          INTEGER NOT NULL,  -- 单位：分
  status          TEXT NOT NULL DEFAULT 'PROCESSING'
                    CHECK (status IN ('PROCESSING','SUCCESS','FAILED')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refunds_registration ON refunds(registration_id);

-- ----------------------------------------------------------------------------
-- 签到记录（§18）
-- ----------------------------------------------------------------------------
CREATE TABLE checkins (
  id                BIGSERIAL PRIMARY KEY,
  registration_id   BIGINT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  event_id          BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  operator_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  operator_admin_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
  operator_name     TEXT,
  method            TEXT NOT NULL CHECK (method IN ('QR','PHONE_LAST4')),
  checked_in_at     TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checkins_registration ON checkins(registration_id);
CREATE INDEX idx_checkins_event ON checkins(event_id);
