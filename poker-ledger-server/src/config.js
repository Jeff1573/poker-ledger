/**
 * 服务端配置：
 * - 生产环境请通过环境变量注入，不要把密钥写进代码仓库。
 */
require("dotenv").config();

function mustGetEnv(key) {
  const v = String(process.env[key] || "").trim();
  if (!v) throw new Error(`缺少环境变量：${key}`);
  return v;
}

/**
 * 读取正整数环境变量；非法值回退到默认值。
 *
 * @param {any} raw
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

module.exports = {
  // HTTP 端口
  PORT: Number(process.env.PORT || 3000),

  // JWT 密钥（生产必须设置强随机值）
  JWT_SECRET: String(process.env.JWT_SECRET || "dev-secret-please-change"),

  // 微信小程序 AppID/Secret：用于把 wx.login 的 code 换取 openid
  WECHAT_APPID: String(process.env.WECHAT_APPID || ""),
  WECHAT_APPSECRET: String(process.env.WECHAT_APPSECRET || ""),

  // 旧 JSON 数据文件路径（仅用于首次迁移/兼容；不设则默认 data/db.json）
  DB_FILE: String(process.env.DB_FILE || ""),

  // SQLite 数据库文件路径（不设则默认 data/db.sqlite）
  SQLITE_FILE: String(process.env.SQLITE_FILE || ""),

  // 日志级别：debug|info|warn|error（默认 info）
  LOG_LEVEL: String(process.env.LOG_LEVEL || "info"),

  // HTTP 访问日志开关：1 开启，0 关闭（默认开启）
  LOG_HTTP_ACCESS: String(process.env.LOG_HTTP_ACCESS || "1") !== "0",

  // 房间邀请码图片访问 token 过期时间（秒）
  ROOM_IMAGE_ACCESS_TTL_SEC: toPositiveInt(process.env.ROOM_IMAGE_ACCESS_TTL_SEC, 300),

  // 房间邀请码签发接口限流窗口（毫秒）
  ROOM_IMAGE_RATE_LIMIT_WINDOW_MS: toPositiveInt(process.env.ROOM_IMAGE_RATE_LIMIT_WINDOW_MS, 60000),

  // 房间邀请码签发接口限流上限（每窗口）
  ROOM_IMAGE_RATE_LIMIT_MAX: toPositiveInt(process.env.ROOM_IMAGE_RATE_LIMIT_MAX, 30)
};
