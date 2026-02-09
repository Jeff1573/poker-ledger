const CONST = require("./const");

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

/**
 * 读取日志级别；默认 info。
 * 说明：小程序线上环境默认不输出 debug，避免噪音过大。
 */
function getCurrentLevel() {
  const lv = String(CONST.LOG_LEVEL || "info").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, lv) ? lv : "info";
}

/**
 * 判断是否允许输出目标级别日志。
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 */
function shouldLog(level) {
  const current = getCurrentLevel();
  const currentWeight = LEVEL_WEIGHT[current];
  const targetWeight = LEVEL_WEIGHT[level] || LEVEL_WEIGHT.info;
  return targetWeight >= currentWeight;
}

/**
 * openId 脱敏：仅保留前后少量字符。
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
 * roomCode 脱敏：仅保留前后字符。
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
 * token 脱敏：永不记录明文 token。
 *
 * @param {string} token
 */
function maskToken(token) {
  const s = String(token || "").trim();
  if (!s) return "";
  return `len:${s.length}`;
}

/**
 * 输出日志（统一前缀）。
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} event
 * @param {string} message
 * @param {any} extra
 */
function emit(level, event, message, extra) {
  if (!shouldLog(level)) return;
  const prefix = `[mini][${level}][${String(event || "unknown")}]`;
  const msg = String(message || "");
  if (level === "error") {
    if (typeof extra === "undefined") {
      console.error(prefix, msg);
      return;
    }
    console.error(prefix, msg, extra);
    return;
  }
  if (level === "warn") {
    if (typeof extra === "undefined") {
      console.warn(prefix, msg);
      return;
    }
    console.warn(prefix, msg, extra);
    return;
  }
  if (typeof extra === "undefined") {
    console.log(prefix, msg);
    return;
  }
  console.log(prefix, msg, extra);
}

function debug(event, message, extra) {
  emit("debug", event, message, extra);
}

function info(event, message, extra) {
  emit("info", event, message, extra);
}

function warn(event, message, extra) {
  emit("warn", event, message, extra);
}

function error(event, message, extra) {
  emit("error", event, message, extra);
}

module.exports = {
  debug,
  info,
  warn,
  error,
  maskOpenId,
  maskRoomCode,
  maskToken
};

