/**
 * 本地存储仅用于「轻量体验优化」：
 * - 缓存登录态 token / openId，便于恢复会话
 * - 记录房主首次分享引导的一次性标记
 * - 不作为业务真相来源（业务真相以后端为准）
 */
// JWT 本地缓存 key：用于小程序重启后快速恢复登录态。
const KEY_TOKEN = "PL_TOKEN";
// openId 本地缓存 key：与 token 配对恢复当前会话身份。
const KEY_OPEN_ID = "PL_OPEN_ID";
// 房主首次分享引导标记 key：只在创建房间后首次进入房间时消费一次。
const KEY_PENDING_OWNER_SHARE_GUIDE_ROOM = "PL_PENDING_OWNER_SHARE_GUIDE_ROOM";

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

/**
 * 记录“房主首次分享引导”待展示的房间号。
 * 设计为一次性标记：由 room 页读取后立即清除，避免重进小程序重复弹出。
 *
 * @param {string} roomCode
 */
function setPendingOwnerShareGuideRoom(roomCode) {
  const code = String(roomCode || "").trim().toUpperCase();
  try {
    wx.setStorageSync(KEY_PENDING_OWNER_SHARE_GUIDE_ROOM, code);
  } catch (err) {
    // 忽略本地存储失败
  }
}

/**
 * 消费“房主首次分享引导”标记。
 * 仅当当前 roomCode 与标记一致时返回 true，并清除标记。
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function consumePendingOwnerShareGuideRoom(roomCode) {
  const code = String(roomCode || "").trim().toUpperCase();
  if (!code) return false;

  try {
    const pending = String(wx.getStorageSync(KEY_PENDING_OWNER_SHARE_GUIDE_ROOM) || "")
      .trim()
      .toUpperCase();
    if (!pending || pending !== code) return false;
    wx.removeStorageSync(KEY_PENDING_OWNER_SHARE_GUIDE_ROOM);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  setToken,
  getToken,
  setOpenId,
  getOpenId,
  setPendingOwnerShareGuideRoom,
  consumePendingOwnerShareGuideRoom
};
