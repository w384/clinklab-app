// 活动评价：从「我的报名/凭证」进入，对自己的某次报名打分 + 留言（1-5 星 + 选填 200 字）。
import { getRegistration } from '../../services/registration';
import { submitReview } from '../../services/reviews';
import { fmtTime, toast } from '../../utils/util';

const STAR_TEXT = ['', '很差，不推荐', '一般般', '还不错', '很推荐', '超赞，强烈安利'];

Page({
  data: {
    registrationId: 0,
    loading: true,
    error: '',
    event_title: '',
    event_time: '',
    rating: 0,
    comment: '',
    submitting: false,
    star_text: '',
  },
  onLoad(opts: Record<string, string | undefined>): void {
    const registrationId = Number(opts && opts.registrationId);
    this.setData({ registrationId });
    if (!registrationId) { this.setData({ loading: false, error: '缺少报名 ID' }); return; }
    this.load(registrationId);
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const reg = await getRegistration(id);
      const ev = reg.event || ({} as { title?: string; start_time?: string });
      this.setData({
        event_title: ev.title || '活动',
        event_time: ev.start_time ? fmtTime(ev.start_time) : '',
        loading: false,
      });
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  pickStar(e: WechatMiniprogram.TouchEvent): void {
    const n = Number(e.currentTarget.dataset.n);
    this.setData({ rating: n, star_text: STAR_TEXT[n] || '' });
  },
  onComment(e: WechatMiniprogram.TextareaInput): void {
    this.setData({ comment: e.detail.value });
  },
  async submit(): Promise<void> {
    const { registrationId, rating, comment, submitting } = this.data;
    if (submitting) return;
    if (!rating) { toast('请先选择评分', 'none'); return; }
    this.setData({ submitting: true });
    try {
      const reg = await getRegistration(registrationId);
      if (!reg.event) throw new Error('活动信息缺失');
      await submitReview(reg.event.id, rating, comment);
      toast('评价已提交，感谢反馈', 'success');
      setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '提交失败，请稍后再试', 'none');
      this.setData({ submitting: false });
    }
  },
});
