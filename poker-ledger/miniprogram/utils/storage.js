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
// 本地开发身份标识 key：仅 develop 环境使用，让每个客户端实例模拟一个独立用户。
const KEY_DEV_USER_TAG = "PL_DEV_USER_TAG";

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

/**
 * 读取本地开发身份标识；不存在时生成一个并持久化。
 * 作用：同一个开发者工具账号/真机始终是同一个“虚拟用户”，不同实例之间互不相同，
 * 便于本地测试多人同房（房间成员、实时同步、结算分摊等）。
 *
 * @returns {string}
 */
function ensureDevUserTag() {
  try {
    const saved = String(wx.getStorageSync(KEY_DEV_USER_TAG) || "").trim();
    if (saved) return saved;

    // 4 位小写字母数字，足够区分本机几个实例
    const tag = Math.random().toString(36).slice(2, 6).padEnd(4, "x");
    wx.setStorageSync(KEY_DEV_USER_TAG, tag);
    return tag;
  } catch (err) {
    // 存储不可用时退化为固定标识，保证仍能登录
    return "local";
  }
}

/**
 * 读取本地开发身份标识（不生成）。
 *
 * @returns {string}
 */
function getDevUserTag() {
  try {
    return String(wx.getStorageSync(KEY_DEV_USER_TAG) || "").trim();
  } catch (err) {
    return "";
  }
}

/**
 * 写入指定开发身份标识。
 * 用途：让真机与开发者工具使用同一个虚拟账号（同一个 tag = 同一个用户）。
 *
 * @param {string} tag
 */
function setDevUserTag(tag) {
  const v = String(tag || "").trim().toLowerCase();
  try {
    wx.setStorageSync(KEY_DEV_USER_TAG, v);
  } catch (err) {
    // 忽略本地存储失败
  }
}

/**
 * 清除本地开发身份标识（下次启动会重新生成，相当于换一个虚拟用户）。
 */
function clearDevUserTag() {
  try {
    wx.removeStorageSync(KEY_DEV_USER_TAG);
  } catch (err) {
    // 忽略本地存储失败
  }
}

module.exports = {
  setToken,
  getToken,
  setOpenId,
  getOpenId,
  setPendingOwnerShareGuideRoom,
  consumePendingOwnerShareGuideRoom,
  ensureDevUserTag,
  getDevUserTag,
  setDevUserTag,
  clearDevUserTag
};
