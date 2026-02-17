const CONST = require("../../utils/const");
const { toUnsignedIntText, validateAmount } = require("../../utils/validator");
const { formatTime } = require("../../utils/format");
const { resolveApiAssetUrl } = require("../../utils/url");
const storage = require("../../utils/storage");
const log = require("../../utils/log");

const TX_PAGE_SIZE = 100;
const TX_FRONT_SOFT_LIMIT = 500;
const VALID_MINICODE_ENV_VERSIONS = new Set(["develop", "trial", "release"]);

/**
 * 获取当前小程序环境版本（develop / trial / release）。
 *
 * @returns {"develop"|"trial"|"release"}
 */
function getCurrentMiniEnvVersion() {
  try {
    const info = typeof wx.getAccountInfoSync === "function" ? wx.getAccountInfoSync() : null;
    const envVersion = String((((info || {}).miniProgram || {}).envVersion) || "").trim().toLowerCase();
    if (VALID_MINICODE_ENV_VERSIONS.has(envVersion)) {
      return envVersion;
    }
  } catch (err) {
    // ignore
  }
  return "release";
}

/**
 * 交易排序：时间倒序；同毫秒下按 id 倒序，确保分页边界稳定。
 *
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function compareTxDesc(a, b) {
  const aCreatedAt = Number((a && a.createdAt) || 0);
  const bCreatedAt = Number((b && b.createdAt) || 0);
  if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;
  return String((b && b.id) || "").localeCompare(String((a && a.id) || ""));
}

/**
 * 统一交易对象格式，补全展示字段，避免多处重复拼装。
 *
 * @param {any} tx
 * @returns {any|null}
 */
function normalizeTxForView(tx) {
  if (!tx) return null;
  const id = String(tx.id || "").trim();
  if (!id) return null;
  const createdAt = Number(tx.createdAt || 0);
  return {
    ...tx,
    id,
    createdAt,
    timeText: formatTime(createdAt),
    fromAvatarResolved: resolveApiAssetUrl(tx && tx.fromAvatar),
    toAvatarResolved: resolveApiAssetUrl(tx && tx.toAvatar)
  };
}

/**
 * 合并两批交易并按 id 去重。
 * - primary 优先：同 id 时保留 primary 的对象。
 * - 最终统一按时间倒序，且限制前端软上限，避免长局内存持续增长。
 *
 * @param {any[]} primary
 * @param {any[]} secondary
 * @returns {any[]}
 */
