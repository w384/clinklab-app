// 图片上传（登录用户，发帖插图等）：选图（压缩）→ base64 → POST /uploads → 绝对 URL。
// 服务端存相对路径 /uploads/xxx，富文本里按需绝对化；这里直接返回绝对 URL 方便展示。
import { post } from './request';
import { API_BASE_URL } from '../config/env';

/** 选择并上传多张图片，返回绝对 URL 数组（按选择顺序）。 */
export function chooseAndUploadImages(count = 9, maxTotalBytes = 6 * 1024 * 1024): Promise<string[]> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: async (res) => {
        try {
          const urls: string[] = [];
          for (const f of res.tempFiles) {
            const dataUrl = await fileToDataUrl(f.tempFilePath);
            if (dataUrl.length > maxTotalBytes * 1.4) throw { code: -1, message: '图片过大，请压缩后再传' };
            const r = await post<{ url: string }>('/uploads', { dataUrl });
            urls.push(API_BASE_URL + r.url);
          }
          resolve(urls);
        } catch (e) {
          reject(e);
        }
      },
      fail: () => reject({ code: -1, message: '未选择图片' }),
    });
  });
}

function fileToDataUrl(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => {
        const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
        const mime =
          ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        resolve(`data:${mime};base64,${r.data}`);
      },
      fail: reject,
    });
  });
}
