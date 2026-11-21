const CONST = require("./const");
const log = require("./log");

let requestSeq = 0;

/**
 * 生成请求日志 ID，用于关联 start/end/fail。
 */
function nextRequestId() {
  requestSeq += 1;
  return `mini_req_${Date.now()}_${requestSeq}`;
}

/**
 * 封装 wx.request：
 * - 自动拼接 API_BASE_URL
 * - 可选携带 Bearer Token
 * - 统一返回后端 JSON（不在这里 showToast，交给页面决定）
 *
 * @param {{
 *   path: string,
 *   method?: 'GET'|'POST'|'PUT'|'DELETE',
 *   data?: any,
 *   token?: string,
 *   timeoutMs?: number,
 * }} opt
 * @returns {Promise<any>}
 */
function request(opt) {
  const path = String(opt.path || "");
  const method = String(opt.method || "GET").toUpperCase();
  const data = opt.data || {};
  const token = String(opt.token || "");
  const timeoutMs = Number(opt.timeoutMs || 10000);
  const requestId = nextRequestId();
  const startAt = Date.now();

  log.info("api.request.start", "发起接口请求", {
    requestId,
    method,
    path,
    timeoutMs,
    hasToken: !!token
  });

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${String(CONST.API_BASE_URL || "").replace(/\/$/, "")}${path}`,
      method,
      data,
      timeout: timeoutMs,
      header: {
        // 上报运行环境与版本，服务端日志据此区分“体验版/正式版/开发版”来源
        "X-Client-Env": String(CONST.ENV_VERSION || ""),
        "X-Client-Version": String(CONST.CLIENT_VERSION || ""),
        ...(token
          ? {
              Authorization: `Bearer ${token}`
            }
          : {})
      },
      success: (res) => {
        const durationMs = Date.now() - startAt;
        const body = res && res.data;
        // 服务端回传的请求 ID：用户报障时可直接给出，用于检索该次请求的全部服务端日志
        const headers = (res && res.header) || {};
        const serverReqId = String(headers["X-Request-Id"] || headers["x-request-id"] || "");
        log.info("api.request.end", "接口请求完成", {
          requestId,
          serverReqId,
          method,
          path,
          statusCode: Number((res && res.statusCode) || 0),
          ok: !!(body && body.ok),
          code: String((body && body.code) || ""),
          durationMs
        });
        if (body && typeof body === "object" && !body.reqId && serverReqId) {
          body.reqId = serverReqId;
        }
        resolve(body);
      },
      fail: (err) => {
        const durationMs = Date.now() - startAt;
        log.warn("api.request.fail", "接口请求失败", {
          requestId,
          method,
          path,
          errMsg: String((err && err.errMsg) || ""),
          durationMs
        });
        reject(err);
      }
    });
  });
}

module.exports = {
  request
};
