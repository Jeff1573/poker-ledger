/**
 * 个人资料页：
 * - 展示微信头像/昵称
 * - 允许仅修改 displayName（展示昵称）
 * - 展示“我参与过的历史记录”，并支持弹窗查看详情
 */
const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");
const CONST = require("../../utils/const");

const HISTORY_PAGE_LIMIT = 20;

/**
 * 将整数输赢值格式化为文本（正数带 +）。
 *
 * @param {number} amount
 * @returns {string}
 */
function formatAmountText(amount) {
  const n = Number(amount || 0);
  return n > 0 ? `+${n}` : String(n);
}

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
    canSaveProfile: false,

    historyLoading: false,
    historyError: "",
    historyRows: [],
    historyHasMore: false,
    historyLoadingMore: false,
    historyNextBeforeDissolvedAt: null,
    historyNextBeforeRoomCode: "",

    showHistoryDetail: false,
    historyDetailLoading: false,
    historyDetailTitle: "",
    historyDetailTxCount: 0,
    historyDetailDissolvedAtText: "",
    historyDetailRows: []
  },

  onLoad() {
    const supportChooseAvatar =
      !!wx.canIUse && wx.canIUse("button.open-type.chooseAvatar") && wx.canIUse("input.type.nickname");
    this.setData({ supportChooseAvatar });
  },

  onShow() {
    this.loadProfile();
    this.loadHistoryFirstPage();
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

  /**
   * 将后端历史行映射为前端展示结构。
   *
   * @param {any} item
   */
  mapHistoryRow(item) {
    const roomCode = String((item && item.roomCode) || "").trim().toUpperCase();
    const settlementId = String((item && (item.settlementId || item.roomCode)) || "").trim().toUpperCase();
    const myAmount = Number(item && item.myAmount || 0);
    const dissolvedAt = Number(item && item.dissolvedAt || 0);

    return {
      settlementId,
      roomCode,
      txCount: Number(item && item.txCount || 0),
      dissolvedAt,
      dissolvedAtText: dissolvedAt ? formatTime(dissolvedAt) : "",
      myAmount,
      myAmountText: formatAmountText(myAmount)
    };
  },

  /**
   * 首屏加载历史记录。
   */
  async loadHistoryFirstPage() {
    if (this.data.historyLoading) return;
    this.setData({
      historyLoading: true,
      historyError: "",
      historyRows: [],
      historyHasMore: false,
      historyLoadingMore: false,
      historyNextBeforeDissolvedAt: null,
      historyNextBeforeRoomCode: ""
    });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/history/me?limit=${HISTORY_PAGE_LIMIT}`,
        method: "GET"
      });

      if (!r || !r.ok || !r.history) {
        this.setData({
          historyLoading: false,
          historyError: String((r && r.message) || "历史记录加载失败"),
          historyRows: [],
          historyHasMore: false,
          historyNextBeforeDissolvedAt: null,
          historyNextBeforeRoomCode: ""
        });
        return;
      }

      const history = r.history || {};
      const rows = (history.rows || []).map((item) => this.mapHistoryRow(item));
      this.setData({
        historyLoading: false,
        historyError: "",
        historyRows: rows,
        historyHasMore: !!history.hasMore,
        historyNextBeforeDissolvedAt: history.nextBeforeDissolvedAt || null,
        historyNextBeforeRoomCode: String(history.nextBeforeRoomCode || "")
      });
    } catch (err) {
      console.error("loadHistoryFirstPage 失败", err);
      this.setData({
        historyLoading: false,
        historyError: "历史记录加载失败，请稍后重试",
        historyRows: [],
        historyHasMore: false,
        historyNextBeforeDissolvedAt: null,
        historyNextBeforeRoomCode: ""
      });
    }
  },

  /**
   * 分页加载更多历史记录。
   */
  async handleLoadMoreHistory() {
    if (this.data.historyLoading || this.data.historyLoadingMore) return;
    if (!this.data.historyHasMore) return;

    const beforeDissolvedAt = Number(this.data.historyNextBeforeDissolvedAt || 0);
    const beforeRoomCode = String(this.data.historyNextBeforeRoomCode || "").trim().toUpperCase();
    if (!beforeDissolvedAt || !beforeRoomCode) return;

    this.setData({ historyLoadingMore: true });
    try {
      const app = getApp();
      const r = await app.apiCall({
        path:
          `/api/history/me?limit=${HISTORY_PAGE_LIMIT}` +
          `&beforeDissolvedAt=${beforeDissolvedAt}` +
          `&beforeRoomCode=${encodeURIComponent(beforeRoomCode)}`,
        method: "GET"
      });

      if (!r || !r.ok || !r.history) {
        wx.showToast({ title: (r && r.message) || "加载更多失败", icon: "none" });
        this.setData({ historyLoadingMore: false });
        return;
      }

      const history = r.history || {};
      const moreRows = (history.rows || []).map((item) => this.mapHistoryRow(item));
      const mergedRows = (this.data.historyRows || []).concat(moreRows);

      this.setData({
        historyRows: mergedRows,
        historyHasMore: !!history.hasMore,
        historyNextBeforeDissolvedAt: history.nextBeforeDissolvedAt || null,
        historyNextBeforeRoomCode: String(history.nextBeforeRoomCode || ""),
        historyLoadingMore: false
      });
    } catch (err) {
      console.error("handleLoadMoreHistory 失败", err);
      this.setData({ historyLoadingMore: false });
      wx.showToast({ title: "加载更多失败", icon: "none" });
    }
  },

  /**
   * 历史列表触底：自动续拉下一页。
   */
  handleHistoryReachBottom() {
    this.handleLoadMoreHistory();
  },

  /**
   * 点击历史项：弹窗显示该局完整胜负关系。
   *
   * @param {any} e
   */
  async handleTapHistory(e) {
    const settlementId = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.settlementid) || "")
      .trim()
      .toUpperCase();
    if (!settlementId) return;

    this.setData({
      showHistoryDetail: true,
      historyDetailLoading: true,
      historyDetailTitle: `房间 ${settlementId}`,
      historyDetailTxCount: 0,
      historyDetailDissolvedAtText: "",
      historyDetailRows: []
    });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/history/me/${encodeURIComponent(settlementId)}`,
        method: "GET"
      });

      if (!r || !r.ok || !r.settlement) {
        wx.showToast({ title: (r && r.message) || "历史详情加载失败", icon: "none" });
        this.setData({
          showHistoryDetail: false,
          historyDetailLoading: false
        });
        return;
      }

      const s = r.settlement || {};
      const totals = s.totals || {};
      const members = s.membersSnapshot || [];
      const rows = members.map((m) => {
        const amountRaw = totals[m.openId];
        const amount = Number.isInteger(amountRaw) ? amountRaw : Number(amountRaw || 0);
        return {
          openId: String(m.openId || ""),
          displayName: String(m.displayName || ""),
          avatarUrlResolved: resolveApiAssetUrl(m.avatarUrl),
          role: String(m.role || ""),
          active: !!m.active,
          amount,
          amountText: formatAmountText(amount)
        };
      });

      rows.sort((a, b) => {
        if (a.role === "owner" && b.role !== "owner") return -1;
        if (b.role === "owner" && a.role !== "owner") return 1;
        return Math.abs(b.amount) - Math.abs(a.amount);
      });

      this.setData({
        showHistoryDetail: true,
        historyDetailLoading: false,
        historyDetailTitle: `房间 ${String(s.roomCode || settlementId).trim().toUpperCase()}`,
        historyDetailTxCount: Number(s.txCount || 0),
        historyDetailDissolvedAtText: s.dissolvedAt ? formatTime(s.dissolvedAt) : "",
        historyDetailRows: rows
      });
    } catch (err) {
      console.error("handleTapHistory 失败", err);
      wx.showToast({ title: "历史详情加载失败", icon: "none" });
      this.setData({
        showHistoryDetail: false,
        historyDetailLoading: false
      });
    }
  },

  handleCloseHistoryDetail() {
    this.setData({ showHistoryDetail: false });
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
