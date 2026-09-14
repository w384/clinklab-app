// 活动 + 报名类型（只读浏览）。
import { get, post } from './request';

export type OptionType = 'SINGLE' | 'DOUBLE' | 'INVITE' | 'WAITLIST';

/** 票种中文标签（用于 UI 展示）。 */
export const OPTION_TYPE_LABEL: Record<OptionType, string> = {
  SINGLE: '单人票',
  DOUBLE: '双人票',
  INVITE: '邀请票',
  WAITLIST: '候补票',
};

export interface RegistrationOption {
  id: number;
  event_id: number;
  name: string;
  description: string | null;
  price: number; // 分
  price_display: string;
  status: string;
  sort_order: number;
  option_type?: OptionType;
  sold_limit?: number | null; // 可购正票上限（>0 生效；null=不限）
  sold_count?: number; // 已支付正票数
  remaining?: number | null; // 剩余可购数（null=不限量）
  // 公开接口已脱敏：购买邀请码（gate_code）不会出现在这里
}

export interface EventItem {
  id: number;
  title: string;
  subtitle: string | null;
  cover_image: string | null;
  cover_detail_image: string | null;
  description: string | null;
  category: string | null;
  location_city: string | null;
  location_name: string | null;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  reminder: string | null;
  detail_images: string[];
  custom_fields: Array<{
    key: string;
    label: string;
    required: boolean;
    type: 'text' | 'textarea' | 'choice';
    options?: string[];
  }>;
  view_count: number;
  like_count: number; // 点赞数
  comment_count: number; // 评论数
  liked: boolean; // 当前用户是否已赞
  start_time: string;
  end_time: string;
  registration_start_time: string;
  registration_end_time: string;
  status: string;
  capacity: number | null;
  refund_rule: string;
  contact_info: string | null;
  registrationOptions: RegistrationOption[];
  valid_paid_count: number;
  attendance_count: number;
  waitlist_count: number;
  checked_in_count: number;
  full: boolean;
  review_count: number;
  review_avg: number;
  start_time_display: string;
  end_time_display: string;
}

export const listEvents = (): Promise<EventItem[]> => get<EventItem[]>('/events');
export const getEvent = (id: number): Promise<EventItem> => get<EventItem>(`/events/${id}`);
/** 进入详情页浏览 +1（静默失败，不影响展示）。 */
export const trackView = (id: number): Promise<unknown> => post(`/events/${id}/view`, {});
