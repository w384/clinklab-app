import { db, tx } from '../db.ts';
import { nowIso, HttpError, fmtCents, fmtTime } from '../util.ts';
import { API_BASE_URL } from '../config.ts';
import { eventReviewStats } from './reviews.ts';
import { countOptionPaid } from './registrations.ts';
import { isLiked } from './likes.ts';

type Row = Record<string, any>;

const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'ENDED', 'OFFLINE', 'CANCELLED'];
const REFUND_RULES = ['ALLOW_ANY', 'BEFORE_24H', 'BEFORE_48H', 'NO_SELF_REFUND'];
const OPTION_TYPES = ['SINGLE', 'DOUBLE', 'INVITE', 'WAITLIST'];

/** 购买邀请码规范化：trim + 大写；空 → null。 */
function normGate(g: unknown): string | null {
  const s = String(g ?? '').trim();
  return s ? s.toUpperCase() : null;
}
/** 校验购买邀请码格式（邀请票必填）。 */
function assertGate(g: unknown): string {
  const s = String(g ?? '').trim();
  if (!/^[A-Za-z0-9-]{4,32}$/.test(s)) throw new HttpError(400, '购买邀请码需为 4-32 位字母/数字/连字符');
  return s.toUpperCase();
}

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

/** 已报名"人数"：PAID 且非候补，按座位计（单人/邀请=1，双人=2）。用于列表"N 人参加"。 */
function countAttendance(eventId: number): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.option_type='DOUBLE' THEN 2 ELSE 1 END), 0) AS n
       FROM registrations r
       LEFT JOIN registration_options o ON o.id = r.registration_option_id
       WHERE r.event_id=? AND r.status='PAID'
         AND (o.option_type IS NULL OR o.option_type <> 'WAITLIST')`
    )
    .get(eventId) as { n: number };
  return Number(r?.n ?? 0);
}

/** 候补中人数：PAID 且票种=候补。 */
function countWaitlist(eventId: number): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM registrations r
       JOIN registration_options o ON o.id = r.registration_option_id
       WHERE r.event_id=? AND r.status='PAID' AND o.option_type='WAITLIST'`
    )
    .get(eventId) as { n: number };
  return Number(r?.n ?? 0);
}

