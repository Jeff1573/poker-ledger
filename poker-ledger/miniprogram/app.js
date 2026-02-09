const api = require("./utils/api");
const log = require("./utils/log");
const storage = require("./utils/storage");
const { validateRoomCode } = require("./utils/validator");

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
 * 将各种输入归一化为合法房间号。
 * 兼容：纯房间号 / PLROOM:ROOMCODE / query 字符串中的 roomCode|code 参数。
 *
 * @param {any} raw
 * @returns {string}
 */
function normalizeInviteRoomCode(raw) {
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
 * 从小程序启动参数中提取邀请码房间号。
 *
 * @param {any} options
 * @returns {string}
 */
function extractInviteRoomCodeFromOptions(options) {
  // 仅认 roomCode/code，不再从 scene 读取，避免把微信入口场景值（如 1001）误判为房间号。
  const roomCodeFromQuery = safeDecode(
    options && (options.roomCode || options.code || (options.query && (options.query.roomCode || options.query.code)))
  );
  return normalizeInviteRoomCode(roomCodeFromQuery);
}

App({
  globalData: {
    token: "",
    openId: "",
    user: null,
    // 记录“待处理邀请码”，供首页 onShow 消费一次，解决热启动分享场景。
    pendingInviteRoomCode: ""
  },

  /**
   * 小程序启动：初始化登录态（通过 wx.login + 后端换取 openid，并签发 JWT）。
   *
   * 注意：
   * - 这一步不需要用户授权（不涉及头像昵称）
   * - 头像昵称需要在页面中通过 wx.getUserProfile 由用户点击触发
   */
  onLaunch(options) {
    this.captureInviteRoomCode(options);

    // 尽早建立登录态，避免页面首次进入时再等待
    log.info("session.launch", "小程序启动，开始初始化登录态");
    this.ensureSession().catch((err) => {
      log.error("session.launch.fail", "初始化登录态失败", {
        errMsg: String((err && err.message) || err || "")
      });
    });
  },

  /**
   * 小程序前后台切换时，持续捕获来自分享卡片/小程序码的参数。
   *
   * @param {any} options
   */
  onShow(options) {
    this.captureInviteRoomCode(options);
  },

  /**
   * 捕获邀请码（若存在则覆盖旧值，始终保留最新一次进入参数）。
   *
   * @param {any} options
   * @returns {string}
   */
  captureInviteRoomCode(options) {
    const code = extractInviteRoomCodeFromOptions(options);
    if (!code) return "";

    this.globalData.pendingInviteRoomCode = code;
    log.info("invite.capture", "捕获到待处理邀请码", {
      roomCodeMasked: log.maskRoomCode(code)
    });
    return code;
  },

  /**
   * 消费一次待处理邀请码。
   *
   * @returns {string}
   */
  consumePendingInviteRoomCode() {
    const code = String(this.globalData.pendingInviteRoomCode || "").trim().toUpperCase();
    this.globalData.pendingInviteRoomCode = "";
    if (code) {
      log.debug("invite.consume", "消费待处理邀请码", {
        roomCodeMasked: log.maskRoomCode(code)
      });
    }
    return code;
  },

  /**
   * 确保已获取 token/openId：
   * 1) 优先用内存缓存
   * 2) 其次读本地存储
   * 3) 最后走 wx.login -> /api/auth/wechat
   *
   * @returns {Promise<{token: string, openId: string}>}
   */
  async ensureSession() {
    log.debug("session.ensure.start", "开始确保登录态");
    if (this.globalData.token && this.globalData.openId) {
      log.debug("session.ensure.memory_hit", "命中内存登录态", {
        openIdMasked: log.maskOpenId(this.globalData.openId)
      });
      return { token: this.globalData.token, openId: this.globalData.openId };
    }

    // 尝试用本地缓存快速恢复
    const cachedToken = storage.getToken();
    const cachedOpenId = storage.getOpenId();
    if (cachedToken && cachedOpenId) {
      this.globalData.token = cachedToken;
      this.globalData.openId = cachedOpenId;
      log.info("session.ensure.storage_hit", "命中本地缓存登录态", {
        openIdMasked: log.maskOpenId(cachedOpenId),
        tokenMasked: log.maskToken(cachedToken)
      });
      return { token: cachedToken, openId: cachedOpenId };
    }

    // 走 wx.login 换取 code（不涉及用户授权）
    log.info("session.wx_login.start", "开始调用 wx.login");
    const loginRes = await new Promise((resolve, reject) => {
      wx.login({
        success: resolve,
        fail: (err) => {
          log.warn("session.wx_login.fail", "wx.login 调用失败", {
            errMsg: String((err && err.errMsg) || "")
          });
          reject(err);
        }
      });
    });
    log.info("session.wx_login.end", "wx.login 调用完成");

    const code = String((loginRes && loginRes.code) || "").trim();
    if (!code) throw new Error("wx.login 未返回 code");

    const r = await api.request({
      path: "/api/auth/wechat",
      method: "POST",
      data: { code }
    });

    if (!r || !r.ok || !r.token || !r.openId) {
      log.warn("session.ensure.exchange_fail", "后端登录态换取失败", {
        code: String((r && r.code) || ""),
        message: String((r && r.message) || "")
      });
      throw new Error((r && r.message) || "后端登录失败");
    }

    this.globalData.token = r.token;
    this.globalData.openId = r.openId;
    storage.setToken(r.token);
    storage.setOpenId(r.openId);

    log.info("session.ensure.success", "登录态建立成功", {
      openIdMasked: log.maskOpenId(r.openId),
      tokenMasked: log.maskToken(r.token)
    });

    return { token: r.token, openId: r.openId };
  },

  /**
   * 封装后端请求：自动确保已登录并附带 token。
   *
   * @param {{path: string, method?: string, data?: any}} opt
   * @returns {Promise<any>}
   */
  async apiCall(opt) {
    const path = String((opt && opt.path) || "");
    const method = String((opt && opt.method) || "GET").toUpperCase();
    let session = await this.ensureSession();
    let r = await api.request({
      path: opt.path,
      method: opt.method,
      data: opt.data,
      token: session.token
    });

    // 若 token 失效：清空本地缓存并重登一次（避免用户陷入死循环）
    if (r && r.ok === false && r.code === "UNAUTHORIZED") {
      log.warn("api.retry.unauthorized", "接口返回未授权，准备重登重试", {
        path,
        method,
        openIdMasked: log.maskOpenId(session.openId)
      });
      this.globalData.token = "";
      this.globalData.openId = "";
      storage.setToken("");
      storage.setOpenId("");

      session = await this.ensureSession();
      r = await api.request({
        path: opt.path,
        method: opt.method,
        data: opt.data,
        token: session.token
      });
      log.info("api.retry.done", "未授权重试完成", {
        path,
        method,
        ok: !!(r && r.ok),
        code: String((r && r.code) || "")
      });
    }

    return r;
  },

  /**
   * 拉取我的用户档案与房间映射。
   * @returns {Promise<any>} /api/me 的返回
   */
  async loadMe() {
    const r = await this.apiCall({ path: "/api/me", method: "GET" });
    if (r && r.ok) this.globalData.user = r.user || null;
    return r;
  }
});
