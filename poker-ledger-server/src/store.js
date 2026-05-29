const path = require("path");

const config = require("./config");
const { ensureDir } = require("./db");
const { openSqlite } = require("./sqlite");
const { importFromJsonIfNeeded } = require("./sqliteImport");
const logger = require("./logger");

// 房间号字符集：去掉易混淆字符（0/O，1/I）
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LEN = 6;
// 交易分页配置：MVP 阶段固定每页/快照均为 100，前后端保持一致。
const TX_SNAPSHOT_LIMIT = 100;
const TX_PAGE_DEFAULT_LIMIT = 100;
const TX_PAGE_MAX_LIMIT = 100;
const LEADERBOARD_DEFAULT_LIMIT = 100;
const LEADERBOARD_MAX_LIMIT = 200;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const LEADERBOARD_BACKFILL_META_KEY = "leaderboard_backfilled_v1";
const ADMIN_USER_PAGE_DEFAULT_SIZE = 20;
const ADMIN_USER_PAGE_MAX_SIZE = 100;
const ADMIN_PASSWORD_SALT_META_KEY = "admin.password.salt";
const ADMIN_PASSWORD_HASH_META_KEY = "admin.password.hash";

const DATA_DIR = path.join(__dirname, "..", "data");
ensureDir(DATA_DIR);

const DEFAULT_JSON_FILE = path.join(DATA_DIR, "db.json");
const DEFAULT_SQLITE_FILE = path.join(DATA_DIR, "db.sqlite");

/**
 * 统一错误返回结构。
 *
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 兼容历史配置：
 * - 优先使用 SQLITE_FILE
 * - 如果未设置 SQLITE_FILE 且 DB_FILE 不是 .json，则将 DB_FILE 视为 SQLite 路径
 */
function resolveSqliteFile() {
  const sqlite = String(config.SQLITE_FILE || "").trim();
  if (sqlite) return path.resolve(sqlite);

  const maybe = String(config.DB_FILE || "").trim();
  if (maybe && !maybe.toLowerCase().endsWith(".json")) return path.resolve(maybe);

  return DEFAULT_SQLITE_FILE;
}

/**
 * 旧 JSON 文件路径（仅用于首次迁移）。
 */
function resolveLegacyJsonFile() {
  const maybe = String(config.DB_FILE || "").trim();
  if (maybe && maybe.toLowerCase().endsWith(".json")) return path.resolve(maybe);
  return DEFAULT_JSON_FILE;
}

const DB_FILE = resolveLegacyJsonFile();
const SQLITE_FILE = resolveSqliteFile();

const db = openSqlite(SQLITE_FILE);

// 首次迁移：SQLite 为空且存在旧 JSON 时，导入后备份旧文件。
const importResult = importFromJsonIfNeeded(db, DB_FILE);
if (!importResult.ok) {
  logger.error({
    scope: "store",
    event: "store.sqlite.init_fail",
    msg: "SQLite 初始化失败",
    extra: {
      message: String(importResult.message || "")
    }
  });
  // 迁移失败时直接中止启动，避免误用空库导致“看似数据丢失”。
  throw new Error(importResult.message || "SQLite 初始化失败");
}

// 简易互斥锁：把所有写操作串行化（保持现有并发语义）。
let lockChain = Promise.resolve();

/**
 * 在互斥锁下执行。
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
function withLock(fn) {
  const run = async () => fn();
  const p = lockChain.then(run, run);
  lockChain = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

/**
 * 写操作统一包装：捕获非预期异常，避免把错误抛到 Express。
 *
 * @template T
 * @param {() => T} fn
 * @returns {Promise<T | {ok:false, code:string, message:string}>}
 */
function safeWrite(fn) {
  return withLock(() => {
    try {
      const r = fn();
      // 防御：本 store 的写方法全部使用同步事务；若误传入 Promise，避免漏捕获 rejection。
      if (r && typeof r.then === "function") {
        throw new Error("store 写入函数不应返回 Promise");
      }
      return r;
    } catch (err) {
      logger.error({
        scope: "store",
        event: "store.sqlite.write_exception",
        msg: "SQLite 写入异常",
        extra: {
          errMsg: String((err && err.message) || err || "")
        }
      });
      return fail("INTERNAL_ERROR", "服务繁忙，请稍后重试");
    }
  });
}

/**
 * @param {string} roomCode
 */
function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

/**
 * @param {any} r
 */
function rowToUser(r) {
  if (!r) return null;
  return {
    openId: String(r.openId || ""),
    nickNameWx: String(r.nickNameWx || ""),
    avatarUrlWx: String(r.avatarUrlWx || ""),
    displayName: String(r.displayName || ""),
    createdAt: Number(r.createdAt || 0),
    updatedAt: Number(r.updatedAt || 0)
  };
}

/**
 * @param {any} r
 */
function rowToUserRoom(r) {
  if (!r) return null;
  return {
    roomCode: normalizeRoomCode(r.roomCode),
    role: String(r.role || ""),
    joinedAt: Number(r.joinedAt || 0)
  };
}

/**
 * 交易行转为对外结构。
 *
 * @param {any} row
 * @param {string} roomCode
 */
function rowToTx(row, roomCode) {
  return {
    id: String(row.id || ""),
    roomCode: normalizeRoomCode(row.roomCode || roomCode),
    fromOpenId: String(row.fromOpenId || ""),
    toOpenId: String(row.toOpenId || ""),
    amount: Number(row.amount || 0),
    note: String(row.note || ""),
    createdAt: Number(row.createdAt || 0),
    fromName: String(row.fromName || ""),
    toName: String(row.toName || ""),
    fromAvatar: String(row.fromAvatar || ""),
    toAvatar: String(row.toAvatar || "")
  };
}

/**
 * 交易分页条数归一化。
 *
 * @param {any} limit
 * @returns {number}
 */
function normalizeTxPageLimit(limit) {
  const n = Number(limit || 0);
  if (!Number.isInteger(n) || n <= 0) return TX_PAGE_DEFAULT_LIMIT;
  return Math.min(TX_PAGE_MAX_LIMIT, n);
}

/**
 * 排行榜分页条数归一化。
 *
 * @param {any} limit
 * @returns {number}
 */
function normalizeLeaderboardLimit(limit) {
  const n = Number(limit || 0);
  if (!Number.isInteger(n) || n <= 0) return LEADERBOARD_DEFAULT_LIMIT;
  return Math.min(LEADERBOARD_MAX_LIMIT, n);
}

/**
 * 历史分页条数归一化。
 *
 * @param {any} limit
 * @returns {number}
 */
function normalizeHistoryLimit(limit) {
  const n = Number(limit || 0);
  if (!Number.isInteger(n) || n <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(HISTORY_MAX_LIMIT, n);
}

/**
 * 归一化后台分页参数，避免后台一次性拉取过多用户。
 *
 * @param {any} page
 * @param {any} pageSize
 */
function normalizeAdminUserPage(page, pageSize) {
  const p = Number(page || 1);
  const ps = Number(pageSize || ADMIN_USER_PAGE_DEFAULT_SIZE);
  const safePage = Number.isInteger(p) && p > 0 ? p : 1;
  const safePageSize = Number.isInteger(ps) && ps > 0
    ? Math.min(ps, ADMIN_USER_PAGE_MAX_SIZE)
    : ADMIN_USER_PAGE_DEFAULT_SIZE;
  return {
    page: safePage,
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize
  };
}

/**
 * 后台用户字段统一归一化和校验。
 *
 * @param {any} payload
 * @param {{ requireOpenId?: boolean }} options
 */
function normalizeAdminUserPayload(payload, options) {
  const source = payload && typeof payload === "object" ? payload : {};
  const opts = options || {};
  const out = {};

  if (opts.requireOpenId || Object.prototype.hasOwnProperty.call(source, "openId")) {
    out.openId = String(source.openId || "").trim();
    if (!out.openId) return fail("INVALID_OPENID", "openId 不能为空");
    if (out.openId.length > 128) return fail("INVALID_OPENID", "openId 过长");
  }

  for (const key of ["nickNameWx", "avatarUrlWx", "displayName"]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = String(source[key] || "").trim();
    }
  }

  if (Object.prototype.hasOwnProperty.call(out, "nickNameWx") && out.nickNameWx.length > 50) {
    return fail("INVALID_NICKNAME", "微信昵称过长");
  }
  if (Object.prototype.hasOwnProperty.call(out, "avatarUrlWx") && out.avatarUrlWx.length > 1000) {
    return fail("INVALID_AVATAR", "头像地址过长");
  }
  if (Object.prototype.hasOwnProperty.call(out, "displayName") && out.displayName.length > 20) {
    return fail("INVALID_DISPLAY_NAME", "展示昵称过长");
  }

  return { ok: true, data: out };
}

