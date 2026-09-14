import { db, tx } from '../db.ts';
import { nowIso, HttpError, genRegistrationNo, genQrToken, fmtCents, fmtTime, randNonce } from '../util.ts';
import { REG_PAY_DEADLINE_MS } from '../config.ts';
import { parseCustomFields } from './events.ts';

type Row = Record<string, any>;

function countValidPaid(eventId: number): number {
  // 候补票（WAITLIST）不计入名额：候补是"满了才登记"，不占座位
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM registrations r
       WHERE r.event_id=? AND r.status='PAID'
         AND NOT EXISTS (SELECT 1 FROM registration_options o WHERE o.id=r.registration_option_id AND o.option_type='WAITLIST')`
    )
    .get(eventId) as { n: number };
  return Number(r?.n ?? 0);
}

/** 某票种已支付（正票）数量。 */
export function countOptionPaid(optionId: number): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE registration_option_id=? AND status='PAID'`).get(optionId) as { n: number };
  return Number(r?.n ?? 0);
}

/** 票种是否售罄：该票种 sold_limit（>0）达到上限。（活动级 capacity 已废弃：名额由各票种购票上限按权重加和决定，各票种各自售罄转候补） */
function optionSoldOut(option: Row, eventId: number): boolean {
  void eventId;
  const limit = option.sold_limit === null || option.sold_limit === undefined ? 0 : Number(option.sold_limit);
  return limit > 0 && countOptionPaid(option.id) >= limit;
}

function getEventRow(id: number): Row | null {
  return db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | null;
}

export function getRegistration(id: number): Row {
  let reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(id) as Row;
  if (!reg) throw new HttpError(404, '报名记录不存在');
  // 惰性过期：PENDING 超过支付截止时间仍未支付 → 直接置为 CANCELLED（与定时清理同一规则，保证读取即最新）
  if (reg.status === 'PENDING' && reg.created_at <= new Date(Date.now() - REG_PAY_DEADLINE_MS).toISOString()) {
    const now = nowIso();
    db.prepare(`UPDATE registrations SET status='CANCELLED', cancelled_at=?, updated_at=? WHERE id=? AND status='PENDING'`).run(now, now, id);
    reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(id) as Row;
  }
  const ev = getEventRow(reg.event_id);
  const option = reg.registration_option_id
    ? (db.prepare('SELECT * FROM registration_options WHERE id=?').get(reg.registration_option_id) as Row | null)
    : null;
  const optionType = option?.option_type || (option ? 'SINGLE' : null);
  const isDouble = optionType === 'DOUBLE';
  const seats = isDouble ? 2 : 1;
  const checked = Boolean(reg.checked_in_at);
  const checked2 = Boolean(reg.checked_in_at_2);
  const checkedCount = (checked ? 1 : 0) + (checked2 ? 1 : 0);
  return {
    ...reg,
    form_data: parseFormData(reg.form_data), // JSON 字符串 → 对象（容错坏数据）
    event: ev
      ? { id: ev.id, title: ev.title, location_name: ev.location_name, start_time: ev.start_time, end_time: ev.end_time, status: ev.status, start_time_display: fmtTime(ev.start_time) }
      : null,
    option: option ? { id: option.id, name: option.name, description: option.description, price: option.price, price_display: fmtCents(Number(option.price)), option_type: option.option_type || 'SINGLE' } : null,
    option_type: optionType,
    seats,
    checked_in: checked,
    checked_in_2: checked2,
    checked_count: checkedCount,
    all_checked_in: checkedCount === seats,
    amount_display: fmtCents(Number(reg.amount)),
  };
}

export function listMyRegistrations(userId: number): Row[] {
  const rows = db
    .prepare(`SELECT * FROM registrations WHERE user_id=? ORDER BY created_at DESC, id DESC`)
    .all(userId) as Row[];
  return rows.map((r) => getRegistration(r.id));
}

export interface CreateRegistrationInput {
  registrationOptionId?: number;
  remark?: string;
  gateCode?: string; // 邀请票的"购买邀请码"（后台配置，用户购买时输入）
  customFields?: Record<string, string>; // 活动配置的自定义报名字段（key → 值）
}

