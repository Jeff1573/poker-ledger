/**
 * 微信登录：把 wx.login 的 code 换取 openid。
 *
 * 文档：jscode2session
 * https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 */
const config = require("./config");
const logger = require("./logger");

const ACCESS_TOKEN_REFRESH_GAP_MS = 60 * 1000;
const TOKEN_INVALID_ERRCODES = new Set([40001, 40014, 42001]);
const VALID_MINICODE_ENV_VERSIONS = new Set(["develop", "trial", "release"]);

let accessTokenCache = {
  token: "",
  expireAt: 0
};
let accessTokenPromise = null;

/**
 * 归一化小程序码环境版本。
 *
 * @param {any} raw
 * @returns {"develop"|"trial"|"release"}
 */
function normalizeMiniCodeEnvVersion(raw) {
  const envVersion = String(raw || "").trim().toLowerCase();
  if (VALID_MINICODE_ENV_VERSIONS.has(envVersion)) {
    return envVersion;
  }
  return "release";
}

/**
 * 读取并校验微信配置。
 *
 * @returns {{appid: string, secret: string}}
 */
function getWechatConfig() {
  return {
    appid: String(config.WECHAT_APPID || "").trim(),
    secret: String(config.WECHAT_APPSECRET || "").trim()
  };
}

/**
 * 获取服务端 access_token（带内存缓存）。
 *
 * @param {boolean} forceRefresh
 * @returns {Promise<{ok: true, accessToken: string} | {ok: false, code: string, message: string}>}
 */
async function getAccessToken(forceRefresh) {
  const startAt = Date.now();
  const { appid, secret } = getWechatConfig();
  if (!appid || !secret) {
    logger.error({
      scope: "wechat",
      event: "wechat.token.config_missing",
      msg: "缺少微信配置",
      durationMs: Date.now() - startAt
    });
    return { ok: false, code: "WECHAT_SECRET_MISSING", message: "服务端未配置 WECHAT_APPID/WECHAT_APPSECRET" };
  }

  const now = Date.now();
  if (!forceRefresh && accessTokenCache.token && accessTokenCache.expireAt - ACCESS_TOKEN_REFRESH_GAP_MS > now) {
    return { ok: true, accessToken: accessTokenCache.token };
  }

  if (accessTokenPromise) {
    return accessTokenPromise;
  }

  accessTokenPromise = (async () => {
    const url =
      "https://api.weixin.qq.com/cgi-bin/token" +
      "?grant_type=client_credential" +
      `&appid=${encodeURIComponent(appid)}` +
      `&secret=${encodeURIComponent(secret)}`;

    logger.debug({
      scope: "wechat",
      event: "wechat.token.fetch.start",
      msg: "开始获取微信 access_token"
    });

    let data = null;
    try {
      const resp = await fetch(url, { method: "GET" });
      data = await resp.json().catch(() => null);
    } catch (err) {
      logger.error({
        scope: "wechat",
        event: "wechat.token.fetch.network_fail",
        msg: "获取微信 access_token 网络异常",
        durationMs: Date.now() - startAt,
        extra: {
          errMsg: String((err && err.message) || err || "")
        }
      });
      return { ok: false, code: "WECHAT_API_ERROR", message: "获取微信 access_token 失败" };
    }

    if (!data) {
      logger.warn({
        scope: "wechat",
        event: "wechat.token.fetch.bad_payload",
        msg: "获取微信 access_token 返回体不可解析",
        durationMs: Date.now() - startAt
      });
      return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口返回异常" };
    }

    if (data.errcode) {
      logger.warn({
        scope: "wechat",
        event: "wechat.token.fetch.biz_fail",
        msg: "微信 access_token 接口返回错误码",
        durationMs: Date.now() - startAt,
        extra: {
          errcode: Number(data.errcode || 0)
        }
      });
      return { ok: false, code: "WECHAT_API_ERROR", message: `微信接口错误：${data.errcode}` };
    }

    const token = String(data.access_token || "").trim();
    const expiresInSec = Number(data.expires_in || 0);
    if (!token || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
      logger.warn({
        scope: "wechat",
        event: "wechat.token.fetch.invalid_token",
        msg: "微信 access_token 返回数据不完整",
        durationMs: Date.now() - startAt
      });
      return { ok: false, code: "WECHAT_API_ERROR", message: "微信接口未返回有效 access_token" };
    }

    accessTokenCache = {
      token,
      expireAt: Date.now() + expiresInSec * 1000
    };
    logger.info({
      scope: "wechat",
      event: "wechat.token.fetch.ok",
      msg: "获取微信 access_token 成功",
      durationMs: Date.now() - startAt,
      extra: {
        expiresInSec
      }
    });
    return { ok: true, accessToken: token };
  })();

  try {
    return await accessTokenPromise;
  } finally {
    accessTokenPromise = null;
  }
}

