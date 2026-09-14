// 论坛 tab：用户发帖讨论（无需登录可浏览，发帖/点赞/评论需登录）。
import { listPosts, PostItem } from '../../services/posts';
import { getToken } from '../../services/request';
import { fmtTime } from '../../utils/util';

interface Row extends PostItem {
  timeText: string;
  plainContent: string;
}

function stripHtml(html: string): string {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

Page({
  data: {
    list: [] as Row[],
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
      const items = await listPosts();
      const list: Row[] = (items || []).map((p) => ({
        ...p,
        timeText: fmtTime(p.created_at),
        plainContent: stripHtml(p.content),
      }));
      this.setData({ list, loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败，请检查网络' });
    }
  },
  goDetail(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/forum/forum-detail?id=${id}` });
  },
  goCreate(): void {
    if (!getToken()) {
      wx.showToast({ title: '请先在「我的」登录', icon: 'none' });
      wx.switchTab({ url: '/pages/profile/profile' });
      return;
    }
    wx.navigateTo({ url: '/pages/forum/post-create' });
  },
});
