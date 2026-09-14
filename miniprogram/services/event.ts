// 活动 + 报名类型（只读浏览）。
import { get } from './request';

export interface RegistrationOption {
  id: number;
  event_id: number;
  name: string;
  description: string | null;
  price: number; // 分
  price_display: string;
  status: string;
  sort_order: number;
}

export interface EventItem {
  id: number;
  title: string;
  subtitle: string | null;
  cover_image: string | null;
  description: string | null;
  location_name: string | null;
  location_address: string | null;
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
  full: boolean;
  start_time_display: string;
  end_time_display: string;
}

export const listEvents = () => get<EventItem[]>('/events');
export const getEvent = (id: number) => get<EventItem>(`/events/${id}`);
