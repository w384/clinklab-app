// 我的报名：列表 + 继续支付 / 取消 / 退款 / 查看凭证（§35 onShow 刷新）。
import {
  listMyRegistrations, mockPay, cancelRegistration, refundRegistration,
} from '../../services/registration';
import { fmtTime, STATUS_ZH, toast } from '../../utils/util';

function view(r: any) {
  return {
    ...r,
    status_zh: STATUS_ZH[r.status] || r.status,
    time_display: fmtTime(r.paid_at || r.created_at),
    checked_in_zh: r.checked_in ? '已签到' : '',
  };
}

Page({
  data: { regs: [] as any[], loading: true, error: '' },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true, error: '' });
    listMyRegistrations()
      .then((regs) => this.setData({ regs: (regs || []).map(view), loading: false }))
      .catch((e: any) => this.setData({ loading: false, error: (e && e.message) || '加载失败' }));
  },
  open(e: any) {
    const { id, status } = e.currentTarget.dataset;
    const url = status === 'PENDING'
      ? `/pages/pay-result/pay-result?id=${id}`
      : `/pages/credential/credential?id=${id}`;
    wx.navigateTo({ url });
  },
  goIndex() { wx.switchTab({ url: '/pages/index/index' }); },
  noop() { /* 拦截按钮区点击冒泡到卡片 open */ },
  onAction(e: any) {
    const { id, act } = e.currentTarget.dataset;
    if (act === 'pay') {
      mockPay(id).then(() => { toast('支付成功', 'success'); this.load(); })
        .catch((x: any) => toast((x && x.message) || '支付失败', 'error'));
    } else if (act === 'cancel') {
      wx.showModal({
        title: '取消报名', content: '确认取消该待支付报名？',
        success: (r) => {
          if (!r.confirm) return;
          cancelRegistration(id).then(() => { toast('已取消', 'success'); this.load(); })
            .catch((x: any) => toast((x && x.message) || '取消失败', 'error'));
        },
      });
    } else if (act === 'refund') {
      wx.showModal({
        title: '申请退款', content: '确认申请退款？',
        success: (r) => {
          if (!r.confirm) return;
          refundRegistration(id).then(() => { toast('退款成功', 'success'); this.load(); })
            .catch((x: any) => toast((x && x.message) || '退款失败', 'error'));
        },
      });
    } else if (act === 'detail') {
      wx.navigateTo({ url: `/pages/credential/credential?id=${id}` });
    }
  },
});
