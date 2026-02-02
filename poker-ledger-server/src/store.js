const path = require("path");
const { DEFAULT_DB, readJson, writeJsonAtomic, ensureDir } = require("./db");
const config = require("./config");

// 房间号字符集：去掉易混淆字符（0/O，1/I）
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LEN = 6;

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = config.DB_FILE ? path.resolve(config.DB_FILE) : path.join(DATA_DIR, "db.json");

ensureDir(DATA_DIR);

/**
 * 读盘初始化。
 */
let db = (() => {
  try {
    const fromDisk = readJson(DB_FILE);
    if (!fromDisk) return JSON.parse(JSON.stringify(DEFAULT_DB));
    return { ...JSON.parse(JSON.stringify(DEFAULT_DB)), ...fromDisk };
  } catch (err) {
    // 读盘失败时用默认库，避免服务直接起不来
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
})();

// 简易互斥锁：把所有写操作串行化，避免并发写导致状态错乱
let lockChain = Promise.resolve();

/**
 * 在互斥锁下执行，保证对 db 的读写一致性。
 *
 * @template T
 * @param {(db: any) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
function withLock(fn) {
  const run = async () => fn(db);
  const p = lockChain.then(run, run);
  lockChain = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

/**
 * 保存到磁盘（JSON）。
 */
function persist() {
  writeJsonAtomic(DB_FILE, db);
}

/**
 * 确保用户存在（若不存在则创建空档案）。
 *
 * @param {string} openId
 * @returns {any} user
 */
function ensureUser(openId) {
  const now = Date.now();
  const existed = db.users[openId];
  if (existed) return existed;

  const user = {
    openId,
    nickNameWx: "",
    avatarUrlWx: "",
    displayName: "",
    createdAt: now,
    updatedAt: now
  };
  db.users[openId] = user;
  return user;
}

/**
 * 生成房间号（短码+字母）。
 *
 * @returns {string}
 */
function genRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
    const idx = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

/**
 * 获取房间快照：room + members + txs（最近 200 笔，按 createdAt desc）。
 *
 * @param {string} roomCode
 * @returns {{room: any, members: any[], txs: any[]} | null}
 */
function getRoomSnapshot(roomCode) {
  const room = db.rooms[roomCode];
  if (!room) return null;

  const membersMap = db.roomMembers[roomCode] || {};
  const members = Object.values(membersMap);
  members.sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;
    return Number(a.joinedAt || 0) - Number(b.joinedAt || 0);
  });

  const txs = (db.roomTxs[roomCode] || []).slice(-200).slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return { room, members, txs };
}

/**
 * 计算房间 active 成员数。
 *
 * @param {string} roomCode
 * @returns {number}
 */
function calcActiveMemberCount(roomCode) {
  const membersMap = db.roomMembers[roomCode] || {};
  return Object.values(membersMap).filter((m) => m && m.active).length;
}

/**
 * 统一错误返回结构。
 *
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  return { ok: false, code, message };
}

module.exports = {
  DB_FILE,
  withLock,
  persist,
  ensureUser,
  genRoomCode,
  getRoomSnapshot,
  calcActiveMemberCount,
  fail,

  // 仅供路由层使用：读当前内存库（只读场景）
  _unsafeGetDb() {
    return db;
  }
};