/** 最终核验人数：签到记录条数（双人票两个座位各核销各记一条）。 */
function countCheckedIn(eventId: number): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM checkins WHERE event_id=?`).get(eventId) as { n: number };
  return Number(r?.n ?? 0);
}

/** 详情图片：存 JSON 数组字符串；读出解析成数组（容错坏数据）。 */
function parseDetailImages(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

/** 自定义报名字段定义：{ key, label, required?, type?, options? }。存 JSON 数组字符串，读出解析（容错坏数据）。 */
export interface CustomFieldDef {
  key: string;
  label: string;
  required?: boolean;
  type?: 'text' | 'textarea' | 'choice';
  options?: string[]; // type='choice' 时的固定勾选选项（如 有酒/无酒/热饮）
}
export function parseCustomFields(raw: unknown): CustomFieldDef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x) =>
          x &&
          typeof x === 'object' &&
          typeof x.key === 'string' &&
          x.key.length > 0 &&
          typeof x.label === 'string' &&
          x.label.length > 0
      )
      .map((x) => ({
        key: String(x.key).slice(0, 50),
        label: String(x.label).slice(0, 50),
        required: x.required === true,
        type: x.type === 'textarea' ? 'textarea' : x.type === 'choice' ? 'choice' : 'text',
        options:
          Array.isArray(x.options) && x.options.length
            ? x.options.map((o: any) => String(o).trim()).filter((o: string) => o.length > 0).slice(0, 10)
            : undefined,
      }));
  } catch {
    return [];
  }
}
function stringifyCustomFields(v: unknown): string | null {
  // 入参是对象数组（后台/种子传入）；parseCustomFields 期望 JSON 字符串，这里直接校验数组
  if (!Array.isArray(v)) return null;
  const defs = v
    .filter((x) => x && typeof x === 'object' && typeof x.key === 'string' && x.key.length > 0 && typeof x.label === 'string' && x.label.length > 0)
    .map((x) => {
      const type = x.type === 'textarea' ? 'textarea' : x.type === 'choice' ? 'choice' : 'text';
      const options =
        Array.isArray(x.options) && x.options.length
          ? x.options.map((o: any) => String(o).trim()).filter((o: string) => o.length > 0).slice(0, 10)
          : undefined;
      return {
        key: String(x.key).slice(0, 50),
        label: String(x.label).slice(0, 50),
        required: x.required === true,
        type,
        ...(type === 'choice' ? { options: options && options.length ? options : ['选项1', '选项2'] } : {}),
      };
    });
  return defs.length ? JSON.stringify(defs) : null;
}

/** 相对上传路径（/uploads/…）→ 绝对 URL（小程序端直接用）。其余（http/data:）原样返回。 */
function absolutizeImage(u: string): string {
  return u && u.startsWith('/uploads/') ? API_BASE_URL + u : u;
}

/** 绝对 URL → 相对路径（写库时归一化，DB 只存相对路径，跨环境可迁移）。 */
function relativizeImage(u: string): string {
  return API_BASE_URL && u.startsWith(API_BASE_URL) ? u.slice(API_BASE_URL.length) : u;
}

/** 正文 HTML 里 /uploads/… 的图片 src → 绝对 URL（小程序 rich-text 无法解析相对地址）。 */
function absolutizeDescHtml(html: string): string {
  if (!html || html.indexOf('/uploads/') < 0) return html;
  return html.replace(/src="\/(uploads\/[^"]+)"/g, (m, p) => `src="${API_BASE_URL}/${p}"`);
}

/** 正文 HTML 写库时把绝对 URL 的图片 src 归一化为相对路径。 */
function relativizeDescHtml(html: string): string {
  if (!html || !API_BASE_URL) return html;
  const base = API_BASE_URL.replace(/\/$/, '');
  if (html.indexOf(base) < 0) return html;
  return html.split(base + '/').join('/');
}

function serializeEvent(e: Row, withOptions: boolean, userId = 0): Row {
  const options: Row[] = withOptions
    ? (db.prepare('SELECT * FROM registration_options WHERE event_id=? AND status=\'ACTIVE\' ORDER BY sort_order, id').all(e.id) as Row[])
        .map((o) => {
          const { gate_code, ...rest } = o; // 公开 API 不泄露购买邀请码（后台专用接口才返回）
          void gate_code;
          const soldCount = o.option_type === 'WAITLIST' ? 0 : countOptionPaid(Number(o.id));
          const limit = o.sold_limit === null || o.sold_limit === undefined ? 0 : Number(o.sold_limit);
          return {
            ...rest,
            price_display: fmtCents(Number(o.price)),
            sold_count: soldCount,
            remaining: limit > 0 ? Math.max(0, limit - soldCount) : null, // null=不限量
          };
        })
    : [];
  const validPaid = countValidPaid(e.id);
  // 动态名额（capacity 废弃）：总可参与人数 = Σ(正票种购票上限 × 权重：双人=2、单人/邀请=1)，候补不计；
  // 任一正票种购票上限留空（不限量）→ 总名额视为不限（前端名额处不显示）；full = 所有正票种均售罄。
  const paidOptions = options.filter((o) => o.option_type !== 'WAITLIST');
  let totalCapacity: number | null = 0;
  let allSoldOut = paidOptions.length > 0;
  for (const o of paidOptions) {
    const limit = o.sold_limit === null || o.sold_limit === undefined ? 0 : Number(o.sold_limit);
    const soldCount = countOptionPaid(Number(o.id));
    if (limit <= 0) { totalCapacity = null; allSoldOut = false; continue; }
    if (totalCapacity !== null) totalCapacity += limit * (o.option_type === 'DOUBLE' ? 2 : 1);
    if (soldCount < limit) allSoldOut = false;
  }
  if (totalCapacity === null) allSoldOut = false;
  const attendance = countAttendance(e.id);
  const remainingCapacity = totalCapacity === null ? null : Math.max(0, totalCapacity - attendance);
  const full = allSoldOut;
  return {
    ...e,
    cover_image: e.cover_image ? absolutizeImage(String(e.cover_image)) : null,
    cover_detail_image: e.cover_detail_image ? absolutizeImage(String(e.cover_detail_image)) : null,
    description: absolutizeDescHtml(String(e.description || '')), // 正文里的内插图（/uploads/…）转绝对 URL（小程序 rich-text 需要）
    registrationOptions: options,
    valid_paid_count: validPaid,
    attendance_count: attendance, // 已报名人数（双人票按 2 计）
    total_capacity: totalCapacity, // 总可参与人数（Σ购票上限×权重）；任一票种不限量 → null
    remaining_capacity: remainingCapacity, // 剩余可参与人数；total_capacity 为 null 时也是 null
    waitlist_count: countWaitlist(e.id), // 候补中人数
    checked_in_count: countCheckedIn(e.id), // 已核销人数
    detail_images: parseDetailImages(e.detail_images).map(absolutizeImage), // 详情图片（JSON 数组 → 数组，相对→绝对）
    custom_fields: parseCustomFields(e.custom_fields), // 自定义报名字段定义（供小程序报名表单渲染）
    review_count: eventReviewStats(e.id).count, // 评价数（C⑨）
    review_avg: eventReviewStats(e.id).avg, // 平均分（1-5 星，保留 1 位）
    view_count: Number(e.view_count ?? 0), // 浏览数
    like_count: Number(
      db.prepare("SELECT COUNT(*) AS n FROM likes WHERE target_type='EVENT' AND target_id=?").get(e.id)?.n ?? 0
    ), // 点赞数
    comment_count: Number(
      db.prepare("SELECT COUNT(*) AS n FROM comments WHERE target_type='EVENT' AND target_id=?").get(e.id)?.n ?? 0
    ), // 评论数
    liked: isLiked(userId, 'EVENT', Number(e.id)), // 当前用户是否已赞
    capacity: e.capacity === null || e.capacity === undefined ? null : Number(e.capacity), // 兼容旧字段（不再参与名额逻辑）
    full,
    start_time_display: fmtTime(e.start_time),
    end_time_display: fmtTime(e.end_time),
  };
}

/** 公开活动列表：仅返回"可报名 / 进行中"的已发布活动（§2 用户端）。 */
export function listEvents(userId = 0): Row[] {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE status='PUBLISHED'
         AND registration_start_time <= ? AND registration_end_time >= ?
       ORDER BY registration_start_time DESC, id DESC`
    )
    .all(now) as Row[];
  // 兜底：若时间窗口已过但活动仍在，仍返回已发布的（前端按 status 展示）
  if (rows.length === 0) {
    return (db.prepare(`SELECT * FROM events WHERE status='PUBLISHED' ORDER BY id DESC`).all() as Row[]).map((e) => serializeEvent(e, true, userId));
  }
  return rows.map((e) => serializeEvent(e, true, userId));
}

