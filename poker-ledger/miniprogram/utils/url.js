const CONST = require("./const");

/**
 * 把后端返回的资源地址补全为可直接用于 <image src> 的 URL。
 *
 * 约定：
 * - 若是 http/https 开头：认为已是完整 URL，原样返回
 * - 若是 / 开头：认为是后端静态资源相对路径，拼接 API_BASE_URL
 * - 其他：原样返回（例如本地临时路径）
 *
 * @param {string} u
 * @returns {string}
 */
function resolveApiAssetUrl(u) {
  const raw = String(u || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) {
    const base = String(CONST.API_BASE_URL || "").replace(/\/$/, "");
    return `${base}${raw}`;
  }
  return raw;
}

module.exports = {
  resolveApiAssetUrl
};

