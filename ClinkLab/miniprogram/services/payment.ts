// 支付：生产目标 = 微信统一下单 → wx.requestPayment → 服务端 notify 落终态。
// 沙箱（development）无真实商户凭证，走 mock-pay（服务端 development-only，403/absent in production）。
// 关键（硬性规则）：wx.requestPayment 成功 ≠ 最终状态；以服务端 GET /registrations/:id 为准。
import { post } from './request';

export interface PrepayPayment {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
  paySign: string;
}

export interface PrepayResult {
  registration_id: number;
  out_trade_no: string;
  amount: number; // 分
  amount_display: string; // 元
  channel: string;
  note?: string;
  payment?: PrepayPayment; // 真实微信模式才有；mock 模式无此字段 → 页面降级到 mock-pay
}

// 统一下单（生产）。mock 模式返回无 payment 的结果；页面据此降级到 mock-pay。
export const prepay = (registrationId: number): Promise<PrepayResult> =>
  post<PrepayResult>(`/registrations/${registrationId}/pay/prepay`);

export function wxRequestPayment(p: PrepayPayment): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    wx.requestPayment({
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType,
      paySign: p.paySign,
      success: () => resolve(),
      fail: (err) => reject({ code: -1, message: '支付未完成', data: err }),
    });
  });
}
