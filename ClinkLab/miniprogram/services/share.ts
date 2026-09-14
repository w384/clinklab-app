// 分享内容（「分享」tab）：现场视频 / 网课 / 知识文字（只读浏览）。
import { get, post } from './request';

export type ShareType = 'VIDEO' | 'COURSE' | 'TEXT';

export const SHARE_TYPE_LABEL: Record<ShareType, string> = {
  VIDEO: '现场视频',
  COURSE: '网课',
  TEXT: '知识文字',
};

export interface ShareItem {
  id: number;
  type: ShareType;
  title: string;
  summary: string | null;
  cover_image: string | null;
  video_url: string | null;
  content: string | null;
  sort_order: number;
  status: string;
  view_count: number; // 浏览数
  like_count: number; // 点赞数
  comment_count: number; // 评论数
  liked: boolean; // 当前用户是否已赞
}

export const listShares = (): Promise<ShareItem[]> => get<ShareItem[]>('/shares');
export const getShare = (id: number): Promise<ShareItem> => get<ShareItem>(`/shares/${id}`);
/** 进入分享详情浏览 +1。 */
export const viewShare = (id: number): Promise<unknown> => post(`/shares/${id}/view`);
