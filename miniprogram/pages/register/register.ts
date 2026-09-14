// 报名填写：姓名 / 手机号 / 备注；金额由服务端计算（客户端不决定金额，§9）。
import { ensureLogin } from '../../services/auth';
import { getEvent, RegistrationOption } from '../../services/event';
import { createRegistration } from '../../services/registration';

Page({
  data: {
    eventId: 0,
    options: [] as RegistrationOption[],
    pickerLabels: [] as string[],
    optionIndex: 0,
    name: '',
    phone: '',
    remark: '',
    amount_display: '',
    submitting: false,
  },
  onLoad(q: Record<string, string>) {
    this.setData({ eventId: Number(q.eventId) });
    this.loadOptions(Number(q.optionId) || 0);
  },
  async loadOptions(preselectId: number) {
    try {
      const e = await getEvent(this.data.eventId);
      const options = (e.registrationOptions || []).filter((o) => o.status === 'ACTIVE');
      const idx = Math.max(0, options.findIndex((o) => o.id === preselectId));
      this.setData({
        options,
        pickerLabels: options.map((o) => `${o.name} · ${o.price_display}`),
        optionIndex: idx,
        amount_display: options[idx] ? options[idx].price_display : '',
      });
    } catch { /* 详情页已展示，忽略 */ }
  },
  onOptionChange(e: any) {
    const idx = Number(e.detail.value);
    this.setData({ optionIndex: idx, amount_display: this.data.options[idx] ? this.data.options[idx].price_display : '' });
  },
  onName(e: any) { this.setData({ name: e.detail.value }); },
  onPhone(e: any) { this.setData({ phone: e.detail.value }); },
  onRemark(e: any) { this.setData({ remark: e.detail.value }); },
  async submit() {
    const { eventId, options, optionIndex, name, phone, remark } = this.data;
    if (!name.trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    const ph = phone.trim();
    if (!/^1\d{10}$/.test(ph)) return wx.showToast({ title: '请填写正确的 11 位手机号', icon: 'none' });
    if (!options.length) return wx.showToast({ title: '没有可报名类型', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await ensureLogin();
      const reg = await createRegistration(eventId, {
        registrationOptionId: options[optionIndex].id,
        name: name.trim(),
        phone: ph,
        remark: remark.trim() || undefined,
      });
      wx.navigateTo({ url: `/pages/pay-result/pay-result?id=${reg.id}` });
    } catch (e: any) {
      wx.showToast({ title: (e && e.message) || '报名失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
