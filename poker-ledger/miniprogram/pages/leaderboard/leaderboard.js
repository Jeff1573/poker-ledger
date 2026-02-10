const { resolveApiAssetUrl } = require("../../utils/url");

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

Page({
  data: {
    loading: false,
    errorText: "",
    totalPlayers: 0,
    rows: []
  },

  onShow() {
    this.loadLeaderboard();
  },

  async loadLeaderboard() {
    if (this.data.loading) return;
    this.setData({ loading: true, errorText: "" });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: "/api/leaderboard?limit=100",
        method: "GET"
      });
      if (!r || !r.ok || !r.leaderboard) {
        this.setData({
          loading: false,
          errorText: String((r && r.message) || "加载排行榜失败"),
          totalPlayers: 0,
          rows: []
        });
        return;
      }

      const payload = r.leaderboard || {};
      const rows = (payload.rows || []).map((item) => {
        const netProfit = Number(item.netProfit || 0);
        return {
          rank: Number(item.rank || 0),
          openId: String(item.openId || ""),
          displayName: String(item.displayName || "成员"),
          avatarUrlResolved: resolveApiAssetUrl(item.avatarUrl),
          winRateText: formatWinRateText(item.winRate),
          winCount: Number(item.winCount || 0),
          lossCount: Number(item.lossCount || 0),
          drawCount: Number(item.drawCount || 0),
          matchCount: Number(item.matchCount || 0),
          netProfit,
          netProfitText: netProfit > 0 ? `+${netProfit}` : String(netProfit)
        };
      });

      this.setData({
        totalPlayers: Number(payload.totalPlayers || 0),
        rows,
        loading: false,
        errorText: ""
      });
    } catch (err) {
      console.error("loadLeaderboard 失败", err);
      this.setData({
        loading: false,
        errorText: "网络异常，请稍后重试",
        totalPlayers: 0,
        rows: []
      });
    }
  },

  retryLoad() {
    this.loadLeaderboard();
  }
});