/**
 * 胜率计算：平局不计分母。
 *
 * @param {number} winCount
 * @param {number} lossCount
 * @returns {number}
 */
function calcWinRate(winCount, lossCount) {
  const win = Number(winCount || 0);
  const loss = Number(lossCount || 0);
  const denom = win + loss;
  if (denom <= 0) return 0;
  return win / denom;
}

/**
 * 查询房间交易分页（createdAt/id 双游标，避免同毫秒记录翻页错乱）。
 *
 * @param {string} roomCode
 * @param {number|null} beforeCreatedAt
 * @param {string|null} beforeId
 * @param {number} limit
 * @returns {{txs:any[], hasMore:boolean, nextBeforeCreatedAt:number|null, nextBeforeId:string|null}}
 */
function queryRoomTxPage(roomCode, beforeCreatedAt, beforeId, limit) {
  const rc = normalizeRoomCode(roomCode);
  const pageLimit = normalizeTxPageLimit(limit);
  const fetchLimit = pageLimit + 1;

  const cursorCreatedAt = Number(beforeCreatedAt || 0);
  const cursorId = String(beforeId || "").trim();
  const hasCursor = Number.isInteger(cursorCreatedAt) && cursorCreatedAt > 0 && !!cursorId;

  const rows = hasCursor
    ? stmt.listRoomTxsBefore.all(rc, cursorCreatedAt, cursorCreatedAt, cursorId, fetchLimit)
    : stmt.listRoomTxsLatest.all(rc, fetchLimit);

  const pageRows = rows.slice(0, pageLimit);
  const txs = pageRows.map((row) => rowToTx(row, rc));
  const hasMore = rows.length > pageLimit;

  let nextBeforeCreatedAt = null;
  let nextBeforeId = null;
  if (hasMore && pageRows.length > 0) {
    const tail = pageRows[pageRows.length - 1];
    nextBeforeCreatedAt = Number(tail.createdAt || 0);
    nextBeforeId = String(tail.id || "");
  }

  return { txs, hasMore, nextBeforeCreatedAt, nextBeforeId };
}

/**
 * 查询“我参与过的历史结算”分页（dissolvedAt/roomCode 双游标）。
 *
 * @param {string} openId
 * @param {number|null} beforeDissolvedAt
 * @param {string|null} beforeRoomCode
 * @param {number} limit
 * @returns {{rows:any[], hasMore:boolean, nextBeforeDissolvedAt:number|null, nextBeforeRoomCode:string|null}}
 */
function queryMySettlementHistoryPage(openId, beforeDissolvedAt, beforeRoomCode, limit) {
  const oid = String(openId || "");
  const pageLimit = normalizeHistoryLimit(limit);
  const fetchLimit = pageLimit + 1;

  const cursorDissolvedAt = Number(beforeDissolvedAt || 0);
  const cursorRoomCode = normalizeRoomCode(beforeRoomCode);
  const hasCursor = Number.isInteger(cursorDissolvedAt) && cursorDissolvedAt > 0 && !!cursorRoomCode;

  const rows = hasCursor
    ? stmt.listMySettlementHistoryBefore.all(oid, cursorDissolvedAt, cursorDissolvedAt, cursorRoomCode, fetchLimit)
    : stmt.listMySettlementHistoryLatest.all(oid, fetchLimit);

  const pageRows = rows.slice(0, pageLimit).map((row) => ({
    settlementId: normalizeRoomCode(row.roomCode),
    roomCode: normalizeRoomCode(row.roomCode),
    dissolvedAt: Number(row.dissolvedAt || 0),
    txCount: Number(row.txCount || 0),
    myAmount: Number(row.myAmount || 0)
  }));
  const hasMore = rows.length > pageLimit;

  let nextBeforeDissolvedAt = null;
  let nextBeforeRoomCode = null;
  if (hasMore && pageRows.length > 0) {
    const tail = pageRows[pageRows.length - 1];
    nextBeforeDissolvedAt = Number(tail.dissolvedAt || 0);
    nextBeforeRoomCode = String(tail.roomCode || "");
  }

  return {
    rows: pageRows,
    hasMore,
    nextBeforeDissolvedAt,
    nextBeforeRoomCode
  };
}

/**
 * 查询时间线结算分页（支持 mine/all，dissolvedAt/roomCode 双游标）。
 *
 * @param {string} openId
 * @param {"mine"|"all"} scope
 * @param {number|null} beforeDissolvedAt
 * @param {string|null} beforeRoomCode
 * @param {number} limit
 * @returns {{rows:any[], hasMore:boolean, nextBeforeDissolvedAt:number|null, nextBeforeRoomCode:string|null}}
 */
function querySettlementTimelinePage(openId, scope, beforeDissolvedAt, beforeRoomCode, limit) {
  const oid = String(openId || "");
  const queryScope = scope === "all" ? "all" : "mine";
  const pageLimit = normalizeHistoryLimit(limit);
  const fetchLimit = pageLimit + 1;

  const cursorDissolvedAt = Number(beforeDissolvedAt || 0);
  const cursorRoomCode = normalizeRoomCode(beforeRoomCode);
  const hasCursor = Number.isInteger(cursorDissolvedAt) && cursorDissolvedAt > 0 && !!cursorRoomCode;

  let rows = [];
  if (queryScope === "all") {
    rows = hasCursor
      ? stmt.listSettlementTimelineBefore.all(cursorDissolvedAt, cursorDissolvedAt, cursorRoomCode, fetchLimit)
      : stmt.listSettlementTimelineLatest.all(fetchLimit);
  } else {
    rows = hasCursor
      ? stmt.listMySettlementTimelineBefore.all(oid, cursorDissolvedAt, cursorDissolvedAt, cursorRoomCode, fetchLimit)
      : stmt.listMySettlementTimelineLatest.all(oid, fetchLimit);
  }

  const pageRows = rows.slice(0, pageLimit).map((row) => ({
    roomCode: normalizeRoomCode(row.roomCode),
    ownerOpenId: String(row.ownerOpenId || ""),
    dissolvedAt: Number(row.dissolvedAt || 0),
    txCount: Number(row.txCount || 0)
  }));
  const hasMore = rows.length > pageLimit;

  let nextBeforeDissolvedAt = null;
  let nextBeforeRoomCode = null;
  if (hasMore && pageRows.length > 0) {
    const tail = pageRows[pageRows.length - 1];
    nextBeforeDissolvedAt = Number(tail.dissolvedAt || 0);
    nextBeforeRoomCode = String(tail.roomCode || "");
  }

  return {
    rows: pageRows,
    hasMore,
    nextBeforeDissolvedAt,
    nextBeforeRoomCode
  };
}

/**
 * 把时间线记录转换为对外结构（附成员输赢与我的状态）。
 *
 * @param {string} openId
 * @param {{roomCode:string, ownerOpenId:string, txCount:number, dissolvedAt:number}} row
 */
