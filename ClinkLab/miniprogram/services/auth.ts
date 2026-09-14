// 微信登录：wx.login 拿 code → 服务端 code2Session 换系统会话 token。
// 客户端只持有系统会话 token（Bearer）+ 用户资料（含 isAdmin 角色），不接触 session_key / openid。
// 角色隔离：isAdmin 由服务端判定（users.is_admin），客户端仅用于决定 UI 是否展示管理入口。
import { post, get, put, getToken } from './request';

export interface WxUser {
  userId: number;
  nickname: string | null;
  phone: string | null;
  avatar: string | null;
  isAdmin: boolean;
  isNew?: boolean;
}

export interface LoginResult {
  token: string;
  user: WxUser;
}

// 全局 App 形状（app.ts 用 App<...> 声明，这里本地定义以便 getApp<T>() 强类型访问）
export interface ClinkApp {
  globalData: {
    user: WxUser | null;
    isAdmin: boolean;
  };
}

function appRef(): ClinkApp {
  return getApp<ClinkApp>();
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

function persistUser(user: WxUser): void {
  try {
    appRef().globalData.user = user;
    appRef().globalData.isAdmin = !!user.isAdmin;
    wx.setStorageSync('cl_user', user);
  } catch { /* ignore */ }
}

export async function wxLogin(): Promise<LoginResult> {
  const code = await wxLoginCode();
  const res = await post<LoginResult>('/auth/wechat-login', { code }, true);
  try { wx.setStorageSync('cl_token', res.token); } catch { /* ignore */ }
  persistUser(res.user);
  return res;
}

// 有 token 则校验；401 或无 token 则重新登录
export async function ensureLogin(): Promise<LoginResult> {
  if (getToken()) {
    try {
      const me = await get<WxUser>('/me');
      persistUser(me);
      return { token: getToken() as string, user: me };
    } catch (e) {
      const err = e as { code?: number };
      if (err && err.code === 401) { /* fallthrough 重新登录 */ }
      else throw e;
    }
  }
  return wxLogin();
}

/**
 * 从服务端重新拉取当前用户（含最新 isAdmin 角色）并更新本地缓存。
 * 用于「开通工作人员权限」等角色变更后同步——否则 getIsAdmin() 仍读登录时的旧缓存。
 */
export async function refreshUser(): Promise<WxUser | null> {
  if (!getToken()) return getCurrentUser();
  const me = await get<WxUser>('/me');
  persistUser(me);
  return me;
}

/**
 * 完善/更新当前用户资料（昵称/手机/头像），只提交传入的字段。
 * 头像为 base64 data URL（chooseAvatar 得到）；采集不到时前端不传，服务端保留原值。
 */
export async function updateProfile(patch: { nickname?: string; phone?: string; avatar?: string }): Promise<WxUser> {
  const res = await put<{ ok: boolean; user: WxUser }>('/me', patch);
  if (res && res.user) persistUser(res.user);
  return (res && res.user) || getCurrentUser()!;
}

export function logout(): Promise<void> {
  if (getToken()) {
    return post('/me/logout').catch(() => undefined).then(() => {
      clearLocal();
    });
  }
  clearLocal();
  return Promise.resolve();
}

function clearLocal(): void {
  try {
    wx.removeStorageSync('cl_token');
    wx.removeStorageSync('cl_user');
    appRef().globalData.user = null;
    appRef().globalData.isAdmin = false;
  } catch { /* ignore */ }
}

export function getCurrentUser(): WxUser | null {
  try {
    if (appRef().globalData.user) return appRef().globalData.user;
    const u = wx.getStorageSync('cl_user') as WxUser | undefined;
    if (u) { appRef().globalData.user = u; appRef().globalData.isAdmin = !!u.isAdmin; return u; }
    return null;
  } catch {
    return null;
  }
}

export function getIsAdmin(): boolean {
  const u = getCurrentUser();
  return !!(u && u.isAdmin);
}
