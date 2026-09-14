// 支付结果：以服务端状态为准（wx.requestPayment success ≠ 终态）。
import { getRegistration, mockPay, Registration } from '../../services/registration';
import { prepay, wxRequestPayment } from '../../services/payment';
import { requestSubscribeMessage } from '../../services/subscribe';
import { fmtTime, toast } from '../../utils/util';

Page({
  data: {
    id: 0,
    reg: null as Registration | null,
    loading: true,
    error: '',
    paid_at_display: '',
    cancelled_at_display: '',
    isWaitlist: false,
  },
  onLoad(opts: Record<string, string | undefined>): void {
    const id = Number(opts && opts.id);
    this.setData({ id });
    if (id) this.load(id);
    else this.setData({ loading: false, error: '缺少报名 ID' });
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const reg = await getRegistration(id);
      this.setData({
        reg,
        isWaitlist: reg.option_type === 'WAITLIST',
        paid_at_display: reg.paid_at ? fmtTime(reg.paid_at) : '',
        cancelled_at_display: reg.cancelled_at ? fmtTime(reg.cancelled_at) : '',
        loading: false,
      });
      // B⑤：支付成功后弹一次订阅授权（报名成功 + 活动提醒）；未配置模板时静默跳过
      if (reg.status === 'PAID' && reg.option_type !== 'WAITLIST') {
        requestSubscribeMessage().catch(() => {});
      }
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  // 订单已取消（超时/主动取消）→ 回到活动详情重新报名
  reRegister(): void {
    const ev = this.data.reg && this.data.reg.event;
    if (!ev) return;
    wx.redirectTo({ url: `/pages/detail/detail?id=${ev.id}` });
  },
  viewCred(): void {
    const reg = this.data.reg;
    if (!reg) return;
    if (reg.qr_token || reg.option_type === 'WAITLIST') {
      wx.navigateTo({ url: `/pages/credential/credential?id=${reg.id}` });
    } else {
      this.continuePay();
    }
  },
  /** 继续支付：对同一 PENDING 报名重新触发（真实环境走 prepay 拉起支付；mock 环境直接 mockPay），不新建报名。 */
  async continuePay(): Promise<void> {
    const id = this.data.id;
    if (!id) return;
    try {
      this.setData({ loading: true, error: '' });
      const pre = await prepay(id);
      if (pre.payment) {
        await wxRequestPayment(pre.payment);
      } else {
        await mockPay(id);
      }
      await this.load(id);
      const reg = this.data.reg;
      if (reg && reg.status === 'PAID') toast('支付成功', 'success');
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '支付失败，请重试' });
    }
  },
  goHome(): void {
    wx.switchTab({ url: '/pages/index/index' });
  },
  // 分享：把活动发给朋友（报名成功后）
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const reg = this.data.reg;
    const ev = reg && reg.event;
    return {
      title: ev ? `${ev.title} · 碰杯LAB，一起来？` : '碰杯LAB · 硬核知识×微醺社交',
      path: ev ? `/pages/detail/detail?id=${ev.id}` : '/pages/index/index',
    };
  },
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent {
    const reg = this.data.reg;
    const ev = reg && reg.event;
    return {
      title: ev ? `${ev.title} · 碰杯LAB` : '碰杯LAB · 硬核知识×微醺社交',
      query: ev ? `id=${ev.id}` : '',
    };
  },
});