/** form_data：JSON 字符串 → 对象（容错坏数据）。 */
function parseFormData(raw: unknown): Record<string, any> {
  if (!raw) return {};
  try {
    const p = JSON.parse(String(raw));
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/** 校验并收集自定义报名字段：只接受活动配置声明过的 key；必填项非空；单选值必须在选项内；文本 ≤200 字。 */
function collectCustomFields(ev: Row, input?: Record<string, string>): Record<string, string> {
  const defs = parseCustomFields(ev.custom_fields);
  const out: Record<string, string> = {};
  if (!defs.length) return out;
  const provided = input && typeof input === 'object' ? input : {};
  for (const d of defs) {
    const v = provided[d.key] !== undefined && provided[d.key] !== null ? String(provided[d.key]).trim() : '';
    if (d.required && !v) throw new HttpError(400, `请选择/填写「${d.label}」`);
    if (!v) continue;
    if (d.type === 'choice') {
      if (!Array.isArray(d.options) || !d.options.includes(v)) throw new HttpError(400, `「${d.label}」选项无效`);
      out[d.key] = v;
    } else {
      out[d.key] = v.slice(0, 200);
    }
  }
  return out;
}

/**
 * 创建报名（§7/§9）。
 * - 活动必须 PUBLISHED 且在报名窗口内。
 * - 金额由服务端依据报名类型计算（§9：客户端传入的 price 不可信）。
 * - capacity 软性判断（§5）：有效已支付人数 < capacity。
 * - 不实现库存锁定 / 预占 / 候补（§5）。
 */
export function createRegistration(eventId: number, userId: number, input: CreateRegistrationInput): Row {
  const ev = getEventRow(eventId);
  if (!ev) throw new HttpError(404, '活动不存在');
  if (ev.status !== 'PUBLISHED') throw new HttpError(403, '活动未发布，暂不可报名');
  const now = nowIso();
  if (ev.registration_start_time > now) throw new HttpError(403, '报名尚未开始');
  if (ev.registration_end_time < now) throw new HttpError(403, '报名已截止');

  // 姓名/手机取自登录用户资料快照（§ 首次登录采集，报名不重复填写；改资料不回溯已报名记录）
  const u = db.prepare('SELECT nickname, phone FROM users WHERE id=?').get(userId) as { nickname: string | null; phone: string | null };
  const name = String(u?.nickname || '').trim();
  const phone = String(u?.phone || '').trim();
  if (!name) throw new HttpError(400, '请先在「我的」里完善昵称');
  if (!/^\d{7,15}$/.test(phone)) throw new HttpError(400, '请先在「我的」里完善手机号');

  // 选择报名类型：指定则校验归属，否则取活动默认（第一个 ACTIVE，按 sort_order）
  let option: Row | null = null;
  if (input.registrationOptionId) {
    option = (db.prepare(`SELECT * FROM registration_options WHERE id=? AND event_id=? AND status='ACTIVE'`).get(input.registrationOptionId, eventId) as Row | null) || null;
    if (!option) throw new HttpError(404, '所选报名类型不存在');
  } else {
    option = (db.prepare(`SELECT * FROM registration_options WHERE event_id=? AND status='ACTIVE' ORDER BY sort_order, id LIMIT 1`).get(eventId) as Row | null) || null;
    if (!option) throw new HttpError(400, '该活动还没有可用的报名类型');
  }

  const optionType = option.option_type || 'SINGLE';

  // 邀请票：需输入后台配置的"购买邀请码"（门槛，人工告知对应用户）
  if (optionType === 'INVITE') {
    if (!option.gate_code) throw new HttpError(400, '该邀请票未配置购买邀请码');
    const provided = String(input.gateCode || '').trim().toUpperCase();
    if (provided !== String(option.gate_code).trim().toUpperCase()) throw new HttpError(403, '邀请码不正确，无法购买该票');
  }

  // 名额：候补票不受约束；正票售罄（该票种 sold_limit 达到上限）→ 自动转候补（不拒绝）
  const soldOut = optionType !== 'WAITLIST' && optionSoldOut(option, eventId);

  // 售罄 → 自动登记候补：记下想买的票种（wish_option_id），退票后按候补顺序补位转正
  if (soldOut) {
    const waitOpt = (db.prepare(`SELECT * FROM registration_options WHERE event_id=? AND option_type='WAITLIST' AND status='ACTIVE' ORDER BY sort_order, id LIMIT 1`).get(eventId) as Row | null) || null;
    if (!waitOpt) throw new HttpError(409, '该票种已售罄，且活动未开放候补，无法报名');
    const regNo = genRegistrationNo();
    const custom = collectCustomFields(ev, input.customFields);
    const formData = JSON.stringify({ remark: input.remark ? String(input.remark).slice(0, 500) : null, custom });
    const res = db
      .prepare(
        `INSERT INTO registrations (registration_no, event_id, user_id, registration_option_id, wish_option_id, name, phone, form_data, amount, status, paid_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,0,'PAID',?,?,?)`
      )
      .run(regNo, eventId, userId, waitOpt.id, option.id, name, phone, formData, now, now, now);
    const regId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO payments (registration_id, out_trade_no, wechat_transaction_id, amount, status, paid_at, raw_notify_data, created_at, updated_at)
                VALUES (?,?,?,?, 'SUCCESS', ?, ?, ?, ?)`)
      .run(regId, 'PAY' + regNo.slice(3), 'mock_waitlist', 0, now, JSON.stringify({ source: 'auto-waitlist-soldout', wishOptionId: option.id }), now, now);
    return getRegistration(regId);
  }

  // 服务端计算真实金额（§9）：候补票免费
  const amount = optionType === 'WAITLIST' ? 0 : Number(option.price);
  const regNo = genRegistrationNo();
  const custom = collectCustomFields(ev, input.customFields);
  const formData = JSON.stringify({ remark: input.remark ? String(input.remark).slice(0, 500) : null, custom });

  // 候补票：免费、免支付、直接 PAID、不出凭证码（仅统计候补人数）
  if (optionType === 'WAITLIST') {
    const res = db
      .prepare(
        `INSERT INTO registrations (registration_no, event_id, user_id, registration_option_id, name, phone, form_data, amount, status, paid_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,0,'PAID',?,?,?)`
      )
      .run(regNo, eventId, userId, option.id, name, phone, formData, now, now, now);
    const regId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO payments (registration_id, out_trade_no, wechat_transaction_id, amount, status, paid_at, raw_notify_data, created_at, updated_at)
                VALUES (?,?,?,?, 'SUCCESS', ?, ?, ?, ?)`)
      .run(regId, 'PAY' + regNo.slice(3), 'mock_waitlist', 0, now, JSON.stringify({ source: 'waitlist-free' }), now, now);
    return getRegistration(regId);
  }

  // 其余票种（单人/双人/邀请）：待支付
  const res = db
    .prepare(
      `INSERT INTO registrations (registration_no, event_id, user_id, registration_option_id, name, phone, form_data, amount, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'PENDING', ?, ?)`
    )
    .run(regNo, eventId, userId, option.id, name, phone, formData, amount, now, now);
  return getRegistration(Number(res.lastInsertRowid));
}

/**
 * 报名支付终态（PENDING → PAID，生成 qr_token，落 Payment(SUCCESS)）。
 * 被两条路径共用（幂等、同一业务逻辑，§36）：
 *   - mock-pay（development）：meta 缺省，落 mock transaction_id；
 *   - 真实回调 notify（§36）：meta 带真实 transaction_id + 原始回调体。
 * 幂等：重复调用对已 PAID 的报名返回成功，不重复写 Payment、不重复生成凭证。
 * 名额硬校验在事务内（BEGIN IMMEDIATE 串行化并发支付），简单防止超名额（§5 的软判断兜底）。
 * 支付单落库：若 prepay 阶段已落 PENDING 支付单则升级为 SUCCESS，否则新建（兼容 mock-pay 直接支付）。
 */
export function payRegistration(regId: number, meta?: { transactionId?: string; notifyRaw?: string }): Row {
  const result = tx(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(regId) as Row;
    if (!reg) throw new HttpError(404, '报名记录不存在');
    if (reg.status === 'PAID') return getRegistration(regId); // 幂等：已支付
    if (reg.status !== 'PENDING') throw new HttpError(409, `当前状态 ${reg.status} 不可支付`);

    const ev = getEventRow(reg.event_id);
    // 票种 sold_limit 硬校验（防并发超卖：创建时转候补，支付瞬间再次兜底）
    if (ev) {
      const optRow = reg.registration_option_id
        ? (db.prepare('SELECT * FROM registration_options WHERE id=?').get(reg.registration_option_id) as Row | null)
        : null;
      if (optRow && optRow.option_type !== 'WAITLIST') {
        const limit = optRow.sold_limit === null || optRow.sold_limit === undefined ? 0 : Number(optRow.sold_limit);
        if (limit > 0 && countOptionPaid(optRow.id) >= limit) throw new HttpError(409, '该票种已售罄');
      }
    }

    const now = nowIso();
    const option = reg.registration_option_id
      ? (db.prepare('SELECT * FROM registration_options WHERE id=?').get(reg.registration_option_id) as Row | null)
      : null;
    const optionType = option?.option_type || 'SINGLE';
    const qrToken = genQrToken();
    const qrToken2 = optionType === 'DOUBLE' ? genQrToken() : null; // 双人票：座位2 凭证码
    const outTradeNo = 'PAY' + reg.registration_no.slice(3);
    const transactionId = meta?.transactionId || 'mock_' + randNonce(8);
    const notifyRaw = meta?.notifyRaw || JSON.stringify({ source: 'mock-pay' });
    const upd = db
      .prepare(`UPDATE registrations SET status='PAID', paid_at=?, qr_token=?, qr_token_2=?, updated_at=? WHERE id=? AND status='PENDING'`)
      .run(now, qrToken, qrToken2, now, regId);
    if (upd.changes === 0) {
      const cur = (db.prepare('SELECT status FROM registrations WHERE id=?').get(regId) as Row)?.status;
      if (cur === 'PAID') return getRegistration(regId); // 并发下已被支付，幂等返回
      throw new HttpError(409, '支付状态已变化，请刷新后重试');
    }
    // 支付单落库：升级 prepay 的 PENDING 单，或（mock-pay 路径）新建 SUCCESS 单
    const existing = db.prepare(`SELECT id, status FROM payments WHERE registration_id=? ORDER BY id DESC LIMIT 1`).get(regId) as Row | null;
    if (existing && existing.status === 'PENDING') {
      db.prepare(`UPDATE payments SET status='SUCCESS', wechat_transaction_id=?, paid_at=?, raw_notify_data=?, updated_at=? WHERE id=?`)
        .run(transactionId, now, notifyRaw, now, existing.id);
    } else if (!existing) {
      db.prepare(`INSERT INTO payments (registration_id, out_trade_no, wechat_transaction_id, amount, status, paid_at, raw_notify_data, created_at, updated_at)
                  VALUES (?,?,?,?, 'SUCCESS', ?, ?, ?, ?)`)
        .run(regId, outTradeNo, transactionId, reg.amount, now, notifyRaw, now, now);
    }
    return getRegistration(regId);
  });
  // 订阅消息：支付成功后发「报名成功」通知（fire-and-forget，失败不影响支付结果；未配置模板自动跳过）
  if (result && result.status === 'PAID' && result.option_type !== 'WAITLIST') {
    void import('./subscribe.ts').then((m) => m.notifyPaySuccess(result)).catch(() => {});
  }
  return result;
}

