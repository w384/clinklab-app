// 订阅消息（B⑤）：支付/报名成功后弹一次授权窗，把授权成功的模板 ID 回传服务端记录。
// 微信订阅为一次性授权：每次用户点"允许" = 服务端 1 次发送额度。
// 模板 ID 未配置（空数组）时不弹窗、不发请求，静默跳过。
import { post } from './request';
import { SUBSCRIBE_TEMPLATE_IDS } from '../config/env';

/** 请求订阅授权并回传服务端。任何失败都静默吞掉（不影响主流程）。 */
export function requestSubscribeMessage(): Promise<void> {
  const ids = SUBSCRIBE_TEMPLATE_IDS || [];
  if (!ids.length) return Promise.resolve();
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => {
        ids.forEach((id) => {
          if (res[id] === 'accept') {
            post('/me/subscribe', { templateId: id }).catch(() => {});
          }
        });
        resolve();
      },
      fail: () => resolve(),
    });
  });
}
