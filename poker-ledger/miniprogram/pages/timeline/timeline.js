const { formatTime } = require("../../utils/format");

const HISTORY_PAGE_LIMIT = 20;
const TIMELINE_SCOPE_OPTIONS = [
  { label: "与我相关", value: "mine" },
  { label: "全部", value: "all" }
];

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

/**
 * 根据选择器下标解析时间线 scope。
 *
 * @param {number} index
 * @returns {"mine"|"all"}
 */
function resolveTimelineScopeByIndex(index) {
  const idx = Number(index || 0);
  const opt = TIMELINE_SCOPE_OPTIONS[idx];
  return opt && opt.value === "all" ? "all" : "mine";
}

/**
 * 按状态构造右侧主指标文案。
 *
 * @param {string} status
 * @param {number|null} amount
 * @returns {string}
 */
function buildTimelineStatusText(status, amount) {
  const n = Number(amount || 0);
  if (status === "win") return `赢 ${Math.abs(n)}`;
  if (status === "loss") return `输 ${Math.abs(n)}`;
  if (status === "draw") return "平 0";
  return "未参与";
}

/**
 * 生成成员输赢摘要文本。
 *
 * 示例：张三(+10)，李四(-5)
 *
 * @param {{displayName:string, amountText:string}[]} members
 * @returns {string}
 */
function buildMembersDigestText(members) {
  const rows = Array.isArray(members) ? members : [];
  if (rows.length === 0) return "暂无成员输赢数据";
  return rows.map((m) => `${String(m.displayName || "成员")}(${String(m.amountText || "0")})`).join("，");
}

