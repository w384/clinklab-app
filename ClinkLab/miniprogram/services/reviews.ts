// 评价（C⑨）：活动评价列表（公开）+ 提交/更新我的评价。
import { get, post } from './request';

export interface ReviewItem {
  id: number;
  rating: number;
  comment: string | null;
  created_at: string;
  nickname: string;
  stars?: string; // ★★★★☆（本地预处理，方便 wxml 渲染）
}

export const listEventReviews = (eventId: number): Promise<ReviewItem[]> => get<ReviewItem[]>(`/events/${eventId}/reviews`);

export const submitReview = (eventId: number, rating: number, comment?: string): Promise<{ id: number }> =>
  post<{ id: number }>('/me/reviews', { eventId, rating, comment: comment && comment.trim() ? comment.trim() : undefined });

/** 1-5 → ★★★★★ 文本。 */
export function starsText(n: number): string {
  const r = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}
