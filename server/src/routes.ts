import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as events from './services/events.ts';
import * as registrations from './services/registrations.ts';
import * as checkin from './services/checkin.ts';
import * as admin from './services/admin.ts';
import * as wxpay from './services/wxpay.ts';
import * as subscribe from './services/subscribe.ts';
import * as reviews from './services/reviews.ts';
import * as shares from './services/shares.ts';
import * as comments from './services/comments.ts';
import * as likes from './services/likes.ts';
import * as posts from './services/posts.ts';
import { qrDataUrl } from './services/qr.ts';
import {
  wxLogin, requireAuth, requireAdmin, destroySession, bearerToken,
  getSessionUser, getAdminSession, adminLogin, destroyAdminSession,
  updateProfile, wxPhoneDecrypt,
} from './auth.ts';
import { db } from './db.ts';
import { HttpError, fmtCents, nowIso } from './util.ts';
import { APP_ENV, API_BASE_URL, MOCK_PAY_ENABLED, ADMIN_USERNAME, ADMIN_PASSWORD, WX_PAY_USE_REAL } from './config.ts';

type Row = Record<string, any>;
type Req = { headers?: Record<string, any>; params?: any; query?: any; body?: any; log?: any };

/** 现场工作人员（§25）：被标记为工作人员（is_admin）的用户，或管理端登录态。普通用户一律 403。 */
function requireStaff(req: Req): Row {
  const token = bearerToken(req);
  const user = getSessionUser(token);
  if (user) {
    if (user.isAdmin) return user;
    throw new HttpError(403, '需要工作人员权限（请联系管理员开通）');
  }
  const adm = getAdminSession(token);
  if (adm) return adm;
  throw new HttpError(401, '需要登录（工作人员或管理端）');
}

/** 可选登录态：有 token 且有效则返回用户，否则 null（公开接口的 liked 状态用）。 */
function optionalUser(req: Req): Row | null {
  const token = bearerToken(req);
  if (!token) return null;
  return getSessionUser(token) || null;
}

function loadRegistration(id: number): Row {
  const r = db.prepare('SELECT * FROM registrations WHERE id=?').get(id) as Row;
  if (!r) throw new HttpError(404, '报名记录不存在');
  return r;
}

