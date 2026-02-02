/**
 * 微信登录：把 wx.login 的 code 换取 openid。
 *
 * 文档：jscode2session
 * https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 */
const config = require("./config");

/**
 * @param {string} code
 * @returns {Promise<{ok: true, openId: string} | {ok: false, code: string, message: string}>}
 */
async function codeToOpenId(code) {
  const appid = String(config.WECHAT_APPID || "").trim();
  const secret = String(config.WECHAT_APPSECRET || "").trim();

  if (!appid || !secret) {
    return { ok: false, code: "WECHAT_SECRET_MISSING", message: "服务端未配置 WECHAT_APPID/WECHAT_APPSECRET" };
  }

  const url =
    "https://api.weixin.qq.com/sns/jscode2session" +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    "&grant_type=authorization_code";

  const resp = await fetch(url, { method: "GET" });
  const data = await resp.json().catch(() => null);
  if (!data) return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口返回异常" };

  if (data.errcode) {
    return { ok: false, code: "WECHAT_API_ERROR", message: `微信接口错误：${data.errcode}` };
  }

  const openId = String(data.openid || "").trim();
  if (!openId) return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口未返回 openid" };

  return { ok: true, openId };
}

module.exports = {
  codeToOpenId
};

