// 活动首页：公开浏览可报名活动（无需登录）。
import { listEvents, EventItem } from '../../services/event';

interface Row extends EventItem {
  start_display: string;
  location_display: string;
  min_price: string; // 元（不补零）
  has_options: boolean;
  cover_label: string;
  attend_text: string; // "N 人参加"
}

// 紧凑时间："09/04 周五 20:00"
function compactTime(iso: string | null): string {
  if (!iso) return '时间待定';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${wd} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
        const attend = e.attendance_count != null ? e.attendance_count : 0;
        return {
          ...e,
          start_display: compactTime(e.start_time),
          location_display: e.location_name || e.location_city || '地点待定',
          min_price: Number.isInteger(yuan) ? yuan.toString() : yuan.toFixed(2),
          has_options: opts.length > 0,
          cover_label: (e.title || '').trim().slice(0, 2) || '🎟️',
          attend_text: `${attend} 人参加`,
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
