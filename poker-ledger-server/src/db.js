const fs = require("fs");
const path = require("path");

const DEFAULT_DB = {
  users: {}, // { [openId]: { openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt } }
  userRoom: {}, // { [openId]: { roomCode, role, joinedAt } }
  rooms: {}, // { [roomCode]: { roomCode, ownerOpenId, status, createdAt, updatedAt, memberCount, totals, lastTxAt } }
  roomMembers: {}, // { [roomCode]: { [openId]: { openId, role, displayName, avatarUrl, joinedAt, active, updatedAt } } }
  roomTxs: {}, // { [roomCode]: Array<Tx> }（按 createdAt asc 存；读取时可倒序+limit）
  settlements: {} // { [roomCode]: Settlement }
};

/**
 * 确保目录存在。
 *
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 读取 JSON 文件（不存在则返回 null）。
 *
 * @param {string} filePath
 * @returns {any|null}
 */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * 原子写入 JSON（先写临时文件再替换）。
 *
 * @param {string} filePath
 * @param {any} data
 */
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  DEFAULT_DB,
  readJson,
  writeJsonAtomic,
  ensureDir
};

