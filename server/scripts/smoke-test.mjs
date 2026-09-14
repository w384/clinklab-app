// V0.1 付费报名 —— 端到端冒烟（用独立临时库，inject 走真实路由 + SQLite）。
// 覆盖 §41 两条验证链 + 名额/退款/幂等/并发防重。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', 'data', 'smoke-test');
const dbFile = path.join(dataDir, 'registration.sqlite');
fs.mkdirSync(dataDir, { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (fs.existsSync(f)) fs.rmSync(f);

process.env.DB_PATH = dbFile;
process.env.APP_ENV = 'development';

const { buildApp } = await import('../src/app.ts');
const app = buildApp();
await app.ready();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  \u2713', name);
  } else {
    fail++;
    console.log('  \u2717', name, extra);
  }
};

async function call(method, url, { token, adminToken, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const r = await app.inject({ method, url, headers, payload: body });
  let json;
  try {
    json = JSON.parse(r.body);
  } catch {
    json = r.body;
  }
  return { status: r.statusCode, body: json };
}

// 首次登录补全资料（§ 报名前采集昵称/手机，报名不重复填写）
const completeProfile = (token, nickname, phone) => call('PUT', '/me', { token, body: { nickname, phone } });

const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;
const H = 3_600_000;
const now = Date.now();

console.log('\n[0] 管理端登录');
const admin = await call('POST', '/admin/auth/login', { body: { username: 'admin', password: 'admin123' } });
const adminToken = admin.body.token;
ok('管理端登录成功', admin.status === 200 && Boolean(adminToken));

console.log('\n[1] 建活动（capacity=100，可退款）');
const ev1 = await call('POST', '/admin/events', {
  adminToken,
  body: {
    title: '冒烟活动 A',
    locationName: '上海',
    startTime: iso(now + 10 * DAY),
    endTime: iso(now + 10 * DAY + 4 * H),
    registrationStartTime: iso(now - 1 * H),
    registrationEndTime: iso(now + 9 * DAY),
    capacity: 100,
    refundRule: 'ALLOW_ANY',
    status: 'PUBLISHED',
  },
});
ok('创建活动成功', ev1.status === 200 && ev1.body.id > 0);
const optA = await call('POST', `/admin/events/${ev1.body.id}/options`, { adminToken, body: { name: '标准票', price: 9900 } });
ok('添加报名类型', optA.status === 200 && optA.body.id > 0);

console.log('\n[2] 微信登录（mock）→ 创建报名');
const userA = await call('POST', '/auth/wechat-login', { body: { code: 'smoke_user_a' } });
const tokenA = userA.body.token;
ok('用户登录', userA.status === 200 && Boolean(tokenA));

const profA = await completeProfile(tokenA, '张三', '13812345678');
ok('完善资料（昵称+手机）', profA.status === 200 && profA.body.ok === true, JSON.stringify(profA.body));

const regA = await call('POST', `/events/${ev1.body.id}/registrations`, {
  token: tokenA,
  body: { registrationOptionId: optA.body.id, remark: '测试备注' },
});
ok('创建报名（PENDING）', regA.status === 200 && regA.body.status === 'PENDING', JSON.stringify(regA.body));
ok('金额服务端计算 ¥99', regA.body.amount === 9900 && regA.body.amount_display === '¥99');

console.log('\n[3] 模拟支付 → PAID + qr_token + 凭证');
const payA = await call('POST', `/dev/registrations/${regA.body.id}/mock-pay`, { token: tokenA });
ok('支付成功 PAID', payA.status === 200 && payA.body.status === 'PAID');
ok('生成 qr_token', typeof payA.body.qr_token === 'string' && payA.body.qr_token.startsWith('c1k_'));

const payA2 = await call('POST', `/dev/registrations/${regA.body.id}/mock-pay`, { token: tokenA });
ok('重复支付幂等', payA2.status === 200 && payA2.body.status === 'PAID' && payA2.body.qr_token === payA.body.qr_token);

const detailA = await call('GET', `/registrations/${regA.body.id}`, { token: tokenA });
ok('详情含二维码 data URL', detailA.status === 200 && typeof detailA.body.qr_data_url === 'string' && detailA.body.qr_data_url.startsWith('data:image/png;base64,'));

console.log('\n[4] 二维码签到 → 防重复');
// 现场签到是"工作人员"动作（§25）：被标记 is_admin 的用户（App 内）或管理端登录态（浏览器后台）。普通用户一律 403。
const staffLogin = await call('POST', '/auth/wechat-login', { body: { code: 'smoke_staff' } });
const staffToken = staffLogin.body.token;
const mkStaff = await call('POST', '/dev/auth/make-admin', { token: staffToken });
ok('工作人员开通（is_admin）', mkStaff.status === 200 && mkStaff.body.isAdmin === true, JSON.stringify(mkStaff.body));

// 角色隔离：普通用户（非工作人员）尝试签到/查询 → 403
const plainCi = await call('POST', `/registrations/${regA.body.id}/checkin`, { token: tokenA, body: { method: 'QR', operator: '路人' } });
ok('普通用户签到 403（角色隔离）', plainCi.status === 403, `status=${plainCi.status}`);

const resolve = await call('GET', `/checkin/resolve?qrToken=${encodeURIComponent(payA.body.qr_token)}`, { token: staffToken });
ok('二维码定位报名', resolve.status === 200 && resolve.body.registration.registration_id === regA.body.id);

const ci1 = await call('POST', `/registrations/${regA.body.id}/checkin`, { token: staffToken, body: { method: 'QR', operator: '现场小王' } });
ok('首次签到成功', ci1.status === 200 && ci1.body.already === false);

const ci2 = await call('POST', `/registrations/${regA.body.id}/checkin`, { token: staffToken, body: { method: 'QR', operator: '现场小王' } });
ok('重复签到幂等（已签到）', ci2.status === 200 && ci2.body.already === true && /已核销|已签到/.test(ci2.body.message));

// 并发：两个工作人员同时签到同一报名（新报名）
const userC = await call('POST', '/auth/wechat-login', { body: { code: 'smoke_user_c' } });
await completeProfile(userC.body.token, '并发用户', '13900001111');
const regC = await call('POST', `/events/${ev1.body.id}/registrations`, { token: userC.body.token, body: { registrationOptionId: optA.body.id } });
await call('POST', `/dev/registrations/${regC.body.id}/mock-pay`, { token: userC.body.token });
const [c1, c2] = await Promise.all([
  call('POST', `/registrations/${regC.body.id}/checkin`, { token: staffToken, body: { method: 'QR', operator: '甲' } }),
  call('POST', `/registrations/${regC.body.id}/checkin`, { token: staffToken, body: { method: 'QR', operator: '乙' } }),
]);
const wins = [c1, c2].filter((x) => x.body && x.body.already === false);
ok('并发签到只有一个成功', wins.length === 1, JSON.stringify([c1.body?.already, c2.body?.already]));

console.log('\n[5] 手机号后四位签到（§15-§17/§20）');
const userB = await call('POST', '/auth/wechat-login', { body: { code: 'smoke_user_b' } });
await completeProfile(userB.body.token, '李四', '13899995678');
const regB = await call('POST', `/events/${ev1.body.id}/registrations`, { token: userB.body.token, body: { registrationOptionId: optA.body.id } });
await call('POST', `/dev/registrations/${regB.body.id}/mock-pay`, { token: userB.body.token });

const plainSearch = await call('GET', `/events/${ev1.body.id}/checkin/search?phoneLast4=5678`, { token: tokenA });
ok('普通用户查询签到 403（角色隔离）', plainSearch.status === 403, `status=${plainSearch.status}`);

const search = await call('GET', `/events/${ev1.body.id}/checkin/search?phoneLast4=5678`, { token: staffToken });
ok('手机号后四位命中候选', search.status === 200 && search.body.count >= 1, JSON.stringify(search.body));
const cand = search.body.candidates.find((c) => c.registration_id === regB.body.id);
ok('候选手机号脱敏', cand && /138\*{4}5678/.test(cand.masked_phone), cand?.masked_phone || 'none');

const ciB = await call('POST', `/registrations/${regB.body.id}/checkin`, { token: staffToken, body: { method: 'PHONE_LAST4', operator: '现场小李' } });
ok('手机号后四位签到成功', ciB.status === 200 && ciB.body.already === false);

console.log('\n[6] 退款（§22）+ 幂等 + 已签到不可退');
const userD = await call('POST', '/auth/wechat-login', { body: { code: 'smoke_user_d' } });
await completeProfile(userD.body.token, '王五', '13700002222');
const regD = await call('POST', `/events/${ev1.body.id}/registrations`, { token: userD.body.token, body: { registrationOptionId: optA.body.id } });
await call('POST', `/dev/registrations/${regD.body.id}/mock-pay`, { token: userD.body.token });
const rf1 = await call('POST', `/registrations/${regD.body.id}/refund`, { token: userD.body.token, body: { reason: '临时有事' } });
ok('退款成功 REFUNDED', rf1.status === 200 && rf1.body.status === 'REFUNDED');
const rf2 = await call('POST', `/registrations/${regD.body.id}/refund`, { token: userD.body.token, body: {} });
ok('重复退款幂等', rf2.status === 200 && rf2.body.status === 'REFUNDED');
const rfCI = await call('POST', `/registrations/${regA.body.id}/refund`, { token: tokenA, body: {} });
ok('已签到不可退款（403）', rfCI.status === 403, `status=${rfCI.status}`);

console.log('\n[7] 名额 sold_limit（§5）：售罄转候补 / 无候补则拒绝');
const ev2 = await call('POST', '/admin/events', {
  adminToken,
  body: {
    title: '冒烟活动 B（名额1）',
    startTime: iso(now + 10 * DAY),
    endTime: iso(now + 10 * DAY + 4 * H),
    registrationStartTime: iso(now - 1 * H),
    registrationEndTime: iso(now + 9 * DAY),
    capacity: 1,
    refundRule: 'ALLOW_ANY',
    status: 'PUBLISHED',
  },
});
const optB = await call('POST', `/admin/events/${ev2.body.id}/options`, { adminToken, body: { name: '票(限1)', price: 100, soldLimit: 1 } });
const u1 = await call('POST', '/auth/wechat-login', { body: { code: 'cap_u1' } });
await completeProfile(u1.body.token, '甲', '13511110000');
const r1 = await call('POST', `/events/${ev2.body.id}/registrations`, { token: u1.body.token, body: { registrationOptionId: optB.body.id } });
await call('POST', `/dev/registrations/${r1.body.id}/mock-pay`, { token: u1.body.token });
const u2 = await call('POST', '/auth/wechat-login', { body: { code: 'cap_u2' } });
await completeProfile(u2.body.token, '乙', '13522220000');
const r2 = await call('POST', `/events/${ev2.body.id}/registrations`, { token: u2.body.token, body: { registrationOptionId: optB.body.id } });
ok('票种售罄且无候补拒绝创建（409）', r2.status === 409, `status=${r2.status} ${r2.body.error}`);

// —— 售罄但开放候补：自动转候补（PAID / 免费 / 记录预期票种） ——
const optWlB = await call('POST', `/admin/events/${ev2.body.id}/options`, { adminToken, body: { name: '候补', price: 0, optionType: 'WAITLIST' } });
const u3 = await call('POST', '/auth/wechat-login', { body: { code: 'cap_u3' } });
await completeProfile(u3.body.token, '丙', '13533330000');
const r3 = await call('POST', `/events/${ev2.body.id}/registrations`, { token: u3.body.token, body: { registrationOptionId: optB.body.id } });
ok('售罄自动转候补（200/PAID/免费）', r3.status === 200 && r3.body.status === 'PAID' && r3.body.amount === 0, `status=${r3.status} ${r3.body.error || r3.body.status}`);

console.log('\n[8] 管理端名单 / 签到记录 / 统计');
const list = await call('GET', `/admin/registrations?eventId=${ev1.body.id}`, { adminToken });
ok('管理端报名名单', list.status === 200 && list.body.total >= 4, `total=${list.body?.total}`);
const byPhone = await call('GET', `/admin/registrations?phone=5678`, { adminToken });
ok('手机号筛选', byPhone.status === 200 && byPhone.body.items.some((i) => i.registration_no === regB.body.registration_no));
const byCi = await call('GET', `/admin/registrations?eventId=${ev1.body.id}&checkinStatus=CHECKED_IN`, { adminToken });
ok('签到状态筛选 CHECKED_IN', byCi.status === 200 && byCi.body.total === 3 && byCi.body.items.every((i) => i.checked_in), `total=${byCi.body?.total}`);
const byNoCi = await call('GET', `/admin/registrations?eventId=${ev1.body.id}&checkinStatus=NOT_CHECKED_IN`, { adminToken });
ok('签到状态筛选 NOT_CHECKED_IN', byNoCi.status === 200 && byNoCi.body.total === 1 && byNoCi.body.items.every((i) => !i.checked_in), `total=${byNoCi.body?.total}`);
const checkins = await call('GET', `/admin/checkins?eventId=${ev1.body.id}`, { adminToken });
ok('签到记录', checkins.status === 200 && checkins.body.total >= 3, `total=${checkins.body?.total}`);
const stats = await call('GET', `/admin/stats?eventId=${ev1.body.id}`, { adminToken });
ok('统计 paid/checked_in', stats.status === 200 && stats.body.paid === 3 && stats.body.refunded === 1 && stats.body.checked_in === 3, JSON.stringify(stats.body));
const exportR = await app.inject({ method: 'GET', url: `/admin/export?eventId=${ev1.body.id}`, headers: { authorization: `Bearer ${adminToken}` } });
ok('CSV 导出（BOM+表头）', exportR.statusCode === 200 && exportR.rawPayload.toString('utf8').startsWith('\ufeff') && /姓名,参加次数,手机号,活动/.test(exportR.body));

console.log('\n[9] 归属校验：他人报名不可操作');
const otherDetail = await call('GET', `/registrations/${regA.body.id}`, { token: userB.body.token });
ok('他人报名详情 403', otherDetail.status === 403, `status=${otherDetail.status}`);
const otherRefund = await call('POST', `/registrations/${regA.body.id}/refund`, { token: userB.body.token, body: {} });
ok('他人报名退款 403', otherRefund.status === 403, `status=${otherRefund.status}`);

console.log('\n[10] 四类票：单人 / 双人(2码) / 邀请(门槛码) / 候补(免费)');
  // —— 双人票：1 人付费、出 2 个码、各扫各核销 ——
  const optD = await call('POST', `/admin/events/${ev1.body.id}/options`, { adminToken, body: { name: '双人同行票', price: 19900, optionType: 'DOUBLE' } });
  ok('建双人票', optD.status === 200 && optD.body.option_type === 'DOUBLE', JSON.stringify(optD.body).slice(0, 120));
  const uD = await call('POST', '/auth/wechat-login', { body: { code: 'four_double' } });
  await completeProfile(uD.body.token, '双人行', '13600000001');
  const f4reg = await call('POST', `/events/${ev1.body.id}/registrations`, { token: uD.body.token, body: { registrationOptionId: optD.body.id } });
  const payD = await call('POST', `/dev/registrations/${f4reg.body.id}/mock-pay`, { token: uD.body.token });
  ok('双人票支付 PAID', payD.status === 200 && payD.body.status === 'PAID');
  ok('双人票出 2 个不同码', typeof payD.body.qr_token === 'string' && typeof payD.body.qr_token_2 === 'string' && payD.body.qr_token !== payD.body.qr_token_2);
  const staff2 = await call('POST', '/auth/wechat-login', { body: { code: 'four_staff' } });
  await call('POST', '/dev/auth/make-admin', { token: staff2.body.token });
  const res1 = await call('GET', `/checkin/resolve?qrToken=${encodeURIComponent(payD.body.qr_token)}`, { token: staff2.body.token });
  ok('双人码1 定位 seat=1', res1.status === 200 && res1.body.registration.registration_id === f4reg.body.id && res1.body.seat_no === 1, JSON.stringify({ seat: res1.body.seat_no }));
  const res2 = await call('GET', `/checkin/resolve?qrToken=${encodeURIComponent(payD.body.qr_token_2)}`, { token: staff2.body.token });
  ok('双人码2 定位 seat=2', res2.status === 200 && res2.body.seat_no === 2, JSON.stringify({ seat: res2.body.seat_no }));
  const f4c1 = await call('POST', `/registrations/${f4reg.body.id}/checkin`, { token: staff2.body.token, body: { method: 'QR', operator: '小王', seat: 1 } });
  ok('双人码1 核销成功', f4c1.status === 200 && f4c1.body.already === false && f4c1.body.seat_no === 1, JSON.stringify(f4c1.body).slice(0, 120));
  const f4c2 = await call('POST', `/registrations/${f4reg.body.id}/checkin`, { token: staff2.body.token, body: { method: 'QR', operator: '小王', seat: 2 } });
  ok('双人码2 核销成功', f4c2.status === 200 && f4c2.body.already === false && /2/.test(f4c2.body.message || ''), JSON.stringify(f4c2.body).slice(0, 120));
  const detD = await call('GET', `/registrations/${f4reg.body.id}`, { token: uD.body.token });
  ok('双人 2/2 全核销', detD.status === 200 && detD.body.checked_count === 2 && detD.body.all_checked_in === true, JSON.stringify({ c: detD.body.checked_count, all: detD.body.all_checked_in }));

  // —— 邀请票：购买需门槛码（错码 403）；核销=扫码（1 码）——
  const optI = await call('POST', `/admin/events/${ev1.body.id}/options`, { adminToken, body: { name: '受邀专享票', price: 12900, optionType: 'INVITE', gateCode: 'GATE-123' } });
  ok('建邀请票（门槛码）', optI.status === 200 && optI.body.option_type === 'INVITE', JSON.stringify(optI.body).slice(0, 120));
  const uI = await call('POST', '/auth/wechat-login', { body: { code: 'four_invite' } });
  await completeProfile(uI.body.token, '受邀者', '13600000003');
  const regIbad = await call('POST', `/events/${ev1.body.id}/registrations`, { token: uI.body.token, body: { registrationOptionId: optI.body.id, gateCode: 'WRONG' } });
  ok('邀请票错误门槛码 403', regIbad.status === 403, `status=${regIbad.status}`);
  const regI = await call('POST', `/events/${ev1.body.id}/registrations`, { token: uI.body.token, body: { registrationOptionId: optI.body.id, gateCode: 'GATE-123' } });
  ok('邀请票正确门槛码可购买(PENDING)', regI.status === 200 && regI.body.status === 'PENDING');
  const payI = await call('POST', `/dev/registrations/${regI.body.id}/mock-pay`, { token: uI.body.token });
  ok('邀请票核销=扫码(1码,无码2)', payI.status === 200 && typeof payI.body.qr_token === 'string' && !payI.body.qr_token_2);

  // —— 门槛码脱敏：公开接口不返回 gate_code；后台接口返回 ——
  const pubEv = await call('GET', `/events/${ev1.body.id}`, { token: uI.body.token });
  const pubInvite = (pubEv.body.registrationOptions || []).find((o) => o.id === optI.body.id);
  ok('公开接口脱敏门槛码', pubEv.status === 200 && pubInvite && pubInvite.gate_code === undefined, JSON.stringify(pubInvite || {}).slice(0, 120));
  const admOpts = await call('GET', `/admin/events/${ev1.body.id}/options`, { adminToken });
  const admInvite = admOpts.body.find((o) => o.id === optI.body.id);
  ok('后台接口可见门槛码', admOpts.status === 200 && admInvite && admInvite.gate_code === 'GATE-123', JSON.stringify(admInvite || {}).slice(0, 120));

  // —— 候补票：免费、直接 PAID、无码、不受名额约束 ——
  const optW = await call('POST', `/admin/events/${ev1.body.id}/options`, { adminToken, body: { name: '候补登记', price: 0, optionType: 'WAITLIST' } });
  ok('建候补票(免费/WAITLIST)', optW.status === 200 && optW.body.option_type === 'WAITLIST' && optW.body.price === 0);
  const uW = await call('POST', '/auth/wechat-login', { body: { code: 'four_wait' } });
  await completeProfile(uW.body.token, '候补生', '13600000002');
  const regW = await call('POST', `/events/${ev1.body.id}/registrations`, { token: uW.body.token, body: { registrationOptionId: optW.body.id } });
  ok('候补免支付直接 PAID', regW.status === 200 && regW.body.status === 'PAID' && regW.body.amount === 0, JSON.stringify(regW.body).slice(0, 120));
  const detW = await call('GET', `/registrations/${regW.body.id}`, { token: uW.body.token });
  ok('候补无核销码', detW.status === 200 && !detW.body.qr_token && !detW.body.qr_data_url);
  const wlStats = await call('GET', `/admin/stats?eventId=${ev1.body.id}`, { adminToken });
  ok('统计含候补人数≥1', wlStats.status === 200 && wlStats.body.waitlist >= 1, JSON.stringify(wlStats.body));

  // —— 候补不受名额约束：capacity=1 时，候补可多次登记 ——
  const ev3 = await call('POST', '/admin/events', { adminToken, body: { title: '候补名额测试', startTime: iso(now + 10 * DAY), endTime: iso(now + 10 * DAY + 4 * H), registrationStartTime: iso(now - 1 * H), registrationEndTime: iso(now + 9 * DAY), capacity: 1, refundRule: 'ALLOW_ANY', status: 'PUBLISHED' } });
  const optW3 = await call('POST', `/admin/events/${ev3.body.id}/options`, { adminToken, body: { name: '候补', price: 0, optionType: 'WAITLIST' } });
  const uw1 = await call('POST', '/auth/wechat-login', { body: { code: 'cap_wait1' } }); await completeProfile(uw1.body.token, '候补1', '13611110001');
  const uw2 = await call('POST', '/auth/wechat-login', { body: { code: 'cap_wait2' } }); await completeProfile(uw2.body.token, '候补2', '13622220002');
  const rw1 = await call('POST', `/events/${ev3.body.id}/registrations`, { token: uw1.body.token, body: { registrationOptionId: optW3.body.id } });
  const rw2 = await call('POST', `/events/${ev3.body.id}/registrations`, { token: uw2.body.token, body: { registrationOptionId: optW3.body.id } });
  ok('候补不受名额限制(2人都能候补)', rw1.status === 200 && rw2.status === 200, `s1=${rw1.status} s2=${rw2.status}`);

await app.close();

console.log(`\n================ 冒烟结果 ================`);
console.log(`  通过 ${pass}  失败 ${fail}`);
if (fail > 0) process.exit(1);
console.log('  全部通过 \u2713');
process.exit(0);