/** 归属校验：用户只能操作自己的报名（身份来自服务端登录态，客户端不声明身份）。 */
function assertOwner(user: Row, regId: number): Row {
  const r = loadRegistration(regId);
  if (Number(r.user_id) !== Number(user.userId)) throw new HttpError(403, '无权操作该报名记录');
  return r;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ───────────── 全局错误处理 ─────────────
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      const where = first?.path?.length ? first.path.join('.') : 'body';
      return reply.status(400).send({ error: `参数错误（${where}）：${first?.message || '请求参数不合法'}` });
    }
    if (err?.validation) return reply.status(400).send({ error: err.message || '请求参数错误' });
    req?.log?.error(err);
    const sc = err?.statusCode;
    const status = typeof sc === 'number' && sc >= 400 && sc < 600 ? sc : 500;
    return reply.status(status).send({ error: err?.message || '服务器内部错误' });
  });
  app.setNotFoundHandler((_req: any, reply: any) => reply.status(404).send({ error: '接口不存在' }));

  // ───────────── 公共 ─────────────
  app.get('/health', async () => ({ ok: true, service: 'clinklab-registration', version: '0.1.0', env: APP_ENV, mockPayEnabled: MOCK_PAY_ENABLED }));

  /** 客户端据此读取环境 + API 基址 + 是否可用模拟支付（§28：不写死地址）。 */
  app.get('/config', async () => ({ env: APP_ENV, apiBaseUrl: API_BASE_URL, mockPayEnabled: MOCK_PAY_ENABLED }));

  /** 微信登录：code → 系统 token。客户端不得自行声明 openid/user_id（§32）。 */
  app.post('/auth/wechat-login', async (req: any) => {
    const b = z.object({ code: z.string().min(1) }).parse(req.body || {});
    return wxLogin(b.code);
  });

  app.get('/events', async (req: any) => events.listEvents(Number(optionalUser(req)?.userId || 0)));
  app.get('/events/:id', async (req: any) => events.getEvent(Number(req.params.id), Number(optionalUser(req)?.userId || 0)));
  /** 进入详情页浏览 +1（小程序详情页 onLoad 时调用）。 */
  app.post('/events/:id/view', async (req: any) => events.incrementView(Number(req.params.id)));

  // ───────────── 登录态（用户） ─────────────
  app.get('/me', async (req: any) => requireAuth(req));
  /** 完善/更新资料（首次登录补全昵称/手机/头像）。昵称、手机、头像均可选，只更新传入的字段。 */
  app.put('/me', async (req: any) => {
    const user = requireAuth(req);
    const b = z
      .object({
        nickname: z.string().max(64).optional(),
        phone: z.string().max(20).optional(),
        avatar: z.string().max(1_300_000).optional(),
      })
      .parse(req.body || {});
    return { ok: true, user: updateProfile(Number(user.userId), b) };
  });
  app.post('/me/logout', async (req: any) => {
    destroySession(bearerToken(req));
    return { ok: true };
  });
  /** 微信一键获取手机号（getPhoneNumber 的 code → 服务端解密）。开发模式未配置凭证则 400，前端引导手动输入。 */
  app.post('/me/phone', async (req: any) => {
    const user = requireAuth(req);
    const b = z.object({ code: z.string().min(1) }).parse(req.body || {});
    const res = await wxPhoneDecrypt(Number(user.userId), b.code);
    return { ok: true, user: { userId: res.userId, phone: res.phone } };
  });

  // ───────────── 报名（用户端，userId 来自服务端登录态） ─────────────
  /** 创建报名（§7/§9）。姓名/手机取自登录用户资料快照（首次登录时采集，报名不重复填写）；金额由服务端计算。 */
  app.post('/events/:id/registrations', async (req: any) => {
    const user = requireAuth(req);
    const eventId = Number(req.params.id);
    const b = z
      .object({
        registrationOptionId: z.number().int().optional(),
        remark: z.string().max(500).optional(),
        gateCode: z.string().max(32).optional(), // 邀请票的"购买邀请码"
        customFields: z.record(z.string().max(50), z.string().max(200)).optional(), // 自定义报名字段
      })
      .parse(req.body || {});
    return registrations.createRegistration(eventId, Number(user.userId), b);
  });

  app.get('/me/registrations', async (req: any) => {
    const user = requireAuth(req);
    return registrations.listMyRegistrations(Number(user.userId));
  });

  /** 记录订阅消息授权（B⑤：用户 requestSubscribeMessage 成功后回调，1 次授权 = 1 次发送额度）。 */
  app.post('/me/subscribe', async (req: any) => {
    const user = requireAuth(req);
    const b = z.object({ templateId: z.string().min(1).max(64) }).parse(req.body || {});
    const u = db.prepare('SELECT openid FROM users WHERE id=?').get(Number(user.userId)) as { openid?: string } | undefined;
    return subscribe.recordSubscribe(Number(user.userId), String(u?.openid || ''), b.templateId);
  });

  // ───────────── 评价（C⑨） ─────────────
  /** 提交 / 更新我的评价（活动结束后或已核销，1-5 星 + 留言）。 */
  app.post('/me/reviews', async (req: any) => {
    const user = requireAuth(req);
    const b = z
      .object({ eventId: z.number().int().positive(), rating: z.number().min(1).max(5), comment: z.string().max(500).optional() })
      .parse(req.body || {});
    return reviews.upsertReview(Number(user.userId), b);
  });

  /** 我的评价列表。 */
  app.get('/me/reviews', async (req: any) => {
    const user = requireAuth(req);
    return reviews.listMyReviews(Number(user.userId));
  });

  /** 活动评价列表（公开）。 */
  app.get('/events/:id/reviews', async (req: any) => {
    return reviews.listEventReviews(Number(req.params.id));
  });

  // ───────────── 评论区（分享 + 参加过的活动，支持回复 / 回复的回复 / 点赞） ─────────────
  /** 评论区列表（公开）：GET /comments?type=SHARE|EVENT&id=<目标id>；带点赞数 + 当前用户已赞状态。 */
  app.get('/comments', async (req: any) => {
    const q = (req.query as Record<string, string>) || {};
    return comments.listComments(String(q.type || ''), Number(q.id), Number(optionalUser(req)?.userId || 0));
  });
  /** 发评论 / 回复 / 回复的回复（登录；活动评论需已支付报名过；分享/帖子评论只需登录）。replyToId = 被回复的那条回复 id（parentId 仍指向根评论）。 */
  app.post('/comments', async (req: any) => {
    const user = requireAuth(req);
    const b = z
      .object({
        type: z.enum(['SHARE', 'EVENT', 'POST']),
        id: z.number().int().positive(),
        content: z.string().max(500),
        parentId: z.number().int().positive().optional(),
        replyToId: z.number().int().positive().optional(),
      })
      .parse(req.body || {});
    return comments.createComment(Number(user.userId), { type: b.type, id: b.id, content: b.content, parentId: b.parentId, replyToId: b.replyToId });
  });
  /** 删除评论（作者本人；管理员可删任意）。 */
  app.delete('/comments/:id', async (req: any) => {
    const user = requireAuth(req);
    return comments.deleteComment(Number(user.userId), Boolean((user as any).isAdmin), Number(req.params.id));
  });

  // ───────────── 点赞（活动 / 分享 / 评论，登录后点赞/取消） ─────────────
  /** 点赞 / 取消点赞（幂等切换）：body {type: EVENT|SHARE|COMMENT|POST, id} → { liked, count }。 */
  app.post('/likes/toggle', async (req: any) => {
    const user = requireAuth(req);
    const b = z
      .object({ type: z.enum(['EVENT', 'SHARE', 'COMMENT', 'POST']), id: z.number().int().positive() })
      .parse(req.body || {});
    return likes.toggleLike(Number(user.userId), b.type, b.id);
  });

  /** 报名详情 + 报名凭证（§11）。PAID 时附带二维码 data URL。 */
  app.get('/registrations/:id', async (req: any) => {
    const user = requireAuth(req);
    const regId = Number(req.params.id);
    const r = assertOwner(user, regId);
    const detail = registrations.getRegistration(regId);
    if (r.status === 'PAID' && r.qr_token) {
      (detail as Row).qr_data_url = await qrDataUrl(r.qr_token);
      if (r.qr_token_2) (detail as Row).qr_data_url_2 = await qrDataUrl(r.qr_token_2); // 双人票座位2
    }
    return detail;
  });

  app.post('/registrations/:id/cancel', async (req: any) => {
    const user = requireAuth(req);
    const regId = Number(req.params.id);
    assertOwner(user, regId);
    return registrations.cancelRegistration(regId);
  });

  app.post('/registrations/:id/refund', async (req: any) => {
    const user = requireAuth(req);
    const regId = Number(req.params.id);
    assertOwner(user, regId);
    const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body || {});
    const reason = b.reason || '用户申请退款';
    if (WX_PAY_USE_REAL) {
      // 真实微信退款（§22）：先预校验规则（可退才继续），再向微信发起签名退款请求，受理成功后落业务状态机。
      // 生产还应校验微信退款异步通知（refund/notify）后再最终 REFUNDED（见 DEVELOPMENT.md §7）。
      const reg = loadRegistration(regId);
      if (reg.status === 'REFUNDED' || reg.status === 'REFUNDING') return registrations.getRegistration(regId); // 幂等
      const { reg: rr } = registrations.assertRefundable(regId); // 不可退在此抛错（不发起真实退款）
      const outTradeNo = 'PAY' + rr.registration_no.slice(3);
      const outRefundNo = 'REF' + rr.registration_no.slice(3) + Date.now().toString(36).toUpperCase();
      const real = await wxpay.requestRefund({
        outTradeNo, outRefundNo,
        totalCents: Number(rr.amount), refundCents: Number(rr.amount), reason,
      });
      return registrations.refundRegistration(regId, reason, { outRefundNo: real.outRefundNo });
    }
    return registrations.refundRegistration(regId, reason);
  });

  // ───────────── 支付 ─────────────
  /**
   * 生产路径（§9/§36）：wx.requestPayment success 不代表支付成功，最终以服务端状态为准。
   *  - POST /registrations/:id/pay/prepay：创建预支付（生产走微信统一下单，返回支付参数）
   *  - POST /pay/notify：微信异步回调，验签后调用同一 payRegistration（幂等）
   */
  app.post('/registrations/:id/pay/prepay', async (req: any) => {
    const user = requireAuth(req);
    const regId = Number(req.params.id);
    const r = assertOwner(user, regId);
    if (r.status !== 'PENDING') throw new HttpError(409, '该报名当前状态不可发起支付');
    if (!WX_PAY_USE_REAL) {
      return {
        registration_id: regId,
        out_trade_no: 'PAY' + r.registration_no.slice(3),
        amount: Number(r.amount),
        amount_display: fmtCents(Number(r.amount)),
        channel: 'wechat',
        note: '未配置商户凭据（mock 环境）；演示环境请使用 /dev 模拟支付。',
      };
    }
    // 真实微信统一下单（§36）：openid 来自服务端登录态（客户端不得声明），金额服务端计算。
    const openid = String((user as Row).openid || '');
    if (!openid) throw new HttpError(401, '缺少微信 openid，无法发起支付');
    const ev = db.prepare('SELECT * FROM events WHERE id=?').get(r.event_id) as Row | null;
    const outTradeNo = 'PAY' + r.registration_no.slice(3);
    const { prepayId, wxPayParams } = await wxpay.jsapiPrepay({
      outTradeNo,
      amountCents: Number(r.amount),
      description: ev?.title || '活动报名',
      openid,
    });
    wxpay.createPrepay(regId, prepayId); // 落 PENDING 支付单（out_trade_no 幂等），供 notify 反查
    return {
      registration_id: regId,
      out_trade_no: outTradeNo,
      amount: Number(r.amount),
      amount_display: fmtCents(Number(r.amount)),
      channel: 'wechat',
      payment: wxPayParams, // 直接交给小程序 wx.requestPayment
    };
  });

  /** 微信异步回调（§36）。真实模式：验签（平台证书）+ 解密（APIv3 密钥）→ 反查支付单 → payRegistration（幂等）。 */
  app.post('/pay/notify', async (req: any) => {
    if (WX_PAY_USE_REAL) {
      const rawBody = String((req as any).rawBody ?? '');
      const info = wxpay.verifyNotify(req.headers, rawBody);
      if (info.tradeState !== 'SUCCESS') {
        return { code: 'SUCCESS', message: `交易状态 ${info.tradeState || '未知'}，忽略`, state: info.tradeState };
      }
      const pay = db.prepare('SELECT * FROM payments WHERE out_trade_no=?').get(info.outTradeNo) as Row | null;
      if (!pay) throw new HttpError(404, 'out_trade_no 无对应支付单');
      const paid = registrations.payRegistration(Number(pay.registration_id), { transactionId: info.transactionId, notifyRaw: rawBody });
      return { code: 'SUCCESS', message: 'OK', status: paid.status };
    }
    // mock 回调（development 占位）：保持现有占位行为，便于无凭据联调。
    const body = req.body || {};
    const regId = Number(body.registration_id || 0);
    const result = body.result === 'FAIL' ? 'FAIL' : 'SUCCESS';
    if (!regId) return { code: 'FAIL', message: '缺少 registration_id' };
    const r = loadRegistration(regId);
    if (result === 'FAIL') return { code: 'SUCCESS', message: '已记录失败', status: r.status };
    const paid = registrations.payRegistration(regId);
    return { code: 'SUCCESS', message: 'OK', status: paid.status };
  });

  /**
   * 模拟支付（§38，development-only）。PENDING → PAID，生成 qr_token。
   * 幂等：重复调用对已 PAID 的报名返回成功。staging/production 不注册（404/403）。
   */
  app.post('/dev/registrations/:id/mock-pay', async (req: any) => {
    const user = requireAuth(req);
    const regId = Number(req.params.id);
    assertOwner(user, regId);
    return registrations.payRegistration(regId);
  });

  /** 开发：把当前登录用户标记为工作人员（is_admin=1），便于在小程序内测试签到（§25，仅 development）。 */
  app.post('/dev/auth/make-admin', async (req: any, reply: any) => {
    if (!MOCK_PAY_ENABLED) return reply.status(403).send({ error: `该接口在 ${APP_ENV} 环境被禁用` });
    const user = requireAuth(req);
    const uid = Number(user.userId);
    db.prepare('UPDATE users SET is_admin=1, updated_at=? WHERE id=?').run(nowIso(), uid);
    return { ok: true, userId: uid, isAdmin: true };
  });

  // ───────────── 现场签到（工作人员：用户或管理端） ─────────────
  /** 二维码定位报名（§12/§14）：供工作人员核对后确认。 */
  app.get('/checkin/resolve', async (req: any) => {
    requireStaff(req);
    const q = req.query as Record<string, string>;
    return checkin.resolveByQrToken(String(q.qrToken || ''));
  });

  /** 手机号后四位查询（§15/§16/§20）：限定当前活动，脱敏候选，不自动签到（§17）。 */
  app.get('/events/:eventId/checkin/search', async (req: any) => {
    requireStaff(req);
    const eventId = Number(req.params.eventId);
    const q = req.query as Record<string, string>;
    return checkin.searchByPhoneLast4(eventId, String(q.phoneLast4 || ''));
  });

  /** 统一签到（§19）：二维码与手机号后四位都走这里，服务端原子防重。 */
  app.post('/registrations/:id/checkin', async (req: any) => {
    const staff = requireStaff(req);
    const regId = Number(req.params.id);
    const b = z
      .object({ method: z.enum(['QR', 'PHONE_LAST4']), operator: z.string().max(64).optional(), seat: z.number().int().min(1).max(2).optional() })
      .parse(req.body || {});
    const operatorName = b.operator || (staff as Row).nickname || (staff as Row).username || '现场工作人员';
    const operatorAdminId = (staff as Row).adminId ?? null;
    return checkin.performCheckin(regId, b.method, operatorName, operatorAdminId, b.seat);
  });

  // ───────────── 管理端（后台） ─────────────
  app.post('/admin/auth/login', async (req: any) => {
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body || {});
    return adminLogin(b.username, b.password);
  });
  app.get('/admin/me', async (req: any) => requireAdmin(req));
  app.post('/admin/auth/logout', async (req: any) => {
    destroyAdminSession(bearerToken(req));
    return { ok: true };
  });

  /** 创建 / 编辑活动 + 报名类型（§23 活动管理）。 */
  app.post('/admin/events', async (req: any) => {
    requireAdmin(req);
    const b = z
      .object({
        title: z.string().min(1),
        subtitle: z.string().max(120).optional(),
        coverImage: z.string().max(2_000_000).optional(),
        description: z.string().max(20_000).optional(),
        category: z.string().max(40).optional(),
        locationCity: z.string().max(60).optional(),
        locationName: z.string().max(120).optional(),
        locationAddress: z.string().max(400).optional(),
        reminder: z.string().max(1000).optional(),
        detailImages: z.array(z.string().max(2_000_000)).max(20).optional(),
        startTime: z.string().min(1),
        endTime: z.string().min(1),
        registrationStartTime: z.string().min(1),
        registrationEndTime: z.string().min(1),
        status: z.enum(['DRAFT', 'PUBLISHED', 'ENDED', 'OFFLINE', 'CANCELLED']).optional(),
        capacity: z.number().int().min(0).nullable().optional(),
        refundRule: z.enum(['ALLOW_ANY', 'BEFORE_24H', 'BEFORE_48H', 'NO_SELF_REFUND']).optional(),
        contactInfo: z.string().max(200).optional(),
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        coverDetailImage: z.string().max(2_000_000).optional(),
        customFields: z
          .array(z.object({ key: z.string().min(1).max(50), label: z.string().min(1).max(50), required: z.boolean().optional(), type: z.enum(['text', 'textarea', 'choice']).optional(), options: z.array(z.string().max(30)).max(10).optional() }))
          .max(10)
          .optional(),
      })
      .parse(req.body || {});
    return events.createEvent(b);
  });

  app.put('/admin/events/:id', async (req: any) => {
    requireAdmin(req);
    const id = Number(req.params.id);
    const b = z
      .object({
        title: z.string().min(1).optional(),
        subtitle: z.string().max(120).optional(),
        coverImage: z.string().max(2_000_000).optional(),
        description: z.string().max(20_000).optional(),
        category: z.string().max(40).optional(),
        locationCity: z.string().max(60).optional(),
        locationName: z.string().max(120).optional(),
        locationAddress: z.string().max(400).optional(),
        reminder: z.string().max(1000).optional(),
        detailImages: z.array(z.string().max(2_000_000)).max(20).optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        registrationStartTime: z.string().optional(),
        registrationEndTime: z.string().optional(),
        capacity: z.number().int().min(0).nullable().optional(),
        refundRule: z.enum(['ALLOW_ANY', 'BEFORE_24H', 'BEFORE_48H', 'NO_SELF_REFUND']).optional(),
        contactInfo: z.string().max(200).optional(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'ENDED', 'OFFLINE', 'CANCELLED']).optional(),
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        coverDetailImage: z.string().max(2_000_000).optional(),
        customFields: z
          .array(z.object({ key: z.string().min(1).max(50), label: z.string().min(1).max(50), required: z.boolean().optional(), type: z.enum(['text', 'textarea', 'choice']).optional(), options: z.array(z.string().max(30)).max(10).optional() }))
          .max(10)
          .optional(),
      })
      .parse(req.body || {});
    return events.updateEvent(id, b);
  });

  /** 归档活动列表（后台「归档活动」标签）：已结束/下架/取消的活动，只显示信息 + 最终核验人数，不带票种。 */
  app.get('/admin/events/archived', async (req: any) => {
    requireAdmin(req);
    return events.listArchivedEvents();
  });

  /** 后台：读取某活动全部报名类型（含"购买邀请码"，供编辑展示；公开 API 不返回该字段）。 */
  app.get('/admin/events/:id/options', async (req: any) => {
    requireAdmin(req);
    const eventId = Number(req.params.id);
    const ev = db.prepare('SELECT id FROM events WHERE id=?').get(eventId) as Row | null;
    if (!ev) throw new HttpError(404, '活动不存在');
    const rows = db.prepare('SELECT * FROM registration_options WHERE event_id=? ORDER BY sort_order, id').all(eventId) as Row[];
    return rows.map((o) => ({ ...o, price_display: fmtCents(Number(o.price)) }));
  });

  app.post('/admin/events/:id/options', async (req: any) => {
    requireAdmin(req);
    const eventId = Number(req.params.id);
    const b = z
      .object({
        name: z.string().min(1).max(64),
        description: z.string().max(300).optional(),
        price: z.number().int().min(0),
        optionType: z.enum(['SINGLE', 'DOUBLE', 'INVITE', 'WAITLIST']).optional(),
        gateCode: z.string().max(32).optional(),
        sortOrder: z.number().int().min(0).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        soldLimit: z.number().int().min(0).nullable().optional(), // 可购票上限（>0 生效；0/空=不限）
      })
      .parse(req.body || {});
    return events.addRegistrationOption(eventId, b);
  });

  app.put('/admin/events/:id/options/:optionId', async (req: any) => {
    requireAdmin(req);
    const optionId = Number(req.params.optionId);
    const b = z
      .object({
        name: z.string().min(1).max(64).optional(),
        description: z.string().max(300).optional(),
        price: z.number().int().min(0).optional(),
        optionType: z.enum(['SINGLE', 'DOUBLE', 'INVITE', 'WAITLIST']).optional(),
        gateCode: z.string().max(32).optional(),
        sortOrder: z.number().int().min(0).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        soldLimit: z.number().int().min(0).nullable().optional(),
      })
      .parse(req.body || {});
    return events.updateRegistrationOption(optionId, b);
  });

  /** 删除某活动的票种（§ ②）：已有报名则 409 拒绝。 */
  app.delete('/admin/events/:eventId/options/:optionId', async (req: any) => {
    requireAdmin(req);
    return events.deleteRegistrationOption(Number(req.params.optionId));
  });

  app.post('/admin/events/:id/status', async (req: any) => {
    requireAdmin(req);
    const id = Number(req.params.id);
    const b = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ENDED', 'OFFLINE', 'CANCELLED']) }).parse(req.body || {});
    return events.setEventStatus(id, b.status);
  });

  /** 删除活动（§ ①，不可逆）：级联删除票种 / 报名 / 支付 / 退款 / 签到。UI 需二次确认。 */
  app.delete('/admin/events/:id', async (req: any) => {
    requireAdmin(req);
    return events.deleteEvent(Number(req.params.id));
  });

  /** 报名名单（搜索 / 筛选，§23）。 */
  app.get('/admin/registrations', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return admin.listRegistrations({
      eventId: q.eventId ? Number(q.eventId) : undefined,
      name: q.name || undefined,
      phone: q.phone || undefined,
      registrationNo: q.registrationNo || undefined,
      optionType: q.optionType || undefined,
      paymentStatus: q.paymentStatus || undefined,
      checkinStatus: q.checkinStatus || undefined,
      minAttend: q.minAttend ? Number(q.minAttend) : undefined,
      paidFrom: q.paidFrom || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });

  app.get('/admin/checkins', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return admin.listCheckins({
      eventId: q.eventId ? Number(q.eventId) : undefined,
      keyword: q.keyword || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });
  /** 后台：导出签到记录 CSV（与列表同款筛选）。 */
  app.get('/admin/export-checkins', async (req: any, reply: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    const { filename, csv } = admin.exportCheckinsCsv({
      eventId: q.eventId ? Number(q.eventId) : undefined,
      keyword: q.keyword || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });

  app.get('/admin/stats', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return admin.stats(q.eventId ? Number(q.eventId) : undefined);
  });

  // 用户参加次数统计（全平台「已报名且已核验」的活动数，供后台按次数设置折扣票）
  app.get('/admin/attendance', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return admin.attendanceStats(q.minAttend ? Number(q.minAttend) : undefined);
  });

  app.get('/admin/export', async (req: any, reply: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    const { filename, csv } = admin.exportRegistrationsCsv(q.eventId ? Number(q.eventId) : undefined);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });

  /** 后台：全部评价列表（C⑨）。 */
  app.get('/admin/reviews', async (req: any) => {
    requireAdmin(req);
    return reviews.listAllReviews();
  });

  /** 后台：评论管理看板（类型/关键词筛选 + 分页 + 删除任意评论，删根连带回复）。 */
  app.get('/admin/comments', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return comments.adminListComments({
      type: (q.type || undefined) as 'ALL' | 'SHARE' | 'EVENT' | 'POST',
      keyword: q.keyword || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });
  app.delete('/admin/comments/:id', async (req: any) => {
    requireAdmin(req);
    comments.deleteComment(0, true, Number(req.params.id));
    return { ok: true };
  });

  // ───────────── 仅开发环境（§38）：staging/production 下禁用 ─────────────
  if (!MOCK_PAY_ENABLED) {
    app.post('/dev/registrations/:id/mock-pay', async (_req: any, reply: any) =>
      reply.status(403).send({ error: `模拟支付在 ${APP_ENV} 环境被禁用` })
    );
  }

  // 管理端默认账号提示（MOCK_PAY 开启时暴露，便于联调/演示）
  if (MOCK_PAY_ENABLED) {
    app.get('/admin/credentials', async () => ({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, note: 'mockPay 开启时暴露，用于联调/演示；正式环境请改 ADMIN_PASSWORD' }));
  }

  /** 图片上传：base64 dataURL → 服务器文件，返回相对 URL /uploads/…（后台专用，管理端可换行编辑）。 */
  app.post('/admin/upload-image', async (req: any) => {
    requireAdmin(req);
    const b = z.object({ dataUrl: z.string().min(1).max(25_000_000) }).parse(req.body || {});
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(b.dataUrl);
    if (!m) throw new HttpError(400, '仅支持 png/jpg/gif/webp 图片（dataURL 格式）');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (!buf.length) throw new HttpError(400, '图片内容为空');
    if (buf.length > 6 * 1024 * 1024) throw new HttpError(400, '图片超过 6MB，请压缩后再传');
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', APP_ENV, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return { url: `/uploads/${name}` };
  });

  /** 图片上传（登录用户，小程序发帖插图等）：base64 dataURL → 服务器文件，返回相对 URL /uploads/…。 */
  app.post('/uploads', async (req: any) => {
    requireAuth(req);
    const b = z.object({ dataUrl: z.string().min(1).max(25_000_000) }).parse(req.body || {});
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(b.dataUrl);
    if (!m) throw new HttpError(400, '仅支持 png/jpg/gif/webp 图片（dataURL 格式）');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (!buf.length) throw new HttpError(400, '图片内容为空');
    if (buf.length > 6 * 1024 * 1024) throw new HttpError(400, '图片超过 6MB，请压缩后再传');
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', APP_ENV, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return { url: `/uploads/${name}` };
  });

  /** 分享内容：公开列表 + 详情（「分享」tab：现场视频/网课/知识文字）；带浏览/点赞/评论数 + 当前用户已赞。 */
  app.get('/shares', async (req: any) => shares.listShares(Number(optionalUser(req)?.userId || 0)));
  app.get('/shares/:id', async (req: any) => {
    const id = Number(req.params.id);
    const row = shares.getShare(id, Number(optionalUser(req)?.userId || 0));
    if (!row) throw new HttpError(404, '分享不存在');
    return row;
  });
  /** 进入分享详情浏览 +1（小程序分享详情 onLoad 时调用）。 */
  app.post('/shares/:id/view', async (req: any) => {
    const id = Number(req.params.id);
    if (!shares.getShare(id)) throw new HttpError(404, '分享不存在');
    shares.incrementView(id);
    return { ok: true };
  });

  // ───────────── 论坛帖子（用户端，评论/点赞复用 comments/likes 的 POST 目标） ─────────────
  /** 帖子列表（公开）：带作者 + 浏览/点赞/评论数 + 当前用户已赞。 */
  app.get('/posts', async (req: any) => posts.listPosts(Number(optionalUser(req)?.userId || 0)));
  /** 帖子详情（公开）。 */
  app.get('/posts/:id', async (req: any) => posts.getPost(Number(req.params.id), Number(optionalUser(req)?.userId || 0)));
  /** 进入帖子详情浏览 +1（小程序帖子详情 onLoad 时调用）。 */
  app.post('/posts/:id/view', async (req: any) => {
    const id = Number(req.params.id);
    posts.getPost(id);
    posts.incrementView(id);
    return { ok: true };
  });
  /** 发帖（登录）：{title, content?}，正文可含图片富文本 HTML。 */
  app.post('/posts', async (req: any) => {
    const user = requireAuth(req);
    const b = z
      .object({ title: z.string().max(80), content: z.string().max(50_000).optional() })
      .parse(req.body || {});
    return posts.createPost(Number(user.userId), b);
  });
  /** 删帖（作者本人）。 */
  app.delete('/posts/:id', async (req: any) => {
    const user = requireAuth(req);
    posts.deletePost(Number(user.userId), false, Number(req.params.id));
    return { ok: true };
  });
  /** 后台删帖（管理员，可删任意）。 */
  app.delete('/admin/posts/:id', async (req: any) => {
    requireAdmin(req);
    posts.deletePost(0, true, Number(req.params.id));
    return { ok: true };
  });
  /** 后台：帖子管理列表（?status=ACTIVE|ARCHIVED|ALL + keyword 搜索 + 分页）。 */
  app.get('/admin/posts', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    const status = String(q.status || 'ACTIVE').toUpperCase();
    return posts.adminListPosts({
      status: status === 'ALL' ? 'ALL' : status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
      keyword: q.keyword || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });
  /** 后台：归档帖子（用户端不再显示）。 */
  app.post('/admin/posts/:id/archive', async (req: any) => {
    requireAdmin(req);
    posts.setPostArchived(Number(req.params.id), true);
    return { ok: true };
  });
  /** 后台：恢复归档帖子。 */
  app.post('/admin/posts/:id/restore', async (req: any) => {
    requireAdmin(req);
    posts.setPostArchived(Number(req.params.id), false);
    return { ok: true };
  });

  /** 后台：分享管理（列表支持 状态/关键词/类型/时间范围/分页；CRUD）。 */
  app.get('/admin/shares', async (req: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    return shares.adminListShares({
      status: (q.status || undefined) as 'ALL' | 'PUBLISHED' | 'DRAFT' | 'OFFLINE',
      keyword: q.keyword || undefined,
      type: q.type || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });
  /** 后台：导出分享 CSV（与列表同款状态/关键词/类型过滤）。 */
  app.get('/admin/export-shares', async (req: any, reply: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    const { filename, csv } = shares.exportSharesCsv({ status: q.status || undefined, keyword: q.keyword || undefined, type: q.type || undefined });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });
  /** 后台：导出帖子 CSV（与列表同款状态/关键词过滤）。 */
  app.get('/admin/export-posts', async (req: any, reply: any) => {
    requireAdmin(req);
    const q = req.query as Record<string, string>;
    const status = String(q.status || 'ACTIVE').toUpperCase();
    const { filename, csv } = posts.exportPostsCsv({ status: status === 'ALL' ? 'ALL' : status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE', keyword: q.keyword || undefined });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });
  app.post('/admin/shares', async (req: any) => {
    requireAdmin(req);
    return shares.createShare(req.body || {});
  });
  app.put('/admin/shares/:id', async (req: any) => {
    requireAdmin(req);
    return shares.updateShare(Number(req.params.id), req.body || {});
  });
  app.delete('/admin/shares/:id', async (req: any) => {
    requireAdmin(req);
    shares.deleteShare(Number(req.params.id));
    return { ok: true };
  });

  /** 开发诊断：接收浏览器端图片渲染测量数据（临时调试，生产不暴露）。 */
  if (APP_ENV === 'development') {
    app.post('/dev/diag', async (req: any) => {
      const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', APP_ENV);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'diag.json'), JSON.stringify(req.body || {}, null, 2));
      return { ok: true };
    });
  }
}