function mergeTxList(primary, secondary) {
  const idSet = new Set();
  const merged = [];

  const consume = (list) => {
    const arr = Array.isArray(list) ? list : [];
    for (const item of arr) {
      const tx = normalizeTxForView(item);
      if (!tx) continue;
      if (idSet.has(tx.id)) continue;
      idSet.add(tx.id);
      merged.push(tx);
    }
  };

  consume(primary);
  consume(secondary);

  merged.sort(compareTxDesc);
  return merged.slice(0, TX_FRONT_SOFT_LIMIT);
}

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
    viewState: "loading",

    roomCode: "",
    showShareGuide: false,
    ownerGuideShown: false,
    role: "",
    roleText: "",
    meOpenId: "",

    room: null,
    members: [],
    totalsRows: [],
    txs: [],
    txRows: [],
    txHasMore: false,
    txLoadingMore: false,
    txLoadError: "",
    txCursorCreatedAt: 0,
    txCursorId: "",
    txScrollIntoView: "",

    // 点击成员头像转账（弹窗）
    showTransferModal: false,
    transferToOpenId: "",
    transferToName: "",
    transferToAvatarUrl: "",
    transferAmountText: "",
    transferCanSubmit: false,

    // 入房码弹层
    showJoinCode: false,
    joinCodeUrl: "",
    joinCodeLoadError: false
  },

  onLoad() {
    this.setData({ viewState: "loading" });
  },

  onShow() {
    this._pageActive = true;
    // 房间内允许“发送给朋友”，失败时静默降级（低版本基础库可能不支持）。
    try {
      wx.showShareMenu({
        menus: ["shareAppMessage"],
        fail: () => {}
      });
    } catch (err) {
      // ignore
    }
    this.bootstrapRoomTab();
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
   * 空态按钮：统一回到首页 tab。
   */
  handleGoHomeTab() {
    this.switchToHomeTab();
  },

  /**
   * 切换到首页 tab，失败时兜底 reLaunch。
   */
  switchToHomeTab() {
    wx.switchTab({
      url: "/pages/home/home",
      fail: () => {
        wx.reLaunch({ url: "/pages/home/home" });
      }
    });
  },

  /**
   * 应用房间 tab 空态，并清理房间态相关数据与连接。
   *
   * @param {"loading"|"no_profile"|"no_room"} viewState
   */
  applyIdleState(viewState) {
    this._joinCodeReqVersion = Number(this._joinCodeReqVersion || 0) + 1;
    this.closeSocket();
    this._roomGoneHandled = false;
    this.setData({
      viewState,
      roomCode: "",
      showShareGuide: false,
      ownerGuideShown: false,
      role: "",
      roleText: "",
      room: null,
      members: [],
      totalsRows: [],
      txs: [],
      txRows: [],
      txHasMore: false,
      txLoadingMore: false,
      txLoadError: "",
      txCursorCreatedAt: 0,
      txCursorId: "",
      txScrollIntoView: "",
      showTransferModal: false,
      transferToOpenId: "",
      transferToName: "",
      transferToAvatarUrl: "",
      transferAmountText: "",
      transferCanSubmit: false,
      showJoinCode: false,
      joinCodeUrl: "",
      joinCodeLoadError: false
    });
  },

  /**
   * 进入“未授权资料”视图。
   */
  applyNoProfileState() {
    this.applyIdleState("no_profile");
  },

  /**
   * 进入“未在房间”视图。
   */
  applyNoRoomState() {
    this.applyIdleState("no_room");
  },

  /**
   * room tab 启动入口：
   * 1) 先根据 /api/me 判定资料状态与在房状态
   * 2) 仅在 inRoom 时进入实时同步链路（WS + snapshot）
   */
  async bootstrapRoomTab() {
    if (this._bootstrapping) return;
    this._bootstrapping = true;
    const hasRoomViewCache =
      this.data.viewState === "in_room" &&
      !!String(this.data.roomCode || "").trim();
    // tabBar 切回 room 时优先保留已渲染内容，避免先回到 loading 造成视觉闪烁。
    this.setData(
      hasRoomViewCache
        ? {
            loading: true
          }
        : {
            loading: true,
            viewState: "loading"
          }
    );

    try {
      const app = getApp();
      const session = await app.ensureSession();
      this.setData({ meOpenId: session.openId });

      const me = await app.loadMe();
      if (!me || !me.ok) {
        this.toast((me && me.message) || "房间状态初始化失败");
        this.applyNoRoomState();
        return;
      }

      const user = me.user || null;
      const hasProfile = !!(user && user.displayName && user.avatarUrlWx);
      if (!hasProfile) {
        this.applyNoProfileState();
        return;
      }

      const roomCode = String(me.roomCode || "").trim().toUpperCase();
      if (!me.inRoom || !roomCode) {
        this.applyNoRoomState();
        return;
      }

      this.setData({
        viewState: "in_room",
        roomCode
      });
      await this.enterRoom(roomCode);
    } catch (err) {
      log.error("room.bootstrap.fail", "房间 tab 初始化失败", {
        errMsg: String((err && err.message) || err || "")
      });
      this.toast("房间初始化失败，请稍后重试");
      this.applyNoRoomState();
    } finally {
      this.setData({ loading: false });
      this._bootstrapping = false;
    }
  },

  /**
   * 进入房间前做一次访问控制：
   * - 必须存在 /api/rooms/my 映射且 roomCode 匹配
   * - 再建立 WebSocket 订阅，保证“回到房间自动同步”
   *
   * @param {string} expectedRoomCode
   */
  async enterRoom(expectedRoomCode) {
    if (this._entering) return;
    const roomCode = String(expectedRoomCode || this.data.roomCode || "").trim().toUpperCase();
    if (!roomCode) {
      this.applyNoRoomState();
      return;
    }

    this._entering = true;
    log.info("room.enter.start", "开始进入房间", {
      roomCodeMasked: log.maskRoomCode(roomCode)
    });

    try {
      const app = getApp();
      const session = await app.ensureSession();
      this.setData({ meOpenId: session.openId });
      log.debug("room.enter.session_ready", "登录态准备完成", {
        openIdMasked: log.maskOpenId(session.openId)
      });

      const myRoom = await app.apiCall({ path: "/api/rooms/my", method: "GET" });
      if (!myRoom || !myRoom.ok) {
        this.toast((myRoom && myRoom.message) || "进入房间失败");
        this.applyNoRoomState();
        return;
      }
      if (!myRoom.inRoom) {
        this.applyNoRoomState();
        return;
      }
      const myRoomCode = String(myRoom.roomCode || "").trim().toUpperCase();
      if (!myRoomCode || myRoomCode !== roomCode) {
        this.applyNoRoomState();
        return;
      }

      const roleText = myRoom.role === "owner" ? "房主" : "成员";
      // 引导弹层只允许“创建后首次进入房间”展示一次，避免重进小程序重复弹出。
      const shouldShowShareGuide =
        myRoom.role === "owner" &&
        !this.data.ownerGuideShown &&
        storage.consumePendingOwnerShareGuideRoom(myRoomCode);

      this._roomGoneHandled = false;
      this.setData({
        viewState: "in_room",
        roomCode: myRoomCode,
        role: myRoom.role,
        roleText,
        showShareGuide: shouldShowShareGuide,
        ownerGuideShown: this.data.ownerGuideShown || shouldShowShareGuide
      });

      // 1) 建立 WS 订阅（实时同步）
      await this.startSocket();

      // 2) 兜底拉一次快照（防止 WS 因网络问题未及时收到）
      await this.fetchSnapshot();
      log.info("room.enter.success", "进入房间成功", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode)
      });
    } catch (err) {
      console.error("enterRoom 失败", err);
      log.error("room.enter.fail", "进入房间失败", {
        roomCodeMasked: log.maskRoomCode(roomCode),
        errMsg: String((err && err.message) || err || "")
      });
      this.toast("进入房间失败，请检查后端/网络");
      this.applyNoRoomState();
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
      if (r && r.ok) {
        this.applySnapshot(r);
        log.debug("room.snapshot.ok", "房间快照同步完成", {
          roomCodeMasked: log.maskRoomCode(this.data.roomCode),
          memberCount: Array.isArray(r.members) ? r.members.length : 0,
          txCount: Array.isArray(r.txs) ? r.txs.length : 0
        });
      } else {
        log.warn("room.snapshot.biz_fail", "房间快照业务失败", {
          roomCodeMasked: log.maskRoomCode(this.data.roomCode),
          code: String((r && r.code) || ""),
          message: String((r && r.message) || "")
        });
      }
    } catch (err) {
      // 兜底失败不影响 WS 正常工作
      log.warn("room.snapshot.fail", "房间快照请求失败", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        errMsg: String((err && err.message) || err || "")
      });
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

    // 交易：快照只保证“最新窗口”，与本地已加载历史做合并去重。
    const snapshotTxs = (snap.txs || []).map((t) => normalizeTxForView(t)).filter((t) => !!t);
    const prevTxs = this.data.txs || [];
    const prevTopTxId = String((prevTxs[0] && prevTxs[0].id) || "").trim();
    const txs = mergeTxList(snapshotTxs, prevTxs);
    const nextTopTxId = String((txs[0] && txs[0].id) || "").trim();
    const shouldScrollToTop = !!nextTopTxId && nextTopTxId !== prevTopTxId;

    // 若本地已加载过更多历史，保持当前翻页游标，避免被快照回退到“最新 100”。
    const keepExistingPaging = prevTxs.length > snapshotTxs.length;
    const nextHasMoreRaw = !!snap.txHasMore;
    const nextCursorCreatedAtRaw = Number(snap.txNextBeforeCreatedAt || 0);
    const nextCursorIdRaw = String(snap.txNextBeforeId || "");
    const nextHasMoreFromSnapshot = nextHasMoreRaw && nextCursorCreatedAtRaw > 0 && !!nextCursorIdRaw;

    const existedHasMoreRaw = !!this.data.txHasMore;
    const existedCursorCreatedAtRaw = Number(this.data.txCursorCreatedAt || 0);
    const existedCursorIdRaw = String(this.data.txCursorId || "");
    const existedHasMore = existedHasMoreRaw && existedCursorCreatedAtRaw > 0 && !!existedCursorIdRaw;

    const txHasMore = keepExistingPaging ? existedHasMore : nextHasMoreFromSnapshot;
    const txCursorCreatedAt = txHasMore
      ? (keepExistingPaging ? existedCursorCreatedAtRaw : nextCursorCreatedAtRaw)
      : 0;
    const txCursorId = txHasMore
      ? (keepExistingPaging ? existedCursorIdRaw : nextCursorIdRaw)
      : "";

    this.setData(
      {
        room: snap.room || null,
        members,
        txs,
        txHasMore,
        txLoadingMore: false,
        txLoadError: "",
        txCursorCreatedAt,
        txCursorId
      },
      () => {
        this.enrichMembersWithAmount();
        this.rebuildTotalsRows();
        this.rebuildTxRows(() => {
          if (shouldScrollToTop) {
            this.scrollTxListToTop();
          }
        });
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

    const wsBase = String(CONST.WS_BASE_URL || "").replace(/\/$/, "");
    const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;
    // 仅打印脱敏后的连接地址，便于真机排查“到底连到了哪个域名/路径”。
    const wsUrlMasked = `${wsBase}/ws?token=${encodeURIComponent(log.maskToken(token) || "******")}`;
    log.info("ws.connect.start", "开始建立 WebSocket 连接", {
      roomCodeMasked: log.maskRoomCode(this.data.roomCode),
      tokenMasked: log.maskToken(token),
      wsUrlMasked
    });
    const task = wx.connectSocket({ url });
    this._socket = task;
    this._socketOpen = false;

    task.onOpen(() => {
      this._socketOpen = true;
      this._reconnectAttempt = 0;
      log.info("ws.connect.open", "WebSocket 已连接", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode)
      });
      this.sendWs({ type: "subscribe", roomCode: this.data.roomCode });
    });

    task.onMessage((msg) => {
      this.handleWsMessage(msg);
    });

    task.onClose((event) => {
      this._socketOpen = false;
      log.warn("ws.connect.close", "WebSocket 已关闭", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        code: Number((event && event.code) || 0),
        reason: String((event && event.reason) || "")
      });
      if (this._pageActive) this.scheduleReconnect();
    });

    task.onError((err) => {
      // onError 通常会伴随 onClose，这里只做日志
      console.error("WebSocket 错误", err);
      log.error("ws.connect.error", "WebSocket 连接异常", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        errMsg: String((err && err.errMsg) || "")
      });
    });
  },

  /**
   * 关闭 WebSocket 与重连定时器。
   */
  closeSocket() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      log.debug("ws.reconnect.cancel", "已取消重连定时器");
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
    if (!this._socket || !this._socketOpen) {
      log.debug("ws.send.skip", "WebSocket 未连接，忽略发送", {
        type: String(payload && payload.type || "")
      });
      return;
    }
    const type = String((payload && payload.type) || "");
    log.debug("ws.send", "发送 WebSocket 消息", { type });
    try {
      this._socket.send({ data: JSON.stringify(payload) });
    } catch (err) {
      // ignore
      log.warn("ws.send.fail", "发送 WebSocket 消息失败", {
        type,
        errMsg: String((err && err.message) || err || "")
      });
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
    const type = String(data.type || "");
    log.debug("ws.recv", "收到 WebSocket 消息", {
      type,
      roomCodeMasked: log.maskRoomCode(this.data.roomCode),
      memberCount: type === "room_snapshot" && Array.isArray(data.members) ? data.members.length : undefined,
      txCount: type === "room_snapshot" && Array.isArray(data.txs) ? data.txs.length : undefined
    });

    // 增量推送：新增交易
    if (data.type === "tx_added") {
      this.handleTxAdded(data.tx, data.totals);
      return;
    }

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
        this.applyNoRoomState();
      }
    }
  },

  /**
   * 处理增量推送的新交易
   *
   * @param {object} tx - 新交易对象
   * @param {object} totals - 更新后的总账
   */
  handleTxAdded(tx, totals) {
    if (!tx || !totals) return;

    // 1. 格式化新交易（与 applySnapshot 中的处理保持一致）
    const newTx = normalizeTxForView(tx);
    if (!newTx) return;

    // 2. 将新交易插入列表，并做去重 + 前端软上限控制（500 条）
    const txs = mergeTxList([newTx], this.data.txs || []);

    // 3. 更新房间总账
    const room = this.data.room || {};
    const updatedRoom = {
      ...room,
      totals,
      lastTxAt: tx.createdAt
    };

    // 4. 批量更新数据
    this.setData(
      {
        room: updatedRoom,
        txs
      },
      () => {
        this.enrichMembersWithAmount();
        this.rebuildTotalsRows();
        this.rebuildTxRows(() => {
          this.scrollTxListToTop();
        });
      }
    );
  },

  /**
   * 简单指数退避重连：1s, 2s, 4s... 上限 10s
   */
  scheduleReconnect() {
    if (this._reconnectTimer) return;
    const attempt = Number(this._reconnectAttempt || 0);
    const delay = Math.min(10000, 1000 * Math.pow(2, attempt));
    this._reconnectAttempt = attempt + 1;
    log.warn("ws.reconnect.schedule", "计划重连 WebSocket", {
      roomCodeMasked: log.maskRoomCode(this.data.roomCode),
      attempt: this._reconnectAttempt,
      delayMs: delay
    });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._pageActive) return;
      log.info("ws.reconnect.try", "开始执行 WebSocket 重连", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        attempt: this._reconnectAttempt
      });

      // 若期间用户已退出房间，则不再重连
      try {
        const app = getApp();
        const myRoom = await app.apiCall({ path: "/api/rooms/my", method: "GET" });
        const roomCode = String(this.data.roomCode || "").trim().toUpperCase();
        const myRoomCode = String((myRoom && myRoom.roomCode) || "").trim().toUpperCase();
        if (!myRoom || !myRoom.ok || !myRoom.inRoom || myRoomCode !== roomCode) {
          this.applyNoRoomState();
          return;
        }
      } catch (err) {
        // ignore
        log.warn("ws.reconnect.precheck.fail", "重连前房间状态检查失败", {
          errMsg: String((err && err.message) || err || "")
        });
      }

      this.startSocket();
    }, delay);
  },

  /**
   * 为成员数组附加净输赢金额数据
   */
  enrichMembersWithAmount() {
    const room = this.data.room || {};
    const totals = (room && room.totals) || {};
    const members = this.data.members || [];

    const enrichedMembers = members.map(m => {
      const amountRaw = totals && totals[m.openId];
      const amount = Number.isInteger(amountRaw) ? amountRaw : Number(amountRaw || 0);
      return {
        ...m,
        amount,
        amountText: amount > 0 ? `+${amount}` : String(amount)
      };
    });

    this.setData({ members: enrichedMembers });
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
   * 生成全部交易列表
   * - 显示：转账者 → 接收者，金额
   *
   * @param {Function=} onDone
   */
  rebuildTxRows(onDone) {
    const txs = this.data.txs || [];

    const rows = [];
    for (const t of txs) {
      if (!t) continue;

      const amount = Number(t.amount || 0);

      rows.push({
        id: t.id,
        fromName: String(t.fromName || "成员"),
        toName: String(t.toName || "成员"),
        timeText: String(t.timeText || ""),
        amount: amount,
        amountText: String(amount),
        fromAvatarResolved: String(t.fromAvatarResolved || ""),
        toAvatarResolved: String(t.toAvatarResolved || "")
      });
    }

    this.setData({ txRows: rows }, () => {
      if (typeof onDone === "function") onDone();
    });
  },

  /**
   * 将交易列表滚动到顶部锚点。
   * 先清空再设置，确保同一锚点可被重复触发。
   */
  scrollTxListToTop() {
    this.setData({ txScrollIntoView: "" }, () => {
      this.setData({ txScrollIntoView: "tx-list-top-anchor" });
    });
  },

  /**
   * 交易列表触底：尝试加载更早一页历史。
   */
  handleTxListReachBottom() {
    this.loadMoreTxs();
  },

  /**
   * 拉取交易历史分页（createdAt + id 双游标）。
   */
  async loadMoreTxs() {
    if (this.data.viewState !== "in_room") return;
    if (this.data.txLoadingMore) return;
    if (!this.data.txHasMore) return;

    const beforeCreatedAt = Number(this.data.txCursorCreatedAt || 0);
    const beforeId = String(this.data.txCursorId || "").trim();
    if (!beforeCreatedAt || !beforeId) {
      // 游标异常时直接收敛为“无更多”，避免无限请求。
      this.setData({
        txHasMore: false,
        txLoadingMore: false,
        txLoadError: "",
        txCursorCreatedAt: 0,
        txCursorId: ""
      });
      return;
    }

    this.setData({ txLoadingMore: true, txLoadError: "" });
    log.info("tx.page.start", "开始加载交易历史分页", {
      roomCodeMasked: log.maskRoomCode(this.data.roomCode),
      beforeCreatedAt
    });

    try {
      const app = getApp();
      const query =
        `beforeCreatedAt=${encodeURIComponent(beforeCreatedAt)}` +
        `&beforeId=${encodeURIComponent(beforeId)}` +
        `&limit=${TX_PAGE_SIZE}`;
      const r = await app.apiCall({
        path: `/api/rooms/${this.data.roomCode}/txs?${query}`,
        method: "GET"
      });

      if (!r || !r.ok) {
        const message = String((r && r.message) || "加载历史失败，请继续上拉重试");
        log.warn("tx.page.biz_fail", "交易历史分页业务失败", {
          roomCodeMasked: log.maskRoomCode(this.data.roomCode),
          code: String((r && r.code) || ""),
          message
        });
        this.setData({
          txLoadingMore: false,
          txLoadError: message
        });
        return;
      }

      const pageTxs = (r.txs || []).map((t) => normalizeTxForView(t)).filter((t) => !!t);
      const txs = mergeTxList(this.data.txs || [], pageTxs);

      const nextHasMoreRaw = !!r.hasMore;
      const nextBeforeCreatedAt = Number(r.nextBeforeCreatedAt || 0);
      const nextBeforeId = String(r.nextBeforeId || "");
      const txHasMore = nextHasMoreRaw && nextBeforeCreatedAt > 0 && !!nextBeforeId;

      this.setData(
        {
          txs,
          txHasMore,
          txLoadingMore: false,
          txLoadError: "",
          txCursorCreatedAt: txHasMore ? nextBeforeCreatedAt : 0,
          txCursorId: txHasMore ? nextBeforeId : ""
        },
        () => {
          this.rebuildTxRows();
        }
      );
      log.info("tx.page.success", "交易历史分页加载成功", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        pageCount: pageTxs.length,
        hasMore: txHasMore
      });
    } catch (err) {
      log.warn("tx.page.fail", "交易历史分页请求失败", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        errMsg: String((err && err.message) || err || "")
      });
      this.setData({
        txLoadingMore: false,
        txLoadError: "网络异常，请继续上拉重试"
      });
    }
  },

  /**
   * 点击成员头像：打开转账弹窗（我转给 TA）。
   */
  handleTapMember(e) {
    if (this.data.viewState !== "in_room") return;
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
    if (this.data.viewState !== "in_room") return;
    if (!this.data.transferCanSubmit) return;
    if (this._transferSubmitting) return;

    const toOpenId = String(this.data.transferToOpenId || "").trim();
    const amount = Number(this.data.transferAmountText);
    log.info("tx.submit.start", "开始提交转账", {
      roomCodeMasked: log.maskRoomCode(this.data.roomCode),
      toOpenIdMasked: log.maskOpenId(toOpenId),
      amount
    });
    const v = validateAmount(amount);
    if (!v.ok) {
      log.warn("tx.submit.invalid", "转账金额校验失败", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        amount
      });
      this.toast(v.message);
      return;
    }

    // 转账提交使用页面私有状态，避免触发 loading 相关按钮禁用样式（发灰）。
    this._transferSubmitting = true;
    try {
      const app = getApp();
      const r = await app.apiCall({
        path: "/api/txs",
        method: "POST",
        data: { toOpenId, amount: v.amount, note: "" }
      });
      if (!r || !r.ok) {
        log.warn("tx.submit.biz_fail", "转账业务失败", {
          roomCodeMasked: log.maskRoomCode(this.data.roomCode),
          code: String((r && r.code) || ""),
          message: String((r && r.message) || "")
        });
        this.toast((r && r.message) || "转账失败");
        return;
      }

      this.closeTransferModal();
      // 优先依赖 WS 的 tx_added 增量推送，避免每次转账后整页快照刷新。
      // 仅在 WS 未连接时兜底拉取一次快照，保证最终一致性。
      let usedSnapshotFallback = false;
      if (!this._socketOpen) {
        usedSnapshotFallback = true;
        await this.fetchSnapshot();
      }

      log.info("tx.submit.success", "转账提交成功", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        toOpenIdMasked: log.maskOpenId(toOpenId),
        amount,
        usedSnapshotFallback
      });
    } catch (err) {
      console.error("transfer 失败", err);
      log.error("tx.submit.fail", "转账提交失败", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        toOpenIdMasked: log.maskOpenId(toOpenId),
        amount,
        errMsg: String((err && err.message) || err || "")
      });
      this.toast("转账失败，请稍后重试");
    } finally {
      this._transferSubmitting = false;
    }
  },

  copyRoomCode() {
    wx.setClipboardData({ data: this.data.roomCode });
  },

  async handleShowJoinCode() {
    if (this.data.viewState !== "in_room") return;
    if (this.data.loading) return;
    if (this._joinCodeLoading) return;

    this._joinCodeLoading = true;
    const reqVersion = Number(this._joinCodeReqVersion || 0) + 1;
    this._joinCodeReqVersion = reqVersion;
    const envVersion = getCurrentMiniEnvVersion();
    const app = getApp();
    this.setData({ showJoinCode: true, joinCodeUrl: "", joinCodeLoadError: false });

    try {
      const path =
        `/api/rooms/${this.data.roomCode}/share-codes` +
        `?envVersion=${encodeURIComponent(envVersion)}`;
      const r = await app.apiCall({
        path,
        method: "GET"
      });
      const minicodeUrl = String((r && r.joinCode && r.joinCode.minicodeUrl) || "");
      if (reqVersion !== this._joinCodeReqVersion) return;
      if (!r || !r.ok || !minicodeUrl) {
        log.warn("join_code.fetch.biz_fail", "获取邀请码失败", {
          roomCodeMasked: log.maskRoomCode(this.data.roomCode),
          code: String((r && r.code) || ""),
          message: String((r && r.message) || "")
        });
        this.toast((r && r.message) || "邀请码生成失败，请稍后重试");
        this.setData({
          showJoinCode: false,
          joinCodeUrl: "",
          joinCodeLoadError: false
        });
        return;
      }

      this.setData({
        joinCodeUrl: resolveApiAssetUrl(minicodeUrl),
        joinCodeLoadError: false
      });
    } catch (err) {
      if (reqVersion !== this._joinCodeReqVersion) return;
      log.warn("join_code.fetch.fail", "获取邀请码失败", {
        roomCodeMasked: log.maskRoomCode(this.data.roomCode),
        errMsg: String((err && err.message) || err || "")
      });
      this.toast("邀请码生成失败，请稍后重试");
      this.setData({
        showJoinCode: false,
        joinCodeUrl: "",
        joinCodeLoadError: false
      });
    } finally {
      this._joinCodeLoading = false;
    }
  },

  handleJoinCodeImageLoad() {
    if (!this.data.showJoinCode) return;
    if (!this.data.joinCodeLoadError) return;
    this.setData({ joinCodeLoadError: false });
  },

  handleJoinCodeImageError() {
    if (!this.data.showJoinCode) return;
    if (!this.data.joinCodeLoadError) {
      this.toast("邀请码图加载失败，请稍后重试");
    }
    this.setData({ joinCodeLoadError: true });
  },

  closeJoinCode() {
    this._joinCodeReqVersion = Number(this._joinCodeReqVersion || 0) + 1;
    this.setData({
      showJoinCode: false,
      joinCodeLoadError: false
    });
  },

  /**
   * 关闭“首次分享引导”弹层。
   */
  closeShareGuide() {
    this.setData({ showShareGuide: false });
  },

  /**
   * 打开邀请码图弹层，用户可长按图片“发送给朋友”。
   */
  handleShareByMenuTip() {
    if (this.data.viewState !== "in_room") return;
    if (this.data.showShareGuide) this.closeShareGuide();
    this.handleShowJoinCode();
  },

  async handleLeave() {
    if (this.data.viewState !== "in_room") return;
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
      this.switchToHomeTab();
    } catch (err) {
      console.error("room_leave 失败", err);
      this.toast("退出失败，请稍后重试");
    } finally {
      this.setData({ loading: false });
    }
  },

  async handleDissolve() {
    if (this.data.viewState !== "in_room") return;
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

      storage.clearLastRoomCode();
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

    storage.clearLastRoomCode();
    this.closeSocket();
    if (this.data.role === "owner") {
      wx.redirectTo({ url: `/pages/settlement/settlement?roomCode=${settlementId || this.data.roomCode}` });
      return;
    }

    wx.showModal({
      title: "房间已解散",
      content: "房主已解散房间",
      showCancel: false,
      success: () => this.switchToHomeTab()
    });
  },

  toast(title) {
    wx.showToast({
      title: String(title || ""),
      icon: "none"
    });
  },

  /**
   * 房间分享卡片配置：
   * - 落点必须是 home，避免新用户直接进入 room 被权限校验拦截。
   * - roomCode 放到 query，供 home.onLoad 解析并自动加入。
   *
   * @param {{from?: string}} res
   * @returns {{title: string, path: string}}
   */
  onShareAppMessage(res) {
    if (this.data.viewState !== "in_room") {
      return {
        title: "来打牌记账",
        path: "/pages/home/home"
      };
    }

    // 仅保留右上角菜单分享通路：若引导层还在，分享时顺便关闭，避免重复打扰。
    if (this.data.showShareGuide) {
      this.closeShareGuide();
    }

    const roomCode = String(this.data.roomCode || "").trim().toUpperCase();
    const code = encodeURIComponent(roomCode);
    return {
      title: `点击加入房间 ${roomCode}`,
      path: `/pages/home/home?roomCode=${code}`
    };
  }
});
