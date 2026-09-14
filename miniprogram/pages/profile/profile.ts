// 个人中心：当前用户 / 环境信息 / 快捷入口 / 重新登录、退出登录。
import { ensureLogin, logout, wxLogin, WxUser } from '../../services/auth';
import { getEnv, getMockPay } from '../../services/appConfig';
import { toast } from '../../utils/util';

Page({
  data: {
    user: null as WxUser | null,
    env: '',
    mockPay: false,
  },
  onShow() { this.load(); },
  async load() {
    this.setData({ env: getEnv(), mockPay: getMockPay() });
    try {
      const r = await ensureLogin();
      this.setData({ user: r.user });
    } catch {
      this.setData({ user: null });
    }
  },
  relogin() {
    logout()
      .then(() => wxLogin())
      .then((r) => { toast('已重新登录', 'success'); this.setData({ user: r.user }); })
      .catch((e: any) => toast((e && e.message) || '登录失败', 'error'));
  },
  doLogout() {
    wx.showModal({
      title: '退出登录', content: '确认退出当前账号？',
      success: (r) => {
        if (!r.confirm) return;
        logout().then(() => { toast('已退出', 'success'); this.setData({ user: null }); });
      },
    });
  },
  goCheckin() { wx.navigateTo({ url: '/pages/checkin/checkin' }); },
  goIndex() { wx.switchTab({ url: '/pages/index/index' }); },
  goMy() { wx.switchTab({ url: '/pages/my/my' }); },
});
