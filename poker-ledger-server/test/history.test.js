const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("node:child_process");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-history-"));
const SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
const LEGACY_JSON_FILE = path.join(TMP_DIR, "legacy.json");

process.env.SQLITE_FILE = SQLITE_FILE;
process.env.DB_FILE = LEGACY_JSON_FILE;
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");
const { signToken } = require("../src/auth");

const OWNER_A = "history_owner_a";
const MEMBER_B = "history_member_b";
const MEMBER_C = "history_member_c";
const OUTSIDER_D = "history_outsider_d";

let round1RoomCode = "";
let round2RoomCode = "";
let round3RoomCode = "";

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
 * 创建并解散一局，返回 settlementId（当前即 roomCode）。
 *
 * @param {{owner:string, members:string[], txs:Array<{from:string, to:string, amount:number}>}} payload
 * @returns {Promise<string>}
 */
async function createAndDissolve(payload) {
  const c = await store.createRoom(payload.owner);
  assert.equal(c.ok, true);
  const roomCode = String(c.roomCode || "");
  assert.ok(roomCode);

  for (const memberOpenId of payload.members || []) {
    const j = await store.joinRoom(memberOpenId, roomCode);
    assert.equal(j.ok, true);
  }

  for (const tx of payload.txs || []) {
    const r = await store.addTx(tx.from, tx.to, tx.amount, "");
    assert.equal(r.ok, true);
  }

  const d = await store.dissolveRoom(payload.owner);
  assert.equal(d.ok, true);
  assert.equal(String(d.settlementId || ""), roomCode);
  return roomCode;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {any[]} rows
 * @param {string} roomCode
 */
function findHistoryRow(rows, roomCode) {
  return rows.find((x) => String(x.roomCode || "") === String(roomCode || "")) || null;
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

test.before(async () => {
  await ensureProfile(OWNER_A, "甲");
  await ensureProfile(MEMBER_B, "乙");
  await ensureProfile(MEMBER_C, "丙");
  await ensureProfile(OUTSIDER_D, "丁");

  // Round 1: B +80, A -50, C -30
  round1RoomCode = await createAndDissolve({
    owner: OWNER_A,
    members: [MEMBER_B, MEMBER_C],
    txs: [
      { from: OWNER_A, to: MEMBER_B, amount: 50 },
      { from: MEMBER_C, to: MEMBER_B, amount: 30 }
    ]
  });
  await sleep(2);

  // Round 2: A +20, B -20
  round2RoomCode = await createAndDissolve({
    owner: MEMBER_B,
    members: [OWNER_A],
    txs: [{ from: MEMBER_B, to: OWNER_A, amount: 20 }]
  });
  await sleep(2);

  // Round 3: A/C 平局（无交易）
  round3RoomCode = await createAndDissolve({
    owner: MEMBER_C,
    members: [OWNER_A],
    txs: []
  });
});

test("历史列表：成员与房主都能看到同一局，且 myAmount 正确", () => {
  const ownerPage = store.listMySettlementHistory(OWNER_A, null, null, 50);
  const ownerRound1 = findHistoryRow(ownerPage.rows, round1RoomCode);
  const ownerRound2 = findHistoryRow(ownerPage.rows, round2RoomCode);
  const ownerRound3 = findHistoryRow(ownerPage.rows, round3RoomCode);
  assert.ok(ownerRound1 && ownerRound2 && ownerRound3);
  assert.equal(Number(ownerRound1.myAmount || 0), -50);
  assert.equal(Number(ownerRound2.myAmount || 0), 20);
  assert.equal(Number(ownerRound3.myAmount || 0), 0);

  const memberPage = store.listMySettlementHistory(MEMBER_B, null, null, 50);
  const memberRound1 = findHistoryRow(memberPage.rows, round1RoomCode);
  const memberRound2 = findHistoryRow(memberPage.rows, round2RoomCode);
  assert.ok(memberRound1 && memberRound2);
  assert.equal(Number(memberRound1.myAmount || 0), 80);
  assert.equal(Number(memberRound2.myAmount || 0), -20);
});

test("历史详情权限：非参与者查看返回 FORBIDDEN", () => {
  const r = store.getMySettlement(OUTSIDER_D, round1RoomCode);
  assert.equal(r.ok, false);
  assert.equal(r.code, "FORBIDDEN");
});

test("历史详情：返回完整 totals 与 membersSnapshot", () => {
  const r = store.getMySettlement(MEMBER_B, round1RoomCode);
  assert.equal(r.ok, true);
  assert.ok(r.settlement);

  const s = r.settlement;
  assert.equal(String(s.roomCode || ""), round1RoomCode);
  assert.equal(Number(s.totals[OWNER_A] || 0), -50);
  assert.equal(Number(s.totals[MEMBER_B] || 0), 80);
  assert.equal(Number(s.totals[MEMBER_C] || 0), -30);
  assert.equal(Array.isArray(s.membersSnapshot), true);
  assert.equal(s.membersSnapshot.length, 3);
});

test("历史分页：dissolvedAt + roomCode 双游标连续翻页", () => {
  const page1 = store.listMySettlementHistory(OWNER_A, null, null, 2);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.hasMore, true);
  assert.ok(Number(page1.nextBeforeDissolvedAt || 0) > 0);
  assert.ok(String(page1.nextBeforeRoomCode || ""));

  const page2 = store.listMySettlementHistory(
    OWNER_A,
    page1.nextBeforeDissolvedAt,
    page1.nextBeforeRoomCode,
    2
  );
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.hasMore, false);

  const ids = new Set([...page1.rows.map((x) => String(x.settlementId || "")), ...page2.rows.map((x) => String(x.settlementId || ""))]);
  assert.equal(ids.size, 3);

  const cursorAt = Number(page1.nextBeforeDissolvedAt || 0);
  const cursorRoom = String(page1.nextBeforeRoomCode || "");
  for (const row of page2.rows) {
    const at = Number(row.dissolvedAt || 0);
    const room = String(row.roomCode || "");
    assert.ok(at < cursorAt || (at === cursorAt && room < cursorRoom));
  }
});

