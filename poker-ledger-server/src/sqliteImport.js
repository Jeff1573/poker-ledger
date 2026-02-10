const fs = require("fs");
const path = require("path");

const { DEFAULT_DB, readJson } = require("./db");

/**
 * 判断库是否为空（用于决定是否触发首次导入）。
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {boolean}
 */
function isSqliteEmpty(db) {
  try {
    // 若已标记导入过，则不再触发自动导入（避免误删/重复导入）。
    const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get("imported_from_json");
    if (meta && String(meta.value || "") === "true") return false;

    // 任一业务表存在记录，都视为非空库。
    const tables = [
      "users",
      "user_room",
      "rooms",
      "room_members",
      "room_totals",
      "room_txs",
      "settlements",
      "settlement_totals",
      "settlement_members",
      "leaderboard_stats"
    ];
    for (const t of tables) {
      // 表名来自固定白名单，不存在注入风险。
      const any = db.prepare(`SELECT 1 AS one FROM ${t} LIMIT 1`).get();
      if (any) return false;
    }
    return true;
  } catch (err) {
    return true;
  }
}

/**
 * 把旧 JSON 数据规范化为完整结构。
 *
 * @param {any} raw
 * @returns {any}
 */
function normalizeLegacyDb(raw) {
  const clonedDefault = JSON.parse(JSON.stringify(DEFAULT_DB));
  const src = raw && typeof raw === "object" ? raw : {};
  const merged = { ...clonedDefault, ...src };

  if (!merged.users || typeof merged.users !== "object") merged.users = {};
  if (!merged.userRoom || typeof merged.userRoom !== "object") merged.userRoom = {};
  if (!merged.rooms || typeof merged.rooms !== "object") merged.rooms = {};
  if (!merged.roomMembers || typeof merged.roomMembers !== "object") merged.roomMembers = {};
  if (!merged.roomTxs || typeof merged.roomTxs !== "object") merged.roomTxs = {};
  if (!merged.settlements || typeof merged.settlements !== "object") merged.settlements = {};

  return merged;
}

/**
 * 从旧版 JSON 导入到 SQLite。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} jsonPath
 * @returns {{ ok: boolean, imported: boolean, backupPath: string, message?: string }}
 */
