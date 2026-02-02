const api = require("./utils/api");
const storage = require("./utils/storage");

App({
  globalData: {
    token: "",
    openId: "",
    user: null
  },

  /**
   * 小程序启动：初始化登录态（通过 wx.login + 后端换取 openid，并签发 JWT）。
   *
   * 注意：
   * - 这一步不需要用户授权（不涉及头像昵称）
   * - 头像昵称需要在页面中通过 wx.getUserProfile 由用户点击触发
   */
  onLaunch() {
    // 尽早建立登录态，避免页面首次进入时再等待
    this.ensureSession().catch((err) => {
      console.error("初始化登录态失败", err);
    });
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
    if (this.globalData.token && this.globalData.openId) {
      return { token: this.globalData.token, openId: this.globalData.openId };
    }

    // 尝试用本地缓存快速恢复
    const cachedToken = storage.getToken();
    const cachedOpenId = storage.getOpenId();
    if (cachedToken && cachedOpenId) {
      this.globalData.token = cachedToken;
      this.globalData.openId = cachedOpenId;
      return { token: cachedToken, openId: cachedOpenId };
    }

    // 走 wx.login 换取 code（不涉及用户授权）
    const loginRes = await new Promise((resolve, reject) => {
      wx.login({
        success: resolve,
        fail: reject
      });
    });

    const code = String((loginRes && loginRes.code) || "").trim();
    if (!code) throw new Error("wx.login 未返回 code");

    const r = await api.request({
      path: "/api/auth/wechat",
      method: "POST",
      data: { code }
    });

    if (!r || !r.ok || !r.token || !r.openId) {
      throw new Error((r && r.message) || "后端登录失败");
    }

    this.globalData.token = r.token;
    this.globalData.openId = r.openId;
    storage.setToken(r.token);
    storage.setOpenId(r.openId);

    return { token: r.token, openId: r.openId };
  },

  /**
   * 封装后端请求：自动确保已登录并附带 token。
   *
   * @param {{path: string, method?: string, data?: any}} opt
   * @returns {Promise<any>}
   */
  async apiCall(opt) {
    let session = await this.ensureSession();
    let r = await api.request({
      path: opt.path,
      method: opt.method,
      data: opt.data,
      token: session.token
    });

    // 若 token 失效：清空本地缓存并重登一次（避免用户陷入死循环）
    if (r && r.ok === false && r.code === "UNAUTHORIZED") {
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
