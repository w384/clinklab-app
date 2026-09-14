// 活动首页：公开浏览可报名活动（无需登录）。
import { listEvents, EventItem } from '../../services/event';
import { fmtTime } from '../../utils/util';

interface Row extends EventItem {
  start_display: string;
  reg_window_display: string;
  capacity_display: string;
}

Page({
  data: { events: [] as Row[], loading: true, error: '' },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const events = await listEvents();
      const list: Row[] = (events || []).map((e) => ({
        ...e,
        start_display: fmtTime(e.start_time),
        reg_window_display: `${fmtTime(e.registration_start_time)} ~ ${fmtTime(e.registration_end_time)}`,
        capacity_display: e.capacity ? `${e.valid_paid_count}/${e.capacity}` : '不限',
      }));
      this.setData({ events: list, loading: false });
    } catch (e: any) {
      this.setData({ loading: false, error: (e && e.message) || '加载失败，请检查网络' });
    }
  },
  goDetail(e: any) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
