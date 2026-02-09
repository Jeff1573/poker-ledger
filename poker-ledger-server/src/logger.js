const config = require("./config");

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function getLogLevel() {
  const lv = String(config.LOG_LEVEL || "info").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, lv) ? lv : "info";
}

function shouldLog(level) {
  const current = getLogLevel();
  return (LEVEL_WEIGHT[level] || LEVEL_WEIGHT.info) >= LEVEL_WEIGHT[current];
}

/**
 * openId 脱敏：默认仅保留前后少量字符。
 *
 * @param {string} openId
 */
function maskOpenId(openId) {
  const s = String(openId || "").trim();
  if (!s) return "";
  if (s.length <= 6) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * roomCode 脱敏：默认仅保留前后字符。
 *
 * @param {string} roomCode
 */
function maskRoomCode(roomCode) {
  const s = String(roomCode || "").trim().toUpperCase();
  if (!s) return "";
  if (s.length <= 4) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * 对扩展字段做轻量脱敏，防止误打印 token/secret。
 *
 * @param {any} extra
 * @returns {any}
 */
function sanitizeExtra(extra) {
  if (!extra || typeof extra !== "object") return extra;
  if (Array.isArray(extra)) return extra.map((item) => sanitizeExtra(item));

  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    const lower = String(k || "").toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("authorization") ||
      lower.includes("password")
    ) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (v && typeof v === "object") {
      out[k] = sanitizeExtra(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 输出结构化 JSON 日志。
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {{
 *   scope?: string,
 *   event?: string,
 *   msg?: string,
 *   reqId?: string,
 *   roomCode?: string,
 *   openId?: string,
 *   durationMs?: number,
 *   extra?: any
 * }} payload
 */
function write(level, payload) {
  if (!shouldLog(level)) return;
  const p = payload || {};
  const line = {
    ts: new Date().toISOString(),
    level,
    scope: String(p.scope || ""),
    event: String(p.event || ""),
    msg: String(p.msg || ""),
    reqId: String(p.reqId || ""),
    roomCode: maskRoomCode(p.roomCode),
    openIdMasked: maskOpenId(p.openId),
    durationMs: Number.isFinite(Number(p.durationMs)) ? Number(p.durationMs) : null,
    extra: sanitizeExtra(p.extra) || null
  };
  const text = JSON.stringify(line);
  if (level === "error") {
    console.error(text);
    return;
  }
  if (level === "warn") {
    console.warn(text);
    return;
  }
  console.log(text);
}

function debug(payload) {
  write("debug", payload);
}

function info(payload) {
  write("info", payload);
}

function warn(payload) {
  write("warn", payload);
}

function error(payload) {
  write("error", payload);
}

module.exports = {
  debug,
  info,
  warn,
  error,
  maskOpenId,
  maskRoomCode
};

