// 点赞（活动 / 分享 / 评论 / 帖子）：登录后点赞/取消（幂等切换），返回最新状态。
import { post } from './request';

export type LikeTargetType = 'EVENT' | 'SHARE' | 'COMMENT' | 'POST';

export interface LikeResult {
  liked: boolean;
  count: number;
}

export const toggleLike = (type: LikeTargetType, id: number): Promise<LikeResult> => post<LikeResult>('/likes/toggle', { type, id });
