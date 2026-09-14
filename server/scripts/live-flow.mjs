// 真实 HTTP 冒烟（走已启动的 127.0.0.1:3050），确认 transport 层 OK。
const B = 'http://127.0.0.1:3050';
const J = async (method, url, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(B + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  \u2713', n)) : (fail++, console.log('  \u2717', n)); };

const ev = (await J('GET', '/events')).body[0];
const opt = ev.registrationOptions[0];
const u = (await J('POST', '/auth/wechat-login', { body: { code: 'live_' + Date.now() } })).body;
const reg = (await J('POST', `/events/${ev.id}/registrations`, { token: u.token, body: { registrationOptionId: opt.id, name: '活体', phone: '136' + String(Date.now()).slice(-7) } })).body;
ok('创建报名', reg.status && reg.status === 'PENDING');
const paid = (await J('POST', `/dev/registrations/${reg.id}/mock-pay`, { token: u.token })).body;
ok('支付 PAID + qr_token', paid.status === 'PAID' && String(paid.qr_token).startsWith('c1k_'));
const detail = (await J('GET', `/registrations/${reg.id}`, { token: u.token })).body;
ok('凭证二维码', String(detail.qr_data_url).startsWith('data:image/png'));
const resolve = (await J('GET', `/checkin/resolve?qrToken=${encodeURIComponent(paid.qr_token)}`, { token: u.token })).body;
ok('二维码解析', resolve.registration.registration_id === reg.id);
const ci = (await J('POST', `/registrations/${reg.id}/checkin`, { token: u.token, body: { method: 'QR', operator: 'live' } })).body;
ok('签到成功', ci.already === false);
const ci2 = (await J('POST', `/registrations/${reg.id}/checkin`, { token: u.token, body: { method: 'QR', operator: 'live' } })).body;
ok('重复签到幂等', ci2.already === true);
const u2 = (await J('POST', '/auth/wechat-login', { body: { code: 'live2_' + Date.now() } })).body;
const reg2 = (await J('POST', `/events/${ev.id}/registrations`, { token: u2.token, body: { registrationOptionId: opt.id, name: '退款人', phone: '135' + String(Date.now()).slice(-7) } })).body;
await J('POST', `/dev/registrations/${reg2.id}/mock-pay`, { token: u2.token });
const rf = (await J('POST', `/registrations/${reg2.id}/refund`, { token: u2.token, body: { reason: 'live' } })).body;
ok('退款 REFUNDED', rf.status === 'REFUNDED');
const adm = (await J('POST', '/admin/auth/login', { body: { username: 'admin', password: 'admin123' } })).body;
const list = (await J('GET', `/admin/registrations?eventId=${ev.id}`, { token: adm.token })).body;
ok('管理端名单', list.total >= 2);
console.log(`\nLIVE FLOW: 通过 ${pass} 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