function buildTimelineRow(openId, row) {
  const oid = String(openId || "");
  const roomCode = normalizeRoomCode(row.roomCode);
  const settlement = buildSettlementPayload(roomCode, {
    ownerOpenId: String(row.ownerOpenId || ""),
    txCount: Number(row.txCount || 0),
    dissolvedAt: Number(row.dissolvedAt || 0)
  });

  const totals = settlement.totals || {};
  const members = (settlement.membersSnapshot || []).map((m) => {
    const amountRaw = totals[m.openId];
    const amount = Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : 0;
    return {
      openId: String(m.openId || ""),
      displayName: String(m.displayName || ""),
      role: String(m.role || ""),
      active: !!m.active,
      amount
    };
  });

  members.sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;

    const absDiff = Math.abs(b.amount) - Math.abs(a.amount);
    if (absDiff !== 0) return absDiff;

    const nameDiff = String(a.displayName || "").localeCompare(String(b.displayName || ""));
    if (nameDiff !== 0) return nameDiff;
    return String(a.openId || "").localeCompare(String(b.openId || ""));
  });

  const joined = members.some((m) => m.openId === oid);
  const myAmountRaw = totals[oid];
  const myAmount = joined ? (Number.isFinite(Number(myAmountRaw)) ? Number(myAmountRaw) : 0) : null;
  let myStatus = "not_joined";
  if (joined) {
    if (Number(myAmount || 0) > 0) myStatus = "win";
    else if (Number(myAmount || 0) < 0) myStatus = "loss";
    else myStatus = "draw";
  }

  return {
    settlementId: roomCode,
    roomCode,
    dissolvedAt: settlement.dissolvedAt,
    txCount: settlement.txCount,
    myAmount,
    myStatus,
    memberCount: members.length,
    members
  };
}

