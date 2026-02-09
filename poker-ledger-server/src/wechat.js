/**
 * 微信登录：把 wx.login 的 code 换取 openid。
 *
 * 文档：jscode2session
 * https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 */
const config = require("./config");
const logger = require("./logger");

/**
 * @param {string} code
 * @returns {Promise<{ok: true, openId: string} | {ok: false, code: string, message: string}>}
 */
async function codeToOpenId(code) {
  const startAt = Date.now();
  const appid = String(config.WECHAT_APPID || "").trim();
  const secret = String(config.WECHAT_APPSECRET || "").trim();

  if (!appid || !secret) {
    logger.error({
      scope: "wechat",
      event: "wechat.code2session.config_missing",
      msg: "缺少微信配置",
      durationMs: Date.now() - startAt
    });
    return { ok: false, code: "WECHAT_SECRET_MISSING", message: "服务端未配置 WECHAT_APPID/WECHAT_APPSECRET" };
  }

  const url =
    "https://api.weixin.qq.com/sns/jscode2session" +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    "&grant_type=authorization_code";

  logger.debug({
    scope: "wechat",
    event: "wechat.code2session.start",
    msg: "开始调用微信 code2session"
  });

  let data = null;
  try {
    const resp = await fetch(url, { method: "GET" });
    data = await resp.json().catch(() => null);
  } catch (err) {
    logger.error({
      scope: "wechat",
      event: "wechat.code2session.network_fail",
      msg: "调用微信接口失败",
      durationMs: Date.now() - startAt,
      extra: {
        errMsg: String((err && err.message) || err || "")
      }
    });
    return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口请求失败" };
  }

  if (!data) {
    logger.warn({
      scope: "wechat",
      event: "wechat.code2session.bad_payload",
      msg: "微信接口返回体不可解析",
      durationMs: Date.now() - startAt
    });
    return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口返回异常" };
  }

  if (data.errcode) {
    logger.warn({
      scope: "wechat",
      event: "wechat.code2session.biz_fail",
      msg: "微信接口返回错误码",
      durationMs: Date.now() - startAt,
      extra: {
        errcode: Number(data.errcode || 0)
      }
    });
    return { ok: false, code: "WECHAT_API_ERROR", message: `微信接口错误：${data.errcode}` };
  }

  const openId = String(data.openid || "").trim();
  if (!openId) {
    logger.warn({
      scope: "wechat",
      event: "wechat.code2session.no_openid",
      msg: "微信接口未返回 openid",
      durationMs: Date.now() - startAt
    });
    return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口未返回 openid" };
  }

  logger.info({
    scope: "wechat",
    event: "wechat.code2session.ok",
    msg: "微信登录换取 openid 成功",
    openId,
    durationMs: Date.now() - startAt
  });

  return { ok: true, openId };
}

module.exports = {
  codeToOpenId
};
