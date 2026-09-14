// 现场签到（工作人员）：扫码 或 手机号后四位。仅 is_admin 用户可访问（服务端再校验）。
import { listEvents } from '../../services/event';
import {
  resolveQrToken, searchByPhoneLast4, performCheckin,
  QrResolved, PhoneSearchResult, CheckinResult, CheckinMethod,
} from '../../services/checkin';
import { ensureLogin, getIsAdmin, refreshUser } from '../../services/auth';
import { toast } from '../../utils/util';

interface EventOpt { id: number; title: string; }

Page({
  data: {
    isAdmin: false,
    mode: 'scan',
    events: [] as EventOpt[],
    eventId: 0,
    last4: '',
    resolved: null as QrResolved | null,
    search: null as PhoneSearchResult | null,
    lastResult: null as CheckinResult | null,
    busy: false,
    error: '',
  },
  async onShow(): Promise<void> {
    // 从服务端同步最新角色（避免「开通工作人员权限」后本地缓存仍是旧的 isAdmin=false）
    let admin = getIsAdmin();
    try {
      const me = await refreshUser();
      admin = !!(me && me.isAdmin);
    } catch { /* 网络失败时退回本地缓存判定 */ }
    this.setData({ isAdmin: admin });
    if (!admin) return;
    try {
      await ensureLogin();
      const events = await listEvents();
      const opts: EventOpt[] = (events || []).map((e) => ({ id: e.id, title: e.title }));
      this.setData({ events: opts, eventId: opts[0] ? opts[0].id : 0 });
    } catch { /* 事件列表加载失败不阻塞签到 */ }
  },
  setMode(e: WechatMiniprogram.TouchEvent): void {
    this.setData({ mode: e.currentTarget.dataset.mode as string, resolved: null, search: null, lastResult: null, error: '' });
  },
  onEventChange(e: WechatMiniprogram.PickerChange): void {
    const idx = Number(e.detail.value);
    const ev = this.data.events[idx];
    this.setData({ eventId: ev ? ev.id : 0, search: null });
  },
  onLast4(e: WechatMiniprogram.Input): void {
    this.setData({ last4: e.detail.value });
  },
  async scanQr(): Promise<void> {
    this.setData({ busy: true, error: '', lastResult: null });
    try {
      const code = await new Promise<string>((resolve, reject) => {
        wx.scanCode({
          success: (r) => (r.result ? resolve(r.result) : reject({ code: -1, message: '未识别到二维码' })),
          fail: (err) => reject({ code: -1, message: '取消或识别失败', data: err }),
        });
      });
      const res = await resolveQrToken(code);
      this.setData({ resolved: res, busy: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ busy: false, error: (err && err.message) || '识别失败' });
    }
  },
  async doSearch(): Promise<void> {
    const last4 = this.data.last4.trim();
    const eventId = this.data.eventId;
    if (!/^\d{4}$/.test(last4)) { toast('请输入 4 位数字', 'none'); return; }
    if (!eventId) { toast('请选择活动', 'none'); return; }
    this.setData({ busy: true, error: '' });
    try {
      const res = await searchByPhoneLast4(eventId, last4);
      this.setData({ search: res, busy: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ busy: false, error: (err && err.message) || '查询失败' });
    }
  },
  async confirmCheckin(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const id = e.currentTarget.dataset.id as number;
    const method = (e.currentTarget.dataset.method as string) === 'PHONE_LAST4'
      ? 'PHONE_LAST4' as CheckinMethod
      : 'QR' as CheckinMethod;
    this.setData({ busy: true, error: '' });
    try {
      const res = await performCheckin(id, method);
      this.setData({ lastResult: res, busy: false, resolved: null, search: null, last4: '' });
      if (!res.already) toast('签到成功', 'success');
    } catch (e2) {
      const err = e2 as { message?: string };
      this.setData({ busy: false, error: (err && err.message) || '签到失败' });
    }
  },
});