export function getEvent(id: number, userId = 0): Row {
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row;
  if (!e) throw new HttpError(404, '活动不存在');
  return serializeEvent(e, true, userId);
}

/** 浏览数 +1（小程序进入详情页时调用）。 */
export function incrementView(id: number): Row {
  const e = db.prepare('SELECT id FROM events WHERE id=?').get(id) as Row;
  if (!e) throw new HttpError(404, '活动不存在');
  db.prepare('UPDATE events SET view_count = COALESCE(view_count,0) + 1, updated_at=? WHERE id=?').run(nowIso(), id);
  return getEvent(id);
}

/** 归档活动列表（后台「归档活动」标签）：已结束/已下架/已取消的活动，只显示活动信息 + 最终核验人数，不带票种。 */
export function listArchivedEvents(): Row[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE status IN ('ENDED','OFFLINE','CANCELLED') ORDER BY updated_at DESC, id DESC`)
    .all() as Row[];
  return rows.map((e) => {
    const s = serializeEvent(e, false);
    return {
      id: s.id,
      title: s.title,
      subtitle: s.subtitle,
      category: s.category,
      cover_image: s.cover_image,
      location_city: s.location_city,
      location_name: s.location_name,
      location_address: s.location_address,
      start_time: s.start_time,
      end_time: s.end_time,
      status: s.status,
      capacity: s.capacity,
      valid_paid_count: s.valid_paid_count,
      attendance_count: s.attendance_count,
      checked_in_count: s.checked_in_count,
      start_time_display: s.start_time_display,
      end_time_display: s.end_time_display,
      updated_at: s.updated_at,
    };
  });
}

export interface CreateEventInput {
  title: string;
  subtitle?: string;
  coverImage?: string;
  coverDetailImage?: string;
  description?: string;
  category?: string;
  locationCity?: string;
  locationName?: string;
  locationAddress?: string;
  reminder?: string;
  detailImages?: string[];
  startTime: string;
  endTime: string;
  registrationStartTime: string;
  registrationEndTime: string;
  status?: string;
  capacity?: number | null;
  refundRule?: string;
  contactInfo?: string;
  latitude?: number | null;
  longitude?: number | null;
  customFields?: CustomFieldDef[] | null;
}

export function createEvent(input: CreateEventInput): Row {
  const now = nowIso();
  const status = input.status && EVENT_STATUSES.includes(input.status) ? input.status : 'DRAFT';
  const refundRule = input.refundRule && REFUND_RULES.includes(input.refundRule) ? input.refundRule : 'NO_SELF_REFUND';
  const capacity = input.capacity === undefined ? null : input.capacity === null ? null : Number(input.capacity);
  if (capacity !== null && (Number.isNaN(capacity) || capacity < 0)) throw new HttpError(400, '名额 capacity 不能为负');
  const detailImages = Array.isArray(input.detailImages) ? JSON.stringify(input.detailImages.filter((x) => typeof x === 'string' && x)) : null;
  const description = relativizeDescHtml(String(input.description || ''));
  const res = db
    .prepare(
      `INSERT INTO events (title, subtitle, cover_image, cover_detail_image, description, category, location_city, location_name, location_address, reminder, detail_images,
        start_time, end_time, registration_start_time, registration_end_time, status, capacity, refund_rule, contact_info, latitude, longitude, custom_fields, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.title,
      input.subtitle ?? null,
      input.coverImage ?? null,
      input.coverDetailImage ?? null,
      description || null,
      input.category ?? null,
      input.locationCity ?? null,
      input.locationName ?? null,
      input.locationAddress ?? null,
      input.reminder ?? null,
      detailImages,
      input.startTime,
      input.endTime,
      input.registrationStartTime,
      input.registrationEndTime,
      status,
      capacity,
      refundRule,
      input.contactInfo ?? null,
      input.latitude === undefined || input.latitude === null ? null : Number(input.latitude),
      input.longitude === undefined || input.longitude === null ? null : Number(input.longitude),
      stringifyCustomFields(input.customFields),
      now,
      now
    );
  return getEvent(Number(res.lastInsertRowid));
}

