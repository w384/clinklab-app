// 填写报名：步骤1 活动信息 + 报名选项 + 资料快照（昵称/手机取自「我的」，不重复填写）→ 步骤2 确认支付 → 结果页。
// 金额/状态由服务端决定；wx.requestPayment 成功 ≠ 终态，最终以服务端 GET 为准。
import { getEvent, EventItem } from '../../services/event';
import { createRegistration, getRegistration, mockPay, Registration } from '../../services/registration';
import { prepay, wxRequestPayment } from '../../services/payment';
import { ensureLogin, getCurrentUser } from '../../services/auth';
import { fmtCents, toast } from '../../utils/util';

interface OptionRow {
  id: number;
  name: string;
  description: string;
  price_display: string;
}

Page({
  data: {
    eventId: 0,
    event: null as EventItem | null,
    options: [] as OptionRow[],
    selectedOptionId: 0,
    profile: null as { nickname: string; phone: string } | null,
    profileReady: false,
    remark: '',
    step: 1,
    reg: null as Registration | null,
    loading: true,
    error: '',
    busy: false,
  },
  async onLoad(opts: Record<string, string | undefined>): Promise<void> {
    const eventId = Number(opts && opts.eventId);
    this.setData({ eventId });
    if (!eventId) { this.setData({ loading: false, error: '缺少活动 ID' }); return; }
    // 报名需登录：先确保登录态，再读取资料快照（昵称/手机来自「我的」，首次登录时采集）
    try { await ensureLogin(); } catch { /* 未登录可浏览，但无法报名 */ }
    this.syncProfile();
    this.loadEvent(eventId);
  },
  // 同步资料快照到页面（报名页只读展示，不再让用户填写）
  syncProfile(): void {
    const u = getCurrentUser();
    const ready = !!(u && u.nickname && u.phone);
    this.setData({
      profileReady: ready,
      profile: u ? { nickname: u.nickname || '', phone: u.phone || '' } : null,
    });
  },
  onShow(): void {
    // 从「完善资料」页返回时刷新快照
    if (this.data.eventId) this.syncProfile();
  },
  async loadEvent(eventId: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const e = await getEvent(eventId);
      const options: OptionRow[] = (e.registrationOptions || []).map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description || '',
        price_display: fmtCents(o.price).replace('¥', ''),
      }));
      this.setData({ event: e, options, selectedOptionId: options[0] ? options[0].id : 0, loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  onSelectOption(e: WechatMiniprogram.TouchEvent): void {
    this.setData({ selectedOptionId: e.currentTarget.dataset.id as number });
  },
  onRemark(e: WechatMiniprogram.TextareaInput): void {
    this.setData({ remark: e.detail.value });
  },
  goProfile(): void {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  // 步骤1 → 创建报名（PENDING）→ 步骤2。姓名/手机由服务端取自资料快照。
  async confirmCreate(): Promise<void> {
    const { eventId, selectedOptionId, remark, profileReady } = this.data;
    if (!profileReady) { toast('请先在「我的」里完善昵称和手机号', 'none'); return; }
    if (!selectedOptionId) { toast('请选择报名选项', 'none'); return; }
    this.setData({ busy: true });
    try {
      await ensureLogin();
      const reg = await createRegistration(eventId, {
        registrationOptionId: selectedOptionId,
        remark: remark ? remark.trim() : undefined,
      });
      this.setData({ reg, step: 2, busy: false });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '创建报名失败', 'none');
      this.setData({ busy: false });
    }
  },

  // 步骤2 → 支付（真实 or mock）→ 结果页
  async goPay(): Promise<void> {
    const reg = this.data.reg;
    if (!reg) return;
    this.setData({ busy: true });
    try {
      const pre = await prepay(reg.id);
      if (pre.payment) {
        // 真实微信统一下单 → 拉起支付
        await wxRequestPayment(pre.payment);
      } else {
        // mock 模式（development-only）
        await mockPay(reg.id);
      }
      // 以服务端状态为准
      const fresh = await getRegistration(reg.id);
      this.setData({ reg: fresh, busy: false });
      wx.redirectTo({ url: `/pages/pay-result/pay-result?id=${fresh.id}` });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '支付未完成，请重试', 'none');
      this.setData({ busy: false });
      wx.redirectTo({ url: `/pages/pay-result/pay-result?id=${reg.id}` });
    }
  },
});
