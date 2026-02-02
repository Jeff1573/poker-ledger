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
  SQLITE_FILE: String(process.env.SQLITE_FILE || "")
};