const stmt = {
  getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
  upsertMeta: db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)"),

  getUser: db.prepare("SELECT openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt FROM users WHERE openId = ?"),
  getAdminUser: db.prepare(
    "SELECT u.openId, u.nickNameWx, u.avatarUrlWx, u.displayName, u.createdAt, u.updatedAt, " +
      "ur.roomCode AS currentRoomCode, ur.role AS currentRole, ur.joinedAt AS currentJoinedAt " +
      "FROM users u LEFT JOIN user_room ur ON ur.openId = u.openId WHERE u.openId = ?"
  ),
  insertUserIgnore: db.prepare(
    "INSERT OR IGNORE INTO users(openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt) VALUES (?, '', '', '', ?, ?)"
  ),
  insertAdminUser: db.prepare(
    "INSERT INTO users(openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  updateAdminUser: db.prepare(
    "UPDATE users SET nickNameWx = ?, avatarUrlWx = ?, displayName = ?, updatedAt = ? WHERE openId = ?"
  ),
  deleteUser: db.prepare("DELETE FROM users WHERE openId = ?"),
  countAdminUsers: db.prepare(
    "SELECT COUNT(*) AS c FROM users u " +
      "WHERE (? = '' OR u.openId LIKE ? OR u.nickNameWx LIKE ? OR u.displayName LIKE ?)"
  ),
  listAdminUsers: db.prepare(
    "SELECT u.openId, u.nickNameWx, u.avatarUrlWx, u.displayName, u.createdAt, u.updatedAt, " +
      "ur.roomCode AS currentRoomCode, ur.role AS currentRole, ur.joinedAt AS currentJoinedAt " +
      "FROM users u LEFT JOIN user_room ur ON ur.openId = u.openId " +
      "WHERE (? = '' OR u.openId LIKE ? OR u.nickNameWx LIKE ? OR u.displayName LIKE ?) " +
      "ORDER BY u.updatedAt DESC, u.openId ASC LIMIT ? OFFSET ?"
  ),

  getUserRoom: db.prepare("SELECT openId, roomCode, role, joinedAt FROM user_room WHERE openId = ?"),
  insertUserRoom: db.prepare("INSERT OR REPLACE INTO user_room(openId, roomCode, role, joinedAt) VALUES (?, ?, ?, ?)"),
  deleteUserRoomByOpenId: db.prepare("DELETE FROM user_room WHERE openId = ?"),
  deleteUserRoomByRoomCode: db.prepare("DELETE FROM user_room WHERE roomCode = ?"),

  getRoom: db.prepare(
    "SELECT roomCode, ownerOpenId, status, createdAt, updatedAt, memberCount, lastTxAt FROM rooms WHERE roomCode = ?"
  ),
  insertRoom: db.prepare(
    "INSERT INTO rooms(roomCode, ownerOpenId, status, createdAt, updatedAt, memberCount, lastTxAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  updateRoomMemberCount: db.prepare("UPDATE rooms SET memberCount = ?, updatedAt = ? WHERE roomCode = ?"),
  updateRoomLastTx: db.prepare("UPDATE rooms SET lastTxAt = ?, updatedAt = ? WHERE roomCode = ?"),
  deleteRoom: db.prepare("DELETE FROM rooms WHERE roomCode = ?"),

  getRoomMember: db.prepare(
    "SELECT roomCode, openId, role, displayName, avatarUrl, joinedAt, active, updatedAt FROM room_members WHERE roomCode = ? AND openId = ?"
  ),
  listRoomMembers: db.prepare(
    "SELECT roomCode, openId, role, displayName, avatarUrl, joinedAt, active, updatedAt FROM room_members WHERE roomCode = ?"
  ),
  upsertRoomMember: db.prepare(
    "INSERT OR REPLACE INTO room_members(roomCode, openId, role, displayName, avatarUrl, joinedAt, active, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  setRoomMemberInactive: db.prepare("UPDATE room_members SET active = 0, updatedAt = ? WHERE roomCode = ? AND openId = ?"),
  updateRoomMemberDisplayName: db.prepare(
    "UPDATE room_members SET displayName = ?, updatedAt = ? WHERE roomCode = ? AND openId = ?"
  ),
  updateRoomMemberProfile: db.prepare(
    "UPDATE room_members SET displayName = ?, avatarUrl = ?, updatedAt = ? WHERE roomCode = ? AND openId = ?"
  ),
  countActiveMembers: db.prepare("SELECT COUNT(*) AS c FROM room_members WHERE roomCode = ? AND active = 1"),
  deleteRoomMembers: db.prepare("DELETE FROM room_members WHERE roomCode = ?"),

  listRoomTotals: db.prepare("SELECT openId, total FROM room_totals WHERE roomCode = ?"),
  insertRoomTotalIgnore: db.prepare("INSERT OR IGNORE INTO room_totals(roomCode, openId, total) VALUES (?, ?, 0)"),
  addRoomTotal: db.prepare("UPDATE room_totals SET total = total + ? WHERE roomCode = ? AND openId = ?"),
  subRoomTotal: db.prepare("UPDATE room_totals SET total = total - ? WHERE roomCode = ? AND openId = ?"),
  deleteRoomTotals: db.prepare("DELETE FROM room_totals WHERE roomCode = ?"),

  listRoomTxsLatest: db.prepare(
    "SELECT id, roomCode, fromOpenId, toOpenId, amount, note, createdAt, fromName, toName, fromAvatar, toAvatar FROM room_txs WHERE roomCode = ? ORDER BY createdAt DESC, id DESC LIMIT ?"
  ),
  listRoomTxsBefore: db.prepare(
    "SELECT id, roomCode, fromOpenId, toOpenId, amount, note, createdAt, fromName, toName, fromAvatar, toAvatar FROM room_txs WHERE roomCode = ? AND (createdAt < ? OR (createdAt = ? AND id < ?)) ORDER BY createdAt DESC, id DESC LIMIT ?"
  ),
  insertTx: db.prepare(
    "INSERT INTO room_txs(id, roomCode, fromOpenId, toOpenId, amount, note, createdAt, fromName, toName, fromAvatar, toAvatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  countRoomTxs: db.prepare("SELECT COUNT(*) AS c FROM room_txs WHERE roomCode = ?"),
  deleteRoomTxs: db.prepare("DELETE FROM room_txs WHERE roomCode = ?"),

  updateUserProfile: db.prepare(
    "UPDATE users SET nickNameWx = COALESCE(?, nickNameWx), avatarUrlWx = COALESCE(?, avatarUrlWx), displayName = ?, updatedAt = ? WHERE openId = ?"
  ),

  upsertSettlement: db.prepare(
    "INSERT OR REPLACE INTO settlements(roomCode, ownerOpenId, txCount, dissolvedAt) VALUES (?, ?, ?, ?)"
  ),
  deleteSettlementTotals: db.prepare("DELETE FROM settlement_totals WHERE roomCode = ?"),
  deleteSettlementMembers: db.prepare("DELETE FROM settlement_members WHERE roomCode = ?"),
  insertSettlementTotal: db.prepare("INSERT OR REPLACE INTO settlement_totals(roomCode, openId, total) VALUES (?, ?, ?)"),
  insertSettlementMember: db.prepare(
    "INSERT OR REPLACE INTO settlement_members(roomCode, seq, openId, displayName, avatarUrl, role, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  getSettlement: db.prepare("SELECT roomCode, ownerOpenId, txCount, dissolvedAt FROM settlements WHERE roomCode = ?"),
  getSettlementMemberByOpenId: db.prepare("SELECT roomCode, openId FROM settlement_members WHERE roomCode = ? AND openId = ?"),
  listSettlementTimelineLatest: db.prepare(
    "SELECT roomCode, ownerOpenId, txCount, dissolvedAt FROM settlements ORDER BY dissolvedAt DESC, roomCode DESC LIMIT ?"
  ),
  listSettlementTimelineBefore: db.prepare(
    "SELECT roomCode, ownerOpenId, txCount, dissolvedAt FROM settlements WHERE (dissolvedAt < ? OR (dissolvedAt = ? AND roomCode < ?)) ORDER BY dissolvedAt DESC, roomCode DESC LIMIT ?"
  ),
  listMySettlementTimelineLatest: db.prepare(
    "SELECT s.roomCode, s.ownerOpenId, s.txCount, s.dissolvedAt " +
      "FROM settlement_members sm " +
      "INNER JOIN settlements s ON s.roomCode = sm.roomCode " +
      "WHERE sm.openId = ? " +
      "ORDER BY s.dissolvedAt DESC, s.roomCode DESC LIMIT ?"
  ),
  listMySettlementTimelineBefore: db.prepare(
    "SELECT s.roomCode, s.ownerOpenId, s.txCount, s.dissolvedAt " +
      "FROM settlement_members sm " +
      "INNER JOIN settlements s ON s.roomCode = sm.roomCode " +
      "WHERE sm.openId = ? AND (s.dissolvedAt < ? OR (s.dissolvedAt = ? AND s.roomCode < ?)) " +
      "ORDER BY s.dissolvedAt DESC, s.roomCode DESC LIMIT ?"
  ),
  listMySettlementHistoryLatest: db.prepare(
    "SELECT s.roomCode, s.dissolvedAt, s.txCount, COALESCE(st.total, 0) AS myAmount " +
      "FROM settlement_members sm " +
      "INNER JOIN settlements s ON s.roomCode = sm.roomCode " +
      "LEFT JOIN settlement_totals st ON st.roomCode = sm.roomCode AND st.openId = sm.openId " +
      "WHERE sm.openId = ? " +
      "ORDER BY s.dissolvedAt DESC, s.roomCode DESC LIMIT ?"
  ),
  listMySettlementHistoryBefore: db.prepare(
    "SELECT s.roomCode, s.dissolvedAt, s.txCount, COALESCE(st.total, 0) AS myAmount " +
      "FROM settlement_members sm " +
      "INNER JOIN settlements s ON s.roomCode = sm.roomCode " +
      "LEFT JOIN settlement_totals st ON st.roomCode = sm.roomCode AND st.openId = sm.openId " +
      "WHERE sm.openId = ? AND (s.dissolvedAt < ? OR (s.dissolvedAt = ? AND s.roomCode < ?)) " +
      "ORDER BY s.dissolvedAt DESC, s.roomCode DESC LIMIT ?"
  ),
  listSettlements: db.prepare("SELECT roomCode, dissolvedAt FROM settlements ORDER BY dissolvedAt ASC, roomCode ASC"),
  listSettlementTotals: db.prepare("SELECT openId, total FROM settlement_totals WHERE roomCode = ?"),
  listSettlementMembers: db.prepare(
    "SELECT seq, openId, displayName, avatarUrl, role, active FROM settlement_members WHERE roomCode = ? ORDER BY seq ASC"
  ),

  clearLeaderboardStats: db.prepare("DELETE FROM leaderboard_stats"),
  deleteLeaderboardStats: db.prepare("DELETE FROM leaderboard_stats WHERE openId = ?"),
  upsertLeaderboardStats: db.prepare(
    "INSERT INTO leaderboard_stats(openId, displayName, avatarUrl, winCount, lossCount, drawCount, matchCount, netProfit, lastSettlementAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(openId) DO UPDATE SET " +
      "displayName = CASE WHEN excluded.displayName <> '' THEN excluded.displayName ELSE leaderboard_stats.displayName END, " +
      "avatarUrl = CASE WHEN excluded.avatarUrl <> '' THEN excluded.avatarUrl ELSE leaderboard_stats.avatarUrl END, " +
      "winCount = leaderboard_stats.winCount + excluded.winCount, " +
      "lossCount = leaderboard_stats.lossCount + excluded.lossCount, " +
      "drawCount = leaderboard_stats.drawCount + excluded.drawCount, " +
      "matchCount = leaderboard_stats.matchCount + excluded.matchCount, " +
      "netProfit = leaderboard_stats.netProfit + excluded.netProfit, " +
      "lastSettlementAt = CASE WHEN excluded.lastSettlementAt > leaderboard_stats.lastSettlementAt THEN excluded.lastSettlementAt ELSE leaderboard_stats.lastSettlementAt END, " +
      "updatedAt = excluded.updatedAt"
  ),
  countLeaderboardStats: db.prepare("SELECT COUNT(*) AS c FROM leaderboard_stats"),
  listLeaderboardStats: db.prepare(
    "SELECT openId, displayName, avatarUrl, winCount, lossCount, drawCount, matchCount, netProfit, lastSettlementAt FROM leaderboard_stats"
  )
};

/**
 * 获取用户档案（不存在则返回 null）。
 *
 * @param {string} openId
 */
function getUser(openId) {
  return rowToUser(stmt.getUser.get(String(openId || "")));
}

/**
 * 后台用户行转为管理端展示结构。
 *
 * @param {any} r
 */
function rowToAdminUser(r) {
  if (!r) return null;
  return {
    openId: String(r.openId || ""),
    nickNameWx: String(r.nickNameWx || ""),
    avatarUrlWx: String(r.avatarUrlWx || ""),
    displayName: String(r.displayName || ""),
    createdAt: Number(r.createdAt || 0),
    updatedAt: Number(r.updatedAt || 0),
    currentRoom: r.currentRoomCode
      ? {
          roomCode: normalizeRoomCode(r.currentRoomCode),
          role: String(r.currentRole || ""),
          joinedAt: Number(r.currentJoinedAt || 0)
        }
      : null
  };
}

/**
 * 获取用户所在房间映射（不存在则返回 null）。
 *
 * @param {string} openId
 */
function getUserRoom(openId) {
  return rowToUserRoom(stmt.getUserRoom.get(String(openId || "")));
}

/**
 * 确保用户存在（若不存在则创建空档案）。
 *
 * @param {string} openId
 * @returns {any} user
 */
function ensureUser(openId) {
  const oid = String(openId || "");
  const now = Date.now();
  stmt.insertUserIgnore.run(oid, now, now);
  return getUser(oid);
}

/**
 * 生成房间号（短码+字母）。
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
 * 获取房间快照：room + members + txs（最新窗口 100 笔，支持继续分页）。
 *
 * @param {string} roomCode
 * @returns {{
 *   room: any,
 *   members: any[],
 *   txs: any[],
 *   txHasMore: boolean,
 *   txNextBeforeCreatedAt: number | null,
 *   txNextBeforeId: string | null
 * } | null}
 */
function getRoomSnapshot(roomCode) {
  const rc = normalizeRoomCode(roomCode);
  const roomRow = stmt.getRoom.get(rc);
  if (!roomRow) return null;

  const totalsRows = stmt.listRoomTotals.all(rc);
  const totals = {};
  for (const r of totalsRows) {
    totals[String(r.openId || "")] = Number(r.total || 0);
  }

  const room = {
    roomCode: normalizeRoomCode(roomRow.roomCode),
    ownerOpenId: String(roomRow.ownerOpenId || ""),
    status: String(roomRow.status || ""),
    createdAt: Number(roomRow.createdAt || 0),
    updatedAt: Number(roomRow.updatedAt || 0),
    memberCount: Number(roomRow.memberCount || 0),
    totals,
    lastTxAt: Number(roomRow.lastTxAt || 0)
  };

  const members = stmt.listRoomMembers.all(rc).map((m) => ({
    openId: String(m.openId || ""),
    role: String(m.role || ""),
    displayName: String(m.displayName || ""),
    avatarUrl: String(m.avatarUrl || ""),
    joinedAt: Number(m.joinedAt || 0),
    active: !!m.active,
    updatedAt: Number(m.updatedAt || 0)
  }));

  members.sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;
    return Number(a.joinedAt || 0) - Number(b.joinedAt || 0);
  });

  const txPage = queryRoomTxPage(rc, null, null, TX_SNAPSHOT_LIMIT);

  return {
    room,
    members,
    txs: txPage.txs,
    txHasMore: txPage.hasMore,
    txNextBeforeCreatedAt: txPage.nextBeforeCreatedAt,
    txNextBeforeId: txPage.nextBeforeId
  };
}

/**
 * 获取交易历史分页（按 createdAt desc, id desc）。
 *
 * @param {string} roomCode
 * @param {number|null} beforeCreatedAt
 * @param {string|null} beforeId
 * @param {number} limit
 */
function listRoomTxPage(roomCode, beforeCreatedAt, beforeId, limit) {
  return queryRoomTxPage(roomCode, beforeCreatedAt, beforeId, limit);
}

/**
 * 按单次结算结果累计排行榜数据。
 *
 * @param {{[openId: string]: number}} totals
 * @param {{openId: string, displayName: string, avatarUrl: string}[]} membersSnapshot
 * @param {number} dissolvedAt
 */
function upsertLeaderboardBySettlement(totals, membersSnapshot, dissolvedAt) {
  const profileMap = {};
  const members = Array.isArray(membersSnapshot) ? membersSnapshot : [];
  for (const m of members) {
    if (!m) continue;
    const openId = String(m.openId || "").trim();
    if (!openId) continue;
    profileMap[openId] = {
      displayName: String(m.displayName || ""),
      avatarUrl: String(m.avatarUrl || "")
    };
  }

  const totalMap = totals && typeof totals === "object" ? totals : {};
  const openIdSet = new Set(Object.keys(totalMap));
  for (const oid of Object.keys(profileMap)) openIdSet.add(oid);

  const settledAt = Number(dissolvedAt || 0);
  const updatedAt = Date.now();
  for (const openId of openIdSet) {
    const oid = String(openId || "").trim();
    if (!oid) continue;

    const amount = Number(totalMap[oid] || 0);
    let winCount = 0;
    let lossCount = 0;
    let drawCount = 0;
    if (amount > 0) {
      winCount = 1;
    } else if (amount < 0) {
      lossCount = 1;
    } else {
      drawCount = 1;
    }

    const profile = profileMap[oid] || {};
    stmt.upsertLeaderboardStats.run(
      oid,
      String(profile.displayName || ""),
      String(profile.avatarUrl || ""),
      winCount,
      lossCount,
      drawCount,
      1,
      amount,
      settledAt,
      updatedAt
    );
  }
}

/**
 * 启动时回填排行榜（仅一次）。
 * - 仅从已存储的结算记录回放，避免因 roomCode 复用导致重复累计。
 * - 通过 meta 标记保证幂等。
 */
function backfillLeaderboardIfNeeded() {
  const tx = db.transaction(() => {
    const marked = stmt.getMeta.get(LEADERBOARD_BACKFILL_META_KEY);
    if (marked && String(marked.value || "") === "true") {
      return { skipped: true, settlementCount: 0 };
    }

    stmt.clearLeaderboardStats.run();

    const settlements = stmt.listSettlements.all();
    for (const s of settlements) {
      if (!s) continue;
      const roomCode = normalizeRoomCode(s.roomCode);
      if (!roomCode) continue;

      const totalsRows = stmt.listSettlementTotals.all(roomCode);
      const totals = {};
      for (const t of totalsRows) {
        totals[String(t.openId || "")] = Number(t.total || 0);
      }

      const membersSnapshot = stmt.listSettlementMembers.all(roomCode).map((m) => ({
        openId: String(m.openId || ""),
        displayName: String(m.displayName || ""),
        avatarUrl: String(m.avatarUrl || "")
      }));

      upsertLeaderboardBySettlement(totals, membersSnapshot, Number(s.dissolvedAt || 0));
    }

    stmt.upsertMeta.run(LEADERBOARD_BACKFILL_META_KEY, "true");
    return { skipped: false, settlementCount: settlements.length };
  });

  try {
    const r = tx();
    logger.info({
      scope: "store",
      event: "store.leaderboard.backfill",
      msg: r.skipped ? "排行榜历史回填已跳过" : "排行榜历史回填完成",
      extra: {
        skipped: !!r.skipped,
        settlementCount: Number(r.settlementCount || 0)
      }
    });
  } catch (err) {
    logger.error({
      scope: "store",
      event: "store.leaderboard.backfill_fail",
      msg: "排行榜历史回填失败",
      extra: {
        errMsg: String((err && err.message) || err || "")
      }
    });
    throw err;
  }
}

/**
 * 登录时：确保用户存在。
 *
 * @param {string} openId
 */
function ensureUserForLogin(openId) {
  return safeWrite(() => {
    const tx = db.transaction(() => {
      ensureUser(openId);
      return { ok: true };
    });
    return tx();
  });
}

/**
 * 注销账号（仅删除用户档案；要求不在房间中）。
 *
 * @param {string} openId
 */
function deactivateUser(openId) {
  return safeWrite(() => {
    const oid = String(openId || "");
    const tx = db.transaction(() => {
      const mapping = getUserRoom(oid);
      if (mapping) return fail("IN_ROOM", "请先退出房间后再注销账号");
      stmt.deleteUser.run(oid);
      return { ok: true };
    });
    return tx();
  });
}

/**
 * 保存用户资料（微信头像/昵称 + 展示昵称）。
 *
 * @param {string} openId
 * @param {{nickNameWx: string|null, avatarUrlWx: string|null, displayName: string}} payload
 */
function updateUserProfile(openId, payload) {
  return safeWrite(() => {
    const oid = String(openId || "");
    const nickNameWx = Object.prototype.hasOwnProperty.call(payload || {}, "nickNameWx") ? payload.nickNameWx : null;
    const avatarUrlWx = Object.prototype.hasOwnProperty.call(payload || {}, "avatarUrlWx") ? payload.avatarUrlWx : null;
    const displayName = String((payload && payload.displayName) || "");

    const tx = db.transaction(() => {
      ensureUser(oid);
      const now = Date.now();
      stmt.updateUserProfile.run(nickNameWx, avatarUrlWx, displayName, now, oid);

      const mapping = getUserRoom(oid);
      if (mapping && mapping.roomCode) {
        if (avatarUrlWx !== null) {
          stmt.updateRoomMemberProfile.run(displayName, String(avatarUrlWx || ""), now, mapping.roomCode, oid);
        } else {
          stmt.updateRoomMemberDisplayName.run(displayName, now, mapping.roomCode, oid);
        }
      }

      return { ok: true, user: getUser(oid) };
    });

    return tx();
  });
}

/**
 * 读取后台管理员密码摘要配置。
 */
function getAdminPasswordRecord() {
  const salt = stmt.getMeta.get(ADMIN_PASSWORD_SALT_META_KEY);
  const hash = stmt.getMeta.get(ADMIN_PASSWORD_HASH_META_KEY);
  return {
    salt: salt ? String(salt.value || "") : "",
    hash: hash ? String(hash.value || "") : ""
  };
}

/**
 * 保存后台管理员密码摘要。
 *
 * @param {string} salt
 * @param {string} hash
 */
function saveAdminPasswordRecord(salt, hash) {
  return safeWrite(() => {
    const nextSalt = String(salt || "").trim();
    const nextHash = String(hash || "").trim();
    if (!nextSalt || !nextHash) return fail("INVALID_ADMIN_PASSWORD", "管理员密码摘要无效");

    const tx = db.transaction(() => {
      stmt.upsertMeta.run(ADMIN_PASSWORD_SALT_META_KEY, nextSalt);
      stmt.upsertMeta.run(ADMIN_PASSWORD_HASH_META_KEY, nextHash);
      return { ok: true };
    });
    return tx();
  });
}

/**
 * 后台分页查询用户。
 *
 * @param {{ q?: any, page?: any, pageSize?: any }} query
 */
function listAdminUsers(query) {
  const q = String((query && query.q) || "").trim();
  const { page, pageSize, offset } = normalizeAdminUserPage(query && query.page, query && query.pageSize);
  const like = `%${q}%`;
  const total = Number((stmt.countAdminUsers.get(q, like, like, like) || {}).c || 0);
  const rows = stmt.listAdminUsers.all(q, like, like, like, pageSize, offset).map(rowToAdminUser);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    page,
    pageSize,
    total,
    totalPages,
    rows
  };
}

