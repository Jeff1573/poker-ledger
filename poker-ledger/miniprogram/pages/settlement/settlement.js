const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");

/**
 * 结算页：
 * - 仅房主可查看（由后端鉴权）
 * - 展示解散时的成员快照与净输赢
 */
Page({
  data: {
    loading: false,
    roomCode: "",
    txCount: 0,
    dissolvedAtText: "",
    rows: []
  },

  onLoad(options) {
    const roomCode = String((options && options.roomCode) || "").trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: "缺少结算ID", icon: "none" });
      wx.redirectTo({ url: "/pages/home/home" });
      return;
    }

    this.setData({ roomCode }, () => this.loadSettlement());
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

  goHome() {
    wx.redirectTo({ url: "/pages/home/home" });
  }
});
