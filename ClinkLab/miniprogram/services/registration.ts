// 报名（核心对象）：创建 / 我的 / 详情 / 取消 / 退款 / 模拟支付。
import { post, get } from './request';

export type RegistrationStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDING' | 'REFUNDED';
export type OptionType = 'SINGLE' | 'DOUBLE' | 'INVITE' | 'WAITLIST';

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
  qr_token_2?: string | null; // 双人票：座位2 凭证码
  qr_data_url?: string;
  qr_data_url_2?: string; // 双人票：座位2 二维码 data URL
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
  checked_in_at: string | null;
  checked_in: boolean;
  checked_in_2?: string | null; // 双人票：座位2 核销时间
  checked_count?: number; // 已核销座位数（单人=1，双人=0/1/2）
  all_checked_in?: boolean; // 全部座位核销完成
  option_type?: OptionType;
  created_at: string;
  updated_at: string;
  event?: { id: number; title: string; start_time: string; [k: string]: unknown };
  option?: { id: number; name: string; price: number; price_display: string; option_type?: OptionType } | null;
}

export interface CreateRegistrationBody {
  registrationOptionId?: number;
  remark?: string;
  gateCode?: string; // 邀请票的"购买邀请码"（后台配置，购买时输入）
  customFields?: Record<string, string>; // 活动配置的自定义报名字段（key → 值）
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

// 是否可评价：已支付非候补 +（已核销 或 活动已结束）——与服务端 assertReviewable 一致
export function canReview(r: Registration): boolean {
  if (r.status !== 'PAID') return false;
  if ((r.option_type || (r.option && r.option.option_type) || 'SINGLE') === 'WAITLIST') return false;
  if (r.checked_in) return true;
  const end = r.event ? ((r.event as { end_time?: string }).end_time || '') : '';
  return !!end && new Date(end).getTime() <= Date.now();
}