/**
 * 后台读取单个用户详情。
 *
 * @param {string} openId
 */
function getAdminUser(openId) {
  const oid = String(openId || "").trim();
  if (!oid) return fail("INVALID_OPENID", "openId 不能为空");

  const user = rowToAdminUser(stmt.getAdminUser.get(oid));
  if (!user) return fail("NOT_FOUND", "用户不存在");
  return { ok: true, user };
}

/**
 * 后台创建用户档案，不创建房间关系。
 *
 * @param {{openId:string,nickNameWx?:string,avatarUrlWx?:string,displayName?:string}} payload
 */
function createAdminUser(payload) {
  return safeWrite(() => {
    const normalized = normalizeAdminUserPayload(payload, { requireOpenId: true });
    if (!normalized.ok) return normalized;

    const data = normalized.data;
    const tx = db.transaction(() => {
      const existed = stmt.getUser.get(data.openId);
      if (existed) return fail("USER_EXISTS", "用户已存在");

      const now = Date.now();
      stmt.insertAdminUser.run(
        data.openId,
        String(data.nickNameWx || ""),
        String(data.avatarUrlWx || ""),
        String(data.displayName || ""),
        now,
        now
      );
      return { ok: true, user: rowToAdminUser(stmt.getAdminUser.get(data.openId)) };
    });
    return tx();
  });
}

