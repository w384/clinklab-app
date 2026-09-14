// 填写报名：步骤1 活动信息 + 报名选项 + 资料快照（昵称/手机取自「我的」，不重复填写）→ 步骤2 确认支付 → 结果页。
// 金额/状态由服务端决定；wx.requestPayment 成功 ≠ 终态，最终以服务端 GET 为准。
import { getEvent, EventItem, OptionType, OPTION_TYPE_LABEL } from '../../services/event';
import { createRegistration, getRegistration, mockPay, Registration } from '../../services/registration';
import { prepay, wxRequestPayment } from '../../services/payment';
import { ensureLogin, getCurrentUser } from '../../services/auth';
import { fmtCents, toast } from '../../utils/util';

interface OptionRow {
  id: number;
  name: string;
  description: string;
  price_display: string;
  option_type: OptionType;
  type_label: string;
  sold_out: boolean; // 该票种已售罄（达到购票上限）
  limit_text: string; // "余 5" / "已售罄" / ''（不限量）
}

Page({
  data: {
    eventId: 0,
    event: null as EventItem | null,
    options: [] as OptionRow[],
    selectedOptionId: 0,
    selectedOptionType: '' as '' | OptionType,
    selectedSoldOut: false, // 当前选中的票种是否已售罄（确认后将转入候补）
    gateCode: '',
    profile: null as { nickname: string; phone: string } | null,
    profileReady: false,
    remark: '',
    customFields: [] as { key: string; label: string; required: boolean; type: 'text' | 'textarea' | 'choice'; options: string[] }[],
    customValues: {} as Record<string, string>,
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
      const options: OptionRow[] = (e.registrationOptions || []).map((o) => {
        const remaining = o.remaining != null ? o.remaining : null;
        const soldOut = o.option_type !== 'WAITLIST' && remaining === 0;
        return {
          id: o.id,
          name: o.name,
          description: o.description || '',
          price_display: fmtCents(o.price).replace('¥', ''),
          option_type: o.option_type || 'SINGLE',
          type_label: OPTION_TYPE_LABEL[o.option_type || 'SINGLE'] || '单人票',
          sold_out: soldOut,
          limit_text: o.option_type === 'WAITLIST' ? '' : soldOut ? '已售罄' : remaining != null ? `余 ${remaining}` : '',
        };
      });
      const first = options[0];
      const customFields: { key: string; label: string; required: boolean; type: 'text' | 'textarea' | 'choice'; options: string[] }[] = (e.custom_fields || []).map((f) => {
        const type = f.type === 'textarea' ? ('textarea' as const) : f.type === 'choice' ? ('choice' as const) : ('text' as const);
        return {
          key: f.key,
          label: f.label,
          required: !!f.required,
          type,
          options: Array.isArray(f.options) ? f.options.map((o) => String(o)) : [],
        };
      });
      this.setData({
        event: e,
        options,
        selectedOptionId: first ? first.id : 0,
        selectedOptionType: first ? first.option_type : '',
        selectedSoldOut: first ? !!(first.sold_out) : false,
        customFields,
        customValues: {},
        loading: false,
      });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  onSelectOption(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    const type = (e.currentTarget.dataset.type as OptionType) || 'SINGLE';
    const soldOut = e.currentTarget.dataset.soldout === '1';
    this.setData({ selectedOptionId: id, selectedOptionType: type, selectedSoldOut: soldOut });
  },
  onGateCode(e: WechatMiniprogram.Input): void {
    this.setData({ gateCode: e.detail.value });
  },
  onRemark(e: WechatMiniprogram.TextareaInput): void {
    this.setData({ remark: e.detail.value });
  },
  onCustomInput(e: WechatMiniprogram.Input): void {
    const key = e.currentTarget.dataset.key as string;
    this.setData({ [`customValues.${key}`]: e.detail.value });
  },
  // 单选字段：点击选项即选中（数据存 customValues.<key>）
  onCustomChoice(e: WechatMiniprogram.TouchEvent): void {
    const key = e.currentTarget.dataset.key as string;
    const value = e.currentTarget.dataset.value as string;
    this.setData({ [`customValues.${key}`]: value });
  },
  goProfile(): void {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  // 步骤1 → 创建报名（PENDING）→ 步骤2。姓名/手机由服务端取自资料快照。
  async confirmCreate(): Promise<void> {
    const { eventId, selectedOptionId, selectedOptionType, gateCode, remark, profileReady, customFields, customValues, options } = this.data;
    if (!profileReady) { toast('请先在「我的」里完善昵称和手机号', 'none'); return; }
    if (!selectedOptionId) { toast('请选择报名选项', 'none'); return; }
    if (selectedOptionType === 'INVITE' && !gateCode.trim()) { toast('请输入购买邀请码', 'none'); return; }
    // 售罄票种：明确告知将转入候补，确认后才继续（服务端自动登记候补，正票退票后按序补位）
    const sel = options.find((o) => o.id === selectedOptionId);
    if (sel && sel.sold_out) {
      const ok = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '该票种已售罄',
          content: '确认后将为你登记候补（免费）。正票有人退票时，将按候补顺序自动补位成正票并提示你支付。是否继续？',
          confirmText: '登记候补',
          cancelText: '再想想',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    // 自定义报名字段：必填校验（服务端也会再校验一次）
    const custom: Record<string, string> = {};
    for (const f of customFields) {
      const v = (customValues[f.key] || '').trim();
      if (f.required && !v) { toast(`请填写「${f.label}」`, 'none'); return; }
      if (v) custom[f.key] = v;
    }
    this.setData({ busy: true });
    try {
      await ensureLogin();
      const reg = await createRegistration(eventId, {
        registrationOptionId: selectedOptionId,
        remark: remark ? remark.trim() : undefined,
        gateCode: selectedOptionType === 'INVITE' ? gateCode.trim() : undefined,
        customFields: Object.keys(custom).length ? custom : undefined,
      });
      // 候补票：免费、直接成功、免支付 → 直接跳结果页
      if (reg.option_type === 'WAITLIST') {
        this.setData({ reg, busy: false });
        wx.redirectTo({ url: `/pages/pay-result/pay-result?id=${reg.id}` });
        return;
      }
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
