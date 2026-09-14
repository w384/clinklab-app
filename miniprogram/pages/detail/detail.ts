// 活动详情：展示活动信息 + 报名类型，选择后进入报名填写。
import { getEvent, RegistrationOption } from '../../services/event';
import { fmtTime, REFUND_RULE_ZH } from '../../utils/util';

interface EventView {
  id: number; title: string; subtitle: string | null; description: string | null;
  location_name: string | null; location_address: string | null;
  start_time: string; end_time: string; registration_start_time: string; registration_end_time: string;
  capacity: number | null; valid_paid_count: number; full: boolean; refund_rule: string;
  start_display: string; end_display: string; reg_window_display: string; refund_rule_display: string;
}

Page({
  data: {
    eventId: 0,
    event: null as EventView | null,
    options: [] as RegistrationOption[],
    selectedOptionId: 0,
    loading: true,
    error: '',
  },
  onLoad(q: Record<string, string>) {
    this.setData({ eventId: Number(q.id) });
    this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const e = await getEvent(this.data.eventId);
      const options = (e.registrationOptions || []).filter((o) => o.status === 'ACTIVE');
      this.setData({
        event: {
          ...e,
          start_display: fmtTime(e.start_time),
          end_display: fmtTime(e.end_time),
          reg_window_display: `${fmtTime(e.registration_start_time)} ~ ${fmtTime(e.registration_end_time)}`,
          refund_rule_display: REFUND_RULE_ZH[e.refund_rule] || e.refund_rule,
        } as EventView,
        options,
        selectedOptionId: options.length ? options[0].id : 0,
        loading: false,
      });
    } catch (err: any) {
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  selectOption(e: any) {
    this.setData({ selectedOptionId: Number(e.detail.value) });
  },
  goRegister() {
    const { eventId, selectedOptionId } = this.data;
    if (!selectedOptionId) { wx.showToast({ title: '请选择报名类型', icon: 'none' }); return; }
    wx.navigateTo({ url: `/pages/register/register?eventId=${eventId}&optionId=${selectedOptionId}` });
  },
});