/** 用户取消待支付报名。幂等；已支付不可取消（应走退款）。 */
export function cancelRegistration(regId: number): Row {
  const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(regId) as Row;
  if (!reg) throw new HttpError(404, '报名记录不存在');
  if (reg.status === 'CANCELLED') return getRegistration(regId); // 幂等
  if (reg.status !== 'PENDING') throw new HttpError(409, '已支付报名不能取消，请申请退款');
  const now = nowIso();
  db.prepare(`UPDATE registrations SET status='CANCELLED', cancelled_at=?, updated_at=? WHERE id=? AND status='PENDING'`).run(now, now, regId);
  return getRegistration(regId);
}

/**
 * 退款规则校验（§22）：可退返回 {reg,ev}，不可退抛错。
 * 供真实退款 API 调用前预校验 —— 避免"钱已退给微信，但本地规则拒绝"的不一致。
 */
export function assertRefundable(regId: number): { reg: Row; ev: Row } {
  const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(regId) as Row;
  if (!reg) throw new HttpError(404, '报名记录不存在');
  if (reg.status !== 'PAID') throw new HttpError(409, `当前状态 ${reg.status} 不可退款`);
  if (reg.checked_in_at) throw new HttpError(403, '该报名已签到，不能退款');
  const ev = getEventRow(reg.event_id);
  if (!ev) throw new HttpError(404, '活动不存在');
  const now = nowIso();
  const startMs = new Date(ev.start_time).getTime();
  const nowMs = Date.now();
  switch (ev.refund_rule) {
    case 'NO_SELF_REFUND':
      throw new HttpError(403, '该活动不支持自行退款');
    case 'BEFORE_24H':
      if (nowMs >= startMs - 24 * 3600 * 1000) throw new HttpError(403, '已超过活动开始前 24 小时，不能退款');
      break;
    case 'BEFORE_48H':
      if (nowMs >= startMs - 48 * 3600 * 1000) throw new HttpError(403, '已超过活动开始前 48 小时，不能退款');
      break;
    case 'ALLOW_ANY':
    default:
      if (now > ev.end_time) throw new HttpError(403, '活动已结束，不能退款');
      break;
  }
  return { reg, ev };
}

