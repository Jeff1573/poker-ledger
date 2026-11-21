const CONST = require("./const");

/**
 * 运行环境标识。
 *
 * 目的：让开发/测试/正式用户一眼看出"我现在连的是哪个后端"，
 * 避免在体验版上误操作正式数据，或以为功能没生效其实打到旧环境。
 *
 * 区分维度：
 * - envVersion：develop / trial / release（微信官方口径）
 * - platform：devtools 表示开发者工具模拟器，其余为真机
 *
 * 因此 develop 会细分为：
 * - 模拟器 → "本地开发"
 * - 真机   → "开发版"（真机预览/真机调试，走同一套 develop 配置）
 */

let cached = null;

/**
 * 从 URL 中取出 host（含端口），解析失败时原样返回。
 *
 * @param {string} url
 * @returns {string}
 */
function extractHost(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const m = raw.match(/^[a-z]+:\/\/([^/]+)/i);
  return m && m[1] ? m[1] : raw;
}

/**
 * 读取当前运行平台（devtools / ios / android / ...）。
 *
 * @returns {string}
 */
function resolvePlatform() {
  try {
    const info = typeof wx !== "undefined" && wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
    return String((info && info.platform) || "").trim().toLowerCase();
  } catch (err) {
    return "";
  }
}

/**
 * 计算当前环境展示信息（结果缓存，同一运行周期内不变）。
 *
 * @returns {{
 *   envVersion: string,
 *   platform: string,
 *   isDevtools: boolean,
 *   label: string,
 *   tone: "dev"|"develop"|"trial"|"release",
 *   host: string,
 *   detail: string,
 *   apiBaseUrl: string
 * }}
 */
/**
 * 判断后端地址是否属于「本地/内网」。
 *
 * 注意：真机预览虽然标签是“开发版”，但它连的同样是电脑上的局域网后端，
 * 所以连接目标必须单独标出来，否则容易被理解成“连到线上去了”。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLocalBackendUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  if (/^http:\/\//i.test(raw)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(raw);
}

/**
 * 计算当前环境展示信息（结果缓存，同一运行周期内不变）。
 *
 * 两个维度不要混在一起看：
 * - label（标签）：这是哪个版本的小程序包 —— 本地开发 / 开发版 / 体验版 / 正式版
 * - detail（明细）：连的是哪个后端 + 跑在哪台设备 + 是哪个开发账号
 *
 * 所以「开发者工具 = 本地开发」「真机预览 = 开发版」是正确的，
 * 两者连的都是同一个局域网后端（明细里的“本地后端”）。
 */
function getEnvInfo() {
  if (cached) return cached;

  const envVersion = String(CONST.ENV_VERSION || "develop");
  const platform = resolvePlatform();
  const isDevtools = platform === "devtools";
  const apiBaseUrl = String(CONST.API_BASE_URL || "");
  const host = extractHost(apiBaseUrl);
  const isLocalBackend = isLocalBackendUrl(apiBaseUrl);
  const backendLabel = isLocalBackend ? "本地后端" : "线上后端";
  const deviceLabel = isDevtools ? "模拟器" : "真机";

  let label = "正式版";
  let tone = "release";

  if (envVersion === "develop") {
    label = isDevtools ? "本地开发" : "开发版";
    tone = isDevtools ? "dev" : "develop";
  } else if (envVersion === "trial") {
    label = "体验版";
    tone = "trial";
  } else {
    label = "正式版";
    tone = "release";
  }

  // 明细：本地后端/线上后端 + 地址；develop 再补设备信息（区分模拟器与真机）
  const detailParts = [backendLabel];
  if (host) detailParts.push(host);
  if (envVersion === "develop") detailParts.push(deviceLabel);
  const detail = detailParts.join(" · ");

  cached = {
    envVersion,
    platform,
    isDevtools,
    isLocalBackend,
    label,
    tone,
    host,
    detail,
    apiBaseUrl
  };
  return cached;
}

/**
 * 从开发旁路 openId 中提取“账号标识”，用于界面展示。
 * dev_mock_qqqj → qqqj；dev_mock_openid → openid
 *
 * @param {string} openId
 * @returns {string}
 */
function extractDevIdentity(openId) {
  const raw = String(openId || "").trim();
  if (!raw) return "";
  return raw.replace(/^dev_mock_?/, "") || raw;
}

/**
 * 拼接环境说明文案：主机 · 设备 · 开发账号。
 *
 * 为什么要把开发账号显示出来：
 * develop 环境跳过了 wx.login，每个客户端实例都会生成一个独立的虚拟账号
 * （真机是 qqqj、开发者工具可能是 openid）。不显示的话，
 * 就会出现“我在工具里建了房间，手机上却显示没有房间”的困惑。
 *
 * @param {string=} openId
 * @returns {string}
 */
function buildEnvDetail(openId) {
  const info = getEnvInfo();
  if (!CONST.DEV_MOCK_LOGIN) return info.detail;
  const identity = extractDevIdentity(openId);
  if (!identity) return info.detail;
  return `${info.detail} · 账号 ${identity}`;
}

module.exports = {
  getEnvInfo,
  buildEnvDetail,
  extractDevIdentity
};
