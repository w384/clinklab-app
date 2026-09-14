// 活动详情：封面 + 标签 + 标题 + 浏览/候补 + 价格/报名 + 时间/地点/地址 + 提醒 + 图文详情 + 用户评价 + 评论区（参加过的可评论/回复）。
import { getEvent, trackView, EventItem } from '../../services/event';
import { listEventReviews, starsText, ReviewItem } from '../../services/reviews';
import { listComments, createComment, deleteComment, CommentReply, CommentThread } from '../../services/comment';
import { ensureLogin, getCurrentUser } from '../../services/auth';
import { toggleLike } from '../../services/likes';
import { fmtRange, REFUND_RULE_ZH, toast } from '../../utils/util';

interface OptionRow {
  id: number;
  name: string;
  description: string;
  price_display: string; // 元（不含 ¥）
  recommended: boolean;
}

// 紧凑时间："2026年09月04日 周五 20:00-22:00"
function fullTime(start: string, end: string): string {
  const s = new Date(start);
  if (isNaN(s.getTime())) return fmtRange(start, end);
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][s.getDay()];
  const t1 = `${p(s.getHours())}:${p(s.getMinutes())}`;
  let t2 = '';
  const e = new Date(end);
  if (e && !isNaN(e.getTime())) t2 = `-${p(e.getHours())}:${p(e.getMinutes())}`;
  return `${s.getFullYear()}年${p(s.getMonth() + 1)}月${p(s.getDate())}日 ${wd} ${t1}${t2}`;
}