function importFromJsonIfNeeded(db, jsonPath) {
  const absJsonPath = path.resolve(jsonPath);
  if (!fs.existsSync(absJsonPath)) return { ok: true, imported: false, backupPath: "" };
  if (!isSqliteEmpty(db)) return { ok: true, imported: false, backupPath: "" };

  let raw;
  try {
    raw = readJson(absJsonPath);
  } catch (err) {
    return { ok: false, imported: false, backupPath: "", message: "读取旧数据失败" };
  }

  if (!raw) return { ok: true, imported: false, backupPath: "" };

  const legacy = normalizeLegacyDb(raw);

  const insUser = db.prepare(
    "INSERT OR REPLACE INTO users(openId, nickNameWx, avatarUrlWx, displayName, createdAt, updatedAt) VALUES (@openId, @nickNameWx, @avatarUrlWx, @displayName, @createdAt, @updatedAt)"
  );
  const insUserRoom = db.prepare(
    "INSERT OR REPLACE INTO user_room(openId, roomCode, role, joinedAt) VALUES (@openId, @roomCode, @role, @joinedAt)"
  );
  const insRoom = db.prepare(
    "INSERT OR REPLACE INTO rooms(roomCode, ownerOpenId, status, createdAt, updatedAt, memberCount, lastTxAt) VALUES (@roomCode, @ownerOpenId, @status, @createdAt, @updatedAt, @memberCount, @lastTxAt)"
  );
  const insRoomMember = db.prepare(
    "INSERT OR REPLACE INTO room_members(roomCode, openId, role, displayName, avatarUrl, joinedAt, active, updatedAt) VALUES (@roomCode, @openId, @role, @displayName, @avatarUrl, @joinedAt, @active, @updatedAt)"
  );
  const insRoomTotal = db.prepare("INSERT OR REPLACE INTO room_totals(roomCode, openId, total) VALUES (?, ?, ?)");
  const insTx = db.prepare(
    "INSERT OR REPLACE INTO room_txs(id, roomCode, fromOpenId, toOpenId, amount, note, createdAt, fromName, toName, fromAvatar, toAvatar) VALUES (@id, @roomCode, @fromOpenId, @toOpenId, @amount, @note, @createdAt, @fromName, @toName, @fromAvatar, @toAvatar)"
  );
  const insSettlement = db.prepare(
    "INSERT OR REPLACE INTO settlements(roomCode, ownerOpenId, txCount, dissolvedAt) VALUES (@roomCode, @ownerOpenId, @txCount, @dissolvedAt)"
  );
  const insSettlementTotal = db.prepare("INSERT OR REPLACE INTO settlement_totals(roomCode, openId, total) VALUES (?, ?, ?)");
  const insSettlementMember = db.prepare(
    "INSERT OR REPLACE INTO settlement_members(roomCode, seq, openId, displayName, avatarUrl, role, active) VALUES (@roomCode, @seq, @openId, @displayName, @avatarUrl, @role, @active)"
  );
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");

  const run = db.transaction(() => {
    // 防御性清理（理论上库应为空）。
    db.exec(
      "DELETE FROM settlement_members;" +
        "DELETE FROM settlement_totals;" +
        "DELETE FROM settlements;" +
        "DELETE FROM room_txs;" +
        "DELETE FROM room_totals;" +
        "DELETE FROM room_members;" +
        "DELETE FROM rooms;" +
        "DELETE FROM user_room;" +
        "DELETE FROM users;" +
        "DELETE FROM leaderboard_stats;"
    );

    for (const u of Object.values(legacy.users)) {
      if (!u || !u.openId) continue;
      insUser.run({
        openId: String(u.openId),
        nickNameWx: String(u.nickNameWx || ""),
        avatarUrlWx: String(u.avatarUrlWx || ""),
        displayName: String(u.displayName || ""),
        createdAt: Number(u.createdAt || 0),
        updatedAt: Number(u.updatedAt || 0)
      });
    }

    for (const [openId, m] of Object.entries(legacy.userRoom)) {
      if (!m) continue;
      insUserRoom.run({
        openId: String(openId),
        roomCode: String(m.roomCode || "").trim().toUpperCase(),
        role: String(m.role || ""),
        joinedAt: Number(m.joinedAt || 0)
      });
    }

    for (const room of Object.values(legacy.rooms)) {
      if (!room || !room.roomCode) continue;
      insRoom.run({
        roomCode: String(room.roomCode || "").trim().toUpperCase(),
        ownerOpenId: String(room.ownerOpenId || ""),
        status: String(room.status || "active"),
        createdAt: Number(room.createdAt || 0),
        updatedAt: Number(room.updatedAt || 0),
        memberCount: Number(room.memberCount || 0),
        lastTxAt: Number(room.lastTxAt || 0)
      });

      const totals = room.totals && typeof room.totals === "object" ? room.totals : {};
      for (const [oid, total] of Object.entries(totals)) {
        insRoomTotal.run(String(room.roomCode).trim().toUpperCase(), String(oid), Number(total || 0));
      }
    }

    for (const [roomCode0, membersMap] of Object.entries(legacy.roomMembers)) {
      const roomCode = String(roomCode0 || "").trim().toUpperCase();
      const map = membersMap && typeof membersMap === "object" ? membersMap : {};
      for (const m of Object.values(map)) {
        if (!m || !m.openId) continue;
        insRoomMember.run({
          roomCode,
          openId: String(m.openId),
          role: String(m.role || "member"),
          displayName: String(m.displayName || ""),
          avatarUrl: String(m.avatarUrl || ""),
          joinedAt: Number(m.joinedAt || 0),
          active: m.active ? 1 : 0,
          updatedAt: Number(m.updatedAt || 0)
        });
      }
    }

    for (const [roomCode0, txs] of Object.entries(legacy.roomTxs)) {
      const roomCode = String(roomCode0 || "").trim().toUpperCase();
      const arr = Array.isArray(txs) ? txs : [];
      for (const tx of arr) {
        if (!tx || !tx.id) continue;
        insTx.run({
          id: String(tx.id),
          roomCode: String(tx.roomCode || roomCode).trim().toUpperCase(),
          fromOpenId: String(tx.fromOpenId || ""),
          toOpenId: String(tx.toOpenId || ""),
          amount: Number(tx.amount || 0),
          note: String(tx.note || ""),
          createdAt: Number(tx.createdAt || 0),
          fromName: String(tx.fromName || ""),
          toName: String(tx.toName || ""),
          fromAvatar: String(tx.fromAvatar || ""),
          toAvatar: String(tx.toAvatar || "")
        });
      }
    }

    for (const s of Object.values(legacy.settlements)) {
      if (!s || !s.roomCode) continue;
      const roomCode = String(s.roomCode || "").trim().toUpperCase();
      insSettlement.run({
        roomCode,
        ownerOpenId: String(s.ownerOpenId || ""),
        txCount: Number(s.txCount || 0),
        dissolvedAt: Number(s.dissolvedAt || 0)
      });

      const totals = s.totals && typeof s.totals === "object" ? s.totals : {};
      for (const [oid, total] of Object.entries(totals)) {
        insSettlementTotal.run(roomCode, String(oid), Number(total || 0));
      }

      const membersSnapshot = Array.isArray(s.membersSnapshot) ? s.membersSnapshot : [];
      for (let i = 0; i < membersSnapshot.length; i += 1) {
        const m = membersSnapshot[i];
        if (!m) continue;
        insSettlementMember.run({
          roomCode,
          seq: i,
          openId: String(m.openId || ""),
          displayName: String(m.displayName || ""),
          avatarUrl: String(m.avatarUrl || ""),
          role: String(m.role || "member"),
          active: m.active ? 1 : 0
        });
      }
    }

    setMeta.run("imported_from_json", "true");
    setMeta.run("imported_from_json_path", absJsonPath);
    setMeta.run("imported_at", String(Date.now()));
  });

  try {
    run();
  } catch (err) {
    console.error("SQLite 导入失败：", err);
    return { ok: false, imported: false, backupPath: "", message: "导入旧数据失败" };
  }

  // 备份旧文件：导入成功后再做重命名。
  let backupPath = "";
  try {
    const dir = path.dirname(absJsonPath);
    const base = path.basename(absJsonPath);
    const backupName = `${base}.bak.${Date.now()}`;
    backupPath = path.join(dir, backupName);
    fs.renameSync(absJsonPath, backupPath);
  } catch (err) {
    // 备份失败不影响 SQLite 可用性，但保留日志便于人工处理。
    console.error("旧 db.json 备份失败（已完成导入）：", err);
    backupPath = "";
  }

  return { ok: true, imported: true, backupPath };
}

module.exports = {
  isSqliteEmpty,
  importFromJsonIfNeeded
};
