// 报名详情凭证：已支付报名的二维码凭证（qr_token 不可预测，QR 编码 token 而非自增 id，§12）。
import { getRegistration, refundRegistration } from '../../services/registration';
import { fmtTime, STATUS_ZH, toast } from '../../utils/util';

Page({
  data: { id: 0, reg: null as any, loading: true, error: '' },
  onLoad(q: Record<string, string>) { this.setData({ id: Number(q.id) }); this.load(); },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    getRegistration(this.data.id)
      .then((reg) => {
        this.setData({
          reg: {
            ...reg,
            status_zh: STATUS_ZH[reg.status] || reg.status,
            paid_at_display: fmtTime(reg.paid_at),
            checked_in_display: reg.checked_in_at ? fmtTime(reg.checked_in_at) : '',
          },
          loading: false,
        });
      })
      .catch((e: any) => this.setData({ loading: false, error: (e && e.message) || '加载失败' }));
  },
  copyToken() {
    const t = this.data.reg && this.data.reg.qr_token;
    if (!t) return;
    wx.setClipboardData({ data: t, success: () => toast('已复制 qr_token', 'success') });
  },
  refund() {
    wx.showModal({
      title: '申请退款', content: '确认申请退款？',
      success: (r) => {
        if (!r.confirm) return;
        refundRegistration(this.data.id)
          .then(() => { toast('退款成功', 'success'); this.load(); })
          .catch((x: any) => toast((x && x.message) || '退款失败（已签到或不在退款窗口）', 'error'));
      },
    });
  },
});
