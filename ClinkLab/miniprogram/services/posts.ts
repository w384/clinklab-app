// 论坛帖子：登录用户发帖（标题 + 正文，正文可含图片富文本 HTML）；浏览/点赞/评论复用其他服务的通用逻辑。
// 列表/详情公开，带作者 + 浏览/点赞/评论数 + 当前用户已赞。
import { get, post, del } from './request';

export interface PostAuthor {
  id: number;
  nickname: string;
  avatar: string | null;
}

export interface PostItem {
  id: number;
  user_id: number;
  title: string;
  content: string;
  created_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  liked: boolean;
  author: PostAuthor;
}

/** 论坛列表（公开）。 */
export const listPosts = (): Promise<PostItem[]> => get<PostItem[]>('/posts');

/** 帖子详情（公开）。 */
export const getPost = (id: number): Promise<PostItem> => get<PostItem>(`/posts/${id}`);

/** 进入帖子详情浏览 +1（详情页 onLoad 时调用）。 */
export const viewPost = (id: number): Promise<unknown> => post(`/posts/${id}/view`);

/** 发帖（登录）：标题 + 正文（可含图片 HTML）。 */
export const createPost = (title: string, content: string): Promise<PostItem> =>
  post<PostItem>('/posts', { title, content });

/** 删除自己的帖子（登录）。 */
export const deletePost = (id: number): Promise<unknown> => del(`/posts/${id}`);