/**
 * 后台更新用户档案；若用户正在房间内，同步当前房间成员资料。
 *
 * @param {string} openId
 * @param {{nickNameWx?:string,avatarUrlWx?:string,displayName?:string}} payload
 */
function updateAdminUser(openId, payload) {
  return safeWrite(() => {
    const oid = String(openId || "").trim();
    if (!oid) return fail("INVALID_OPENID", "openId 不能为空");

    const normalized = normalizeAdminUserPayload(payload, {});
    if (!normalized.ok) return normalized;

    const data = normalized.data;
    const tx = db.transaction(() => {
      const current = stmt.getUser.get(oid);
      if (!current) return fail("NOT_FOUND", "用户不存在");

      const next = {
        nickNameWx: Object.prototype.hasOwnProperty.call(data, "nickNameWx")
          ? data.nickNameWx
          : String(current.nickNameWx || ""),
        avatarUrlWx: Object.prototype.hasOwnProperty.call(data, "avatarUrlWx")
          ? data.avatarUrlWx
          : String(current.avatarUrlWx || ""),
        displayName: Object.prototype.hasOwnProperty.call(data, "displayName")
          ? data.displayName
          : String(current.displayName || "")
      };
      const now = Date.now();
      stmt.updateAdminUser.run(next.nickNameWx, next.avatarUrlWx, next.displayName, now, oid);

      const mapping = getUserRoom(oid);
      if (mapping && mapping.roomCode) {
        stmt.updateRoomMemberProfile.run(next.displayName, next.avatarUrlWx, now, mapping.roomCode, oid);
      }

      return { ok: true, user: rowToAdminUser(stmt.getAdminUser.get(oid)) };
    });
    return tx();
  });
}

/**
 * 后台安全删除用户：只删 users 档案，房间内用户必须先退出房间。
 *
 * @param {string} openId
 */
function deleteAdminUser(openId) {
  return safeWrite(() => {
    const oid = String(openId || "").trim();
    if (!oid) return fail("INVALID_OPENID", "openId 不能为空");

    const tx = db.transaction(() => {
      const current = stmt.getUser.get(oid);
      if (!current) return fail("NOT_FOUND", "用户不存在");

      const mapping = getUserRoom(oid);
      if (mapping) return fail("IN_ROOM", "用户仍在房间中，不能直接删除");

      // 管理端删除的是用户档案，排行榜属于派生聚合数据，需要同步移除避免前端继续展示。
      stmt.deleteLeaderboardStats.run(oid);
      stmt.deleteUser.run(oid);
      return { ok: true };
    });
    return tx();
  });
}

/**
 * 创建房间（房主）。
 *
 * @param {string} openId
 */
function createRoom(openId) {
  return safeWrite(() => {
    const oid = String(openId || "");

    const tx = db.transaction(() => {
      const existedMapping = getUserRoom(oid);
      if (existedMapping) return fail("ALREADY_IN_ROOM", "你已在房间中，不能重复创建");

      const user = ensureUser(oid);
      if (!user || !user.displayName || !user.avatarUrlWx) {
        return fail("PROFILE_REQUIRED", "请先在小程序授权获取头像昵称");
      }

      let roomCode = "";
      for (let i = 0; i < 20; i += 1) {
        const c = genRoomCode();
        const existedRoom = stmt.getRoom.get(c);
        const existedSettlement = stmt.getSettlement.get(c);
        // 历史结算使用 roomCode 作为 settlementId，创建房间时需避开历史 roomCode，防止覆盖历史记录。
        if (!existedRoom && !existedSettlement) {
          roomCode = c;
          break;
        }
      }
      if (!roomCode) return fail("CREATE_ROOM_FAILED", "创建房间失败，请稍后重试");

      const now = Date.now();
      stmt.insertRoom.run(roomCode, oid, "active", now, now, 1, 0);
      stmt.insertUserRoom.run(oid, roomCode, "owner", now);
      stmt.upsertRoomMember.run(roomCode, oid, "owner", user.displayName, user.avatarUrlWx, now, 1, now);
      stmt.insertRoomTotalIgnore.run(roomCode, oid);

      return { ok: true, roomCode };
    });

    return tx();
  });
}

/**
 * 加入房间（成员）。
 *
 * @param {string} openId
 * @param {string} roomCode
 */
