const path = require("path");
const Database = require("better-sqlite3");

const { ensureDir } = require("./db");
const { initSchema } = require("./sqliteSchema");

/**
 * 打开 SQLite 连接并初始化 schema。
 *
 * 注意：better-sqlite3 为同步 API，本项目规模下足够。
 *
 * @param {string} filePath
 * @returns {import("better-sqlite3").Database}
 */
function openSqlite(filePath) {
  ensureDir(path.dirname(filePath));

  const db = new Database(filePath);

  // 兼顾可靠性与性能的默认设置（单机小项目）。
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  initSchema(db);
  return db;
}

module.exports = {
  openSqlite
};
