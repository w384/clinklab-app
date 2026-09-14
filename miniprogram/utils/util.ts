// 通用工具（与 server/src/util.ts 语义一致：金额分→¥ 不补零，时间本地化，手机号脱敏）。

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

export function toast(title: string, type: 'success' | 'error' | 'none' = 'none') {
  wx.showToast({ title, icon: type === 'none' ? 'none' : type });
}
