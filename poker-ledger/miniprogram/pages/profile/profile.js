/**
 * 个人资料页：
 * - 展示头像/昵称，并给出一眼可见的当前环境标识
 * - 一次性完成头像 + 昵称设置（与首页保持同一套交互）
 * - 已完成后仅修改展示昵称
 * - 提供账号注销入口（低频操作从首页移到这里）
 */
const { resolveApiAssetUrl } = require("../../utils/url");
const CONST = require("../../utils/const");
const storage = require("../../utils/storage");
const log = require("../../utils/log");
const { getEnvInfo, extractDevIdentity } = require("../../utils/env");

/**
 * 生成默认昵称，避免用户必须手打才能完成设置。
 *
 * @returns {string}
 */
function buildDefaultNickname() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `玩家${n}`;
}

Page({
  data: {
    loading: false,
    hasProfile: false,
    user: null,
    userAvatarUrl: "",
    displayNameInput: "",

    // 当前环境
    envLabel: "",
    envTone: "",
    envDetail: "",

    // 开发环境下的虚拟账号（不同设备默认是不同账号）
    devSwitchable: false,
    devIdentity: "",

    // 一步式资料设置
    supportChooseAvatar: false,
    draftAvatarLocal: "",
    draftAvatarPath: "",
    draftDisplayName: "",
    canSaveProfile: false,
    avatarUploading: false
  },

  onLoad() {
    const supportChooseAvatar =
      !!wx.canIUse && wx.canIUse("button.open-type.chooseAvatar") && wx.canIUse("input.type.nickname");
    const env = getEnvInfo();
    this.setData({
      supportChooseAvatar,
      envLabel: env.label,
      envTone: env.tone,
      envDetail: env.detail,
      devSwitchable: !!CONST.DEV_MOCK_LOGIN,
      draftDisplayName: supportChooseAvatar ? buildDefaultNickname() : ""
    });
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
      const patch = {
        hasProfile,
        user,
        userAvatarUrl: resolveApiAssetUrl(user && user.avatarUrlWx),
        displayNameInput: (user && user.displayName) || "",
        envDetail: getEnvInfo().detail,
        devIdentity: extractDevIdentity(me && me.openId)
      };
      if (!hasProfile && !String(this.data.draftDisplayName || "").trim()) {
        patch.draftDisplayName = this.data.supportChooseAvatar ? buildDefaultNickname() : "";
      }
      this.setData(patch);
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
   * 刷新“完成”按钮可用状态。
   */
  refreshCanSaveProfile() {
    const name = String(this.data.draftDisplayName || "").trim();
    const avatarPath = String(this.data.draftAvatarPath || "").trim();
    const ok = !!name && name.length <= 20 && !!avatarPath;
    this.setData({ canSaveProfile: ok });
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
        draftAvatarPath: "",
        avatarUploading: true
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
      log.error("avatar.upload.fail", "头像上传失败", {
        errMsg: String((err && err.message) || err || "")
      });
      wx.showToast({ title: "头像上传失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ avatarUploading: false });
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
   * 保存头像 + 昵称，成功后清空草稿并刷新本页。
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
      this.setData({
        draftAvatarLocal: "",
        draftAvatarPath: "",
        canSaveProfile: false
      });
      wx.showToast({ title: "已保存", icon: "success" });
      await this.loadProfile();
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
      await this.loadProfile();
    } catch (err) {
      // 用户取消授权属于正常分支，静默处理
    } finally {
      this.setData({ loading: false });
    }
  },

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
   * 切换开发账号（仅 develop 环境）。
   *
   * 背景：develop 环境跳过了 wx.login，每个客户端实例会生成一个独立的虚拟账号，
   * 所以「开发者工具建了房间、手机上看不到」是正常的——它们是两个账号。
   * 这里允许手动指定标识：同一个标识 = 同一个账号，方便跨设备对齐或构造多人场景。
   */
  async handleSwitchDevAccount() {
    if (!CONST.DEV_MOCK_LOGIN) return;

    const current = String(storage.getDevUserTag() || this.data.devIdentity || "").trim();
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: "切换开发账号",
        editable: true,
        placeholderText: "留空 = 随机生成新账号",
        content: current,
        confirmText: "切换",
        cancelText: "取消",
        success: resolve,
        fail: () => resolve({ confirm: false })
      });
    });
    if (!res || !res.confirm) return;

    const input = String(res.content || "").trim().toLowerCase();
    if (input && !/^[a-z0-9_-]{1,16}$/.test(input)) {
      wx.showToast({ title: "只能用 1-16 位小写字母/数字", icon: "none" });
      return;
    }

    if (input) storage.setDevUserTag(input);
    else storage.clearDevUserTag();

    // 清掉登录态，强制重新走一次开发旁路登录
    storage.setToken("");
    storage.setOpenId("");
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.token = "";
      app.globalData.openId = "";
      app.globalData.user = null;
    }

    wx.showToast({ title: "已切换账号", icon: "success", duration: 900 });
    setTimeout(() => {
      wx.reLaunch({ url: "/pages/home/home" });
    }, 900);
  },

  /**
   * 注销账号：低频且不可逆的操作，放在「我的」页，避免占首页版面。
   */
  async handleLogout() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: "确认注销",
        content: "注销后需要重新授权登录，确定要退出吗？",
        confirmText: "确定",
        confirmColor: "#C93B2E",
        cancelText: "取消",
        success: resolve,
        fail: () => resolve({ confirm: false })
      });
    });
    if (!res || !res.confirm) return;

    wx.showLoading({ title: "注销中...", mask: true });
    try {
      const app = getApp();
      const deactivateRes = await app.apiCall({
        path: "/api/auth/deactivate",
        method: "POST"
      });

      if (!deactivateRes || !deactivateRes.ok) {
        wx.hideLoading();
        wx.showToast({
          title: (deactivateRes && deactivateRes.message) || "注销失败",
          icon: "none"
        });
        return;
      }

      app.globalData.token = "";
      app.globalData.openId = "";
      app.globalData.user = null;
      storage.setToken("");
      storage.setOpenId("");

      wx.hideLoading();
      wx.showToast({ title: "已注销账号", icon: "success", duration: 1200 });
      setTimeout(() => {
        wx.reLaunch({ url: "/pages/home/home" });
      }, 1200);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || "注销失败", icon: "none" });
    }
  }
});
