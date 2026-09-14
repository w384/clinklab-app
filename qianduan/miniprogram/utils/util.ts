// 通用工具（与 server/src/util.ts 语义一致：金额分→¥ 不补零，时间本地化，手机号脱敏）。
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ISO 起止 → "2024/06/15 (周六) 14:00-17:30"
export function fmtRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = start ? new Date(start) : null;
  if (!s || isNaN(s.getTime())) return fmtTime(start);
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  const date = `${s.getFullYear()}/${p(s.getMonth() + 1)}/${p(s.getDate())}`;
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][s.getDay()];
  const t1 = `${p(s.getHours())}:${p(s.getMinutes())}`;
  let t2 = '';
  const e = end ? new Date(end) : null;
  if (e && !isNaN(e.getTime())) t2 = `-${p(e.getHours())}:${p(e.getMinutes())}`;
  return `${date} (${wd}) ${t1}${t2}`;
}

export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  const yuan = cents / 100;
  const s = Number.isInteger(yuan) ? yuan.toString() : yuan.toFixed(2);
  return `¥${s}`;
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

export const STATUS_ZH: Record<string, string> = {
  PENDING: '待支付',
  PAID: '已支付',
  CANCELLED: '已取消',
  REFUNDING: '退款中',
  REFUNDED: '已退款',
};

export const REFUND_RULE_ZH: Record<string, string> = {
  NO_SELF_REFUND: '不可自行退款',
  BEFORE_24H: '开始前 24 小时可退',
  BEFORE_48H: '开始前 48 小时可退',
  ALLOW_ANY: '活动结束前可退',
};

export function toast(title: string, type: 'success' | 'error' | 'none' = 'none'): void {
  wx.showToast({ title, icon: type === 'none' ? 'none' : type });
}

// ISO → 周几（用于详情页 "2024/06/15 (周六)" 展示）
export function weekdayZh(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

// 手机号后四位（§17 输入约束：4 位数字）
export function phoneLast4(raw: string): string {
  return (raw || '').replace(/\D/g, '').slice(-4);
}

// 简单校验（§19 输入约束：姓名 1-50、手机号 11 位数字）
export function validName(name: string): boolean {
  const s = (name || '').trim();
  return s.length >= 1 && s.length <= 50;
}

export function validPhone(phone: string): boolean {
  return /^1\d{10}$/.test((phone || '').trim());
}
