// app.ts —— 碰杯实验室（Clink Lab）自主办活动报名小程序
// 启动时静默登录（wx.login → 服务端换系统会话 token + 用户资料 + isAdmin 角色）。
// 角色隔离：isAdmin 由服务端判定；这里只把结果存进全局，供页面决定是否展示管理入口。
import { ensureLogin, ClinkApp } from './services/auth';

App<ClinkApp>({
  globalData: {
    user: null,
    isAdmin: false,
  },
  onLaunch(): void {
    // 浏览（活动列表/详情）无需登录；登录失败不阻塞，由需要身份的页面自行 ensureLogin() 重试。
    ensureLogin().catch(() => {
      /* 忽略：静默登录失败时，游客仍可浏览活动 */
    });
  },
});
