import QRCode from 'qrcode';

/**
 * 生成二维码 data URL（base64 PNG），供报名凭证展示（§11）。
 * 二维码内容是 qr_token（随机不可预测，§12），不是自增 id。
 */
export async function qrDataUrl(text: string, width = 300): Promise<string> {
  return await QRCode.toDataURL(text, { width, margin: 1, errorCorrectionLevel: 'M' });
}
