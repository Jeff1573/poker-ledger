/**
 * 个人资料页：
 * - 展示微信头像/昵称
 * - 允许仅修改 displayName（展示昵称）
 * - 展示“我参与过的历史记录”，并支持弹窗查看详情
 */
const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");

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
   * 未授权时统一回到首页进行授权。
   * 原因：授权流程已收敛到首页（chooseAvatar + nickname），资料页不再直接调授权接口。
   */
  handleAuth() {
    const pages = getCurrentPages();
    const prevPage = pages.length > 1 ? pages[pages.length - 2] : null;

    // 常见路径：从首页进入资料页，直接返回即可看到首页授权卡片。
    if (prevPage && prevPage.route === "pages/home/home") {
      wx.navigateBack();
      return;
    }

    // 兜底路径：若资料页不是从首页进入，直接跳首页。
    wx.redirectTo({
      url: "/pages/home/home",
      fail: () => {
        wx.reLaunch({ url: "/pages/home/home" });
      }
    });
  }
});