test("GET /api/history/me 未鉴权返回 401", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken(OWNER_A);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, token);

    const res = await fetch(`${baseUrl}/api/history/me`, { method: "GET" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "UNAUTHORIZED");
  } finally {
    await stopServerProcess(child);
  }
});

test("GET /api/history/me 参数非法返回 ok:false", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken(OWNER_A);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, token);
    const headers = { Authorization: `Bearer ${token}` };

    const r1 = await fetch(`${baseUrl}/api/history/me?limit=abc`, { method: "GET", headers });
    const b1 = await r1.json();
    assert.equal(b1.ok, false);
    assert.equal(b1.code, "INVALID_LIMIT");

    const r2 = await fetch(`${baseUrl}/api/history/me?beforeRoomCode=XXXXXX`, { method: "GET", headers });
    const b2 = await r2.json();
    assert.equal(b2.ok, false);
    assert.equal(b2.code, "INVALID_CURSOR");

    const r3 = await fetch(`${baseUrl}/api/history/me?beforeDissolvedAt=abc&beforeRoomCode=XXXXXX`, {
      method: "GET",
      headers
    });
    const b3 = await r3.json();
    assert.equal(b3.ok, false);
    assert.equal(b3.code, "INVALID_CURSOR");
  } finally {
    await stopServerProcess(child);
  }
});

test("历史详情接口权限正确，且旧结算接口保持房主权限", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerToken = signToken(OWNER_A);
  const memberToken = signToken(MEMBER_B);
  const outsiderToken = signToken(OUTSIDER_D);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, ownerToken);

    const r1 = await fetch(`${baseUrl}/api/history/me/${round1RoomCode}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.ok(b1.settlement);

    const r2 = await fetch(`${baseUrl}/api/history/me/${round1RoomCode}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${outsiderToken}` }
    });
    const b2 = await r2.json();
    assert.equal(b2.ok, false);
    assert.equal(b2.code, "FORBIDDEN");

    const r3 = await fetch(`${baseUrl}/api/settlements/${round1RoomCode}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    const b3 = await r3.json();
    assert.equal(b3.ok, false);
    assert.equal(b3.code, "FORBIDDEN");

    const r4 = await fetch(`${baseUrl}/api/settlements/${round1RoomCode}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const b4 = await r4.json();
    assert.equal(b4.ok, true);
    assert.ok(b4.settlement);
  } finally {
    await stopServerProcess(child);
  }
});
