const jwt = require("jsonwebtoken");
const config = require("./config");
const logger = require("./logger");

const ROOM_IMAGE_ACCESS_KIND = "room_image_access";
const SESSION_TOKEN_KIND = "session";
const ROOM_IMAGE_ASSETS = new Set(["minicode", "qrcode"]);
const VALID_MINICODE_ENV_VERSIONS = new Set(["develop", "trial", "release"]);

/**
 * 归一化小程序码环境版本。
 *
 * @param {any} raw
 * @returns {"develop"|"trial"|"release"}
 */
function normalizeMiniCodeEnvVersion(raw) {
  const envVersion = String(raw || "").trim().toLowerCase();
  if (VALID_MINICODE_ENV_VERSIONS.has(envVersion)) return envVersion;
  return "release";
}

/**
 * 生成 JWT（用于 HTTP 与 WebSocket 鉴权）。
 *
 * @param {string} openId
 * @returns {string}
 */
function signToken(openId) {
  const nowSec = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: openId,
      kind: SESSION_TOKEN_KIND,
      iat: nowSec
    },
    config.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

/**
 * 解析 JWT，失败返回 null。
 *
 * @param {string} token
 * @returns {string|null} openId
 */
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const kind = String((payload && payload.kind) || SESSION_TOKEN_KIND);
    if (kind !== SESSION_TOKEN_KIND) return null;
    const openId = payload && payload.sub;
    return openId ? String(openId) : null;
  } catch (err) {
    return null;
  }
}

/**
 * 签发“房间图片访问”短时 token。
 *
 * @param {{
 *   asset: "minicode"|"qrcode",
 *   roomCode: string,
 *   openId: string,
 *   envVersion?: "develop"|"trial"|"release"
 * }} payload
 * @returns {string}
 */
function signRoomImageAccessToken(payload) {
  const asset = String((payload && payload.asset) || "").trim().toLowerCase();
  const roomCode = String((payload && payload.roomCode) || "").trim().toUpperCase();
  const openId = String((payload && payload.openId) || "").trim();

  if (!ROOM_IMAGE_ASSETS.has(asset)) {
    throw new Error("invalid room image asset");
  }
  if (!/^[0-9A-Z]{4,12}$/.test(roomCode)) {
    throw new Error("invalid room code");
  }
  if (!openId) {
    throw new Error("invalid openId");
  }

  const body = {
    kind: ROOM_IMAGE_ACCESS_KIND,
    asset,
    roomCode,
    sub: openId
  };

  if (asset === "minicode") {
    body.envVersion = normalizeMiniCodeEnvVersion(payload && payload.envVersion);
  }

  return jwt.sign(body, config.JWT_SECRET, {
    expiresIn: Number(config.ROOM_IMAGE_ACCESS_TTL_SEC || 300)
  });
}

/**
 * 验证“房间图片访问”短时 token。
 *
 * @param {string} token
 * @returns {{asset: "minicode"|"qrcode", roomCode: string, openId: string, envVersion: "develop"|"trial"|"release"|null}|null}
 */
function verifyRoomImageAccessToken(token) {
  try {
    const payload = jwt.verify(String(token || ""), config.JWT_SECRET);
    const kind = String((payload && payload.kind) || "").trim().toLowerCase();
    if (kind !== ROOM_IMAGE_ACCESS_KIND) return null;

    const asset = String((payload && payload.asset) || "").trim().toLowerCase();
    if (!ROOM_IMAGE_ASSETS.has(asset)) return null;

    const roomCode = String((payload && payload.roomCode) || "").trim().toUpperCase();
    if (!/^[0-9A-Z]{4,12}$/.test(roomCode)) return null;

    const openId = String((payload && payload.sub) || "").trim();
    if (!openId) return null;

    const envVersion = asset === "minicode"
      ? normalizeMiniCodeEnvVersion(payload && payload.envVersion)
      : null;

    return {
      asset,
      roomCode,
      openId,
      envVersion
    };
  } catch (err) {
    return null;
  }
}

/**
 * Express 鉴权中间件：从 Authorization: Bearer xxx 解析 openId。
 */
function authMiddleware(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m && m[1];
  const reqId = String(req._reqId || "");

  if (!m) {
    logger.warn({
      scope: "auth",
      event: "auth.fail.missing_bearer",
      msg: "缺少 Authorization Bearer",
      reqId
    });
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "未登录或登录已过期" });
    return;
  }

  const openId = token ? verifyToken(token) : null;

  if (!openId) {
    logger.warn({
      scope: "auth",
      event: "auth.fail.invalid_token",
      msg: "JWT 校验失败",
      reqId
    });
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "未登录或登录已过期" });
    return;
  }

  logger.debug({
    scope: "auth",
    event: "auth.ok",
    msg: "鉴权通过",
    reqId,
    openId
  });
  req.openId = openId;
  next();
}

module.exports = {
  signToken,
  verifyToken,
  signRoomImageAccessToken,
  verifyRoomImageAccessToken,
  authMiddleware
};