function joinRoom(openId, roomCode) {
  return safeWrite(() => {
    const oid = String(openId || "");
    const rc = normalizeRoomCode(roomCode);

    const tx = db.transaction(() => {
      const existedMapping = getUserRoom(oid);
      if (existedMapping) return fail("ALREADY_IN_ROOM", "加入新房间前请先退出当前房间");

      const room = stmt.getRoom.get(rc);
      if (!room) return fail("ROOM_NOT_FOUND", "房间不存在");
      if (String(room.status || "") !== "active") return fail("ROOM_NOT_ACTIVE", "房间不可加入（可能已解散）");

      const user = ensureUser(oid);
      if (!user || !user.displayName || !user.avatarUrlWx) {
        return fail("PROFILE_REQUIRED", "请先在小程序授权获取头像昵称");
      }

      const now = Date.now();
      const existedMember = stmt.getRoomMember.get(rc, oid);
      const wasActive = !!(existedMember && existedMember.active);
      const joinedAt = existedMember ? Number(existedMember.joinedAt || 0) : now;

      stmt.insertUserRoom.run(oid, rc, "member", now);
      stmt.upsertRoomMember.run(rc, oid, "member", user.displayName, user.avatarUrlWx, joinedAt, 1, now);

      // 维护 memberCount=active 成员数
      const c = stmt.countActiveMembers.get(rc);
      const memberCount = Number(c && c.c) || 0;
      stmt.updateRoomMemberCount.run(memberCount, now, rc);

      // totals：首次出现则补 0，保证总账展示完整
      stmt.insertRoomTotalIgnore.run(rc, oid);

      return { ok: true, roomCode: rc, wasActive };
    });

    return tx();
  });
}

/**
 * 成员主动退出（房主不能退出，只能解散）。
 *
 * @param {string} openId
 */
function leaveRoom(openId) {
  return safeWrite(() => {
    const oid = String(openId || "");

    const tx = db.transaction(() => {
      const mapping = getUserRoom(oid);
      if (!mapping) return fail("NOT_IN_ROOM", "你不在任何房间中");
      if (mapping.role === "owner") return fail("OWNER_CANNOT_LEAVE", "房主不能退出，请使用解散房间");

      const rc = normalizeRoomCode(mapping.roomCode);
      const room = stmt.getRoom.get(rc);
      if (!room) return fail("ROOM_NOT_FOUND", "房间不存在");

      const now = Date.now();
      stmt.deleteUserRoomByOpenId.run(oid);
      stmt.setRoomMemberInactive.run(now, rc, oid);

      const c = stmt.countActiveMembers.get(rc);
      const memberCount = Number(c && c.c) || 0;
      stmt.updateRoomMemberCount.run(memberCount, now, rc);

      return { ok: true, roomCode: rc };
    });

    return tx();
  });
}

/**
 * 新增交易（转账）。
 *
 * @param {string} fromOpenId
 * @param {string} toOpenId
 * @param {number} amount
 * @param {string} note
 */
function addTx(fromOpenId, toOpenId, amount, note) {
  return safeWrite(() => {
    const fromOid = String(fromOpenId || "").trim();
    const toOid = String(toOpenId || "").trim();
    const amt = Number(amount || 0);
    const note2 = String(note || "").trim().slice(0, 50);

    if (!toOid) return fail("INVALID_TO", "请选择收款人");
    if (toOid === fromOid) return fail("INVALID_TO", "不能转给自己");
    if (!Number.isInteger(amt)) return fail("INVALID_AMOUNT", "金额必须为整数");
    if (amt <= 0) return fail("INVALID_AMOUNT", "金额必须大于 0");
    if (amt > 99999999) return fail("INVALID_AMOUNT", "金额过大");

    const tx = db.transaction(() => {
      const mapping = getUserRoom(fromOid);
      if (!mapping) return fail("NOT_IN_ROOM", "你不在房间中");
      const rc = normalizeRoomCode(mapping.roomCode);

      const room = stmt.getRoom.get(rc);
      if (!room) return fail("ROOM_NOT_FOUND", "房间不存在");
      if (String(room.status || "") !== "active") return fail("ROOM_NOT_ACTIVE", "房间不可记账（可能已解散）");

      const fromMember = stmt.getRoomMember.get(rc, fromOid);
      const toMember = stmt.getRoomMember.get(rc, toOid);
      if (!fromMember || !fromMember.active) return fail("MEMBER_INACTIVE", "你已退出房间，不能记账");
      if (!toMember || !toMember.active) return fail("TO_NOT_IN_ROOM", "收款人不在房间中");

      const createdAt = Date.now();
      const txId = `tx_${createdAt}_${Math.random().toString(16).slice(2, 10)}`;

      stmt.insertTx.run(
        txId,
        rc,
        fromOid,
        toOid,
        amt,
        note2,
        createdAt,
        String(fromMember.displayName || ""),
        String(toMember.displayName || ""),
        String(fromMember.avatarUrl || ""),
        String(toMember.avatarUrl || "")
      );

      // totals：缺失补 0，再做加减
      stmt.insertRoomTotalIgnore.run(rc, fromOid);
      stmt.insertRoomTotalIgnore.run(rc, toOid);
      stmt.subRoomTotal.run(amt, rc, fromOid);
      stmt.addRoomTotal.run(amt, rc, toOid);

      stmt.updateRoomLastTx.run(createdAt, createdAt, rc);

      // 读取更新后的总账，用于增量推送
      const totalsRows = stmt.listRoomTotals.all(rc);
      const totals = {};
      for (const r of totalsRows) {
        totals[String(r.openId || "")] = Number(r.total || 0);
      }

      // 构造完整交易对象，用于增量推送
      const tx = {
        id: txId,
        roomCode: rc,
        fromOpenId: fromOid,
        toOpenId: toOid,
        amount: amt,
        note: note2,
        createdAt,
        fromName: String(fromMember.displayName || ""),
        toName: String(toMember.displayName || ""),
        fromAvatar: String(fromMember.avatarUrl || ""),
        toAvatar: String(toMember.avatarUrl || "")
      };

      return { ok: true, roomCode: rc, txId, tx, totals };
    });

    return tx();
  });
}

/**
 * 房主解散房间：生成结算快照并清空房间数据。
 *
 * @param {string} openId
 */
function dissolveRoom(openId) {
  return safeWrite(() => {
    const oid = String(openId || "");

    const tx = db.transaction(() => {
      const mapping = getUserRoom(oid);
      if (!mapping) return fail("NOT_IN_ROOM", "你不在房间中");
      if (mapping.role !== "owner") return fail("FORBIDDEN", "仅房主可解散房间");

      const rc = normalizeRoomCode(mapping.roomCode);
      const room = stmt.getRoom.get(rc);
      if (!room) return fail("ROOM_NOT_FOUND", "房间不存在");

      const members = stmt
        .listRoomMembers
        .all(rc)
        .map((m) => ({
          openId: String(m.openId || ""),
          displayName: String(m.displayName || ""),
          avatarUrl: String(m.avatarUrl || ""),
          role: String(m.role || ""),
          active: !!m.active,
          joinedAt: Number(m.joinedAt || 0)
        }));

      const totalsRows = stmt.listRoomTotals.all(rc);
      const totals = {};
      for (const r of totalsRows) {
        totals[String(r.openId || "")] = Number(r.total || 0);
      }

      // 结算覆盖所有成员（含已退出成员），缺失补 0
      for (const m of members) {
        if (!Object.prototype.hasOwnProperty.call(totals, m.openId)) totals[m.openId] = 0;
      }

      const membersSnapshot = members
        .slice()
        .sort((a, b) => {
          if (a.role === "owner" && b.role !== "owner") return -1;
          if (b.role === "owner" && a.role !== "owner") return 1;
          return Number(a.joinedAt || 0) - Number(b.joinedAt || 0);
        })
        .map((m) => ({
          openId: m.openId,
          displayName: m.displayName,
          avatarUrl: m.avatarUrl,
          role: m.role,
          active: !!m.active
        }));

      const txCountRow = stmt.countRoomTxs.get(rc);
      const txCount = Number(txCountRow && txCountRow.c) || 0;
      const dissolvedAt = Date.now();

      // 历史记录要求“每次解散保留一条”；当前通过“房间号全局不复用”保证不会覆盖旧结算。
      stmt.upsertSettlement.run(rc, oid, txCount, dissolvedAt);
      stmt.deleteSettlementTotals.run(rc);
      stmt.deleteSettlementMembers.run(rc);

      for (const [oid2, total] of Object.entries(totals)) {
        stmt.insertSettlementTotal.run(rc, String(oid2), Number(total || 0));
      }

      for (let i = 0; i < membersSnapshot.length; i += 1) {
        const m = membersSnapshot[i];
        stmt.insertSettlementMember.run(
          rc,
          i,
          String(m.openId || ""),
          String(m.displayName || ""),
          String(m.avatarUrl || ""),
          String(m.role || ""),
          m.active ? 1 : 0
        );
      }

      // 累计全局排行榜（与解散放在同一事务，保证原子一致）。
      upsertLeaderboardBySettlement(totals, membersSnapshot, dissolvedAt);

      // 清理房间数据
      stmt.deleteRoom.run(rc);
      stmt.deleteRoomMembers.run(rc);
      stmt.deleteRoomTxs.run(rc);
      stmt.deleteRoomTotals.run(rc);

      // 释放一人一房映射：清理仍在该房间的映射
      stmt.deleteUserRoomByRoomCode.run(rc);

      return { ok: true, roomCode: rc, settlementId: rc };
    });

    return tx();
  });
}

