const path = require("path");

const config = require("./config");
const { ensureDir } = require("./db");
const { openSqlite } = require("./sqlite");
const { importFromJsonIfNeeded } = require("./sqliteImport");

// 房间号字符集：去掉易混淆字符（0/O，1/I）
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LEN = 6;

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
  console.error("SQLite 初始化失败：", importResult.message || "");
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
      console.error("SQLite 写入异常：", err);
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

const stmt = {
  getUser: db.prepare("SELECT openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt FROM users WHERE openId = ?"),
  insertUserIgnore: db.prepare(
    "INSERT OR IGNORE INTO users(openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt) VALUES (?, '', '', '', ?, ?)"
  ),
  deleteUser: db.prepare("DELETE FROM users WHERE openId = ?"),

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

  listRoomTxs: db.prepare(
    "SELECT id, roomCode, fromOpenId, toOpenId, amount, note, createdAt, fromName, toName, fromAvatar, toAvatar FROM room_txs WHERE roomCode = ? ORDER BY createdAt DESC LIMIT 200"
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
  listSettlementTotals: db.prepare("SELECT openId, total FROM settlement_totals WHERE roomCode = ?"),
  listSettlementMembers: db.prepare(
    "SELECT seq, openId, displayName, avatarUrl, role, active FROM settlement_members WHERE roomCode = ? ORDER BY seq ASC"
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
 * 获取房间快照：room + members + txs（最近 200 笔，按 createdAt desc）。
 *
 * @param {string} roomCode
 * @returns {{room: any, members: any[], txs: any[]} | null}
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

  const txs = stmt.listRoomTxs.all(rc).map((t) => ({
    id: String(t.id || ""),
    roomCode: normalizeRoomCode(t.roomCode || rc),
    fromOpenId: String(t.fromOpenId || ""),
    toOpenId: String(t.toOpenId || ""),
    amount: Number(t.amount || 0),
    note: String(t.note || ""),
    createdAt: Number(t.createdAt || 0),
    fromName: String(t.fromName || ""),
    toName: String(t.toName || ""),
    fromAvatar: String(t.fromAvatar || ""),
    toAvatar: String(t.toAvatar || "")
  }));

  return { room, members, txs };
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
        if (!existedRoom) {
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
      return { ok: true, roomCode: rc, txId };
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

      // 允许 roomCode 复用：结算使用 OR REPLACE 覆盖旧记录
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
    ok: true,
    settlement: {
      roomCode: rc,
      ownerOpenId: String(s.ownerOpenId || ""),
      totals,
      membersSnapshot,
      txCount: Number(s.txCount || 0),
      dissolvedAt: Number(s.dissolvedAt || 0)
    }
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

module.exports = {
  DB_FILE,
  SQLITE_FILE,

  withLock,
  fail,

  // 只读方法（同步）
  getUser,
  getUserRoom,
  getRoomSnapshot,
  getSettlement,
  getMe,

  // 写方法（带锁 + 事务）
  ensureUserForLogin,
  deactivateUser,
  updateUserProfile,
  createRoom,
  joinRoom,
  leaveRoom,
  addTx,
  dissolveRoom,

  // 兼容旧接口：SQLite 下不再需要显式 persist
  persist() {}
};
