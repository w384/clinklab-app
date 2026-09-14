// 分享 tab：现场录制视频 / 线上网课 / 知识文字（无需登录）。
import { listShares, ShareItem, SHARE_TYPE_LABEL } from '../../services/share';

interface Row extends ShareItem {
  type_label: string;
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
      const items = await listShares();
      const list: Row[] = (items || []).map((s) => ({
        ...s,
        type_label: SHARE_TYPE_LABEL[s.type] || s.type,
      }));
      this.setData({ list, loading: false });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败，请检查网络' });
    }
  },
  goDetail(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    wx.navigateTo({ url: `/pages/share-detail/share-detail?id=${id}` });
  },
});
