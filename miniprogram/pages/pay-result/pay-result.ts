// 支付结果（§35 onShow 刷新，状态以服务端为准；wx.requestPayment 成功 ≠ 最终状态）。
// 开发环境走 mock-pay；生产走 统一下单 + wx.requestPayment（随后仍回服务端核对）。
import { getRegistration, mockPay, cancelRegistration } from '../../services/registration';
import { prepay, wxRequestPayment } from '../../services/payment';
import { getMockPay } from '../../services/appConfig';
import { fmtTime, STATUS_ZH, toast } from '../../utils/util';

function withView(reg: any) {
  return {
    ...reg,
    status_zh: STATUS_ZH[reg.status] || reg.status,
    paid_at_display: fmtTime(reg.paid_at),
    amount_display: reg.amount_display,
  };
}

Page({
  data: {
    id: 0,
    reg: null as any,
    loading: true,
    mockPay: false,
    paying: false,
  },
  onLoad(q: Record<string, string>) {
    this.setData({ id: Number(q.id) });
    this.load();
  },
  onShow() { this.load(); },
  load() {
    this.setData({ loading: true });
    getRegistration(this.data.id)
      .then((reg) => {
        this.setData({
          reg: withView(reg),
          loading: false,
          mockPay: getMockPay(),
        });
        wx.setNavigationBarTitle({ title: reg.status === 'PAID' ? '支付成功' : '待支付' });
      })
      .catch((e: any) => {
        this.setData({ loading: false });
        wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
      });
  },
  onMockPay() {
    this.setData({ paying: true });
    mockPay(this.data.id)
      .then((reg) => {
        toast('支付成功', 'success');
        this.setData({ reg: withView(reg), paying: false });
        wx.setNavigationBarTitle({ title: '支付成功' });
      })
      .catch((e: any) => {
        this.setData({ paying: false });
        toast((e && e.message) || '支付失败', 'error');
        this.load();
      });
  },
  onRealPay() {
    this.setData({ paying: true });
    prepay(this.data.id)
      .then((pp) => wxRequestPayment(pp.payment))
      .then(() => {
        // 支付结束（成功或用户取消）后，一律回服务端核对真实状态
        this.setData({ paying: false });
        this.load();
      })
      .catch((e: any) => {
        this.setData({ paying: false });
        if (e && e.code === -1 && e.message === '支付未完成') toast('支付未完成，可在"我的报名"继续支付', 'none');
        else toast((e && e.message) || '发起支付失败（生产环境需真实商户）', 'error');
        this.load();
      });
  },
  onCancel() {
    wx.showModal({
      title: '取消报名',
      content: '确认取消该待支付报名？',
      success: (r) => {
        if (!r.confirm) return;
        cancelRegistration(this.data.id)
          .then(() => { toast('已取消', 'success'); this.load(); })
          .catch((e: any) => toast((e && e.message) || '取消失败', 'error'));
      },
    });
  },
  goCredential() {
    wx.redirectTo({ url: `/pages/credential/credential?id=${this.data.id}` });
  },
});
