const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");
const LEADERBOARD_PREVIEW_LIMIT = 10;

/**
 * 将胜率格式化为百分比文本。
 *
 * @param {any} v
 * @returns {string}
 */
function formatWinRateText(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return "0.0%";
  const pct = Math.max(0, Math.min(1, n)) * 100;
  return `${pct.toFixed(1)}%`;
}

/**
 * 结算页：
 * - 仅房主可查看（由后端鉴权）
 * - 展示解散时的成员快照与净输赢
 * - 展示全局排行榜 Top 10 预览
 */
Page({
  data: {
    loading: false,
    roomCode: "",
    txCount: 0,
    dissolvedAtText: "",
    rows: [],

    leaderboardLoading: false,
    leaderboardError: "",
    leaderboardRows: []
  },

  onLoad(options) {
    const roomCode = String((options && options.roomCode) || "").trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: "缺少结算ID", icon: "none" });
      wx.switchTab({ url: "/pages/home/home" });
      return;
    }

    this.setData({ roomCode }, () => {
      this.loadSettlement();
      this.loadLeaderboardPreview();
    });
  },

  async loadSettlement() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/settlements/${this.data.roomCode}`,
        method: "GET"
      });

      const s = r && r.settlement;
      if (!s) {
        wx.showToast({ title: (r && r.message) || "结算不存在或无权限", icon: "none" });
        return;
      }

      const totals = (s && s.totals) || {};
      const members = (s && s.membersSnapshot) || [];

      const rows = members.map((m) => {
        const amountRaw = totals[m.openId];
        const amount = Number.isInteger(amountRaw) ? amountRaw : Number(amountRaw || 0);
        return {
          openId: m.openId,
          displayName: m.displayName,
          avatarUrl: resolveApiAssetUrl(m.avatarUrl),
          role: m.role,
          active: m.active,
          amount,
          amountText: amount > 0 ? `+${amount}` : String(amount)
        };
      });

      rows.sort((a, b) => {
        if (a.role === "owner" && b.role !== "owner") return -1;
        if (b.role === "owner" && a.role !== "owner") return 1;
        // 其余按输赢绝对值从大到小，便于快速查看
        return Math.abs(b.amount) - Math.abs(a.amount);
      });

      this.setData({
        txCount: Number(s.txCount || 0),
        dissolvedAtText: s.dissolvedAt ? formatTime(s.dissolvedAt) : "",
        rows
      });
    } catch (err) {
      console.error("loadSettlement 失败", err);
      wx.showToast({ title: "加载失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadLeaderboardPreview() {
    if (this.data.leaderboardLoading) return;
    this.setData({
      leaderboardLoading: true,
      leaderboardError: ""
    });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/leaderboard?limit=${LEADERBOARD_PREVIEW_LIMIT}`,
        method: "GET"
      });

      if (!r || !r.ok || !r.leaderboard) {
        this.setData({
          leaderboardRows: [],
          leaderboardLoading: false,
          leaderboardError: String((r && r.message) || "排行榜加载失败")
        });
        return;
      }

      // 防御性裁剪：即使后端返回超过 10 条，这里也只展示 Top 10。
      const rows = (r.leaderboard.rows || []).slice(0, LEADERBOARD_PREVIEW_LIMIT).map((item) => {
        const netProfit = Number(item.netProfit || 0);
        return {
          rank: Number(item.rank || 0),
          openId: String(item.openId || ""),
          displayName: String(item.displayName || "成员"),
          avatarUrl: resolveApiAssetUrl(item.avatarUrl),
          winRateText: formatWinRateText(item.winRate),
          netProfit,
          netProfitText: netProfit > 0 ? `+${netProfit}` : String(netProfit),
          winCount: Number(item.winCount || 0),
          lossCount: Number(item.lossCount || 0),
          drawCount: Number(item.drawCount || 0)
        };
      });

      this.setData({
        leaderboardRows: rows,
        leaderboardLoading: false,
        leaderboardError: ""
      });
    } catch (err) {
      console.error("loadLeaderboardPreview 失败", err);
      this.setData({
        leaderboardRows: [],
        leaderboardLoading: false,
        leaderboardError: "排行榜加载失败，请稍后重试"
      });
    }
  },

  goLeaderboard() {
    wx.navigateTo({ url: "/pages/leaderboard/leaderboard" });
  },

  goHome() {
    wx.switchTab({ url: "/pages/home/home" });
  }
});
