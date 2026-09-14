// 分享详情：视频播放 / 网课 / 知识文字阅读 + 点赞 + 评论区（评论 / 回复 / 回复的回复 / 点赞）。
import { getShare, viewShare, ShareItem, SHARE_TYPE_LABEL } from '../../services/share';
import { listComments, createComment, deleteComment, CommentReply, CommentThread } from '../../services/comment';
import { ensureLogin, getCurrentUser } from '../../services/auth';
import { toggleLike } from '../../services/likes';
import { toast } from '../../utils/util';

interface ShareView extends ShareItem {
  type_label: string;
  nodes: string; // content 换行转 <br> 后交给 rich-text（富文本 HTML 原样传入）
}

interface CommentReplyRow extends CommentReply {
  time_display: string;
  is_me: boolean;
}

interface CommentRow extends CommentThread {
  time_display: string;
  is_me: boolean;
  expanded: boolean; // 回复是否展开（默认折叠：只显示最新 1 条）
  visible_replies: CommentReplyRow[]; // 当前可见的回复（折叠=最新1条，展开=全部）
  replies: CommentReplyRow[];
}

// 简短时间："09/04 20:00"
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    loading: true,
    error: '',
    share: null as ShareView | null,
    liked: false, // 当前用户是否已赞分享
    like_count: 0,
    comment_count: 0,
    comments: [] as CommentRow[],
    commentText: '',
    replyingTo: null as number | null, // 正在回复的根评论 id
    replyingReplyTo: null as number | null, // 正在回复的回复 id（回复的回复）
    replyingName: '',
  },
  onLoad(query: Record<string, string | undefined>): void {
    const id = Number((query && query.id) || 0);
    if (id) this.load(id);
    else this.setData({ loading: false, error: '缺少分享 id' });
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const s = await getShare(id);
      // 浏览 +1（静默）
      viewShare(id).catch(() => {});
      // 正文：富文本 HTML（含插图）直接渲染；旧纯文本转 <br> 保持换行
      const raw = s.content || '';
      const nodes = raw.indexOf('<') >= 0 ? raw : raw.replace(/\r?\n/g, '<br/>');
      this.setData({
        share: { ...s, type_label: SHARE_TYPE_LABEL[s.type] || s.type, nodes },
        liked: !!s.liked,
        like_count: s.like_count != null ? s.like_count : 0,
        comment_count: s.comment_count != null ? s.comment_count : 0,
        loading: false,
      });
      await this.loadComments();
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败，请检查网络' });
    }
  },

  // ───────── 评论区 ─────────
  async loadComments(): Promise<void> {
    const s = this.data.share;
    if (!s) return;
    try {
      const me = getCurrentUser();
      const mine = me ? me.userId : -1;
      const list = await listComments('SHARE', s.id);
      const rows: CommentRow[] = (list || []).map((t) => {
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
    const id = Number(e.currentTarget.dataset.id);
    const rows = this.data.comments.map((c) => {
      if (c.id !== id) return c;
      const expanded = !c.expanded;
      return { ...c, expanded, visible_replies: expanded ? c.replies : c.replies.slice(-1) };
    });
    this.setData({ comments: rows });
  },
  onCommentInput(e: WechatMiniprogram.Input): void {
    this.setData({ commentText: e.detail.value });
  },
  replyTo(e: WechatMiniprogram.TouchEvent): void {
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    // 再点一次取消回复
    if (this.data.replyingTo === id && this.data.replyingReplyTo === null) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: id, replyingReplyTo: null, replyingName: name });
  },
  // 回复某条回复（回复的回复：parent 仍指向根评论，replyToId 指向被回复的回复）
  replyToReply(e: WechatMiniprogram.TouchEvent): void {
    const rootId = Number(e.currentTarget.dataset.root);
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    if (this.data.replyingTo === rootId && this.data.replyingReplyTo === id) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: rootId, replyingReplyTo: id, replyingName: name });
  },
  async submitComment(): Promise<void> {
    const s = this.data.share;
    const text = (this.data.commentText || '').trim();
    if (!s) return;
    if (!text) { toast('先写点什么吧', 'none'); return; }
    try {
      await ensureLogin();
      await createComment('SHARE', s.id, text, this.data.replyingTo || undefined, this.data.replyingReplyTo || undefined);
      this.setData({ commentText: '', replyingTo: null, replyingReplyTo: null, replyingName: '' });
      toast('评论成功', 'success');
      await this.loadComments();
      this.setData({ comment_count: this.data.comment_count + 1 });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '评论失败，请重试', 'none');
    }
  },
  // 点赞/取消点赞某条评论或回复（登录）
  async toggleCommentLike(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const id = Number(e.currentTarget.dataset.id);
    try {
      await ensureLogin();
      const res = await toggleLike('COMMENT', id);
      const rows = this.data.comments.map((c) => {
        if (c.id === id) return { ...c, liked: res.liked, like_count: res.count };
        return { ...c, replies: c.replies.map((r) => (r.id === id ? { ...r, liked: res.liked, like_count: res.count } : r)) };
      });
      this.setData({ comments: rows });
    } catch (e2) {
      const err = e2 as { message?: string };
      toast((err && err.message) || '操作失败，请重试', 'none');
    }
  },
  // 点赞/取消点赞分享（登录）
  async toggleShareLike(): Promise<void> {
    const s = this.data.share;
    if (!s) return;
    try {
      await ensureLogin();
      const res = await toggleLike('SHARE', s.id);
      this.setData({ liked: res.liked, like_count: res.count });
    } catch (e2) {
      const err = e2 as { message?: string };
      toast((err && err.message) || '操作失败，请重试', 'none');
    }
  },
  onDeleteComment(e: WechatMiniprogram.TouchEvent): void {
    const id = Number(e.currentTarget.dataset.id);
    wx.showModal({
      title: '删除评论',
      content: '删除后不可恢复（若为根评论，其下回复会一并删除）。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deleteComment(id);
          toast('已删除', 'success');
          await this.loadComments();
        } catch (err) {
          const e2 = err as { message?: string };
          toast((e2 && e2.message) || '删除失败', 'none');
        }
      },
    });
  },
});
