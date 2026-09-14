// 统一请求封装（§34：Authorization / 401 处理 / 超时 / 网络异常）。
import { API_BASE_URL } from '../config/env';

export interface ApiError {
  code: number; // HTTP 状态码；-1 网络/超时
  message: string;
  data?: any;
}

export interface RequestOptions {
  url: string; // 相对路径，如 '/events'
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: any;
  header?: Record<string, string>;
  timeout?: number;
  // 不自动附带 token（如登录、/config）
  noAuth?: boolean;
}

export function getToken(): string | null {
  try { return wx.getStorageSync('cl_token') || null; } catch { return null; }
}

export function request<T = any>(options: RequestOptions): Promise<T> {
  const method = options.method || 'GET';
  const header: Record<string, string> = { 'Content-Type': 'application/json', ...(options.header || {}) };
  if (!options.noAuth) {
    const token = getToken();
    if (token) header.Authorization = `Bearer ${token}`;
  }
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: API_BASE_URL + options.url,
      method: method,
      data: options.data,
      header,
      timeout: options.timeout || 15000,
      success: (res) => {
        if (res.statusCode === 401) {
          // 会话失效：清 token 并提示重新进入（不静默重试）
          try { wx.removeStorageSync('cl_token'); } catch { /* ignore */ }
          const err: ApiError = { code: 401, message: '登录已失效，请重新进入小程序' };
          reject(err);
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T);
          return;
        }
        const body: any = res.data || {};
        const err: ApiError = {
          code: res.statusCode,
          message: body.error || body.message || `请求失败（HTTP ${res.statusCode}）`,
          data: body,
        };
        reject(err);
      },
      fail: (err) => {
        reject({ code: -1, message: '网络异常，请检查连接后重试', data: err });
      },
    });
  });
}

// 便捷封装
export const get = <T = any>(url: string, data?: any) => request<T>({ url, method: 'GET', data });
export const post = <T = any>(url: string, data?: any, noAuth?: boolean) => request<T>({ url, method: 'POST', data, noAuth });
