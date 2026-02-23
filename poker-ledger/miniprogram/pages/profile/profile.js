/**
 * 个人资料页：
 * - 展示微信头像/昵称
 * - 允许仅修改 displayName（展示昵称）
 * - 展示时间线历史（支持 mine/all 筛选）
 */
const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");
const CONST = require("../../utils/const");

const HISTORY_PAGE_LIMIT = 20;
const TIMELINE_PREVIEW_MEMBER_LIMIT = 3;
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
 * 统一输赢颜色 class。
 *
 * @param {number} amount
 * @returns {"plus"|"minus"|"zero"}
 */
function resolveAmountClass(amount) {
  const n = Number(amount || 0);
  if (n > 0) return "plus";
  if (n < 0) return "minus";
  return "zero";
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
    timelineNextBeforeRoomCode: "",
    expandedSettleIds: {}
  },

  onLoad() {
    const supportChooseAvatar =
      !!wx.canIUse && wx.canIUse("button.open-type.chooseAvatar") && wx.canIUse("input.type.nickname");
    // 时间线请求序号：每次首屏刷新递增，用于丢弃过期回包。
    this._timelineReqSeq = 0;
    this.setData({ supportChooseAvatar });
  },

  onShow() {
    this.loadProfile();
    this.loadTimelineFirstPage();
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
        amountText: formatAmountText(amount),
        amountClass: resolveAmountClass(amount)
      };
    });

    const previewMembers = members.slice(0, TIMELINE_PREVIEW_MEMBER_LIMIT);
    const hiddenMemberCount = Math.max(0, members.length - previewMembers.length);

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
      previewMembers,
      hiddenMemberCount
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
      timelineNextBeforeRoomCode: "",
      expandedSettleIds: {}
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
          timelineNextBeforeRoomCode: "",
          expandedSettleIds: {}
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
        timelineNextBeforeRoomCode: String(timeline.nextBeforeRoomCode || ""),
        expandedSettleIds: {}
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
        timelineNextBeforeRoomCode: "",
        expandedSettleIds: {}
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
  },

  /**
   * 展开/收起单局成员明细。
   *
   * @param {any} e
   */
  handleToggleItemExpand(e) {
    const settlementId = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.settlementid) || "")
      .trim()
      .toUpperCase();
    if (!settlementId) return;

    const next = {
      ...(this.data.expandedSettleIds || {})
    };
    next[settlementId] = !next[settlementId];
    this.setData({ expandedSettleIds: next });
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
