const jwt = require("jsonwebtoken");
const config = require("./config");

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
    const openId = payload && payload.sub;
    return openId ? String(openId) : null;
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
  const openId = token ? verifyToken(token) : null;

  if (!openId) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "未登录或登录已过期" });
    return;
  }

  req.openId = openId;
  next();
}

module.exports = {
  signToken,
  verifyToken,
  authMiddleware
};

