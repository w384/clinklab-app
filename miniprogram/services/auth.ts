// 微信登录：wx.login 拿 code → 服务端 code2Session 换系统会话 token。
// 客户端只持有系统会话 token（Bearer），不接触 session_key / openid（服务端保管）。
import { post, get, getToken } from './request';

export interface WxUser {
  userId: number;
  nickname: string | null;
  phone: string | null;
  isNew?: boolean;
}

export interface LoginResult {
  token: string;
  user: WxUser;
}

function wxLoginCode(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    wx.login({
      timeout: 15000,
      success: (r) => (r.code ? resolve(r.code) : reject({ code: -1, message: 'wx.login 未返回 code' })),
      fail: (err) => reject({ code: -1, message: 'wx.login 失败', data: err }),
    });
  });
}

export async function wxLogin(): Promise<LoginResult> {
  const code = await wxLoginCode();
  const res = await post<LoginResult>('/auth/wechat-login', { code }, true);
  try { wx.setStorageSync('cl_token', res.token); } catch { /* ignore */ }
  return res;
}

// 有 token 则校验；401 或无 token 则重新登录
export async function ensureLogin(): Promise<LoginResult> {
  if (getToken()) {
    try {
      const me = await get<WxUser>('/me');
      return { token: getToken() as string, user: me };
    } catch (e: any) {
      if (e && e.code === 401) { /* fallthrough 重新登录 */ }
      else throw e;
    }
  }
  return wxLogin();
}

export function logout(): Promise<void> {
  if (getToken()) {
    return post('/me/logout').catch(() => {}).then(() => {
      try { wx.removeStorageSync('cl_token'); } catch { /* ignore */ }
    });
  }
  try { wx.removeStorageSync('cl_token'); } catch { /* ignore */ }
  return Promise.resolve();
}