/**
 * 构造结算详情（供房主页和历史详情复用）。
 *
 * @param {string} roomCode
 * @param {{ownerOpenId:any, txCount:any, dissolvedAt:any}} s
 */
function buildSettlementPayload(roomCode, s) {
  const rc = normalizeRoomCode(roomCode);

  const totalsRows = stmt.listSettlementTotals.all(rc);
  const totals = {};
  for (const r of totalsRows) {
    totals[String(r.openId || "")] = Number(r.total || 0);
  }

  const membersSnapshot = stmt.listSettlementMembers.all(rc).map((m) => ({
    openId: String(m.openId || ""),
    displayName: String(m.displayName || ""),
    avatarUrl: String(m.avatarUrl || ""),
    role: String(m.role || ""),
    active: !!m.active
  }));

  return {
    roomCode: rc,
    ownerOpenId: String(s.ownerOpenId || ""),
    totals,
    membersSnapshot,
    txCount: Number(s.txCount || 0),
    dissolvedAt: Number(s.dissolvedAt || 0)
  };
}

/**
 * 获取结算（仅房主可读）。
 *
 * @param {string} openId
 * @param {string} roomCode
 */
function getSettlement(openId, roomCode) {
  const oid = String(openId || "");
  const rc = normalizeRoomCode(roomCode);

  const s = stmt.getSettlement.get(rc);
  if (!s) return fail("NOT_FOUND", "结算不存在");
  if (String(s.ownerOpenId || "") !== oid) return fail("FORBIDDEN", "仅房主可查看结算");

  return {
    ok: true,
    settlement: buildSettlementPayload(rc, s)
  };
}

/**
 * 获取“我参与过的历史记录”分页。
 *
 * @param {string} openId
 * @param {number|null} beforeDissolvedAt
 * @param {string|null} beforeRoomCode
 * @param {number} limit
 */
function listMySettlementHistory(openId, beforeDissolvedAt, beforeRoomCode, limit) {
  return queryMySettlementHistoryPage(openId, beforeDissolvedAt, beforeRoomCode, limit);
}

/**
 * 获取时间线历史分页（支持 mine/all）。
 *
 * @param {string} openId
 * @param {"mine"|"all"} scope
 * @param {number|null} beforeDissolvedAt
 * @param {string|null} beforeRoomCode
 * @param {number} limit
 */
function listTimelineHistory(openId, scope, beforeDissolvedAt, beforeRoomCode, limit) {
  const queryScope = scope === "all" ? "all" : "mine";
  const page = querySettlementTimelinePage(openId, queryScope, beforeDissolvedAt, beforeRoomCode, limit);
  const rows = page.rows.map((row) => buildTimelineRow(openId, row));
  return {
    scope: queryScope,
    rows,
    hasMore: page.hasMore,
    nextBeforeDissolvedAt: page.nextBeforeDissolvedAt,
    nextBeforeRoomCode: page.nextBeforeRoomCode
  };
}

/**
 * 获取“我参与过的某次结算详情”。
 *
 * @param {string} openId
 * @param {string} settlementId
 */
function getMySettlement(openId, settlementId) {
  const oid = String(openId || "");
  const rc = normalizeRoomCode(settlementId);

  const s = stmt.getSettlement.get(rc);
  if (!s) return fail("NOT_FOUND", "结算不存在");

  const member = stmt.getSettlementMemberByOpenId.get(rc, oid);
  if (!member) return fail("FORBIDDEN", "你未参与该次结算");

  return {
    ok: true,
    settlement: buildSettlementPayload(rc, s)
  };
}

/**
 * 获取全局排行榜。
 *
 * 排序规则：
 * 1) 净输赢降序，累计赢钱越多越靠前
 * 2) openId 升序（稳定排序）
 *
 * @param {number} limit
 * @returns {{totalPlayers:number, rows:any[]}}
 */
function getLeaderboard(limit) {
  const pageLimit = normalizeLeaderboardLimit(limit);
  const allRows = stmt.listLeaderboardStats.all().map((r) => {
    const winCount = Number(r.winCount || 0);
    const lossCount = Number(r.lossCount || 0);
    const drawCount = Number(r.drawCount || 0);
    const matchCount = Number(r.matchCount || 0);
    const netProfit = Number(r.netProfit || 0);
    const winRate = calcWinRate(winCount, lossCount);

    return {
      openId: String(r.openId || ""),
      displayName: String(r.displayName || ""),
      avatarUrl: String(r.avatarUrl || ""),
      winCount,
      lossCount,
      drawCount,
      matchCount,
      netProfit,
      winRate,
      lastSettlementAt: Number(r.lastSettlementAt || 0)
    };
  });

  allRows.sort((a, b) => {
    if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
    return String(a.openId || "").localeCompare(String(b.openId || ""));
  });

  const rows = allRows.slice(0, pageLimit).map((row, idx) => ({
    rank: idx + 1,
    ...row
  }));

  return {
    totalPlayers: allRows.length,
    rows
  };
}

/**
 * 获取我的信息（用于首页展示/恢复房间）。
 *
 * @param {string} openId
 */
function getMe(openId) {
  const oid = String(openId || "");
  const user = getUser(oid);
  const mapping = getUserRoom(oid);

  return {
    openId: oid,
    user: user || null,
    inRoom: !!mapping,
    roomCode: mapping ? mapping.roomCode : "",
    role: mapping ? mapping.role : ""
  };
}

// 启动即执行一次历史回填，确保旧结算可进入全局排行榜。
backfillLeaderboardIfNeeded();

module.exports = {
  DB_FILE,
  SQLITE_FILE,

  withLock,
  fail,

  // 只读方法（同步）
  getUser,
  getUserRoom,
  getRoomSnapshot,
  listRoomTxPage,
  getSettlement,
  listMySettlementHistory,
  listTimelineHistory,
  getMySettlement,
  getLeaderboard,
  getMe,
  getAdminPasswordRecord,
  listAdminUsers,
  getAdminUser,

  // 写方法（带锁 + 事务）
  saveAdminPasswordRecord,
  ensureUserForLogin,
  deactivateUser,
  updateUserProfile,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  createRoom,
  joinRoom,
  leaveRoom,
  addTx,
  dissolveRoom,

  // 兼容旧接口：SQLite 下不再需要显式 persist
  persist() {}
};
