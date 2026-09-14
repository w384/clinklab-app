import { db, tx } from '../db.ts';
import { nowIso, HttpError, maskPhone, fmtTime } from '../util.ts';

type Row = Record<string, any>;

const CHECKIN_METHODS = ['QR', 'PHONE_LAST4'];

function getEventRow(id: number): Row | null {
  return db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | null;
}

function getOptionRow(id: number | null): Row | null {
  if (!id) return null;
  return (db.prepare('SELECT * FROM registration_options WHERE id=?').get(id) as Row | null) || null;
}

/** 现场签到展示用的报名摘要（脱敏手机号，§17/§20；含票种 + 座位核销进度）。 */
function serializeForCheckin(reg: Row, ev: Row | null, option: Row | null): Row {
  const optionType = option?.option_type || (option ? 'SINGLE' : null);
  const isDouble = optionType === 'DOUBLE';
  const seats = isDouble ? 2 : 1;
  const checked = Boolean(reg.checked_in_at);
  const checked2 = Boolean(reg.checked_in_at_2);
  const checkedCount = (checked ? 1 : 0) + (checked2 ? 1 : 0);
  return {
    registration_id: reg.id,
    registration_no: reg.registration_no,
    name: reg.name,
    masked_phone: maskPhone(reg.phone),
    registration_option: option ? option.name : null,
    option_type: optionType,
    registration_status: reg.status,
    seats,
    checked_in: checked,
    checked_in_2: checked2,
    checked_count: checkedCount,
    all_checked_in: checkedCount === seats,
    checkin_status: checkedCount === seats ? 'CHECKED_IN' : checkedCount > 0 ? 'PARTIAL' : 'NOT_CHECKED_IN',
    checked_in_at: reg.checked_in_at,
    checked_in_at_2: reg.checked_in_at_2,
    event: ev
      ? { id: ev.id, title: ev.title, start_time: ev.start_time, start_time_display: fmtTime(ev.start_time), status: ev.status }
      : null,
  };
}

/** 二维码定位报名（§12/§14）：qr_token/qr_token_2 → Registration + 座位号（供工作人员核对后确认）。 */
export function resolveByQrToken(qrToken: string): Row {
  if (!qrToken) throw new HttpError(400, '缺少 qr_token');
  const reg = db.prepare('SELECT * FROM registrations WHERE qr_token=? OR qr_token_2=?').get(qrToken, qrToken) as Row;
  if (!reg) throw new HttpError(404, '凭证无效或不存在');
  const seatNo = reg.qr_token === qrToken ? 1 : 2; // 双人票：区分是第几码
  const ev = getEventRow(reg.event_id);
  const option = getOptionRow(reg.registration_option_id);
  return { registration: serializeForCheckin(reg, ev, option), seat_no: seatNo };
}

/**
 * 手机号后四位查询（§15/§16/§20）：范围限定当前活动，status=PAID，返回脱敏候选。
 * 仅用于快速定位，不自动签到（§17）。
 */
export function searchByPhoneLast4(eventId: number, phoneLast4: string): Row {
  const last4 = String(phoneLast4 || '').trim();
  if (!/^\d{4}$/.test(last4)) throw new HttpError(400, '请输入 4 位数字（手机号后四位）');
  const ev = getEventRow(eventId);
  if (!ev) throw new HttpError(404, '活动不存在');
  const rows = (db.prepare(`SELECT * FROM registrations WHERE event_id=? AND status='PAID'`).all(eventId) as Row[])
    .filter((r) => String(r.phone || '').slice(-4) === last4)
    .map((r) => serializeForCheckin(r, ev, getOptionRow(r.registration_option_id)))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    event_id: eventId,
    event_title: ev.title,
    phoneLast4: last4,
    count: rows.length,
    candidates: rows,
  };
}

/**
 * 统一签到（§19）：二维码签到与手机号后四位签到都调用这里。
 * 服务端负责全部校验 + 原子防重（§14/§19）：
 *   状态必须 PAID；已退款/已取消不可；已签到幂等返回；
 *   并发下只有一个成功（BEGIN IMMEDIATE + checked_in_at IS NULL 条件更新）。
 */
export function performCheckin(registrationId: number, method: string, operatorName?: string, operatorAdminId?: number | null, seatNo?: number): Row {
  if (!CHECKIN_METHODS.includes(method)) throw new HttpError(400, `签到方式必须是 ${CHECKIN_METHODS.join('/')}`);
  const seat = seatNo === 2 ? 2 : 1;
  return tx(() => {
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(registrationId) as Row;
    if (!reg) throw new HttpError(404, '报名记录不存在');

    if (reg.status === 'REFUNDING' || reg.status === 'REFUNDED') throw new HttpError(403, '已退款报名不能签到');
    if (reg.status === 'CANCELLED') throw new HttpError(403, '已取消报名不能签到');
    if (reg.status !== 'PAID') throw new HttpError(403, '未支付成功不能签到');

    const ev = getEventRow(reg.event_id);
    if (ev && ev.status === 'CANCELLED') throw new HttpError(403, '活动已取消，不能签到');

    const option = getOptionRow(reg.registration_option_id);
    const optionType = option?.option_type || 'SINGLE';
    // 候补票不出码、不核销（仅统计候补人数）
    if (optionType === 'WAITLIST') throw new HttpError(403, '候补票无需核销（仅统计候补人数）');
    // 双人票才有座位2；其余票种只核销座位1
    const targetSeat = optionType === 'DOUBLE' && seat === 2 ? 2 : 1;
    const seatCol = targetSeat === 2 ? 'checked_in_at_2' : 'checked_in_at';

    // 幂等：该座位已核销直接返回（§14 第二次扫码提示"已核销"）
    if (reg[seatCol]) {
      return {
        already: true,
        seat_no: targetSeat,
        registration: serializeForCheckin(reg, ev, option),
        message: `该座位已核销，核销时间：${fmtTime(reg[seatCol])}`,
      };
    }

    const now = nowIso();
    // 原子防重：只有该座位仍未核销且 PAID 时才写入（并发下仅一个成功，§19）
    const upd = db
      .prepare(`UPDATE registrations SET ${seatCol}=?, updated_at=? WHERE id=? AND ${seatCol} IS NULL AND status='PAID'`)
      .run(now, now, registrationId);
    if (upd.changes === 0) {
      const cur = db.prepare(`SELECT ${seatCol} AS v FROM registrations WHERE id=?`).get(registrationId) as Row;
      if (cur && cur.v) {
        return { already: true, seat_no: targetSeat, registration: serializeForCheckin(reg, ev, option), message: `该座位已核销，核销时间：${fmtTime(cur.v)}` };
      }
      throw new HttpError(409, '核销状态已变化，请刷新后重试');
    }

    db
      .prepare(
        `INSERT INTO checkins (registration_id, event_id, operator_user_id, operator_admin_id, operator_name, method, seat_no, checked_in_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(registrationId, reg.event_id, null, operatorAdminId ?? null, operatorName ? String(operatorName).slice(0, 64) : null, method, targetSeat, now, now);

    const fresh = db.prepare('SELECT * FROM registrations WHERE id=?').get(registrationId) as Row;
    return {
      already: false,
      seat_no: targetSeat,
      registration: serializeForCheckin(fresh, ev, option),
      message: targetSeat === 2 ? '第 2 码核销成功' : '核销成功',
    };
  });
}