/**
 * 退款（§22）。服务端检查退款规则 + 是否已签到；幂等。
 * 状态机：PAID → REFUNDING → REFUNDED（真实模式由路由先调微信退款 API，再落此状态机）。
 * 已签到不可退；NO_SELF_REFUND 拒绝自行退款。
 */
export function refundRegistration(regId: number, reason?: string, realRefund?: { outRefundNo?: string }): Row {
  return tx(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(regId) as Row;
    if (!reg) throw new HttpError(404, '报名记录不存在');
    if (reg.status === 'REFUNDED') return getRegistration(regId); // 幂等
    if (reg.status === 'REFUNDING') return getRegistration(regId); // 处理中，幂等返回
    if (reg.status !== 'PAID') throw new HttpError(409, `当前状态 ${reg.status} 不可退款`);
    if (reg.checked_in_at) throw new HttpError(403, '该报名已签到，不能退款');

    const ev = getEventRow(reg.event_id);
    if (!ev) throw new HttpError(404, '活动不存在');
    const now = nowIso();
    const startMs = new Date(ev.start_time).getTime();
    const nowMs = Date.now();
    switch (ev.refund_rule) {
      case 'NO_SELF_REFUND':
        throw new HttpError(403, '该活动不支持自行退款');
      case 'BEFORE_24H':
        if (nowMs >= startMs - 24 * 3600 * 1000) throw new HttpError(403, '已超过活动开始前 24 小时，不能退款');
        break;
      case 'BEFORE_48H':
        if (nowMs >= startMs - 48 * 3600 * 1000) throw new HttpError(403, '已超过活动开始前 48 小时，不能退款');
        break;
      case 'ALLOW_ANY':
      default:
        if (now > ev.end_time) throw new HttpError(403, '活动已结束，不能退款');
        break;
    }

    // PAID → REFUNDING（原子转换，防并发重复退款）
    const t1 = db.prepare(`UPDATE registrations SET status='REFUNDING', updated_at=? WHERE id=? AND status='PAID'`).run(now, regId);
    if (t1.changes === 0) {
      const cur = (db.prepare('SELECT status FROM registrations WHERE id=?').get(regId) as Row)?.status;
      if (cur === 'REFUNDED') return getRegistration(regId);
      throw new HttpError(409, '退款状态已变化，请刷新后重试');
    }

    const outRefundNo = realRefund?.outRefundNo || ('REF' + reg.registration_no.slice(3) + randNonce(4).toUpperCase());
    db
      .prepare(`INSERT INTO refunds (registration_id, out_refund_no, amount, status, reason, created_at, updated_at)
                VALUES (?, ?, ?, 'PROCESSING', ?, ?, ?)`)
      .run(regId, outRefundNo, reg.amount, reason ? String(reason).slice(0, 500) : null, now, now);
    // 模拟微信支付退款成功
    db.prepare(`UPDATE payments SET status='REFUNDED', updated_at=? WHERE registration_id=? AND status='SUCCESS'`).run(now, regId);
    db.prepare(`UPDATE refunds SET status='SUCCESS', updated_at=? WHERE registration_id=?`).run(now, regId);
    // REFUNDING → REFUNDED
    db.prepare(`UPDATE registrations SET status='REFUNDED', refunded_at=?, updated_at=? WHERE id=? AND status='REFUNDING'`).run(now, now, regId);
    // 退票释放正票名额 → 按候补顺序自动补位一个转正（先到先得，转正为待支付）
    promoteWaitlist(ev.id);
    return getRegistration(regId);
  });
}

