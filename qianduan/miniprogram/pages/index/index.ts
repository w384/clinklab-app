// 活动首页：公开浏览可报名活动（无需登录）。
import { listEvents, EventItem } from '../../services/event';
import { fmtTime } from '../../utils/util';

interface Row extends EventItem {
  start_display: string;
  location_display: string;
  min_price: string; // 元（不补零）
  has_options: boolean;
  cover_label: string;
}

Page({
  data: {
    events: [] as Row[],
    loading: true,
    error: '',
  },
  onShow(): void {
    this.load();
  },
  onPullDownRefresh(): void {
    this.load()
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh());
  },
  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const events = await listEvents();
      const list: Row[] = (events || []).map((e) => {
        const opts = e.registrationOptions || [];
        const minCents = opts.length ? Math.min(...opts.map((o) => o.price)) : 0;
        const yuan = minCents / 100;
        return {
          ...e,
          start_display: fmtTime(e.start_time),
          location_display: e.location_address || e.location_name || '地点待定',
          min_price: Number.isInteger(yuan) ? yuan.toString() : yuan.toFixed(2),
          has_options: opts.length > 0,
          cover_label: (e.title || '').trim().slice(0, 2) || '🎟️',
        };
      });
      this.setData({ events: list, loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败，请检查网络' });
    }
  },
  goDetail(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
