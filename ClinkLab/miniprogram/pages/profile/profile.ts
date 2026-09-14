// 我的：用户信息 + 首次登录完善资料（头像/昵称/手机）+ 工作人员入口（仅 is_admin 显示）+ 退出登录。
// 头像：微信 chooseAvatar → 临时文件转 base64 → 服务端落库；采集不到则前端回退首字。
// 手机：微信 getPhoneNumber（一键，需真实凭证）+ 手动输入兜底；报名不重复填写（取自资料快照）。
import { getCurrentUser, getIsAdmin, refreshUser, updateProfile, logout } from '../../services/auth';
import { post } from '../../services/request';
import { toast } from '../../utils/util';

// 微信 chooseAvatar 返回的是临时文件路径（http://tmp/... 或 wxfile://），需读成 base64 才能提交服务端。
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    out += B64_CHARS[a >> 2];
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)];
    out += hasB ? B64_CHARS[((b & 0x0f) << 2) | (c >> 6)] : '=';
    out += hasC ? B64_CHARS[c & 0x3f] : '=';
  }
  return out;
}

function avatarPathToDataUrl(tempPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const mime = /\.png(\?|$)/i.test(tempPath) ? 'image/png' : 'image/jpeg';
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: (res) => {
        const d = res.data;
        const b64 = typeof d === 'string' ? d : bufferToBase64(d);
        resolve(`data:${mime};base64,${b64}`);
      },
      fail: (err) => reject(err),
    });
  });
}

Page({
  data: {
    user: null as { nickname: string; initial: string; phone: string | null; avatar: string | null } | null,
    isAdmin: false,
    needNickname: false,
    needPhone: false,
    draftNickname: '',
    draftPhone: '',
    draftAvatar: '',
    saving: false,
  },
  onShow(): void {
    const u = getCurrentUser();
    const isAdmin = getIsAdmin();
    this.setData({
      user: u
        ? { nickname: u.nickname || '微信用户', initial: (u.nickname || '用').trim().slice(0, 1), phone: u.phone, avatar: u.avatar }
        : null,
      isAdmin,
      needNickname: !u || !u.nickname,
      needPhone: !u || !u.phone,
      draftNickname: (u && u.nickname) || '',
      draftPhone: (u && u.phone) || '',
      draftAvatar: (u && u.avatar) || '',
    });
  },
  goCheckin(): void {
    wx.navigateTo({ url: '/pages/checkin/checkin' });
  },
  goMyRegs(): void {
    wx.navigateTo({ url: '/pages/my/my' });
  },

  // ───────── 完善资料 ─────────
  onChooseAvatar(e: WechatMiniprogram.CustomEvent): void {
    const detail = (e && e.detail) as { avatarUrl?: string } | undefined;
    const tempPath = (detail && detail.avatarUrl) || (typeof e.detail === 'string' ? e.detail : '');
    if (!tempPath) return;
    avatarPathToDataUrl(tempPath)
      .then((dataUrl) => this.setData({ draftAvatar: dataUrl }))
      .catch(() => toast('头像读取失败，请重试', 'none'));
  },
  onNicknameChange(e: WechatMiniprogram.Input): void {
    this.setData({ draftNickname: (e.detail.value || '').trim() });
  },
  onPhoneInput(e: WechatMiniprogram.Input): void {
    this.setData({ draftPhone: (e.detail.value || '').replace(/\D/g, '').slice(0, 11) });
  },
  // 微信一键获取手机号（open-type="getPhoneNumber"）。返回 code → 服务端解密；开发模式失败则手动兜底。
  onGetPhone(e: WechatMiniprogram.CustomEvent): void {
    const d = (e && e.detail) as { code?: string; errMsg?: string } | undefined;
    if (d && d.code) {
      post<{ ok: boolean; user: { phone: string } }>('/me/phone', { code: d.code })
        .then((res) => {
          if (res && res.user && res.user.phone) {
            this.setData({ draftPhone: res.user.phone, needPhone: false });
            toast('已获取微信手机号', 'success');
          }
        })
        .catch((err: { message?: string }) => toast((err && err.message) || '获取失败，请手动输入', 'none'));
    } else {
      toast('未能获取微信手机号，请手动输入', 'none');
    }
  },
  async saveProfile(): Promise<void> {
    const { needNickname, needPhone, draftNickname, draftPhone, draftAvatar } = this.data;
    if (needNickname && !draftNickname) { toast('请填写昵称', 'none'); return; }
    if (needPhone && !/^\d{7,15}$/.test(draftPhone)) { toast('请填写 11 位手机号', 'none'); return; }
    const patch: { nickname?: string; phone?: string; avatar?: string } = {};
    if (needNickname) patch.nickname = draftNickname;
    if (needPhone) patch.phone = draftPhone;
    if (draftAvatar) patch.avatar = draftAvatar;
    if (!patch.nickname && !patch.phone && !patch.avatar) { toast('资料已完整', 'success'); return; }
    this.setData({ saving: true });
    try {
      await updateProfile(patch);
      const u = getCurrentUser();
      this.setData({
        saving: false,
        user: u ? { nickname: u.nickname || '微信用户', initial: (u.nickname || '用').trim().slice(0, 1), phone: u.phone, avatar: u.avatar } : null,
        needNickname: !u || !u.nickname,
        needPhone: !u || !u.phone,
      });
      toast('资料已保存，可直接报名', 'success');
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '保存失败，请重试', 'none');
      this.setData({ saving: false });
    }
  },

  async makeAdmin(): Promise<void> {
    try {
      const res = await post<{ ok: boolean }>('/dev/auth/make-admin');
      if (res && res.ok) {
        await refreshUser(); // 同步服务端角色到本地缓存，供「我的」「签到」等页读取
        this.setData({ isAdmin: true });
        toast('已开通工作人员权限', 'success');
      }
    } catch (e) {
      const err = e as { message?: string };
      toast((err && err.message) || '开通失败（仅 development 环境）', 'none');
    }
  },
  doLogout(): void {
    wx.showModal({
      title: '退出登录',
      content: '确定退出登录吗？',
      success: async (res) => {
        if (!res.confirm) return;
        await logout();
        this.setData({ user: null, isAdmin: false });
        toast('已退出', 'success');
      },
    });
  },
});
