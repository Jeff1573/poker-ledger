const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");

const { initSchema } = require("../src/sqliteSchema");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-leaderboard-"));
const SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
const LEGACY_JSON_FILE = path.join(TMP_DIR, "legacy.json");

process.env.SQLITE_FILE = SQLITE_FILE;
process.env.DB_FILE = LEGACY_JSON_FILE;
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");
const { signToken } = require("../src/auth");

const PLAYER_A = "leader_owner_a";
const PLAYER_B = "leader_member_b";
const PLAYER_C = "leader_member_c";
const PLAYER_H = "leader_draw_h";
const PLAYER_I = "leader_draw_i";

/**
 * @param {string} openId
 * @param {string} displayName
 */
async function ensureProfile(openId, displayName) {
  const r0 = await store.ensureUserForLogin(openId);
  assert.equal(r0.ok, true);
  const r1 = await store.updateUserProfile(openId, {
    nickNameWx: displayName,
    avatarUrlWx: `/uploads/${displayName}.png`,
    displayName
  });
  assert.equal(r1.ok, true);
}

/**
 * @param {string} ownerOpenId
 * @param {string[]} members
 */
async function createRoomWithMembers(ownerOpenId, members) {
  const c = await store.createRoom(ownerOpenId);
  assert.equal(c.ok, true);
  const roomCode = String(c.roomCode || "");
  assert.ok(roomCode);

  for (const m of members) {
    const j = await store.joinRoom(m, roomCode);
    assert.equal(j.ok, true);
  }
  return roomCode;
}

/**
 * @param {string} openId
 * @returns {Promise<any>}
 */
async function dissolveByOwner(openId) {
  const r = await store.dissolveRoom(openId);
  assert.equal(r.ok, true);
  return r;
}

/**
 * @param {any[]} rows
 * @param {string} openId
 */
function findRow(rows, openId) {
  return rows.find((x) => String(x.openId || "") === openId) || null;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? Number(addr.port || 0) : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} port
 */
