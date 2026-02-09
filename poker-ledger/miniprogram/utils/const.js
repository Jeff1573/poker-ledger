/**
 * 全局常量配置。
 * 说明：此版本已放弃微信云开发，改用自建 Node.js 后端。
 */
module.exports = {
  // 小程序日志级别：debug|info|warn|error（默认 info）
  LOG_LEVEL: "info",

  // 后端 HTTP 基地址（生产环境必须为 HTTPS，并配置到小程序“request 合法域名”）
  // API_BASE_URL: "http://192.168.2.106:3000", // dev
  API_BASE_URL: "https://poker.mdice.top",   // pro

  // 后端 WebSocket 基地址（生产环境使用 wss://，并配置到小程序“socket 合法域名”）
  // WS_BASE_URL: "ws://192.168.2.106:3000", // dev
  WS_BASE_URL: "wss://poker.mdice.top",   // pro

  // 房间号字符集：去掉易混淆字符（0/O，1/I）
  ROOM_CODE_ALPHABET: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",

  // 房间号长度（短码+字母，输入成本低）
  ROOM_CODE_LEN: 6,

  // 金额边界（整数，避免异常输入）
  AMOUNT_MIN: 1,
  AMOUNT_MAX: 99999999
};
