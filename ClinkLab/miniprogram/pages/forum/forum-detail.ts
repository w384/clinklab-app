// 帖子详情：正文阅读 + 点赞 + 评论区（评论 / 回复 / 回复的回复 / 点赞）+ 作者可删帖。
import { getPost, viewPost, deletePost, PostItem } from '../../services/posts';
import { listComments, createComment, deleteComment, CommentReply, CommentThread } from '../../services/comment';
import { ensureLogin, getCurrentUser } from '../../services/auth';
import { toggleLike } from '../../services/likes';
import { toast, fmtTime } from '../../utils/util';

interface PostView extends PostItem {
  nodes: string; // 正文 HTML（含图片）直接渲染
  timeText: string;
  is_me: boolean;
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
    post: null as PostView | null,
    liked: false, // 当前用户是否已赞帖子
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
    else this.setData({ loading: false, error: '缺少帖子 id' });
  },
  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const p = await getPost(id);
      // 浏览 +1（静默）
      viewPost(id).catch(() => {});
      const me = getCurrentUser();
      const mine = me ? me.userId : -1;
      this.setData({
        post: { ...p, nodes: p.content || '', timeText: fmtTime(p.created_at), is_me: p.user_id === mine },
        liked: !!p.liked,
        like_count: p.like_count != null ? p.like_count : 0,
        comment_count: p.comment_count != null ? p.comment_count : 0,
        loading: false,
      });
      await this.loadComments();
    } catch (e) {
      const err = e as { message?: string };
      this.setData({ loading: false, error: (err && err.message) || '加载失败，请检查网络' });
    }
  },

  // ───────── 评论区（与分享详情同构） ─────────
  async loadComments(): Promise<void> {
    const p = this.data.post;
    if (!p) return;
    try {
      const me = getCurrentUser();
      const mine = me ? me.userId : -1;
      const list = await listComments('POST', p.id);
      const rows: CommentRow[] = (list || []).map((t) => {
        const replies = (t.replies || []).map((r) => ({ ...r, time_display: shortTime(r.created_at), is_me: r.user_id === mine }));
        return {
          ...t,
          time_display: shortTime(t.created_at),
          is_me: t.user_id === mine,
          expanded: false,
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
    if (this.data.replyingTo === id && this.data.replyingReplyTo === null) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: id, replyingReplyTo: null, replyingName: name });
  },
  replyToReply(e: WechatMiniprogram.TouchEvent): void {
    const rootId = Number(e.currentTarget.dataset.root);
    const id = Number(e.currentTarget.dataset.id);
    const name = String(e.currentTarget.dataset.name || '');
    if (this.data.replyingTo === rootId && this.data.replyingReplyTo === id) this.setData({ replyingTo: null, replyingReplyTo: null, replyingName: '' });
    else this.setData({ replyingTo: rootId, replyingReplyTo: id, replyingName: name });
  },
  async submitComment(): Promise<void> {
    const p = this.data.post;
    const text = (this.data.commentText || '').trim();
    if (!p) return;
    if (!text) { toast('先写点什么吧', 'none'); return; }
    try {
      await ensureLogin();
      await createComment('POST', p.id, text, this.data.replyingTo || undefined, this.data.replyingReplyTo || undefined);
      this.setData({ commentText: '', replyingTo: null, replyingReplyTo: null, replyingName: '' });
      toast('评论成功', 'success');
      await this.loadComments();
      this.setData({ comment_count: this.data.comment_count + 1 });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '评论失败，请重试', 'none');
    }
  },
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
  // 点赞/取消点赞帖子（登录）
  async togglePostLike(): Promise<void> {
    const p = this.data.post;
    if (!p) return;
    try {
      await ensureLogin();
      const res = await toggleLike('POST', p.id);
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
  // 删除自己的帖子（连带其评论/点赞）
  onDeletePost(): void {
    const p = this.data.post;
    if (!p) return;
    wx.showModal({
      title: '删除帖子',
      content: '删除后不可恢复（帖子下的评论会一并删除）。',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deletePost(p.id);
          toast('已删除', 'success');
          wx.navigateBack();
        } catch (err) {
          const e2 = err as { message?: string };
          toast((e2 && e2.message) || '删除失败', 'none');
        }
      },
    });
  },
});
