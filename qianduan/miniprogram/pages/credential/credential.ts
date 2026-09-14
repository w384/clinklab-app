// 报名凭证：二维码 + 报名编号 + 活动信息 + 状态。签到时出示二维码。
import { getRegistration, Registration } from '../../services/registration';
import { fmtTime, STATUS_ZH } from '../../utils/util';

Page({
  data: {
    id: 0,
    reg: null as Registration | null,
    loading: true,
    error: '',
    start_display: '',
    paid_at_display: '',
    checked_in_display: '',
    status_zh: '',
    badge_cls: '',
  },
  onLoad(opts: Record<string, string | undefined>): void {
    const id = Number(opts && opts.id);
    this.setData({ id });
    if (id) this.load(id);
    else this.setData({ loading: false, error: '缺少报名 ID' });
  },
  onShow(): void {
    // 从签到/支付返回时刷新状态
    if (this.data.id) this.load(this.data.id);
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const reg = await getRegistration(id);
      const badge_cls =
        reg.status === 'PAID' ? (reg.checked_in ? 'checked' : 'paid')
        : reg.status === 'PENDING' ? 'pend'
        : reg.status === 'CANCELLED' ? 'cancel'
        : 'refund';
      this.setData({
        reg,
        badge_cls,
        start_display: reg.event ? fmtTime(reg.event.start_time) : '',
        paid_at_display: reg.paid_at ? fmtTime(reg.paid_at) : '',
        checked_in_display: reg.checked_in_at ? fmtTime(reg.checked_in_at) : '',
        status_zh: STATUS_ZH[reg.status] || reg.status,
        loading: false,
      });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  copyNo(): void {
    const reg = this.data.reg;
    if (!reg) return;
    wx.setClipboardData({ data: reg.registration_no });
  },
  backHome(): void {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
