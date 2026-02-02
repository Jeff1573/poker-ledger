const CONST = require("./const");

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

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${String(CONST.API_BASE_URL || "").replace(/\/$/, "")}${path}`,
      method,
      data,
      timeout: timeoutMs,
      header: token
        ? {
            Authorization: `Bearer ${token}`
          }
        : {},
      success: (res) => resolve(res.data),
      fail: (err) => reject(err)
    });
  });
}

module.exports = {
  request
};
