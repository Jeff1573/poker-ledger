/**
 * SQLite 表结构
 *
 * 目标：用最轻依赖把现有 JSON 数据结构落到关系型表结构，并保持对外 API 行为不变。
 */

const SCHEMA_VERSION = 2;

/**
 * 初始化/升级 schema（当前包含 v1/v2 结构）。
 *
 * @param {import("better-sqlite3").Database} db
 */
function initSchema(db) {
  db.exec(
    "\n" +
      "CREATE TABLE IF NOT EXISTS meta (\n" +
      "  key TEXT PRIMARY KEY,\n" +
      "  value TEXT NOT NULL\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS users (\n" +
      "  openId TEXT PRIMARY KEY,\n" +
      "  nickNameWx TEXT NOT NULL DEFAULT '',\n" +
      "  avatarUrlWx TEXT NOT NULL DEFAULT '',\n" +
      "  displayName TEXT NOT NULL DEFAULT '',\n" +
      "  createdAt INTEGER NOT NULL,\n" +
      "  updatedAt INTEGER NOT NULL\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS user_room (\n" +
      "  openId TEXT PRIMARY KEY,\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  role TEXT NOT NULL,\n" +
      "  joinedAt INTEGER NOT NULL\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS rooms (\n" +
      "  roomCode TEXT PRIMARY KEY,\n" +
      "  ownerOpenId TEXT NOT NULL,\n" +
      "  status TEXT NOT NULL,\n" +
      "  createdAt INTEGER NOT NULL,\n" +
      "  updatedAt INTEGER NOT NULL,\n" +
      "  memberCount INTEGER NOT NULL,\n" +
      "  lastTxAt INTEGER NOT NULL\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS room_members (\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  openId TEXT NOT NULL,\n" +
      "  role TEXT NOT NULL,\n" +
      "  displayName TEXT NOT NULL,\n" +
      "  avatarUrl TEXT NOT NULL,\n" +
      "  joinedAt INTEGER NOT NULL,\n" +
      "  active INTEGER NOT NULL,\n" +
      "  updatedAt INTEGER NOT NULL,\n" +
      "  PRIMARY KEY (roomCode, openId)\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS room_totals (\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  openId TEXT NOT NULL,\n" +
      "  total INTEGER NOT NULL,\n" +
      "  PRIMARY KEY (roomCode, openId)\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS room_txs (\n" +
      "  id TEXT PRIMARY KEY,\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  fromOpenId TEXT NOT NULL,\n" +
      "  toOpenId TEXT NOT NULL,\n" +
      "  amount INTEGER NOT NULL,\n" +
      "  note TEXT NOT NULL DEFAULT '',\n" +
      "  createdAt INTEGER NOT NULL,\n" +
      "  fromName TEXT NOT NULL DEFAULT '',\n" +
      "  toName TEXT NOT NULL DEFAULT '',\n" +
      "  fromAvatar TEXT NOT NULL DEFAULT '',\n" +
      "  toAvatar TEXT NOT NULL DEFAULT ''\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS settlements (\n" +
      "  roomCode TEXT PRIMARY KEY,\n" +
      "  ownerOpenId TEXT NOT NULL,\n" +
      "  txCount INTEGER NOT NULL,\n" +
      "  dissolvedAt INTEGER NOT NULL\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS settlement_totals (\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  openId TEXT NOT NULL,\n" +
      "  total INTEGER NOT NULL,\n" +
      "  PRIMARY KEY (roomCode, openId)\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS settlement_members (\n" +
      "  roomCode TEXT NOT NULL,\n" +
      "  seq INTEGER NOT NULL,\n" +
      "  openId TEXT NOT NULL,\n" +
      "  displayName TEXT NOT NULL,\n" +
      "  avatarUrl TEXT NOT NULL,\n" +
      "  role TEXT NOT NULL,\n" +
      "  active INTEGER NOT NULL,\n" +
      "  PRIMARY KEY (roomCode, seq)\n" +
      ");\n" +
      "\n" +
      "CREATE TABLE IF NOT EXISTS leaderboard_stats (\n" +
      "  openId TEXT PRIMARY KEY,\n" +
      "  displayName TEXT NOT NULL DEFAULT '',\n" +
      "  avatarUrl TEXT NOT NULL DEFAULT '',\n" +
      "  winCount INTEGER NOT NULL DEFAULT 0,\n" +
      "  lossCount INTEGER NOT NULL DEFAULT 0,\n" +
      "  drawCount INTEGER NOT NULL DEFAULT 0,\n" +
      "  matchCount INTEGER NOT NULL DEFAULT 0,\n" +
      "  netProfit INTEGER NOT NULL DEFAULT 0,\n" +
      "  lastSettlementAt INTEGER NOT NULL DEFAULT 0,\n" +
      "  updatedAt INTEGER NOT NULL DEFAULT 0\n" +
      ");\n" +
      "\n" +
      "CREATE INDEX IF NOT EXISTS idx_user_room_roomCode ON user_room(roomCode);\n" +
      "CREATE INDEX IF NOT EXISTS idx_room_members_roomCode_active ON room_members(roomCode, active);\n" +
      "CREATE INDEX IF NOT EXISTS idx_room_members_roomCode_joinedAt ON room_members(roomCode, joinedAt);\n" +
      "CREATE INDEX IF NOT EXISTS idx_room_txs_roomCode_createdAt ON room_txs(roomCode, createdAt);\n" +
      "CREATE INDEX IF NOT EXISTS idx_room_txs_roomCode_createdAt_id ON room_txs(roomCode, createdAt, id);\n" +
      "CREATE INDEX IF NOT EXISTS idx_room_totals_roomCode ON room_totals(roomCode);\n" +
      "CREATE INDEX IF NOT EXISTS idx_leaderboard_lastSettlementAt ON leaderboard_stats(lastSettlementAt);\n"
  );

  // 标记 schema 版本（便于后续升级）。
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
}

module.exports = {
  SCHEMA_VERSION,
  initSchema
};