function startServerProcess(port) {
  return spawn(process.execPath, ["src/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      SQLITE_FILE,
      DB_FILE: LEGACY_JSON_FILE,
      LOG_LEVEL: "error",
      LOG_HTTP_ACCESS: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * @param {string} baseUrl
 * @param {string} token
 */
async function waitServerReady(baseUrl, token) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/rooms/my`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.status === 200) return;
    } catch (err) {
      // ignore
    }
    await sleep(100);
  }
  throw new Error("测试服务启动超时");
}

/**
 * @param {import("child_process").ChildProcess} child
 */
async function stopServerProcess(child) {
  if (!child || child.exitCode !== null) return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        // ignore
      }
      resolve();
    }, 2000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill();
    } catch (err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * 独立进程触发 store 初始化（用于验证启动回填幂等）。
 *
 * @param {string} sqliteFile
 * @param {string} legacyJsonFile
 */
function bootStoreInChild(sqliteFile, legacyJsonFile) {
  const script = "const store = require('./src/store'); console.log(JSON.stringify(store.getLeaderboard(100)));";
  return spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      SQLITE_FILE: sqliteFile,
      DB_FILE: legacyJsonFile,
      LOG_LEVEL: "error",
      LOG_HTTP_ACCESS: "0"
    },
    encoding: "utf8"
  });
}

test.before(async () => {
  await ensureProfile(PLAYER_A, "甲");
  await ensureProfile(PLAYER_B, "乙");
  await ensureProfile(PLAYER_C, "丙");
  await ensureProfile(PLAYER_H, "丁");
  await ensureProfile(PLAYER_I, "戊");

  // Round 1: B 胜，A/C 负
  await createRoomWithMembers(PLAYER_A, [PLAYER_B, PLAYER_C]);
  {
    const t1 = await store.addTx(PLAYER_A, PLAYER_B, 50, "");
    assert.equal(t1.ok, true);
    const t2 = await store.addTx(PLAYER_C, PLAYER_B, 20, "");
    assert.equal(t2.ok, true);
  }
  await dissolveByOwner(PLAYER_A);

  // Round 2: A 胜，B 负
  await createRoomWithMembers(PLAYER_A, [PLAYER_B]);
  {
    const t = await store.addTx(PLAYER_B, PLAYER_A, 30, "");
    assert.equal(t.ok, true);
  }
  await dissolveByOwner(PLAYER_A);

  // Round 3: C/B 平局（无交易）
  await createRoomWithMembers(PLAYER_C, [PLAYER_B]);
  await dissolveByOwner(PLAYER_C);

  // Round 4: H/I 平局（用于 tie-break 校验）
  await createRoomWithMembers(PLAYER_H, [PLAYER_I]);
  await dissolveByOwner(PLAYER_H);
});

test("累计统计正确（胜负平/场次/净分）", () => {
  const board = store.getLeaderboard(200);
  assert.equal(board.totalPlayers, 5);

  const a = findRow(board.rows, PLAYER_A);
  const b = findRow(board.rows, PLAYER_B);
  const c = findRow(board.rows, PLAYER_C);
  const h = findRow(board.rows, PLAYER_H);
  const i = findRow(board.rows, PLAYER_I);

  assert.ok(a && b && c && h && i);

  assert.deepEqual(
    {
      winCount: a.winCount,
      lossCount: a.lossCount,
      drawCount: a.drawCount,
      matchCount: a.matchCount,
      netProfit: a.netProfit
    },
    {
      winCount: 1,
      lossCount: 1,
      drawCount: 0,
      matchCount: 2,
      netProfit: -20
    }
  );

  assert.deepEqual(
    {
      winCount: b.winCount,
      lossCount: b.lossCount,
      drawCount: b.drawCount,
      matchCount: b.matchCount,
      netProfit: b.netProfit
    },
    {
      winCount: 1,
      lossCount: 1,
      drawCount: 1,
      matchCount: 3,
      netProfit: 40
    }
  );
});

test("胜率计算正确（平局不计分母）", () => {
  const board = store.getLeaderboard(200);
  const b = findRow(board.rows, PLAYER_B);
  const h = findRow(board.rows, PLAYER_H);
  assert.ok(b && h);

  assert.equal(b.winRate, 0.5);
  assert.equal(h.winRate, 0);
});

test("排序规则正确：胜率 > 净分 > 场次 > openId", () => {
  const board = store.getLeaderboard(200);
  const order = board.rows.map((x) => x.openId);
  assert.deepEqual(order, [PLAYER_B, PLAYER_A, PLAYER_H, PLAYER_I, PLAYER_C]);
});

test("limit 生效且返回 totalPlayers", () => {
  const board = store.getLeaderboard(2);
  assert.equal(board.totalPlayers, 5);
  assert.equal(board.rows.length, 2);
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[1].rank, 2);
});

test("GET /api/leaderboard 未鉴权返回 401", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken(PLAYER_A);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, token);

    const res = await fetch(`${baseUrl}/api/leaderboard`, { method: "GET" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "UNAUTHORIZED");
  } finally {
    await stopServerProcess(child);
  }
});

test("GET /api/leaderboard limit 非法返回 ok:false", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken(PLAYER_A);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, token);

    const res = await fetch(`${baseUrl}/api/leaderboard?limit=abc`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "INVALID_LIMIT");
  } finally {
    await stopServerProcess(child);
  }
});

test("启动回填仅执行一次（leaderboard_backfilled_v1）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-backfill-once-"));
  const sqliteFile = path.join(dir, "db.sqlite");
  const legacyJsonFile = path.join(dir, "legacy.json");
  const roomCode = "BFC001";

  const db = new Database(sqliteFile);
  initSchema(db);
  const dissolvedAt = Date.now();
  db.prepare("INSERT OR REPLACE INTO settlements(roomCode, ownerOpenId, txCount, dissolvedAt) VALUES (?, ?, ?, ?)").run(
    roomCode,
    "owner_bf",
    0,
    dissolvedAt
  );
  db.prepare("INSERT OR REPLACE INTO settlement_totals(roomCode, openId, total) VALUES (?, ?, ?)").run(roomCode, "bf_u1", 100);
  db.prepare("INSERT OR REPLACE INTO settlement_totals(roomCode, openId, total) VALUES (?, ?, ?)").run(roomCode, "bf_u2", -100);
  db.prepare(
    "INSERT OR REPLACE INTO settlement_members(roomCode, seq, openId, displayName, avatarUrl, role, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(roomCode, 0, "bf_u1", "回填甲", "/uploads/a.png", "owner", 1);
  db.prepare(
    "INSERT OR REPLACE INTO settlement_members(roomCode, seq, openId, displayName, avatarUrl, role, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(roomCode, 1, "bf_u2", "回填乙", "/uploads/b.png", "member", 1);
  db.close();

  const firstBoot = bootStoreInChild(sqliteFile, legacyJsonFile);
  assert.equal(firstBoot.status, 0);

  const db2 = new Database(sqliteFile);
  const meta = db2.prepare("SELECT value FROM meta WHERE key = ?").get("leaderboard_backfilled_v1");
  assert.equal(String((meta && meta.value) || ""), "true");
  const row = db2.prepare("SELECT netProfit, winCount, lossCount FROM leaderboard_stats WHERE openId = ?").get("bf_u1");
  assert.equal(Number(row.netProfit || 0), 100);
  assert.equal(Number(row.winCount || 0), 1);
  assert.equal(Number(row.lossCount || 0), 0);

  // 手动改写为哨兵值；若第二次启动仍回填，会被覆盖回 100。
  db2.prepare("UPDATE leaderboard_stats SET netProfit = ? WHERE openId = ?").run(123456, "bf_u1");
  db2.close();

  const secondBoot = bootStoreInChild(sqliteFile, legacyJsonFile);
  assert.equal(secondBoot.status, 0);

  const db3 = new Database(sqliteFile);
  const rowAfter = db3.prepare("SELECT netProfit FROM leaderboard_stats WHERE openId = ?").get("bf_u1");
  assert.equal(Number(rowAfter.netProfit || 0), 123456);
  db3.close();
});
