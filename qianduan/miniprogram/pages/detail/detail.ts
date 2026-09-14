// 活动详情：介绍 + 报名选项 + 立即报名。
import { getEvent, EventItem } from '../../services/event';
import { fmtTime, fmtRange, fmtCents, REFUND_RULE_ZH } from '../../utils/util';

interface OptionRow {
  id: number;
  name: string;
  description: string;
  price_display: string; // 元（不含 ¥）
  recommended: boolean;
}

Page({
  data: {
    id: 0,
    event: null as EventItem | null,
    loading: true,
    error: '',
    options: [] as OptionRow[],
    time_display: '',
    location_display: '',
    reg_window: '',
    tags: [] as string[],
    desc: '',
    refund_zh: '',
  },
  onLoad(opts: Record<string, string | undefined>): void {
    const id = Number(opts && opts.id);
    this.setData({ id });
    if (id) this.load(id);
    else this.setData({ loading: false, error: '缺少活动 ID' });
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const e = await getEvent(id);
      const options: OptionRow[] = (e.registrationOptions || []).map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description || '',
        price_display: fmtCents(o.price).replace('¥', ''),
        recommended: /推荐|早鸟/.test(`${o.name}${o.description || ''}`),
      }));
      const tags = (e.subtitle || '')
        .split(/[·,，、/]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      this.setData({
        event: e,
        options,
        time_display: fmtRange(e.start_time, e.end_time),
        location_display: e.location_address || e.location_name || '地点待定',
        reg_window: `${fmtTime(e.registration_start_time)} ~ ${fmtTime(e.registration_end_time)}`,
        tags,
        desc: e.description || '暂无详细介绍',
        refund_zh: REFUND_RULE_ZH[e.refund_rule] || e.refund_rule,
        loading: false,
      });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  goRegister(): void {
    const id = this.data.id;
    wx.navigateTo({ url: `/pages/register/register?eventId=${id}` });
  },
});
