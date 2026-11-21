/**
 * 全局常量配置。
 * 说明：此版本已放弃微信云开发，改用自建 Node.js 后端。
 */

/**
 * 读取小程序运行环境：develop / trial / release。
 *
 * @returns {"develop"|"trial"|"release"}
 */
function resolveEnvVersion() {
  try {
    if (typeof wx !== "undefined" && wx.getAccountInfoSync) {
      const info = wx.getAccountInfoSync();
      const envVersion = String((info && info.miniProgram && info.miniProgram.envVersion) || "").trim();
      if (envVersion === "develop" || envVersion === "trial" || envVersion === "release") {
        return envVersion;
      }
    }
  } catch (err) {
    // ignore
  }
  return "develop";
}

const ENDPOINTS_BY_ENV = {
  develop: {
    // 本地开发地址。模拟器与真机都用电脑的局域网 IP，不能用 localhost/127.0.0.1：
    // 真机上的 localhost 指向手机自己，必然请求失败。
    // 换网络环境（或 DHCP 重新分配）后，把这里的 IP 改成新的即可。
    API_BASE_URL: "http://192.168.31.210:3000",
    WS_BASE_URL: "ws://192.168.31.210:3000"
  },
  trial: {
    API_BASE_URL: "https://dev.20260326.xyz",
    WS_BASE_URL: "wss://dev.20260326.xyz"
  },
  release: {
    API_BASE_URL: "https://jp.20260326.xyz",
    WS_BASE_URL: "wss://jp.20260326.xyz"
  }
};

const envVersion = resolveEnvVersion();
const endpoint = ENDPOINTS_BY_ENV[envVersion] || ENDPOINTS_BY_ENV.develop;

/**
 * 读取当前运行版本号（正式版/体验版返回真实版本，开发版返回 dev）。
 * 仅用于请求头上报，便于服务端日志区分“不同版本/不同环境”的请求来源。
 *
 * @returns {string}
 */
function resolveClientVersion() {
  try {
    if (typeof wx !== "undefined" && wx.getAccountInfoSync) {
      const version = String((wx.getAccountInfoSync().miniProgram || {}).version || "").trim();
      if (version) return version;
    }
  } catch (err) {
    // ignore
  }
  return envVersion === "develop" ? "dev" : "";
}

module.exports = {
  // 当前运行环境：develop / trial / release
  ENV_VERSION: envVersion,

  // 当前上报给服务端的版本标识
  CLIENT_VERSION: resolveClientVersion(),

  // 本地开发登录旁路开关：只在 develop 环境为 true，因此体验版/正式版上传后必然为 false。
  // 配合服务端 DEV_LOGIN=1 使用，可在没有微信 AppSecret 时完整调试业务功能。
  DEV_MOCK_LOGIN: envVersion === "develop",

  // 小程序日志级别：debug|info|warn|error（默认 info）
  LOG_LEVEL: "info",

  // 后端地址按环境注入：develop / trial / release
  API_BASE_URL: endpoint.API_BASE_URL,

  WS_BASE_URL: endpoint.WS_BASE_URL,

  // 房间号字符集：去掉易混淆字符（0/O，1/I）
  ROOM_CODE_ALPHABET: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",

  // 房间号长度：4 位（32 字符集 ≈ 104 万种组合，便于口头报号）
  ROOM_CODE_LEN: 4,

  // 金额边界（整数，避免异常输入）
  AMOUNT_MIN: 1,
  AMOUNT_MAX: 99999999
};