Page({
  data: {
    scheduleScopeIndex: 0,
    scopeOptions: TIMELINE_SCOPE_OPTIONS.map((x) => x.label),
    currentScopeLabel: TIMELINE_SCOPE_OPTIONS[0].label,

    timelineLoading: false,
    timelineError: "",
    timelineRows: [],
    timelineGroups: [],
    timelineHasMore: false,
    timelineLoadingMore: false,
    timelineNextBeforeDissolvedAt: null,
    timelineNextBeforeRoomCode: ""
  },

  onLoad() {
    // 时间线请求序号：每次首屏刷新递增，用于丢弃过期回包。
    this._timelineReqSeq = 0;
  },

  onShow() {
    this.loadTimelineFirstPage();
  },

  /**
   * 获取当前 scope 值。
   *
   * @returns {"mine"|"all"}
   */
  getCurrentTimelineScope() {
    return resolveTimelineScopeByIndex(this.data.scheduleScopeIndex);
  },

  /**
   * 将后端时间线行映射为前端展示结构。
   *
   * @param {any} item
   */
  mapTimelineRow(item) {
    const roomCode = String((item && item.roomCode) || "").trim().toUpperCase();
    const settlementId = String((item && (item.settlementId || item.roomCode)) || "").trim().toUpperCase();
    const dissolvedAt = Number((item && item.dissolvedAt) || 0);

    const hasMyAmount = !!(item && Object.prototype.hasOwnProperty.call(item, "myAmount"));
    const myAmountRaw = hasMyAmount ? item.myAmount : null;
    const myAmount = myAmountRaw === null || myAmountRaw === undefined ? null : Number(myAmountRaw || 0);

    let myStatus = String((item && item.myStatus) || "").trim().toLowerCase();
    if (myStatus !== "win" && myStatus !== "loss" && myStatus !== "draw" && myStatus !== "not_joined") {
      if (myAmount === null) myStatus = "not_joined";
      else if (myAmount > 0) myStatus = "win";
      else if (myAmount < 0) myStatus = "loss";
      else myStatus = "draw";
    }

    const members = (Array.isArray(item && item.members) ? item.members : []).map((m) => {
      const amount = Number((m && m.amount) || 0);
      return {
        openId: String((m && m.openId) || ""),
        displayName: String((m && m.displayName) || "成员"),
        role: String((m && m.role) || ""),
        active: !!(m && m.active),
        amount,
        amountText: formatAmountText(amount)
      };
    });

    return {
      settlementId,
      roomCode,
      dissolvedAt,
      dissolvedAtText: dissolvedAt ? formatTime(dissolvedAt) : "",
      txCount: Number((item && item.txCount) || 0),
      memberCount: Number((item && item.memberCount) || members.length),
      myAmount,
      myStatus,
      statusText: buildTimelineStatusText(myStatus, myAmount),
      statusClass: `status-${myStatus}`,
      members,
      membersDigestText: buildMembersDigestText(members)
    };
  },

  /**
   * 按年份分组时间线，保持接口返回顺序（默认倒序）。
   *
   * @param {any[]} rows
   * @returns {{year:string, rows:any[]}[]}
   */
  buildTimelineGroupsByYear(rows) {
    const src = Array.isArray(rows) ? rows : [];
    const groups = [];

    for (const row of src) {
      const ts = Number((row && row.dissolvedAt) || 0);
      const year = ts > 0 ? String(new Date(ts).getFullYear()) : "未知";
      const last = groups[groups.length - 1];
      if (!last || last.year !== year) {
        groups.push({ year, rows: [row] });
      } else {
        last.rows.push(row);
      }
    }

    return groups;
  },

  /**
   * 首屏加载时间线。
   */
  async loadTimelineFirstPage() {
    const scope = this.getCurrentTimelineScope();
    const reqSeq = Number(this._timelineReqSeq || 0) + 1;
    this._timelineReqSeq = reqSeq;
    this.setData({
      timelineLoading: true,
      timelineError: "",
      timelineRows: [],
      timelineGroups: [],
      timelineHasMore: false,
      timelineLoadingMore: false,
      timelineNextBeforeDissolvedAt: null,
      timelineNextBeforeRoomCode: ""
    });

    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/history/timeline?scope=${scope}&limit=${HISTORY_PAGE_LIMIT}`,
        method: "GET"
      });
      // 若期间已触发更新请求（如切换 scope），则丢弃旧回包。
      if (reqSeq !== Number(this._timelineReqSeq || 0)) return;

      if (!r || !r.ok || !r.timeline) {
        this.setData({
          timelineLoading: false,
          timelineError: String((r && r.message) || "时间线加载失败"),
          timelineRows: [],
          timelineGroups: [],
          timelineHasMore: false,
          timelineNextBeforeDissolvedAt: null,
          timelineNextBeforeRoomCode: ""
        });
        return;
      }

      const timeline = r.timeline || {};
      const rows = (timeline.rows || []).map((item) => this.mapTimelineRow(item));
      this.setData({
        timelineLoading: false,
        timelineError: "",
        timelineRows: rows,
        timelineGroups: this.buildTimelineGroupsByYear(rows),
        timelineHasMore: !!timeline.hasMore,
        timelineNextBeforeDissolvedAt: timeline.nextBeforeDissolvedAt || null,
        timelineNextBeforeRoomCode: String(timeline.nextBeforeRoomCode || "")
      });
    } catch (err) {
      console.error("loadTimelineFirstPage 失败", err);
      if (reqSeq !== Number(this._timelineReqSeq || 0)) return;
      this.setData({
        timelineLoading: false,
        timelineError: "时间线加载失败，请稍后重试",
        timelineRows: [],
        timelineGroups: [],
        timelineHasMore: false,
        timelineNextBeforeDissolvedAt: null,
        timelineNextBeforeRoomCode: ""
      });
    }
  },

  /**
   * 分页加载更多时间线。
   */
  async loadTimelineMore() {
    if (this.data.timelineLoading || this.data.timelineLoadingMore) return;
    if (!this.data.timelineHasMore) return;

    const beforeDissolvedAt = Number(this.data.timelineNextBeforeDissolvedAt || 0);
    const beforeRoomCode = String(this.data.timelineNextBeforeRoomCode || "").trim().toUpperCase();
    if (!beforeDissolvedAt || !beforeRoomCode) return;

    const scope = this.getCurrentTimelineScope();
    const reqSeq = Number(this._timelineReqSeq || 0);

    this.setData({ timelineLoadingMore: true });
    try {
      const app = getApp();
      const r = await app.apiCall({
        path:
          `/api/history/timeline?scope=${scope}&limit=${HISTORY_PAGE_LIMIT}` +
          `&beforeDissolvedAt=${beforeDissolvedAt}` +
          `&beforeRoomCode=${encodeURIComponent(beforeRoomCode)}`,
        method: "GET"
      });
      // 首屏已刷新或 scope 已切换时，忽略旧分页回包，避免数据串页。
      if (reqSeq !== Number(this._timelineReqSeq || 0) || scope !== this.getCurrentTimelineScope()) {
        this.setData({ timelineLoadingMore: false });
        return;
      }

      if (!r || !r.ok || !r.timeline) {
        wx.showToast({ title: (r && r.message) || "加载更多失败", icon: "none" });
        this.setData({ timelineLoadingMore: false });
        return;
      }

      const timeline = r.timeline || {};
      const moreRows = (timeline.rows || []).map((item) => this.mapTimelineRow(item));
      const mergedRows = (this.data.timelineRows || []).concat(moreRows);

      this.setData({
        timelineRows: mergedRows,
        timelineGroups: this.buildTimelineGroupsByYear(mergedRows),
        timelineHasMore: !!timeline.hasMore,
        timelineNextBeforeDissolvedAt: timeline.nextBeforeDissolvedAt || null,
        timelineNextBeforeRoomCode: String(timeline.nextBeforeRoomCode || ""),
        timelineLoadingMore: false
      });
    } catch (err) {
      console.error("loadTimelineMore 失败", err);
      this.setData({ timelineLoadingMore: false });
      wx.showToast({ title: "加载更多失败", icon: "none" });
    }
  },

  /**
   * 时间线触底：自动续拉下一页。
   */
  handleTimelineReachBottom() {
    this.loadTimelineMore();
  },

  /**
   * 切换时间线筛选（与我相关 / 全部）。
   *
   * @param {any} e
   */
  handleScopeChange(e) {
    const nextIndex = Number((e && e.detail && e.detail.value) || 0);
    if (!Number.isInteger(nextIndex)) return;
    if (nextIndex === this.data.scheduleScopeIndex) return;

    this.setData(
      {
        scheduleScopeIndex: nextIndex,
        currentScopeLabel: this.data.scopeOptions[nextIndex] || TIMELINE_SCOPE_OPTIONS[0].label
      },
      () => this.loadTimelineFirstPage()
    );
  }
});