// 简短时间："09/04 20:00"
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface CmtReplyRow extends CommentReply {
  time_display: string;
  is_me: boolean;
}
interface CmtRow extends CommentThread {
  time_display: string;
  is_me: boolean;
  expanded: boolean; // 回复是否展开（默认折叠：只显示最新 1 条）
  visible_replies: CmtReplyRow[];
  replies: CmtReplyRow[];
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
    min_price: '0',
    view_count: 0,
    like_count: 0, // 点赞数（详情头部展示 + 点赞按钮）
    comment_count: 0, // 评论数
    liked: false, // 当前用户是否已赞活动
    waitlist_count: 0,
    desc_html: '',
    detailImages: [] as string[],
    refund_zh: '',
    // 评价（C⑨，入口在「我的报名 → 凭证」，详情页仅展示）
    reviews: [] as ReviewItem[],
    reviewAvg: 0,
    reviewCount: 0,
    // 评论区（参加过的活动可评论/回复/回复的回复/点赞）
    comments: [] as CmtRow[],
    commentText: '',
    replyingTo: null as number | null, // 正在回复的根评论 id
    replyingReplyTo: null as number | null, // 正在回复的回复 id（回复的回复）
    replyingName: '',
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
      // 浏览 +1（静默，失败不影响展示）
      trackView(id).catch(() => {});
      const options: OptionRow[] = (e.registrationOptions || []).map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description || '',
        price_display: (o.price / 100).toString(),
        recommended: /推荐|早鸟/.test(`${o.name}${o.description || ''}`),
      }));
      const opts = e.registrationOptions || [];
      const minCents = opts.length ? Math.min(...opts.map((o) => o.price)) : 0;
      const yuan = minCents / 100;
      // 正文支持富文本 HTML（管理后台编辑器生成）；旧数据为纯文本则转 <br> 保持换行
      const rawDesc = e.description || '';
      const desc_html = rawDesc.indexOf('<') >= 0 ? rawDesc : rawDesc.replace(/\n/g, '<br>');
      this.setData({
        event: e,
        options,
        time_display: fullTime(e.start_time, e.end_time),
        location_display: e.location_city ? `${e.location_city} | ${e.location_name || '地点待定'}` : e.location_name || '地点待定',
        min_price: Number.isInteger(yuan) ? yuan.toString() : yuan.toFixed(2),
        view_count: e.view_count != null ? e.view_count : 0,
        like_count: e.like_count != null ? e.like_count : 0,
        comment_count: e.comment_count != null ? e.comment_count : 0,
        liked: !!e.liked,
        waitlist_count: e.waitlist_count != null ? e.waitlist_count : 0,
        desc_html,
        detailImages: e.detail_images || [],
        refund_zh: REFUND_RULE_ZH[e.refund_rule] || e.refund_rule,
        reviewAvg: e.review_avg != null ? e.review_avg : 0,
        reviewCount: e.review_count != null ? e.review_count : 0,
        loading: false,
      });
      this.loadReviews(id);
      this.loadComments(id);
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },
  // 加载评价列表（静默失败）
  async loadReviews(id: number): Promise<void> {
    try {
      const list = await listEventReviews(id);
      this.setData({
        reviews: list.map((r) => ({ ...r, stars: starsText(r.rating) })),
        reviewCount: list.length > 0 ? list.length : this.data.reviewCount,
      });
    } catch {
      /* 评价加载失败不阻塞页面 */
    }
  },

  // ───────── 评论区（参加过的活动可评论/回复） ─────────
  async loadComments(id: number): Promise<void> {
    try {
      const me = getCurrentUser();
      const mine = me ? me.userId : -1;
      const list = await listComments('EVENT', id);
      const rows: CmtRow[] = (list || []).map((t) => {
        const replies = (t.replies || []).map((r) => ({ ...r, time_display: shortTime(r.created_at), is_me: r.user_id === mine }));
        return {
          ...t,
          time_display: shortTime(t.created_at),
          is_me: t.user_id === mine,
          expanded: false, // 默认折叠：根评论下只显示最新 1 条回复
          replies,
          visible_replies: replies.length ? replies.slice(-1) : [],
        };
      });
      this.setData({ comments: rows });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '评论加载失败', 'none');
    }
  },
  // 展开 / 收起某条根评论下的回复
  toggleReplies(e: WechatMiniprogram.TouchEvent): void {
    const rid = Number(e.currentTarget.dataset.id);
    const rows = this.data.comments.map((c) => {
      if (c.id !== rid) return c;
      const expanded = !c.expanded;
      return { ...c, expanded, visible_replies: expanded ? c.replies : c.replies.slice(-1) };
    });
    this.setData({ comments: rows });
  },
  onCommentInput(e: WechatMiniprogram.Input): void {
    this.setData({ commentText: e.detail.value });
  },
  replyTo(e: WechatMiniprogram.TouchEvent): void {
    const rid = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    // 再点一次取消回复
    if (this.data.replyingTo === rid && this.data.replyingReplyTo === null) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: rid, replyingReplyTo: null, replyingName: name });
  },
  // 回复某条回复（回复的回复：parent 仍指向根评论，replyToId 指向被回复的回复）
  replyToReply(e: WechatMiniprogram.TouchEvent): void {
    const rootId = Number(e.currentTarget.dataset.root);
    const rid = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    if (this.data.replyingTo === rootId && this.data.replyingReplyTo === rid) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: rootId, replyingReplyTo: rid, replyingName: name });
  },
  async submitComment(): Promise<void> {
    const text = (this.data.commentText || '').trim();
    if (!text) { toast('先写点什么吧', 'none'); return; }
    try {
      await ensureLogin();
      await createComment('EVENT', this.data.id, text, this.data.replyingTo || undefined, this.data.replyingReplyTo || undefined);
      this.setData({ commentText: '', replyingTo: null, replyingReplyTo: null, replyingName: '' });
      toast('评论成功', 'success');
      await this.loadComments(this.data.id);
      // 评论数 +1
      this.setData({ comment_count: this.data.comment_count + 1 });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '评论失败，请重试', 'none');
    }
  },
  // 点赞/取消点赞某条评论或回复（登录）
  async toggleCommentLike(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const rid = Number(e.currentTarget.dataset.id);
    try {
      await ensureLogin();
      const res = await toggleLike('COMMENT', rid);
      const rows = this.data.comments.map((c) => {
        if (c.id === rid) return { ...c, liked: res.liked, like_count: res.count };
        return { ...c, replies: c.replies.map((r) => (r.id === rid ? { ...r, liked: res.liked, like_count: res.count } : r)) };
      });
      this.setData({ comments: rows });
    } catch (e2) {
      const err = e2 as { message?: string };
      toast((err && err.message) || '操作失败，请重试', 'none');
    }
  },
  // 点赞/取消点赞活动（登录）
  async toggleEventLike(): Promise<void> {
    try {
      await ensureLogin();
      const res = await toggleLike('EVENT', this.data.id);
      this.setData({ liked: res.liked, like_count: res.count });
    } catch (e2) {
      const err = e2 as { message?: string };
      toast((err && err.message) || '操作失败，请重试', 'none');
    }
  },
  onDeleteComment(e: WechatMiniprogram.TouchEvent): void {
    const rid = Number(e.currentTarget.dataset.id);
    wx.showModal({
      title: '删除评论',
      content: '删除后不可恢复（若为根评论，其下回复会一并删除）。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deleteComment(rid);
          toast('已删除', 'success');
          await this.loadComments(this.data.id);
        } catch (err) {
          const e2 = err as { message?: string };
          toast((e2 && e2.message) || '删除失败', 'none');
        }
      },
    });
  },
  goRegister(): void {
    const id = this.data.id;
    wx.navigateTo({ url: `/pages/register/register?eventId=${id}` });
  },
  // 分享给好友/群
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const e = this.data.event;
    return {
      title: e ? `${e.title} · 碰杯LAB` : '碰杯LAB · 硬核知识×微醺社交',
      path: `/pages/detail/detail?id=${this.data.id}`,
      imageUrl: e && e.cover_image ? e.cover_image : undefined,
    };
  },
  // 分享到朋友圈
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent {
    const e = this.data.event;
    return {
      title: e ? `${e.title} · 碰杯LAB` : '碰杯LAB · 硬核知识×微醺社交',
      query: `id=${this.data.id}`,
      imageUrl: e && e.cover_image ? e.cover_image : undefined,
    };
  },
  // 打开地图导航（有坐标调起微信地图；没有则复制地址）
  openMap(): void {
    const e = this.data.event;
    if (!e) return;
    const address = e.location_address || e.location_name || '';
    if (!address) {
      toast('暂无地址信息');
      return;
    }
    if (e.latitude != null && e.longitude != null) {
      wx.openLocation({
        latitude: Number(e.latitude),
        longitude: Number(e.longitude),
        name: e.location_name || '活动地点',
        address,
        scale: 16,
      });
    } else {
      wx.setClipboardData({ data: address, success: () => toast('地址已复制，请粘贴到地图 App') });
    }
  },
  previewCover(e: WechatMiniprogram.TouchEvent): void {
    const src = e.currentTarget.dataset.src as string;
    if (src) wx.previewImage({ urls: [src] });
  },
  previewImg(e: WechatMiniprogram.TouchEvent): void {
    const src = e.currentTarget.dataset.src as string;
    const urls = this.data.detailImages || [];
    const idx = urls.indexOf(src);
    wx.previewImage({ urls, current: String(idx >= 0 ? idx : 0) });
  },
});
