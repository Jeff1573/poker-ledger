const CONST = require("../../utils/const");
const { toUnsignedIntText, validateAmount } = require("../../utils/validator");
const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");

/**
 * 房间页职责：
 * - 使用 WebSocket 实时同步房间快照（room/members/txs）
 * - 展示成员横向滑动（房主固定第一个）
 * - 展示总账净输赢
 * - 新增交易（我转给谁多少钱，整数）
 * - 成员退出 / 房主解散
 */
Page({
  data: {
    loading: false,

    roomCode: "",
    role: "",
    roleText: "",
    meOpenId: "",

    room: null,
    members: [],
    totalsRows: [],
    txs: [],
    txRows: [],

    // 点击成员头像转账（弹窗）
    showTransferModal: false,
    transferToOpenId: "",
    transferToName: "",
    transferToAvatarUrl: "",
    transferAmountText: "",
    transferCanSubmit: false,

    // 入房码弹层
    showJoinCode: false,
    joinCodeUrl: ""
  },

  onLoad(options) {
    const roomCode = String((options && options.code) || "").trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: "缺少房间号", icon: "none" });
      wx.redirectTo({ url: "/pages/home/home" });
      return;
    }
    this.setData({ roomCode });
  },

  onShow() {
    this._pageActive = true;
    this.enterRoom();
  },

  onHide() {
    this._pageActive = false;
    this.closeSocket();
  },

  onUnload() {
    this._pageActive = false;
    this.closeSocket();
  },

  noop() {},

  /**
   * 进入房间前做一次访问控制：
   * - 必须存在 /api/rooms/my 映射且 roomCode 匹配
   * - 再建立 WebSocket 订阅，保证“回到房间自动同步”
   */
  async enterRoom() {
    if (this._entering) return;
    this._entering = true;

    try {
      const app = getApp();
      const session = await app.ensureSession();
      this.setData({ meOpenId: session.openId });

      const myRoom = await app.apiCall({ path: "/api/rooms/my", method: "GET" });
      if (!myRoom || !myRoom.ok) {
        this.toast((myRoom && myRoom.message) || "进入房间失败");
        wx.redirectTo({ url: "/pages/home/home" });
        return;
      }
      if (!myRoom.inRoom) {
        this.toast("你不在房间中");
        wx.redirectTo({ url: "/pages/home/home" });
        return;
      }
      if (String(myRoom.roomCode || "").toUpperCase() !== this.data.roomCode) {
        this.toast("你不在该房间中");
        wx.redirectTo({ url: "/pages/home/home" });
        return;
      }

      const roleText = myRoom.role === "owner" ? "房主" : "成员";
      this.setData({ role: myRoom.role, roleText });

      // 1) 建立 WS 订阅（实时同步）
      await this.startSocket();

      // 2) 兜底拉一次快照（防止 WS 因网络问题未及时收到）
      await this.fetchSnapshot();
    } catch (err) {
      console.error("enterRoom 失败", err);
      this.toast("进入房间失败，请检查后端/网络");
      wx.redirectTo({ url: "/pages/home/home" });
    } finally {
      this._entering = false;
    }
  },

  /**
   * HTTP 拉取房间快照（兜底用）。
   */
  async fetchSnapshot() {
    try {
      const app = getApp();
      const r = await app.apiCall({
        path: `/api/rooms/${this.data.roomCode}/snapshot`,
        method: "GET"
      });
      if (r && r.ok) this.applySnapshot(r);
    } catch (err) {
      // 兜底失败不影响 WS 正常工作
    }
  },

  /**
   * 应用房间快照：刷新 room/members/txs，并重建派生 UI 数据。
   *
   * @param {{room:any, members:any[], txs:any[]}} snap
   */
  applySnapshot(snap) {
    // 成员：补全头像 URL，确保 chooseAvatar 上传后的相对路径也能展示
    const members = (snap.members || []).map((m) => ({
      ...m,
      avatarUrlResolved: resolveApiAssetUrl(m && m.avatarUrl)
    }));

    // 交易：补全头像 URL + 格式化时间
    const txs = (snap.txs || []).map((t) => ({
      ...t,
      timeText: formatTime(t.createdAt),
      fromAvatarResolved: resolveApiAssetUrl(t && t.fromAvatar),
      toAvatarResolved: resolveApiAssetUrl(t && t.toAvatar)
    }));

    this.setData(
      {
        room: snap.room || null,
        members,
        txs
      },
      () => {
        this.rebuildTotalsRows();
        this.rebuildTxRows();
      }
    );
  },

  /**
   * 建立 WebSocket 连接并订阅房间。
   */
  async startSocket() {
    this.closeSocket();

    const app = getApp();
    const session = await app.ensureSession();
    const token = session.token;

    const url = `${String(CONST.WS_BASE_URL || "").replace(/\/$/, "")}/ws?token=${encodeURIComponent(token)}`;
    const task = wx.connectSocket({ url });
    this._socket = task;
    this._socketOpen = false;

    task.onOpen(() => {
      this._socketOpen = true;
      this._reconnectAttempt = 0;
      this.sendWs({ type: "subscribe", roomCode: this.data.roomCode });
    });

    task.onMessage((msg) => {
      this.handleWsMessage(msg);
    });

    task.onClose(() => {
      this._socketOpen = false;
      if (this._pageActive) this.scheduleReconnect();
    });

    task.onError((err) => {
      // onError 通常会伴随 onClose，这里只做日志
      console.error("WebSocket 错误", err);
    });
  },

  /**
   * 关闭 WebSocket 与重连定时器。
   */
  closeSocket() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socket) {
      try {
        this._socket.close();
      } catch (err) {
        // ignore
      }
      this._socket = null;
    }
    this._socketOpen = false;
  },

  /**
   * 发送 WS 消息（若未连接则忽略）。
   *
   * @param {any} payload
   */
  sendWs(payload) {
    if (!this._socket || !this._socketOpen) return;
    try {
      this._socket.send({ data: JSON.stringify(payload) });
    } catch (err) {
      // ignore
    }
  },

  /**
   * 解析并处理 WS 消息。
   *
   * @param {{data: any}} msg
   */
  handleWsMessage(msg) {
    let data;
    try {
      data = JSON.parse(String((msg && msg.data) || ""));
    } catch (err) {
      return;
    }
    if (!data || !data.type) return;

    if (data.type === "room_snapshot") {
      this.applySnapshot(data);
      return;
    }

    if (data.type === "room_dissolved") {
      this.handleRoomDissolved(data.settlementId || this.data.roomCode);
      return;
    }

    if (data.type === "error") {
      // 如：订阅失败（你不在该房间中）
      this.toast(data.message || "同步失败");
      if (data.code === "FORBIDDEN" || data.code === "UNAUTHORIZED") {
        wx.redirectTo({ url: "/pages/home/home" });
      }
    }
  },

  /**
   * 简单指数退避重连：1s, 2s, 4s... 上限 10s
   */
  scheduleReconnect() {
    if (this._reconnectTimer) return;
    const attempt = Number(this._reconnectAttempt || 0);
    const delay = Math.min(10000, 1000 * Math.pow(2, attempt));
    this._reconnectAttempt = attempt + 1;

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._pageActive) return;

      // 若期间用户已退出房间，则不再重连
      try {
        const app = getApp();
        const myRoom = await app.apiCall({ path: "/api/rooms/my", method: "GET" });
        if (!myRoom || !myRoom.ok || !myRoom.inRoom || myRoom.roomCode !== this.data.roomCode) {
          wx.redirectTo({ url: "/pages/home/home" });
          return;
        }
      } catch (err) {
        // ignore
      }

      this.startSocket();
    }, delay);
  },

  rebuildTotalsRows() {
    const room = this.data.room || {};
    const totals = (room && room.totals) || {};
    const members = this.data.members || [];

    const memberByOpenId = {};
    for (const m of members) {
      memberByOpenId[m.openId] = m;
    }

    const openIdSet = new Set(Object.keys(totals || {}));
    for (const m of members) openIdSet.add(m.openId);

    const rows = [];
    for (const openId of openIdSet) {
      const m = memberByOpenId[openId];
      const amountRaw = totals && totals[openId];
      const amount = Number.isInteger(amountRaw) ? amountRaw : Number(amountRaw || 0);

      rows.push({
        openId,
        displayName: (m && m.displayName) || "成员",
        avatarUrl: (m && (m.avatarUrlResolved || resolveApiAssetUrl(m.avatarUrl))) || "",
        role: (m && m.role) || "",
        active: m ? !!m.active : false,
        amount,
        amountText: amount > 0 ? `+${amount}` : String(amount)
      });
    }

    // 排序：房主第一，其次 active，最后按昵称
    rows.sort((a, b) => {
      if (a.role === "owner" && b.role !== "owner") return -1;
      if (b.role === "owner" && a.role !== "owner") return 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.displayName || "").localeCompare(String(b.displayName || ""), "zh");
    });

    this.setData({ totalsRows: rows });
  },

  /**
   * 根据当前用户视角生成交易列表：
   * - 只显示「与我相关」的交易
   * - 左侧显示对方头像+昵称
   * - 右侧显示金额：收入为 +（红色），支出为 -（绿色）
   */
  rebuildTxRows() {
    const me = String(this.data.meOpenId || "");
    const txs = this.data.txs || [];

    const rows = [];
    for (const t of txs) {
      if (!t) continue;
      const fromOpenId = String(t.fromOpenId || "");
      const toOpenId = String(t.toOpenId || "");
      if (fromOpenId !== me && toOpenId !== me) continue;

      const isIncome = toOpenId === me;
      const peerOpenId = isIncome ? fromOpenId : toOpenId;
      const peerName = isIncome ? t.fromName : t.toName;
      const peerAvatarUrl = isIncome ? t.fromAvatarResolved : t.toAvatarResolved;

      const rawAmount = Number(t.amount || 0);
      const signedAmount = isIncome ? rawAmount : -rawAmount;

      rows.push({
        id: t.id,
        peerOpenId,
        peerName: String(peerName || "成员"),
        peerAvatarUrl: resolveApiAssetUrl(peerAvatarUrl),
        timeText: String(t.timeText || ""),
        amount: signedAmount,
        amountText: signedAmount > 0 ? `+${signedAmount}` : String(signedAmount),
        amountClass: signedAmount > 0 ? "tx-income" : "tx-expense"
      });
    }

    this.setData({ txRows: rows });
  },

  /**
   * 点击成员头像：打开转账弹窗（我转给 TA）。
   */
  handleTapMember(e) {
    if (this.data.loading) return;

    const openId = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.openid) || "").trim();
    if (!openId) return;
    if (openId === this.data.meOpenId) return;

    const member = (this.data.members || []).find((m) => m && m.openId === openId);
    if (!member) return;
    if (!member.active) {
      this.toast("对方已退出房间");
      return;
    }

    this.setData({
      showTransferModal: true,
      transferToOpenId: openId,
      transferToName: String(member.displayName || "成员"),
      transferToAvatarUrl: String(member.avatarUrlResolved || resolveApiAssetUrl(member.avatarUrl) || ""),
      transferAmountText: "",
      transferCanSubmit: false
    });
  },

  /**
   * 转账金额输入：仅允许整数（用于输入框回显）。
   */
  handleTransferAmountInput(e) {
    const raw = e && e.detail && e.detail.value;
    const transferAmountText = toUnsignedIntText(raw);
    this.setData({ transferAmountText }, () => this.refreshTransferCanSubmit());
  },

  /**
   * 刷新弹窗确认按钮可用状态。
   */
  refreshTransferCanSubmit() {
    const toOpenId = String(this.data.transferToOpenId || "").trim();
    const amount = Number(this.data.transferAmountText);

    const ok =
      !!toOpenId &&
      Number.isInteger(amount) &&
      amount >= CONST.AMOUNT_MIN &&
      amount <= CONST.AMOUNT_MAX;

    this.setData({ transferCanSubmit: ok });
  },

  closeTransferModal() {
    this.setData({
      showTransferModal: false,
      transferToOpenId: "",
      transferToName: "",
      transferToAvatarUrl: "",
      transferAmountText: "",
      transferCanSubmit: false
    });
  },

  /**
   * 确认转账：调用后端写入交易；成功后由 WS 推送刷新列表。
   */
  async confirmTransfer() {
    if (!this.data.transferCanSubmit) return;
    if (this.data.loading) return;

    const toOpenId = String(this.data.transferToOpenId || "").trim();
    const amount = Number(this.data.transferAmountText);
    const v = validateAmount(amount);
    if (!v.ok) {
      this.toast(v.message);
      return;
    }

    this.setData({ loading: true });
    try {
      const app = getApp();
      const r = await app.apiCall({
        path: "/api/txs",
        method: "POST",
        data: { toOpenId, amount: v.amount, note: "" }
      });
      if (!r || !r.ok) {
        this.toast((r && r.message) || "转账失败");
        return;
      }

      this.closeTransferModal();
      wx.showToast({ title: "已记录", icon: "success" });
    } catch (err) {
      console.error("transfer 失败", err);
      this.toast("转账失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  copyRoomCode() {
    wx.setClipboardData({ data: this.data.roomCode });
  },

  async handleShowJoinCode() {
    if (this.data.role !== "owner") return;
    if (this.data.loading) return;

    // 说明：图片资源无法方便携带 Authorization header，因此后端以“公共二维码”方式返回 png
    const base = String(CONST.API_BASE_URL || "").replace(/\/$/, "");
    const joinCodeUrl = `${base}/api/rooms/${this.data.roomCode}/qrcode.png?t=${Date.now()}`;
    this.setData({ joinCodeUrl, showJoinCode: true });
  },

  closeJoinCode() {
    this.setData({ showJoinCode: false });
  },

  async handleLeave() {
    if (this.data.role === "owner") return;
    if (this.data.loading) return;

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: "退出房间",
        content: "退出后将无法继续看到该房间数据，确定退出吗？",
        confirmText: "退出",
        confirmColor: "#FF3B30",
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;

    this.setData({ loading: true });
    try {
      const app = getApp();
      const r = await app.apiCall({ path: "/api/rooms/leave", method: "POST", data: {} });
      if (!r || !r.ok) {
        this.toast((r && r.message) || "退出失败");
        return;
      }

      this.closeSocket();
      wx.redirectTo({ url: "/pages/home/home" });
    } catch (err) {
      console.error("room_leave 失败", err);
      this.toast("退出失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleDissolve() {
    if (this.data.role !== "owner") return;
    if (this.data.loading) return;

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: "解散房间",
        content: "解散后将清空房间数据，并生成本次结算结果（仅房主可查看）。确定解散吗？",
        confirmText: "解散",
        confirmColor: "#FF3B30",
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;

    this.setData({ loading: true });
    try {
      const app = getApp();
      const r = await app.apiCall({ path: "/api/rooms/dissolve", method: "POST", data: {} });
      if (!r || !r.ok) {
        this.toast((r && r.message) || "解散失败");
        return;
      }

      this.closeSocket();
      wx.redirectTo({ url: `/pages/settlement/settlement?roomCode=${r.settlementId || this.data.roomCode}` });
    } catch (err) {
      console.error("room_dissolve 失败", err);
      this.toast("解散失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 房间被解散：按角色跳转。
   *
   * @param {string} settlementId
   */
  handleRoomDissolved(settlementId) {
    if (this._roomGoneHandled) return;
    this._roomGoneHandled = true;

    this.closeSocket();
    if (this.data.role === "owner") {
      wx.redirectTo({ url: `/pages/settlement/settlement?roomCode=${settlementId || this.data.roomCode}` });
      return;
    }

    wx.showModal({
      title: "房间已解散",
      content: "房主已解散房间",
      showCancel: false,
      success: () => wx.redirectTo({ url: "/pages/home/home" })
    });
  },

  toast(title) {
    wx.showToast({
      title: String(title || ""),
      icon: "none"
    });
  }
});
