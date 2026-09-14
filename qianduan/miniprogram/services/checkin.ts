// 现场签到：二维码（§12-§14）与手机号后四位（§15-§17）两条入口，共享同一个签到接口。
// 手机号后四位仅查询候选（脱敏、绝不自动签到），由工作人员确认后签到。
// 权限：本组接口服务端要求调用方 isAdmin（users.is_admin），普通用户无法调用。
import { post, get } from './request';

export interface QrResolved {
  registration: {
    registration_id: number;
    registration_no: string;
    name: string;
    masked_phone: string;
    event: { id: number; title: string } | null;
    registration_option: string | null;
    registration_status: string;
    checkin_status: 'CHECKED_IN' | 'NOT_CHECKED_IN';
    checked_in_at: string | null;
  };
}

export interface PhoneCandidate {
  registration_id: number;
  name: string;
  masked_phone: string;
  registration_option: string | null;
  registration_status: string;
  checkin_status: 'CHECKED_IN' | 'NOT_CHECKED_IN';
  checked_in_at: string | null;
}

export interface PhoneSearchResult {
  count: number;
  event_id: number;
  event_title: string;
  candidates: PhoneCandidate[];
}

export interface CheckinResult {
  already: boolean;
  message: string;
  registration: { registration_no: string; name: string; event: { title: string } | null } | null;
}

export const resolveQrToken = (qrToken: string): Promise<QrResolved> =>
  get<QrResolved>(`/checkin/resolve?qrToken=${encodeURIComponent(qrToken)}`);

export const searchByPhoneLast4 = (eventId: number, last4: string): Promise<PhoneSearchResult> =>
  get<PhoneSearchResult>(`/events/${eventId}/checkin/search?phoneLast4=${encodeURIComponent(last4)}`);

export type CheckinMethod = 'QR' | 'PHONE_LAST4';

export const performCheckin = (registrationId: number, method: CheckinMethod, operator?: string): Promise<CheckinResult> =>
  post<CheckinResult>(`/registrations/${registrationId}/checkin`, { method, operator });
