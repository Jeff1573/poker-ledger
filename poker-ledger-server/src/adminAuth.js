const crypto = require("crypto");

const config = require("./config");
const logger = require("./logger");
const store = require("./store");

const ADMIN_USERNAME = "admin";
const ADMIN_SESSION_COOKIE = "pl_admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_PASSWORD_KEY_LEN = 64;
const sessions = new Map();

/**
 * 生成适合控制台交付的一次性随机密码。
 *
 * @returns {string}
 */
function generateRandomPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * 生成随机 token，用于后台会话和 CSRF。
 *
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * 使用 scrypt 计算密码摘要，避免明文密码落库。
 *
 * @param {string} password
 * @param {string} salt
 * @returns {string}
 */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || ""), String(salt || ""), ADMIN_PASSWORD_KEY_LEN).toString("hex");
}

/**
 * 常量时间比较字符串，避免认证判断暴露明显时序差异。
 *
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * 首次启动或显式重置时初始化后台管理员密码。
 */
async function initAdminPassword() {
  const record = store.getAdminPasswordRecord();
  const shouldReset = String(process.env.ADMIN_RESET_PASSWORD || "").trim() === "1";
  const missing = !record.salt || !record.hash;
  if (!shouldReset && !missing) {
    return { ok: true, generated: false, reset: false, password: "" };
  }

  const password = generateRandomPassword();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const saved = await store.saveAdminPasswordRecord(salt, hash);
  if (!saved.ok) {
    throw new Error(saved.message || "后台管理员密码初始化失败");
  }

  // 明文密码只在初始化/重置时出现一次，便于部署者首次登录。
  console.log(`后台管理员账号：admin，随机密码：${password}`);
  logger.warn({
    scope: "admin.auth",
    event: shouldReset ? "admin.password.reset" : "admin.password.init",
    msg: shouldReset ? "后台管理员密码已重置" : "后台管理员密码已初始化"
  });

  return {
    ok: true,
    generated: true,
    reset: shouldReset,
    password
  };
}

/**
 * 校验后台用户名和密码。
 *
 * @param {string} username
 * @param {string} password
 */
function verifyAdminCredentials(username, password) {
  if (String(username || "").trim() !== ADMIN_USERNAME) return false;

  const record = store.getAdminPasswordRecord();
  if (!record.salt || !record.hash) return false;

  const candidate = hashPassword(password, record.salt);
  return safeEqual(candidate, record.hash);
}

/**
 * 清理过期会话，避免长时间运行后内存增长。
 */
function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (!session || Number(session.expiresAt || 0) <= now) {
      sessions.delete(sessionId);
    }
  }
}

/**
 * 解析 Cookie 头。
 *
 * @param {import("express").Request} req
 * @param {string} name
 */
function getCookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || "");
  const parts = raw.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch (err) {
      // 畸形 Cookie 视为无效会话，避免认证入口因为 URIError 返回 500。
      return "";
    }
  }
  return "";
}

/**
 * 构造后台会话 Cookie。
 *
 * @param {string} value
 * @param {number} maxAgeSec
 */
function buildSessionCookie(value, maxAgeSec) {
  const attrs = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(String(value || ""))}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Number(maxAgeSec || 0)}`
  ];
  if (config.ADMIN_COOKIE_SECURE) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * 创建后台会话并写入 HttpOnly Cookie。
 *
 * @param {import("express").Response} res
 */
function createAdminSession(res) {
  pruneExpiredSessions();

  const sessionId = generateToken();
  const csrfToken = generateToken();
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  sessions.set(sessionId, {
    username: ADMIN_USERNAME,
    csrfToken,
    expiresAt
  });
  res.setHeader("Set-Cookie", buildSessionCookie(sessionId, ADMIN_SESSION_TTL_MS / 1000));
  return {
    username: ADMIN_USERNAME,
    csrfToken,
    expiresAt
  };
}

/**
 * 从请求中读取有效后台会话。
 *
 * @param {import("express").Request} req
 */
function getAdminSession(req) {
  pruneExpiredSessions();

  const sessionId = getCookie(req, ADMIN_SESSION_COOKIE);
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session || Number(session.expiresAt || 0) <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return {
    sessionId,
    ...session
  };
}

/**
 * 销毁当前后台会话，并清理浏览器 Cookie。
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
function destroyAdminSession(req, res) {
  const sessionId = getCookie(req, ADMIN_SESSION_COOKIE);
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", buildSessionCookie("", 0));
}

/**
 * Express 后台登录态中间件。
 */
function requireAdmin(req, res, next) {
  const session = getAdminSession(req);
  if (!session) {
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "未登录或登录已过期" });
    return;
  }
  req.adminSession = session;
  next();
}

/**
 * Express 后台 CSRF 中间件：只保护会改变状态的请求。
 */
function requireAdminCsrf(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }

  const session = req.adminSession;
  const token = String(req.headers["x-csrf-token"] || "");
  if (!session || !safeEqual(token, session.csrfToken)) {
    res.status(403).json({ ok: false, code: "INVALID_CSRF", message: "请求已过期，请刷新后台后重试" });
    return;
  }

  next();
}

module.exports = {
  ADMIN_USERNAME,
  ADMIN_SESSION_COOKIE,
  initAdminPassword,
  verifyAdminCredentials,
  createAdminSession,
  getAdminSession,
  destroyAdminSession,
  requireAdmin,
  requireAdminCsrf
};
