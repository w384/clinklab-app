// 支付：生产目标 = 微信统一下单 → wx.requestPayment → 服务端 notify 落终态。
// 沙箱（development）无真实商户凭证，走 mock-pay（服务端 development-only，403/absent in production）。
// 关键（硬性规则）：wx.requestPayment 成功 ≠ 最终状态；以服务端 GET /registrations/:id 为准。
import { post } from './request';

export interface PrepayResult {
  out_trade_no: string;
  // 生产：调用 wx.requestPayment 所需参数（timeStamp/nonceStr/package/signType/paySign）
  payment: {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
    paySign: string;
  };
}

// 统一下单（生产）。沙箱无商户，会返回 403/501，页面据此降级到 mock-pay。
export const prepay = (registrationId: number) =>
  post<PrepayResult>(`/registrations/${registrationId}/pay/prepay`);

export function wxRequestPayment(p: PrepayResult['payment']): Promise<void> {
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
