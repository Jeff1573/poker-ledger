const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("node:child_process");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-tx-page-"));
const SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
const LEGACY_JSON_FILE = path.join(TMP_DIR, "legacy.json");

process.env.SQLITE_FILE = SQLITE_FILE;
process.env.DB_FILE = LEGACY_JSON_FILE;
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");
const { signToken } = require("../src/auth");

const OWNER_OPEN_ID = "owner_test_openid";
const MEMBER_OPEN_ID = "member_test_openid";

let roomCode = "";

/**
 * 构造测试数据：
 * - 共 250 笔交易
 * - 其中最新 130 笔强制相同 createdAt，用于覆盖“同毫秒分页”边界
 */
async function seedRoomAndTxs() {
  const r0 = await store.ensureUserForLogin(OWNER_OPEN_ID);
  assert.equal(r0.ok, true);
  const r1 = await store.ensureUserForLogin(MEMBER_OPEN_ID);
  assert.equal(r1.ok, true);

  const p0 = await store.updateUserProfile(OWNER_OPEN_ID, {
    nickNameWx: "房主",
    avatarUrlWx: "/uploads/owner.png",
    displayName: "房主"
  });
  assert.equal(p0.ok, true);
  const p1 = await store.updateUserProfile(MEMBER_OPEN_ID, {
    nickNameWx: "成员",
    avatarUrlWx: "/uploads/member.png",
    displayName: "成员"
  });
  assert.equal(p1.ok, true);

  const c = await store.createRoom(OWNER_OPEN_ID);
  assert.equal(c.ok, true);
  roomCode = String(c.roomCode || "");
  assert.ok(roomCode);

  const j = await store.joinRoom(MEMBER_OPEN_ID, roomCode);
  assert.equal(j.ok, true);

  // 先写入 120 笔普通时间交易
  for (let i = 0; i < 120; i += 1) {
    const r = await store.addTx(OWNER_OPEN_ID, MEMBER_OPEN_ID, (i % 9) + 1, "");
    assert.equal(r.ok, true);
  }

  // 再写入 130 笔同毫秒交易，验证游标不会跳页/漏页
  const realNow = Date.now;
  const fixedNow = realNow() + 60000;
  Date.now = () => fixedNow;
  try {
    for (let i = 0; i < 130; i += 1) {
      const r = await store.addTx(OWNER_OPEN_ID, MEMBER_OPEN_ID, (i % 7) + 1, "");
      assert.equal(r.ok, true);
    }
  } finally {
    Date.now = realNow;
  }
}

/**
 * 断言交易按 createdAt desc, id desc 排序。
 *
 * @param {any[]} txs
 */
function assertTxDescOrder(txs) {
  for (let i = 1; i < txs.length; i += 1) {
    const prev = txs[i - 1];
    const cur = txs[i];
    const prevAt = Number(prev.createdAt || 0);
    const curAt = Number(cur.createdAt || 0);
    if (prevAt !== curAt) {
      assert.ok(prevAt > curAt);
      continue;
    }
    assert.ok(String(prev.id || "") > String(cur.id || ""));
  }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取一个可用端口，供子进程启动测试服务。
 */
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
 * 启动测试服务（独立进程），用于校验 HTTP 参数错误返回。
 *
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
 * 等待服务可用。
 *
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
 * 关闭测试服务进程。
 *
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
  await seedRoomAndTxs();
});

test("第一页返回 100 条且排序正确", async () => {
  const page = store.listRoomTxPage(roomCode, null, null, 100);

  assert.equal(page.txs.length, 100);
  assert.equal(page.hasMore, true);
  assert.ok(Number(page.nextBeforeCreatedAt || 0) > 0);
  assert.ok(String(page.nextBeforeId || ""));
  assertTxDescOrder(page.txs);
});

test("第二页与第一页无重复且边界正确", async () => {
  const page1 = store.listRoomTxPage(roomCode, null, null, 100);
  const page2 = store.listRoomTxPage(roomCode, page1.nextBeforeCreatedAt, page1.nextBeforeId, 100);

  assert.equal(page2.txs.length, 100);
  assert.equal(page2.hasMore, true);
  assertTxDescOrder(page2.txs);

  const ids1 = new Set(page1.txs.map((t) => String(t.id || "")));
  const ids2 = new Set(page2.txs.map((t) => String(t.id || "")));
  for (const id of ids2) {
    assert.equal(ids1.has(id), false);
  }

  for (const tx of page2.txs) {
    const createdAt = Number(tx.createdAt || 0);
    const id = String(tx.id || "");
    const cursorAt = Number(page1.nextBeforeCreatedAt || 0);
    const cursorId = String(page1.nextBeforeId || "");
    assert.ok(createdAt < cursorAt || (createdAt === cursorAt && id < cursorId));
  }
});

test("同毫秒交易可连续翻页（beforeCreatedAt + beforeId）", async () => {
  const page1 = store.listRoomTxPage(roomCode, null, null, 100);
  const page2 = store.listRoomTxPage(roomCode, page1.nextBeforeCreatedAt, page1.nextBeforeId, 100);

  const sameCreatedAtRows = page2.txs.filter((t) => Number(t.createdAt || 0) === Number(page1.nextBeforeCreatedAt || 0));
  assert.ok(sameCreatedAtRows.length > 0);

  const cursorId = String(page1.nextBeforeId || "");
  for (const tx of sameCreatedAtRows) {
    assert.ok(String(tx.id || "") < cursorId);
  }

  const page3 = store.listRoomTxPage(roomCode, page2.nextBeforeCreatedAt, page2.nextBeforeId, 100);
  assert.equal(page3.hasMore, false);

  const allIds = new Set([
    ...page1.txs.map((t) => String(t.id || "")),
    ...page2.txs.map((t) => String(t.id || "")),
    ...page3.txs.map((t) => String(t.id || ""))
  ]);
  assert.equal(allIds.size, 250);
});

test("分页接口参数非法时返回 ok:false", async () => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken(OWNER_OPEN_ID);
  const child = startServerProcess(port);

  try {
    await waitServerReady(baseUrl, token);

    const headers = {
      Authorization: `Bearer ${token}`
    };

    const r1 = await fetch(`${baseUrl}/api/rooms/${roomCode}/txs?limit=101`, {
      method: "GET",
      headers
    });
    const b1 = await r1.json();
    assert.equal(b1.ok, false);
    assert.equal(b1.code, "INVALID_LIMIT");

    const r2 = await fetch(`${baseUrl}/api/rooms/${roomCode}/txs?beforeId=tx_xxx`, {
      method: "GET",
      headers
    });
    const b2 = await r2.json();
    assert.equal(b2.ok, false);
    assert.equal(b2.code, "INVALID_CURSOR");

    const r3 = await fetch(`${baseUrl}/api/rooms/${roomCode}/txs?beforeCreatedAt=abc&beforeId=tx_xxx`, {
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
