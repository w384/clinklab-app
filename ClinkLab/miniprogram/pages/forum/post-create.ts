// 发帖：标题 + 正文（textarea）+ 底部插入图片（上传后显示预览，提交时图片追加在正文末尾）。
import { createPost } from '../../services/posts';
import { chooseAndUploadImages } from '../../services/upload';
import { ensureLogin } from '../../services/auth';
import { toast } from '../../utils/util';

Page({
  data: {
    title: '',
    content: '',
    images: [] as string[], // 已上传图片的绝对 URL（预览）
    submitting: false,
  },
  onTitleInput(e: WechatMiniprogram.Input): void {
    this.setData({ title: e.detail.value });
  },
  onContentInput(e: WechatMiniprogram.Input): void {
    this.setData({ content: e.detail.value });
  },
  // 插入图片（底部按钮）：选图 → 上传 → 追加到预览区
  async onAddImage(): Promise<void> {
    const left = 9 - this.data.images.length;
    if (left <= 0) { toast('最多 9 张图片', 'none'); return; }
    try {
      const urls = await chooseAndUploadImages(left);
      if (urls.length) this.setData({ images: this.data.images.concat(urls) });
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '图片上传失败，请重试', 'none');
    }
  },
  onRemoveImage(e: WechatMiniprogram.TouchEvent): void {
    const idx = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    if (idx >= 0 && idx < images.length) images.splice(idx, 1);
    this.setData({ images });
  },
  async submit(): Promise<void> {
    const title = (this.data.title || '').trim();
    const text = (this.data.content || '').trim();
    if (this.data.submitting) return;
    if (!title) { toast('请填写标题', 'none'); return; }
    if (!text && this.data.images.length === 0) { toast('写点内容或加张图片吧', 'none'); return; }
    // 正文：文本（换行转 <br>）+ 图片（追加在末尾）
    const parts: string[] = [];
    if (text) parts.push(text.replace(/\r?\n/g, '<br/>'));
    for (const u of this.data.images) parts.push(`<img src="${u}" style="max-width:100%;border-radius:12rpx;margin-top:16rpx;"/>`);
    try {
      await ensureLogin();
      this.setData({ submitting: true });
      await createPost(title, parts.join('<br/>'));
      toast('发布成功', 'success');
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      this.setData({ submitting: false });
      const err = e as { message?: string };
      toast((err && err.message) || '发布失败，请重试', 'none');
    }
  },
});