/**
 * 退票释放名额后自动补位：按候补顺序（created_at 先到先得）把一个候补转正为待支付正票。
 * 目标票种：候补登记时记录的意向票种（wish_option_id，若仍有额度）优先，否则活动内第一个有额度的正票。
 * 每次只补一个（一次退票释放一个名额）；无候补或无可补票种时返回 null。
 * 必须已处于事务内调用（refundRegistration 的 tx），保证与退票同成功同失败。
 */
export function promoteWaitlist(eventId: number): Row | null {
  const ev = getEventRow(eventId);
  if (!ev) return null;
  const queue = (db.prepare(
    `SELECT * FROM registrations
     WHERE event_id=? AND status='PAID'
       AND EXISTS (SELECT 1 FROM registration_options o WHERE o.id=registrations.registration_option_id AND o.option_type='WAITLIST')
     ORDER BY created_at ASC, id ASC`
  ).all(eventId) as Row[]);
  for (const w of queue) {
    let target: Row | null = null;
    if (w.wish_option_id) {
      const wish = (db.prepare(`SELECT * FROM registration_options WHERE id=? AND event_id=? AND status='ACTIVE' AND option_type<>'WAITLIST'`).get(w.wish_option_id, eventId) as Row | null) || null;
      if (wish && !optionSoldOut(wish, eventId)) target = wish;
    }
    if (!target) {
      const actives = db.prepare(`SELECT * FROM registration_options WHERE event_id=? AND status='ACTIVE' AND option_type<>'WAITLIST' ORDER BY sort_order, id`).all(eventId) as Row[];
      target = actives.find((o) => !optionSoldOut(o, eventId)) || null;
    }
    if (!target) break; // 该候补无可补票种，后面队列也补不了 → 停止
    // 转正：换为目标票种、金额=票价、置为待支付（需在支付时限内完成支付），清空旧凭证/核销痕迹，删除候补 0 元支付单
    db.prepare(`DELETE FROM payments WHERE registration_id=?`).run(w.id);
    const now = nowIso();
    db.prepare(
      `UPDATE registrations SET registration_option_id=?, wish_option_id=NULL, amount=?, status='PENDING', paid_at=NULL,
         qr_token=NULL, qr_token_2=NULL, checked_in_at=NULL, checked_in_at_2=NULL, updated_at=? WHERE id=?`
    ).run(target.id, Number(target.price), now, w.id);
    return getRegistration(w.id);
  }
  return null;
}

/** 清理超时未支付的 PENDING 报名（V0.1 软性清理，非库存机制）。返回清理数量。 */
export function closeExpiredRegistrations(): number {
  const deadline = new Date(Date.now() - REG_PAY_DEADLINE_MS).toISOString();
  const now = nowIso();
  const r = db
    .prepare(`UPDATE registrations SET status='CANCELLED', cancelled_at=?, updated_at=? WHERE status='PENDING' AND created_at <= ?`)
    .run(now, now, deadline);
  return Number(r.changes ?? 0);
}