export function updateEvent(id: number, patch: Record<string, any>): Row {
  const e = db.prepare('SELECT id FROM events WHERE id=?').get(id) as Row;
  if (!e) throw new HttpError(404, '活动不存在');
  const fields: string[] = [];
  const vals: any[] = [];
  const set = (col: string, v: any) => {
    fields.push(`${col}=?`);
    vals.push(v);
  };
  const map: Record<string, string> = {
    title: 'title',
    subtitle: 'subtitle',
    coverImage: 'cover_image',
    cover_image: 'cover_image',
    description: 'description',
    category: 'category',
    locationCity: 'location_city',
    location_city: 'location_city',
    locationName: 'location_name',
    location_name: 'location_name',
    locationAddress: 'location_address',
    location_address: 'location_address',
    reminder: 'reminder',
    startTime: 'start_time',
    start_time: 'start_time',
    endTime: 'end_time',
    end_time: 'end_time',
    registrationStartTime: 'registration_start_time',
    registration_start_time: 'registration_start_time',
    registrationEndTime: 'registration_end_time',
    registration_end_time: 'registration_end_time',
    refundRule: 'refund_rule',
    refund_rule: 'refund_rule',
    contactInfo: 'contact_info',
    contact_info: 'contact_info',
    status: 'status',
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'capacity') {
      if (v !== null) {
        const n = Number(v);
        if (Number.isNaN(n) || n < 0) throw new HttpError(400, '名额 capacity 不能为负');
        const paid = countValidPaid(id);
        if (n < paid) throw new HttpError(400, `名额不能低于已支付人数（当前 ${paid} 人，可设为 null 表示不限）`);
      }
      set('capacity', v === null ? null : Number(v));
    } else if (k === 'latitude' || k === 'longitude') {
      set(k, v === null || v === '' ? null : Number(v));
    } else if (k === 'customFields' || k === 'custom_fields') {
      set('custom_fields', stringifyCustomFields(v));
    } else if (k === 'coverImage' || k === 'cover_image') {
      // 封面图：绝对 URL 归一化为相对路径存库（DB 不存环境相关的完整地址）
      set('cover_image', v ? relativizeImage(String(v)) : null);
    } else if (k === 'coverDetailImage' || k === 'cover_detail_image') {
      set('cover_detail_image', v ? relativizeImage(String(v)) : null);
    } else if (k === 'description') {
      // 正文里的内插图绝对 URL → 相对路径存库（跨环境可迁移）
      set('description', v ? relativizeDescHtml(String(v)) : null);
    } else if (k === 'detailImages' || k === 'detail_images') {
      const arr = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map(relativizeImage) : [];
      set('detail_images', arr.length ? JSON.stringify(arr) : null);
    } else if (k === 'status') {
      if (!EVENT_STATUSES.includes(v)) throw new HttpError(400, `status 必须是 ${EVENT_STATUSES.join('/')}`);
      set('status', v);
    } else if (map[k]) {
      set(map[k], v);
    }
  }
  if (fields.length === 0) throw new HttpError(400, '没有要更新的字段');
  set('updated_at', nowIso());
  vals.push(id);
  db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id=?`).run(...vals);
  return getEvent(id);
}

/** 发布 / 下架 / 结束 / 取消（§23 活动管理）。 */
export function setEventStatus(id: number, status: string): Row {
  if (!EVENT_STATUSES.includes(status)) throw new HttpError(400, `status 必须是 ${EVENT_STATUSES.join('/')}`);
  const e = db.prepare('SELECT id FROM events WHERE id=?').get(id) as Row;
  if (!e) throw new HttpError(404, '活动不存在');
  db.prepare('UPDATE events SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
  return getEvent(id);
}

export interface OptionInput {
  name: string;
  description?: string;
  price: number; // 分
  optionType?: string; // SINGLE/DOUBLE/INVITE/WAITLIST
  gateCode?: string; // 邀请票的购买门槛码
  sortOrder?: number;
  status?: string;
  soldLimit?: number | null; // 该票种可购正票上限（>0 生效；null/0=不限）
}

export function addRegistrationOption(eventId: number, input: OptionInput): Row {
  const ev = db.prepare('SELECT id FROM events WHERE id=?').get(eventId) as Row;
  if (!ev) throw new HttpError(404, '活动不存在');
  if (Number.isNaN(Number(input.price)) || Number(input.price) < 0) throw new HttpError(400, '报名价格必须为非负整数（分）');
  const optionType = OPTION_TYPES.includes(input.optionType as string) ? (input.optionType as string) : 'SINGLE';
  let gateCode: string | null = null;
  let price = Number(input.price);
  if (optionType === 'INVITE') gateCode = assertGate(input.gateCode);
  if (optionType === 'WAITLIST') price = 0; // 候补票免费
  const now = nowIso();
  const soldLimit = normalizeSoldLimit(input.soldLimit);
  const res = db
    .prepare(
      `INSERT INTO registration_options (event_id, name, description, price, option_type, gate_code, status, sort_order, sold_limit, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(eventId, input.name, input.description ?? null, price, optionType, gateCode, input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', input.sortOrder ?? 0, soldLimit, now);
  return db.prepare('SELECT * FROM registration_options WHERE id=?').get(Number(res.lastInsertRowid)) as Row;
}

/** sold_limit 归一化：null/undefined/NaN/0/负 → null（不限）；正整数 → 该值。 */
function normalizeSoldLimit(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function updateRegistrationOption(id: number, patch: Record<string, any>): Row {
  const o = db.prepare('SELECT * FROM registration_options WHERE id=?').get(id) as Row;
  if (!o) throw new HttpError(404, '报名类型不存在');

  // 合并 patch 与现有值，应用一致性约束：候补免费/清除门槛码；邀请必填门槛码；非邀请清除门槛码
  let finalType = o.option_type || 'SINGLE';
  if (patch.optionType !== undefined) {
    if (!OPTION_TYPES.includes(patch.optionType)) throw new HttpError(400, '票种必须是 SINGLE/DOUBLE/INVITE/WAITLIST');
    finalType = patch.optionType;
  }
  let finalGate: string | null = null;
  if (finalType === 'INVITE') {
    const g = patch.gateCode !== undefined ? String(patch.gateCode || '').trim() : String(o.gate_code || '').trim();
    finalGate = assertGate(g);
  } else if (patch.gateCode !== undefined) {
    finalGate = normGate(patch.gateCode);
  } else {
    finalGate = null; // 切换到非邀请票：清除旧门槛码
  }
  let finalPrice = Number(o.price);
  if (patch.price !== undefined) {
    if (Number.isNaN(Number(patch.price)) || Number(patch.price) < 0) throw new HttpError(400, '报名价格必须为非负整数（分）');
    finalPrice = Number(patch.price);
  }
  if (finalType === 'WAITLIST') finalPrice = 0; // 候补票免费

  const fields: string[] = [];
  const vals: any[] = [];
  const set = (col: string, v: any) => {
    fields.push(`${col}=?`);
    vals.push(v);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.optionType !== undefined) set('option_type', finalType);
  if (patch.gateCode !== undefined || (finalType !== 'INVITE' && o.gate_code)) set('gate_code', finalGate);
  if (patch.price !== undefined || finalType === 'WAITLIST') set('price', finalPrice);
  if (patch.sortOrder !== undefined) set('sort_order', Number(patch.sortOrder));
  if (patch.soldLimit !== undefined) set('sold_limit', normalizeSoldLimit(patch.soldLimit));
  if (patch.status !== undefined) set('status', patch.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
  if (fields.length === 0) throw new HttpError(400, '没有要更新的字段');
  db.prepare(`UPDATE registration_options SET ${fields.join(', ')} WHERE id=?`).run(...vals, id);
  return db.prepare('SELECT * FROM registration_options WHERE id=?').get(id) as Row;
}

/** 删除某活动的票种（§ ②）：该票种已有报名时禁止删除（避免报名丢失票种信息），否则物理删除。 */
export function deleteRegistrationOption(optionId: number): { ok: boolean } {
  const o = db.prepare('SELECT id, event_id FROM registration_options WHERE id=?').get(optionId) as Row;
  if (!o) throw new HttpError(404, '报名类型不存在');
  const used = Number((db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE registration_option_id=?').get(optionId) as { n: number })?.n ?? 0);
  if (used > 0) throw new HttpError(409, `该票种已有 ${used} 条报名，不能删除`);
  db.prepare('DELETE FROM registration_options WHERE id=?').run(optionId);
  return { ok: true };
}

/** 删除活动（§ ①，不可逆）：级联删除其票种 / 报名 / 支付 / 退款 / 签到。UI 需二次确认。 */
export function deleteEvent(id: number): { ok: boolean; deleted: { event: number; options: number; registrations: number } } {
  const e = db.prepare('SELECT id FROM events WHERE id=?').get(id) as Row;
  if (!e) throw new HttpError(404, '活动不存在');
  return tx(() => {
    const regIds = (db.prepare('SELECT id FROM registrations WHERE event_id=?').all(id) as Array<{ id: number }>).map((r) => r.id);
    if (regIds.length) {
      const ph = regIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM payments WHERE registration_id IN (${ph})`).run(...regIds);
      db.prepare(`DELETE FROM refunds WHERE registration_id IN (${ph})`).run(...regIds);
      db.prepare(`DELETE FROM checkins WHERE registration_id IN (${ph})`).run(...regIds);
    }
    const nRegs = Number((db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id=?').get(id) as { n: number })?.n ?? 0);
    db.prepare('DELETE FROM registrations WHERE event_id=?').run(id);
    const nOpts = Number((db.prepare('SELECT COUNT(*) AS n FROM registration_options WHERE event_id=?').get(id) as { n: number })?.n ?? 0);
    db.prepare('DELETE FROM registration_options WHERE event_id=?').run(id);
    db.prepare('DELETE FROM events WHERE id=?').run(id);
    return { ok: true, deleted: { event: 1, options: nOpts, registrations: nRegs } };
  });
}
