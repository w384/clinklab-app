// 统一请求封装（§34：Authorization / 401 处理 / 超时 / 网络异常）。
import { API_BASE_URL } from '../config/env';

export interface ApiError {
  code: number; // HTTP 状态码；-1 网络/超时
  message: string;
  data?: unknown;
}

export interface RequestOptions {
  url: string; // 相对路径，如 '/events'
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: Record<string, any>;
  header?: Record<string, string>;
  timeout?: number;
  // 不自动附带 token（如登录、/config）
  noAuth?: boolean;
}

export function getToken(): string | null {
  try {
    return wx.getStorageSync('cl_token') || null;
  } catch {
    return null;
  }
}

export function request<T = unknown>(options: RequestOptions): Promise<T> {
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
          try { wx.removeStorageSync('cl_token'); } catch { /* ignore */ }
          reject({ code: 401, message: '登录已失效，请重新进入小程序' });
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T);
          return;
        }
        const body = (res.data || {}) as Record<string, unknown>;
        reject({
          code: res.statusCode,
          message: (body.error as string) || (body.message as string) || `请求失败（HTTP ${res.statusCode}）`,
          data: body,
        });
      },
      fail: (err) => {
        reject({ code: -1, message: '网络异常，请检查连接后重试', data: err });
      },
    });
  });
}

export const get = <T = unknown>(url: string, data?: Record<string, any>): Promise<T> => request<T>({ url, method: 'GET', data });
export const post = <T = unknown>(url: string, data?: Record<string, any>, noAuth?: boolean): Promise<T> => request<T>({ url, method: 'POST', data, noAuth });
export const put = <T = unknown>(url: string, data?: Record<string, any>): Promise<T> => request<T>({ url, method: 'PUT', data });
