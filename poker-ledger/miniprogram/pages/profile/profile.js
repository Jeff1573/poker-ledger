/**
 * 个人资料页：
 * - 展示微信头像/昵称
 * - 允许仅修改 displayName（展示昵称）
 */
const { resolveApiAssetUrl } = require("../../utils/url");
const CONST = require("../../utils/const");

Page({
  data: {
    loading: false,
    hasProfile: false,
    user: null,
    userAvatarUrl: "",
    displayNameInput: "",
    showProfileModal: false,

    // 与首页一致：支持 chooseAvatar + nickname 授权链路
    supportChooseAvatar: false,
    draftAvatarLocal: "",
    draftAvatarPath: "",
    draftDisplayName: "",
    canSaveProfile: false
  },

  onLoad() {
    const supportChooseAvatar =
      !!wx.canIUse && wx.canIUse("button.open-type.chooseAvatar") && wx.canIUse("input.type.nickname");
    this.setData({ supportChooseAvatar });
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

  /**
   * 刷新授权弹窗“保存并授权”按钮可用状态。
   */
  refreshCanSaveProfile() {
    const name = String(this.data.draftDisplayName || "").trim();
    const avatarPath = String(this.data.draftAvatarPath || "").trim();
    const ok = !!name && name.length <= 20 && !!avatarPath;
    this.setData({ canSaveProfile: ok });
  },

  /**
   * 打开授权弹窗（与首页保持一致的授权流程）。
   */
  handleOpenProfileModal() {
    if (this.data.loading) return;
    this.setData({
      showProfileModal: true,
      draftAvatarLocal: "",
      draftAvatarPath: "",
      draftDisplayName: "",
      canSaveProfile: false
    });
  },

  /**
   * 关闭授权弹窗。上传/保存进行中不允许关闭，避免流程中断。
   */
  handleCloseProfileModal() {
    if (this.data.loading) return;
    this.setData({ showProfileModal: false });
  },

  /**
   * chooseAvatar：先本地预览头像，再上传到后端并保存 avatarPath。
   *
   * @param {any} e
   */
  async handleChooseAvatar(e) {
    const local = String((e && e.detail && e.detail.avatarUrl) || "").trim();
    if (!local) return;

    this.setData(
      {
        draftAvatarLocal: local,
        draftAvatarPath: ""
      },
      () => this.refreshCanSaveProfile()
    );

    const wasLoading = !!this.data.loading;
    if (!wasLoading) this.setData({ loading: true });
    try {
      const app = getApp();
      const session = await app.ensureSession();
      const url = `${String(CONST.API_BASE_URL || "").replace(/\/$/, "")}/api/uploads/avatar`;
      const r = await new Promise((resolve, reject) => {
        wx.uploadFile({
          url,
          filePath: local,
          name: "file",
          header: {
            Authorization: `Bearer ${session.token}`
          },
          success: resolve,
          fail: reject
        });
      });

      let body = null;
      try {
        body = JSON.parse(String((r && r.data) || ""));
      } catch (err) {
        body = null;
      }

      if (!r || r.statusCode !== 200 || !body || !body.ok || !body.avatarPath) {
        wx.showToast({ title: (body && body.message) || "头像上传失败", icon: "none" });
        return;
      }

      this.setData(
        {
          draftAvatarPath: String(body.avatarPath || "").trim()
        },
        () => this.refreshCanSaveProfile()
      );
    } catch (err) {
      console.error("profile handleChooseAvatar 失败", err);
      wx.showToast({ title: "头像上传失败，请稍后重试", icon: "none" });
    } finally {
      if (!wasLoading) this.setData({ loading: false });
    }
  },

  /**
   * 昵称输入。
   *
   * @param {any} e
   */
  handleNicknameInput(e) {
    const v = String((e && e.detail && e.detail.value) || "").trim();
    this.setData({ draftDisplayName: v }, () => this.refreshCanSaveProfile());
  },

  /**
   * 弹窗内保存授权资料，成功后立即跳首页。
   */
  async handleSaveAuthProfile() {
    if (!this.data.canSaveProfile) return;
    if (this.data.loading) return;

    const displayName = String(this.data.draftDisplayName || "").trim();
    const avatarUrlWx = String(this.data.draftAvatarPath || "").trim();
    if (!displayName || !avatarUrlWx) return;

    this.setData({ loading: true });
    try {
      const app = getApp();
      const saveRes = await app.apiCall({
        path: "/api/users/profile",
        method: "PUT",
        data: { displayName, nickNameWx: displayName, avatarUrlWx }
      });
      if (!saveRes || !saveRes.ok) {
        wx.showToast({ title: (saveRes && saveRes.message) || "保存资料失败", icon: "none" });
        return;
      }

      await app.loadMe();
      this.setData({ showProfileModal: false });
      wx.switchTab({
        url: "/pages/home/home",
        fail: () => wx.reLaunch({ url: "/pages/home/home" })
      });
    } catch (err) {
      console.error("profile handleSaveAuthProfile 失败", err);
      wx.showToast({ title: "保存资料失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 兼容兜底：低版本不支持 chooseAvatar 时走 getUserProfile。
   */
  async handleAuthLegacy() {
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
        wx.showToast({ title: (saveRes && saveRes.message) || "保存资料失败", icon: "none" });
        return;
      }

      await app.loadMe();
      this.setData({ showProfileModal: false });
      wx.switchTab({
        url: "/pages/home/home",
        fail: () => wx.reLaunch({ url: "/pages/home/home" })
      });
    } catch (err) {
      // 用户取消授权属于正常分支，静默处理
    } finally {
      this.setData({ loading: false });
    }
  },

  noop() {},

  async handleSave() {
    if (this.data.loading) return;

    const displayName = String(this.data.displayNameInput || "").trim();
    if (!displayName) {
      wx.showToast({ title: "昵称不能为空", icon: "none" });
      return;
    }

    let shouldRefreshProfile = false;
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
      shouldRefreshProfile = true;

      wx.showToast({ title: "已保存", icon: "success" });
    } catch (err) {
      console.error("保存昵称失败", err);
      wx.showToast({ title: "保存失败", icon: "none" });
    } finally {
      this.setData({ loading: false }, () => {
        // Tab 页保存成功后停留当前页，并主动刷新展示数据。
        if (shouldRefreshProfile) this.loadProfile();
      });
    }
  },

  /**
   * 兼容入口：未授权时在当前页打开授权弹窗。
   */
  handleAuth() {
    this.handleOpenProfileModal();
  }
});
