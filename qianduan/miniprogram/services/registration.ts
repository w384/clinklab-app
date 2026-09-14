// 报名（核心对象）：创建 / 我的 / 详情 / 取消 / 退款 / 模拟支付。
import { post, get } from './request';

export type RegistrationStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDING' | 'REFUNDED';

export interface Registration {
  id: number;
  registration_no: string;
  event_id: number;
  user_id: number;
  registration_option_id: number;
  name: string;
  phone: string;
  form_data: Record<string, unknown>;
  amount: number; // 分
  amount_display: string;
  status: RegistrationStatus;
  qr_token: string | null;
  qr_data_url?: string;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
  checked_in_at: string | null;
  checked_in: boolean;
  created_at: string;
  updated_at: string;
  event?: { id: number; title: string; start_time: string; [k: string]: unknown };
  option?: { id: number; name: string; price: number; price_display: string } | null;
}

export interface CreateRegistrationBody {
  registrationOptionId?: number;
  remark?: string;
  // 姓名/手机不再由客户端提交：服务端取自登录用户资料快照（「我的」里完善，报名不重复填写）
}

export const createRegistration = (eventId: number, body: CreateRegistrationBody): Promise<Registration> =>
  post<Registration>(`/events/${eventId}/registrations`, body);

export const listMyRegistrations = (): Promise<Registration[]> => get<Registration[]>('/me/registrations');
export const getRegistration = (id: number): Promise<Registration> => get<Registration>(`/registrations/${id}`);
export const cancelRegistration = (id: number): Promise<Registration> => post<Registration>(`/registrations/${id}/cancel`);
export const refundRegistration = (id: number, reason?: string): Promise<Registration> =>
  post<Registration>(`/registrations/${id}/refund`, reason ? { reason } : undefined);
// development-only：生产走真实微信支付（见 payment.ts）
export const mockPay = (id: number): Promise<Registration> => post<Registration>(`/dev/registrations/${id}/mock-pay`);
