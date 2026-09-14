// 现场签到：二维码（wx.scanCode，§13-14）与手机号后四位（§15-17）两条入口，
// 共享同一个签到接口 POST /registrations/:id/checkin；后四位仅查询候选（脱敏、不自动签到）。
import {
  resolveQrToken, searchByPhoneLast4, performCheckin,
  QrResolved, PhoneSearchResult, CheckinMethod,
} from '../../services/checkin';
import { listEvents, EventItem } from '../../services/event';
import { ensureLogin } from '../../services/auth';
import { STATUS_ZH, toast } from '../../utils/util';

Page({
  data: {
    events: [] as EventItem[],
    eventIndex: 0,
    eventPickerLabels: [] as string[],
    last4: '',
    operator: '',
    resolved: null as any,
    candidates: null as PhoneSearchResult | null,
    result: null as { cls: string; text: string } | null,
    busy: false,
  },
  async onLoad() {
    try {
      const events = await listEvents();
      this.setData({ events, eventPickerLabels: events.map((e) => e.title) });
    } catch { /* 无活动则后四位查询时提示 */ }
  },
  onOperator(e: any) { this.setData({ operator: e.detail.value }); },
  onLast4(e: any) { this.setData({ last4: e.detail.value }); },
  onEventChange(e: any) { this.setData({ eventIndex: Number(e.detail.value) }); },
  async ensureStaff(): Promise<void> {
    try { await ensureLogin(); } catch (e: any) { toast((e && e.message) || '请先登录', 'error'); throw e; }
  },

  // ── 方式一：扫码 ──
  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (r) => this.handleQrToken(r.result),
      fail: (err: any) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
        toast('扫码失败或二维码无效', 'error');
      },
    });
  },
  async handleQrToken(token: string) {
    if (!token) return;
    this.setData({ busy: true, result: null });
    try {
      await this.ensureStaff();
      const r = await resolveQrToken(token);
      const reg = r.registration;
      this.setData({
        resolved: { ...reg, status_zh: STATUS_ZH[reg.registration_status] || reg.registration_status },
        busy: false,
      });
    } catch (e: any) {
      this.setData({ resolved: null, busy: false });
      toast((e && e.message) || '解析失败', 'error');
    }
  },
  confirmQr() {
    if (!this.data.resolved) return;
    this.doCheckin(this.data.resolved.registration_id, 'QR');
  },

  // ── 方式二：手机号后四位 ──
  onPhoneSearch() {
    const { events, eventIndex, last4 } = this.data;
    const ev = events[eventIndex];
    if (!ev) return toast('请选择活动', 'none');
    const l4 = last4.trim();
    if (!/^\d{4}$/.test(l4)) return toast('请输入 4 位数字', 'none');
    this.setData({ busy: true, result: null });
    this.ensureStaff()
      .then(() => searchByPhoneLast4(ev.id, l4))
      .then((r) => this.setData({ candidates: r, busy: false }))
      .catch((e: any) => {
        this.setData({ candidates: null, busy: false });
        toast((e && e.message) || '查询失败', 'error');
      });
  },
  confirmCandidate(e: any) {
    this.doCheckin(Number(e.currentTarget.dataset.id), 'PHONE_LAST4');
  },

  doCheckin(regId: number, method: CheckinMethod) {
    this.setData({ busy: true });
    performCheckin(regId, method, this.data.operator.trim() || undefined)
      .then((r) => {
        this.setData({
          result: { cls: r.already ? 'warn' : 'ok', text: r.message },
          busy: false,
          resolved: null,
          candidates: null,
        });
        toast(r.already ? '该报名已签到' : '签到成功', r.already ? 'none' : 'success');
      })
      .catch((e: any) => {
        this.setData({ busy: false });
        toast((e && e.message) || '签到失败', 'error');
      });
  },
});
