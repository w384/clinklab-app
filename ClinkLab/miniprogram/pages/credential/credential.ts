// 报名凭证：二维码 + 报名编号 + 活动信息 + 状态。签到时出示二维码。评价入口也在这里（我的报名 → 凭证）。
import { getRegistration, Registration, canReview } from '../../services/registration';
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
    checked_in_2_display: '',
    option_type: 'SINGLE' as string,
    isWaitlist: false,
    isDouble: false,
    all_checked_in: false,
    status_zh: '',
    badge_cls: '',
    can_review: false,
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
      const option_type = reg.option_type || (reg.option && reg.option.option_type) || 'SINGLE';
      const isWaitlist = option_type === 'WAITLIST';
      const isDouble = option_type === 'DOUBLE';
      const badge_cls =
        isWaitlist ? 'waitlist'
        : reg.status === 'PAID' ? (reg.checked_in ? 'checked' : 'paid')
        : reg.status === 'PENDING' ? 'pend'
        : reg.status === 'CANCELLED' ? 'cancel'
        : 'refund';
      this.setData({
        reg,
        badge_cls,
        option_type,
        isWaitlist,
        isDouble,
        all_checked_in: !!reg.all_checked_in,
        start_display: reg.event ? fmtTime(reg.event.start_time) : '',
        paid_at_display: reg.paid_at ? fmtTime(reg.paid_at) : '',
        checked_in_display: reg.checked_in_at ? fmtTime(reg.checked_in_at) : '',
        checked_in_2_display: reg.checked_in_2 ? fmtTime(reg.checked_in_2) : '',
        status_zh: isWaitlist ? '候补中' : STATUS_ZH[reg.status] || reg.status,
        can_review: canReview(reg),
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
  goReview(): void {
    const id = this.data.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/review/review?registrationId=${id}` });
  },
  backHome(): void {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
