const { validateRoomCode } = require("../../utils/validator");
const CONST = require("../../utils/const");
const storage = require("../../utils/storage");
const { resolveApiAssetUrl } = require("../../utils/url");

/**
 * 安全解码：避免非法编码导致 decodeURIComponent 抛错。
 *
 * @param {any} v
 * @returns {string}
 */
function safeDecode(v) {
  const text = String(v || "");
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return text;
  }
}

/**
 * 将输入归一化为合法房间号。
 * 兼容：纯房间号 / PLROOM:ROOMCODE / query 字符串中的 roomCode|code 参数。
 *
 * @param {any} raw
 * @returns {string}
 */
function normalizeRoomCode(raw) {
  const tryValidate = (candidate) => {
    const parsed = validateRoomCode(String(candidate || "").trim().toUpperCase());
    return parsed.ok ? parsed.code : "";
  };

  const text = String(raw || "").trim();
  if (!text) return "";

  const direct = tryValidate(text);
  if (direct) return direct;

  const plMatch = text.match(/^PLROOM:([0-9A-Za-z]{4,12})$/i);
  if (plMatch && plMatch[1]) {
    const fromPl = tryValidate(plMatch[1]);
    if (fromPl) return fromPl;
  }

  const paramMatch = text.match(/[?&](?:roomCode|code)=([^&]+)/i);
  if (paramMatch && paramMatch[1]) {
    const fromParam = tryValidate(safeDecode(paramMatch[1]));
    if (fromParam) return fromParam;
  }

  return "";
}

/**
 * 从页面参数中提取邀请码房间号。
 *
 * @param {any} options
 * @returns {string}
 */
function extractInviteRoomCodeFromOptions(options) {
  // 仅认 roomCode/code，不再从 scene 读取，避免把微信入口场景值（如 1001）误判为房间号。
  const roomCodeFromQuery = safeDecode(
    options && (options.roomCode || options.code || (options.query && (options.query.roomCode || options.query.code)))
  );
  return normalizeRoomCode(roomCodeFromQuery);
}

/**
 * 首页职责：
 * 1) 获取用户授权信息（头像/昵称）
 * 2) 创建房间（房主）/ 加入房间（成员）/ 扫码加入
 * 3) 若用户仍在房间内，首页展示房间状态并允许手动继续/退出
 *
 * 说明：本项目已放弃微信云开发，所有数据由自建 Node.js 后端提供（HTTP + WebSocket）。
 */
