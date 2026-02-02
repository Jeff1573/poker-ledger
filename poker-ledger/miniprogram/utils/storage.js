/**
 * 本地存储仅用于「体验优化」：
 * - 最近使用的房间号输入回显
 * - 缓存登录态 token（便于恢复房间）
 * - 不作为业务真相来源（业务真相以后端为准）
 */
const KEY_LAST_ROOM_CODE = "PL_LAST_ROOM_CODE";
const KEY_TOKEN = "PL_TOKEN";
const KEY_OPEN_ID = "PL_OPEN_ID";

function setLastRoomCode(code) {
  try {
    wx.setStorageSync(KEY_LAST_ROOM_CODE, code);
  } catch (err) {
    // 忽略本地存储失败
  }
}

function getLastRoomCode() {
  try {
    return wx.getStorageSync(KEY_LAST_ROOM_CODE) || "";
  } catch (err) {
    return "";
  }
}

function setToken(token) {
  try {
    wx.setStorageSync(KEY_TOKEN, token);
  } catch (err) {
    // 忽略本地存储失败
  }
}

function getToken() {
  try {
    return wx.getStorageSync(KEY_TOKEN) || "";
  } catch (err) {
    return "";
  }
}

function setOpenId(openId) {
  try {
    wx.setStorageSync(KEY_OPEN_ID, openId);
  } catch (err) {
    // 忽略本地存储失败
  }
}

function getOpenId() {
  try {
    return wx.getStorageSync(KEY_OPEN_ID) || "";
  } catch (err) {
    return "";
  }
}

module.exports = {
  setLastRoomCode,
  getLastRoomCode,
  setToken,
  getToken,
  setOpenId,
  getOpenId
};
