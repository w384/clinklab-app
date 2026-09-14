// 支付结果：以服务端状态为准（wx.requestPayment success ≠ 终态）。
import { getRegistration, mockPay, Registration } from '../../services/registration';
import { fmtTime, toast } from '../../utils/util';

Page({
  data: {
    id: 0,
    reg: null as Registration | null,
    loading: true,
    error: '',
    paid_at_display: '',
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
      this.setData({ reg, paid_at_display: reg.paid_at ? fmtTime(reg.paid_at) : '', loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  viewCred(): void {
    const reg = this.data.reg;
    if (reg && reg.qr_token) wx.navigateTo({ url: `/pages/credential/credential?id=${reg.id}` });
    else if (reg) this.continuePay();
  },
  /** 继续支付：对同一 PENDING 报名重新触发（mock 模式直接 mockPay），不新建报名。 */
  async continuePay(): Promise<void> {
    const id = this.data.id;
    if (!id) return;
    try {
      this.setData({ loading: true, error: '' });
      await mockPay(id);
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
});
