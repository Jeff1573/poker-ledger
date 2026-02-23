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
    // 真机调试请改为你电脑在局域网中的可达地址，不要使用 127.0.0.1
    API_BASE_URL: "https://dev.mdice.top",
    WS_BASE_URL: "wss://dev.mdice.top"
  },
  trial: {
    API_BASE_URL: "https://dev.mdice.top",
    WS_BASE_URL: "wss://dev.mdice.top"
  },
  release: {
    API_BASE_URL: "https://jp.mdice.top",
    WS_BASE_URL: "wss://jp.mdice.top"
  }
};

const envVersion = resolveEnvVersion();
const endpoint = ENDPOINTS_BY_ENV[envVersion] || ENDPOINTS_BY_ENV.develop;

module.exports = {
  // 小程序日志级别：debug|info|warn|error（默认 info）
  LOG_LEVEL: "info",

  // 后端地址按环境注入：develop / trial / release
  API_BASE_URL: endpoint.API_BASE_URL,

  WS_BASE_URL: endpoint.WS_BASE_URL,

  // 房间号字符集：去掉易混淆字符（0/O，1/I）
  ROOM_CODE_ALPHABET: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",

  // 房间号长度（短码+字母，输入成本低）
  ROOM_CODE_LEN: 6,

  // 金额边界（整数，避免异常输入）
  AMOUNT_MIN: 1,
  AMOUNT_MAX: 99999999
};