Page({
  data: {
    loading: false,
    hasProfile: false,
    // 资料弹窗：未授权用户点击“开始记账”后才展开。
    showProfileModal: false,
    user: null,
    userAvatarUrl: "",
    roomCodeInput: "",
    pendingRoomCode: "",

    // 推荐授权方案：chooseAvatar + input(type="nickname")
    supportChooseAvatar: false,
    draftAvatarLocal: "",
    draftAvatarPath: "",
    draftDisplayName: "",
    canSaveProfile: false,

    // 首页房间状态：用于“手动继续房间/退出房间”，避免点首页 tab 后被强制跳转。
    inRoom: false,
    activeRoomCode: "",
    activeRoomRole: "",
    activeRoomIsOwner: false
  },

  onLoad(options) {
    const last = storage.getLastRoomCode();
    const pendingRoomCode = extractInviteRoomCodeFromOptions(options);

    // 说明：新版推荐做法是让用户主动选择头像 + 输入昵称（无需获取 userInfo 明文授权）
    const supportChooseAvatar =
      !!wx.canIUse && wx.canIUse("button.open-type.chooseAvatar") && wx.canIUse("input.type.nickname");

    this.setData({
      roomCodeInput: pendingRoomCode || last || "",
      pendingRoomCode,
      supportChooseAvatar
    });

    if (pendingRoomCode) {
      storage.setLastRoomCode(pendingRoomCode);
    }
  },

  onShow() {
    // onShow 先消费 app 全局邀请码，覆盖热启动分享场景（onLoad 不会重复触发）。
    const app = getApp();
    const inviteRoomCode =
      app && typeof app.consumePendingInviteRoomCode === "function" ? app.consumePendingInviteRoomCode() : "";

    if (inviteRoomCode) {
      this.setData({
        pendingRoomCode: inviteRoomCode,
        roomCodeInput: inviteRoomCode
      });
      storage.setLastRoomCode(inviteRoomCode);
    }

    this.bootstrap();
  },

  /**
   * 刷新「保存资料」按钮可用状态。
   * 规则：昵称非空 + 已拿到后端 avatarPath（相对路径）。
   */
  refreshCanSaveProfile() {
    const name = String(this.data.draftDisplayName || "").trim();
    const avatarPath = String(this.data.draftAvatarPath || "").trim();
    const ok = !!name && name.length <= 20 && !!avatarPath;
    this.setData({ canSaveProfile: ok });
  },

  /**
   * 启动引导：
   * - 先通过 /api/me 判断是否仍在房间中，首页展示“当前房间”状态卡
   * - 再判断是否已有用户档案（是否完成授权）
   * - 若是扫码进入且已授权，且当前不在房间中，则尝试自动加入
   */
  async bootstrap() {
    if (this._booting) return;
    this._booting = true;

    try {
      this.setData({ loading: true });

      const app = getApp();
      await app.ensureSession();

      const me = await app.loadMe();
      if (!me || !me.ok) {
        this.toast((me && me.message) || "初始化失败，请检查后端地址/服务端状态");
        return;
      }

      // 1) 更新用户档案、授权状态与当前房间状态
      const inRoom = !!(me.inRoom && me.roomCode);
      const activeRoomCode = inRoom ? String(me.roomCode || "").trim().toUpperCase() : "";
      const activeRoomRole = inRoom ? String(me.role || "").trim().toLowerCase() : "";
      const user = me.user || null;
      const hasProfile = !!(user && user.displayName && user.avatarUrlWx);
      this.setData({
        user,
        hasProfile,
        userAvatarUrl: resolveApiAssetUrl(user && user.avatarUrlWx),
        inRoom,
        activeRoomCode,
        activeRoomRole,
        activeRoomIsOwner: activeRoomRole === "owner"
      });

      // 2) 用户已在房间时不执行自动入房，避免邀请流程误触发“重复加入”。
      if (inRoom) {
        if (this.data.pendingRoomCode) {
          // 清空一次性邀请标记，避免后续 onShow/退出后被历史邀请码反复触发。
          this.setData({ pendingRoomCode: "" });
        }
        return;
      }

      // 3) 如果携带邀请码且已授权，尝试自动加入
      if (this.data.pendingRoomCode && hasProfile) {
        // 先清空 pending，避免自动加入失败后每次 onShow 都重复重试。
        const inviteRoomCode = String(this.data.pendingRoomCode || "").trim().toUpperCase();
        this.setData({ pendingRoomCode: "" });
        await this.joinRoomByCode(inviteRoomCode);
      }
    } catch (err) {
      console.error("bootstrap 失败", err);
      this.toast("初始化失败，请检查后端地址/服务端状态");
    } finally {
      this.setData({ loading: false });
      this._booting = false;
    }
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" });
  },

  goLeaderboard() {
    wx.navigateTo({ url: "/pages/leaderboard/leaderboard" });
  },

  /**
   * 继续当前房间：仅做显式跳转，不在首页 onShow 阶段强制跳转。
   */
  handleContinueRoom() {
    wx.switchTab({ url: "/pages/room/room" });
  },

  /**
   * 从首页退出当前房间（仅成员可退出；房主需去房间页解散）。
   */
  async handleLeaveCurrentRoom() {
    if (!this.data.inRoom || !this.data.activeRoomCode) return;
    if (this._leavingRoom) return;

    // 协议约束：房主不能调用 leave，只能去房间页执行 dissolve。
    if (this.data.activeRoomIsOwner) {
      const ownerRes = await new Promise((resolve, reject) => {
        wx.showModal({
          title: "你是房主",
          content: "房主不能直接退出，请前往房间页解散房间。",
          confirmText: "去房间页",
          cancelText: "取消",
          success: resolve,
          fail: reject
        });
      }).catch(() => null);

      if (ownerRes && ownerRes.confirm) {
        this.handleContinueRoom();
      }
      return;
    }

    const roomCode = String(this.data.activeRoomCode || "").trim().toUpperCase();
    const confirmRes = await new Promise((resolve, reject) => {
      wx.showModal({
        title: "退出房间",
        content: `确定退出房间 ${roomCode} 吗？`,
        confirmText: "退出",
        confirmColor: "#C93B2E",
        cancelText: "取消",
        success: resolve,
        fail: reject
      });
    }).catch(() => null);

    if (!confirmRes || !confirmRes.confirm) return;

    this._leavingRoom = true;
    const wasLoading = !!this.data.loading;
    if (!wasLoading) this.setData({ loading: true });

    try {
      const app = getApp();
      const r = await app.apiCall({ path: "/api/rooms/leave", method: "POST", data: {} });
      if (!r || !r.ok) {
        this.toast((r && r.message) || "退出房间失败");
        return;
      }

      wx.showToast({
        title: "已退出房间",
        icon: "success",
        duration: 1200
      });

      // 先更新本地展示，再刷新 me，保证按钮态和后端状态同步。
      this.setData({
        inRoom: false,
        activeRoomCode: "",
        activeRoomRole: "",
        activeRoomIsOwner: false
      });
      await this.bootstrap();
    } catch (err) {
      console.error("首页退出房间失败", err);
      this.toast("退出房间失败，请稍后重试");
    } finally {
      if (!wasLoading) this.setData({ loading: false });
      this._leavingRoom = false;
    }
  },

  /**
   * 主动触发资料弹窗，避免进入首页即要求授权。
   */
  handleOpenProfileModal() {
    this.setData({ showProfileModal: true });
  },

  /**
   * 关闭资料弹窗。保存/上传进行中不允许关闭，避免流程中断。
   */
  handleCloseProfileModal() {
    if (this.data.loading) return;
    this.setData({ showProfileModal: false });
  },

  /**
   * 占位函数：用于弹窗内容区 catchtap，阻止冒泡到遮罩层。
   */
  noop() {},

  /**
   * 退出登录
   * - 调用后端退出接口
   * - 清除全局状态和本地存储
   * - 刷新页面重新初始化
   */
  async handleLogout() {
    try {
      // 显示确认对话框
      const res = await new Promise((resolve, reject) => {
        wx.showModal({
          title: "确认注销",
          content: "注销后需要重新授权登录,确定要退出吗?",
          confirmText: "确定",
          confirmColor: "#ff3b30",
          cancelText: "取消",
          success: resolve,
          fail: reject
        });
      });

      if (!res.confirm) return;

      // 显示加载提示
      wx.showLoading({ title: "注销中...", mask: true });

      // 调用后端注销接口
      const app = getApp();
      const deactivateRes = await app.apiCall({
        path: "/api/auth/deactivate",
        method: "POST"
      });

      // 注意：业务失败也可能是 HTTP 200，需要以 ok 字段为准
      if (!deactivateRes || !deactivateRes.ok) {
        wx.hideLoading();
        wx.showToast({
          title: (deactivateRes && deactivateRes.message) || "注销失败",
          icon: "none"
        });
        return;
      }

      // 清除全局数据
      app.globalData.token = "";
      app.globalData.openId = "";
      app.globalData.user = null;

      // 清除本地存储
      storage.setToken("");
      storage.setOpenId("");

      wx.hideLoading();

      // 提示成功
      wx.showToast({
        title: "已注销账号",
        icon: "success",
        duration: 1500
      });

      // 延迟后刷新页面
      setTimeout(() => {
        // 重新拉起首页，确保页面 data 与授权态全部重置
        wx.reLaunch({ url: "/pages/home/home" });
      }, 1500);

    } catch (err) {
      wx.hideLoading();
      wx.showToast({
        title: (err && err.message) || "注销失败",
        icon: "none"
      });
    }
  },

  /**
   * chooseAvatar：用户选择头像后会返回本地临时路径。
   * 注意：临时路径无法跨设备同步展示，因此需要上传到后端持久化，并保存返回的 avatarPath。
   */
  async handleChooseAvatar(e) {
    const local = String((e && e.detail && e.detail.avatarUrl) || "").trim();
    if (!local) return;

    // 先本地预览，再异步上传
    this.setData(
      {
        draftAvatarLocal: local,
        draftAvatarPath: ""
      },
      () => this.refreshCanSaveProfile()
    );

    // 注意：上传期间需要禁用按钮；但如果此时页面正处于 bootstrap 的 loading，则不抢占它的 loading 状态
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

      // wx.uploadFile 的返回 data 是字符串
      let body = null;
      try {
        body = JSON.parse(String((r && r.data) || ""));
      } catch (err) {
        body = null;
      }

      if (!r || r.statusCode !== 200 || !body || !body.ok || !body.avatarPath) {
        this.toast((body && body.message) || "头像上传失败");
        return;
      }

      this.setData(
        {
          draftAvatarPath: String(body.avatarPath || "").trim()
        },
        () => this.refreshCanSaveProfile()
      );
    } catch (err) {
      console.error("上传头像失败", err);
      this.toast("头像上传失败，请检查网络/后端地址");
    } finally {
      if (!wasLoading) this.setData({ loading: false });
    }
  },

  /**
   * nickname 输入框：用户输入/选择昵称（微信会给出昵称建议）。
   */
  handleNicknameInput(e) {
    const v = String((e && e.detail && e.detail.value) || "").trim();
    this.setData({ draftDisplayName: v }, () => this.refreshCanSaveProfile());
  },

  /**
   * 保存用户资料：把昵称与后端 avatarPath 写入用户档案。
   */
  async handleSaveProfile() {
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
        // 说明：nickNameWx 仅做展示用途；这里沿用用户输入昵称
        data: { displayName, nickNameWx: displayName, avatarUrlWx }
      });

      if (!saveRes || !saveRes.ok) {
        this.toast((saveRes && saveRes.message) || "保存资料失败");
        return;
      }

      // 资料保存成功后先关闭弹窗，再走统一的首页刷新链路。
      this.setData({ showProfileModal: false });
      // 刷新用户档案并继续流程（包含扫码自动加入）
      await this.bootstrap();
    } catch (err) {
      console.error("保存资料失败", err);
      this.toast("保存失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  handleRoomCodeInput(e) {
    const v = String((e && e.detail && e.detail.value) || "")
      .trim()
      .toUpperCase();
    this.setData({ roomCodeInput: v });
    storage.setLastRoomCode(v);
  },

  async handleCreateRoom() {
    if (!this.data.hasProfile) {
      this.toast("请先授权获取头像昵称");
      return;
    }
    if (this.data.inRoom) {
      this.toast("你已在房间中，请先退出当前房间");
      return;
    }

    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const app = getApp();
      const r = await app.apiCall({ path: "/api/rooms/create", method: "POST", data: {} });
      if (!r || !r.ok) {
        this.toast((r && r.message) || "创建失败");
        if (r && r.code === "ALREADY_IN_ROOM") await this.bootstrap();
        return;
      }

      const roomCode = String(r.roomCode || "").trim().toUpperCase();
      // 写入一次性“房主分享引导”标记：仅在创建后首次进入房间时展示。
      storage.setPendingOwnerShareGuideRoom(roomCode);
      wx.switchTab({ url: "/pages/room/room" });
    } catch (err) {
      console.error("创建房间失败", err);
      this.toast("创建失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleJoinRoom() {
    if (!this.data.hasProfile) {
      this.toast("请先授权获取头像昵称");
      return;
    }
    if (this.data.inRoom) {
      this.toast("你已在房间中，请先退出当前房间");
      return;
    }

    const v = validateRoomCode(this.data.roomCodeInput);
    if (!v.ok) {
      this.toast(v.message);
      return;
    }

    await this.joinRoomByCode(v.code);
  },

  async handleScanJoin() {
    if (!this.data.hasProfile) {
      this.toast("请先授权获取头像昵称");
      return;
    }
    if (this.data.inRoom) {
      this.toast("你已在房间中，请先退出当前房间");
      return;
    }

    try {
      const scanRes = await new Promise((resolve, reject) => {
        wx.scanCode({
          scanType: ["qrCode"],
          success: resolve,
          fail: reject
        });
      });

      const code = this.extractRoomCodeFromScan(scanRes);
      if (!code) {
        this.toast("未识别到房间号");
        return;
      }

      this.setData({ roomCodeInput: code });
      storage.setLastRoomCode(code);
      await this.joinRoomByCode(code);
    } catch (err) {
      // 用户取消扫码属于正常场景，不提示报错
    }
  },

  /**
   * 从扫码结果中尽可能提取 roomCode：
   * - 服务端二维码：PLROOM:ROOMCODE
   * - 普通二维码：可能直接是 roomCode / 或带 roomCode|code 参数的链接
   *
   * @param {any} res
   * @returns {string}
   */
  extractRoomCodeFromScan(res) {
    const tryParseFromText = (text) => {
      const s = String(text || "").trim();
      if (!s) return "";

      const mPl = s.match(/^PLROOM:([0-9A-Za-z]{4,12})$/i);
      if (mPl && mPl[1]) return String(mPl[1]).trim().toUpperCase();

      const mRoomCode = s.match(/[?&]roomCode=([^&]+)/i);
      if (mRoomCode && mRoomCode[1]) return decodeURIComponent(mRoomCode[1]).trim().toUpperCase();

      const mCode = s.match(/[?&]code=([^&]+)/);
      if (mCode && mCode[1]) return decodeURIComponent(mCode[1]).trim().toUpperCase();

      // 纯房间号
      if (/^[0-9A-Za-z]{4,12}$/.test(s)) return s.toUpperCase();
      return "";
    };

    const fromPath = tryParseFromText(res && res.path);
    if (fromPath) return fromPath;

    const fromResult = tryParseFromText(res && res.result);
    if (fromResult) return fromResult;

    return "";
  },

  /**
   * 封装加入房间逻辑（自动入房/手动入房共用）。
   * 并发控制说明：
   * - 通过 _joining 防重入，避免重复点击/重复自动触发导致并发请求
   * - 不再使用 data.loading 作为“是否允许 join”的门禁，避免 bootstrap 期间被误拦截
   *
   * @param {string} roomCode
   */
  async joinRoomByCode(roomCode) {
    if (this._joining) return;
    this._joining = true;

    const wasLoading = !!this.data.loading;
    if (!wasLoading) this.setData({ loading: true });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: "/api/rooms/join",
        method: "POST",
        data: { roomCode: String(roomCode || "").trim().toUpperCase() }
      });

      if (!r || !r.ok) {
        this.toast((r && r.message) || "加入失败");
        return;
      }

      this.setData({ pendingRoomCode: "" });
      wx.switchTab({ url: "/pages/room/room" });
    } catch (err) {
      console.error("加入房间失败", err);
      this.toast("加入失败，请稍后重试");
    } finally {
      if (!wasLoading) this.setData({ loading: false });
      this._joining = false;
    }
  },

  /**
   * 兼容兜底：老版本不支持 chooseAvatar 时，仍使用 getUserProfile（必须由按钮点击触发）。
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
        this.toast((saveRes && saveRes.message) || "保存资料失败");
        return;
      }

      // 兼容授权成功后与 chooseAvatar 流程保持一致：关闭弹窗再刷新首页状态。
      this.setData({ showProfileModal: false });
      // 保存成功后按统一路由链路继续（含“已在房间优先 + 邀请自动加入”）。
      await this.bootstrap();
    } catch (err) {
      // 用户拒绝授权属于正常场景，不做硬提示
    } finally {
      this.setData({ loading: false });
    }
  },

  toast(title) {
    wx.showToast({
      title: String(title || ""),
      icon: "none"
    });
  }
});
