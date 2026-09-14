// 评论区：分享内容 / 参加过的活动 / 论坛帖子，支持楼层式回复。
// 回复的回复（平铺@式）：parentId 仍指向根评论，replyToId = 被回复的那条回复 id，展示时前缀"回复 @昵称"。
// 每条评论带点赞数 like_count + 当前用户已赞 liked。
import { get, post, del } from './request';

export type CommentTargetType = 'SHARE' | 'EVENT' | 'POST';

export interface CommentReply {
  id: number;
  user_id: number;
  nickname: string;
  avatar: string | null;
  content: string;
  created_at: string;
  like_count: number;
  liked: boolean;
  // 回复的回复：被回复对象（有值时为"回复 @xxx"）
  reply_to_user_id?: number;
  reply_to_nickname?: string;
}

export interface CommentThread extends CommentReply {
  replies: CommentReply[];
}

/** 评论区列表（公开）：根评论按时间正序，回复（含回复的回复）平铺在根评论下。 */
export const listComments = (type: CommentTargetType, id: number): Promise<CommentThread[]> =>
  get<CommentThread[]>(`/comments?type=${type}&id=${id}`);

/** 发评论 / 回复（parentId 省略 = 根评论）/ 回复的回复（replyToId = 被回复的那条回复 id）。 */
export const createComment = (type: CommentTargetType, id: number, content: string, parentId?: number, replyToId?: number): Promise<unknown> =>
  post('/comments', { type, id, content, parentId, replyToId });

/** 删除自己的评论（删根评论连带其回复）。 */
export const deleteComment = (id: number): Promise<unknown> => del(`/comments/${id}`);
