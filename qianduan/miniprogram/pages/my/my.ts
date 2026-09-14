// 我的报名：列出当前用户的报名记录（需登录）。
import { listMyRegistrations, cancelRegistration, Registration } from '../../services/registration';
import { ensureLogin, getIsAdmin } from '../../services/auth';
import { fmtTime, STATUS_ZH, toast } from '../../utils/util';

interface Row extends Registration {
  status_zh: string;
  badge_cls: string;
  start_display: string;
  title: string;
}

function badgeCls(r: Registration): string {
  if (r.status === 'PAID') return r.checked_in ? 'checked' : 'paid';
  if (r.status === 'PENDING') return 'pend';
  if (r.status === 'REFUNDING' || r.status === 'REFUNDED') return 'refund';
  if (r.status === 'CANCELLED') return 'cancel';
  return '';
}

Page({
  data: {
    list: [] as Row[],
    loading: true,
    error: '',
    isAdmin: false,
  },
  onShow(): void {
    this.setData({ isAdmin: getIsAdmin() });
    this.load();
  },
  onPullDownRefresh(): void {
    this.load().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },
  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      await ensureLogin();
      const regs = await listMyRegistrations();
      const list: Row[] = (regs || []).map((r) => ({
        ...r,
        status_zh: STATUS_ZH[r.status] || r.status,
        badge_cls: badgeCls(r),
        start_display: r.event ? (fmtTime(r.event.start_time) || '') : '',
        title: r.event ? r.event.title : '活动',
      }));
      this.setData({ list, loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  goCred(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/credential/credential?id=${id}` });
  },
  onCancel(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    wx.showModal({
      title: '取消报名',
      content: '确定取消该报名吗？已支付报名请申请退款。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await cancelRegistration(id);
          toast('已取消', 'success');
          this.load();
        } catch (e) {
          const err = e as { message?: string };
          toast((err && err.message) || '取消失败', 'none');
        }
      },
    });
  },
  goIndex(): void {
    wx.switchTab({ url: '/pages/index/index' });
  },
  noop(): void {
    /* 阻止卡片整卡点击冒泡到按钮 */
  },
});