/**
 * 调用微信接口获取房间小程序码。
 *
 * @param {string} accessToken
 * @param {string} roomCode
 * @param {"develop"|"trial"|"release"} envVersion
 * @returns {Promise<{ok: true, png: Buffer} | {ok: false, code: string, message: string, errcode?: number}>}
 */
async function fetchMiniCodeByToken(accessToken, roomCode, envVersion) {
  const path = `/pages/home/home?roomCode=${encodeURIComponent(roomCode)}`;
  const url = `https://api.weixin.qq.com/wxa/getwxacode?access_token=${encodeURIComponent(accessToken)}`;
  const body = {
    path,
    width: 600,
    env_version: envVersion
  };

  let resp = null;
  let buf = null;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const arr = await resp.arrayBuffer();
    buf = Buffer.from(arr);
  } catch (err) {
    return { ok: false, code: "WECHAT_API_ERROR", message: "请求微信小程序码失败" };
  }

  const contentType = String((resp.headers && resp.headers.get("content-type")) || "").toLowerCase();
  if (contentType.includes("image/")) {
    return { ok: true, png: buf };
  }

  let json = null;
  try {
    json = JSON.parse(String(buf || "").trim() || "{}");
  } catch (err) {
    json = null;
  }
  if (json && json.errcode) {
    return {
      ok: false,
      code: "WECHAT_API_ERROR",
      message: `微信接口错误：${json.errcode}`,
      errcode: Number(json.errcode || 0)
    };
  }
  return { ok: false, code: "WECHAT_API_ERROR", message: "微信小程序码返回异常" };
}

/**
 * 生成房间小程序码（带 access_token 失效重试）。
 *
 * @param {string} roomCode
 * @param {any} envVersionRaw
 * @returns {Promise<{ok: true, png: Buffer} | {ok: false, code: string, message: string}>}
 */
async function generateRoomMiniCode(roomCode, envVersionRaw) {
  const startAt = Date.now();
  const code = String(roomCode || "").trim().toUpperCase();
  const envVersion = normalizeMiniCodeEnvVersion(envVersionRaw);
  if (!/^[0-9A-Z]{4,12}$/.test(code)) {
    return { ok: false, code: "INVALID_ROOM_CODE", message: "房间号无效" };
  }

  const tokenResult = await getAccessToken(false);
  if (!tokenResult.ok) {
    logger.warn({
      scope: "wechat",
      event: "wechat.minicode.fail",
      msg: "生成房间小程序码失败：获取 access_token 失败",
      durationMs: Date.now() - startAt,
      extra: {
        code: String(tokenResult.code || ""),
        envVersion
      }
    });
    return tokenResult;
  }

  let codeResult = await fetchMiniCodeByToken(tokenResult.accessToken, code, envVersion);
  if (!codeResult.ok && TOKEN_INVALID_ERRCODES.has(Number(codeResult.errcode || 0))) {
    const refreshTokenResult = await getAccessToken(true);
    if (!refreshTokenResult.ok) {
      logger.warn({
        scope: "wechat",
        event: "wechat.minicode.fail",
        msg: "生成房间小程序码失败：刷新 access_token 失败",
        durationMs: Date.now() - startAt,
        extra: {
          code: String(refreshTokenResult.code || ""),
          envVersion
        }
      });
      return refreshTokenResult;
    }
    codeResult = await fetchMiniCodeByToken(refreshTokenResult.accessToken, code, envVersion);
  }

  if (!codeResult.ok) {
    logger.warn({
      scope: "wechat",
      event: "wechat.minicode.fail",
      msg: "生成房间小程序码失败",
      durationMs: Date.now() - startAt,
      extra: {
        code: String(codeResult.code || ""),
        errcode: Number(codeResult.errcode || 0),
        envVersion
      }
    });
    return { ok: false, code: codeResult.code, message: codeResult.message };
  }

  logger.info({
    scope: "wechat",
    event: "wechat.minicode.ok",
    msg: "生成房间小程序码成功",
    durationMs: Date.now() - startAt,
    extra: {
      roomCode: code,
      envVersion
    }
  });
  return codeResult;
}

/**
 * @param {string} code
 * @returns {Promise<{ok: true, openId: string} | {ok: false, code: string, message: string}>}
 */
async function codeToOpenId(code) {
  const startAt = Date.now();
  const { appid, secret } = getWechatConfig();

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
  codeToOpenId,
  generateRoomMiniCode
};
