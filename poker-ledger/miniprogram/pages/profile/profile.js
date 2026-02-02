/**
 * 个人资料页：
 * - 展示微信头像/昵称
 * - 允许仅修改 displayName（展示昵称）
 */
const { resolveApiAssetUrl } = require("../../utils/url");

Page({
  data: {
    loading: false,
    hasProfile: false,
    user: null,
    userAvatarUrl: "",
    displayNameInput: ""
  },

  onShow() {
    this.loadProfile();
  },

  async loadProfile() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const app = getApp();
      await app.ensureSession();
      const me = await app.loadMe();
      const user = (me && me.user) || null;
      const hasProfile = !!(user && user.displayName && user.avatarUrlWx);
      this.setData({
        hasProfile,
        user,
        userAvatarUrl: resolveApiAssetUrl(user && user.avatarUrlWx),
        displayNameInput: (user && user.displayName) || ""
      });
    } catch (err) {
      console.error("loadProfile 失败", err);
    } finally {
      this.setData({ loading: false });
    }
  },

  handleDisplayNameInput(e) {
    const v = String((e && e.detail && e.detail.value) || "").trim();
    this.setData({ displayNameInput: v });
  },

  async handleSave() {
    if (this.data.loading) return;

    const displayName = String(this.data.displayNameInput || "").trim();
    if (!displayName) {
      wx.showToast({ title: "昵称不能为空", icon: "none" });
      return;
    }

    this.setData({ loading: true });
    try {
      const app = getApp();
      const r = await app.apiCall({
        path: "/api/users/profile",
        method: "PUT",
        data: { displayName }
      });

      if (!r || !r.ok) {
        wx.showToast({ title: (r && r.message) || "保存失败", icon: "none" });
        return;
      }

      // 保存成功后刷新全局缓存
      await app.loadMe();

      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (err) {
      console.error("保存昵称失败", err);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 如果用户还没授权，可在这里补一次授权。
   * 注意：wx.getUserProfile 必须由用户点击触发。
   */
  async handleAuth() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const profileRes = await new Promise((resolve, reject) => {
        wx.getUserProfile({
          desc: "用于显示房间成员头像和昵称",
          success: resolve,
          fail: reject
        });
      });

      const userInfo = (profileRes && profileRes.userInfo) || {};
      const nickNameWx = String(userInfo.nickName || "").trim();
      const avatarUrlWx = String(userInfo.avatarUrl || "").trim();
      const displayName = nickNameWx;

      const app = getApp();
      const saveRes = await app.apiCall({
        path: "/api/users/profile",
        method: "PUT",
        data: { nickNameWx, avatarUrlWx, displayName }
      });

      if (!saveRes || !saveRes.ok) {
        wx.showToast({
          title: (saveRes && saveRes.message) || "保存资料失败",
          icon: "none"
        });
        return;
      }

      await this.loadProfile();
    } catch (err) {
      // 用户取消授权属于正常场景
    } finally {
      this.setData({ loading: false });
    }
  }
});
