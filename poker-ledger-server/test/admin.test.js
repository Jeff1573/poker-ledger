const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("node:child_process");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-admin-"));
const SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
const LEGACY_JSON_FILE = path.join(TMP_DIR, "legacy.json");

process.env.SQLITE_FILE = SQLITE_FILE;
process.env.DB_FILE = LEGACY_JSON_FILE;
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");
const {
  initAdminPassword,
  verifyAdminCredentials
} = require("../src/adminAuth");

const OWNER_OPEN_ID = "admin_owner_openid";
const DELETE_OPEN_ID = "admin_delete_openid";

let adminPassword = "";
let child = null;
let baseUrl = "";

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
 * 启动测试服务，复用当前临时 SQLite 文件。
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
      LOG_HTTP_ACCESS: "0",
      ADMIN_RESET_PASSWORD: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/**
 * 等待后台接口可访问；401 也代表服务已启动。
 *
 * @param {string} url
 */
async function waitServerReady(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${url}/admin/api/session`);
      if (res.status === 401 || res.status === 200) return;
    } catch (err) {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试服务启动超时");
}

/**
 * 关闭测试服务进程。
 *
 * @param {import("child_process").ChildProcess} proc
 */
async function stopServerProcess(proc) {
  if (!proc || proc.exitCode !== null) return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (err) {
        // ignore
      }
      resolve();
    }, 2000);

    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.kill();
    } catch (err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * 发送后台请求，手动维护 Cookie 与 CSRF。
 *
 * @param {string} url
 * @param {{method?:string, cookie?:string, csrfToken?:string, body?:any}} options
 */
async function requestAdmin(url, options) {
  const opts = options || {};
  const headers = {
    Accept: "application/json"
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.csrfToken) headers["X-CSRF-Token"] = opts.csrfToken;
  if (Object.prototype.hasOwnProperty.call(opts, "body")) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${url}`, {
    method: String(opts.method || "GET"),
    headers,
    body: Object.prototype.hasOwnProperty.call(opts, "body") ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false }));
  return {
    status: res.status,
    data,
    cookie: String(res.headers.get("set-cookie") || "").split(";")[0]
  };
}

test.before(async () => {
  const realConsoleLog = console.log;
  console.log = () => {};
  try {
    const first = await initAdminPassword();
    assert.equal(first.ok, true);
    assert.equal(first.generated, true);
    assert.ok(first.password);
    assert.equal(verifyAdminCredentials("admin", first.password), true);

    process.env.ADMIN_RESET_PASSWORD = "1";
    const reset = await initAdminPassword();
    delete process.env.ADMIN_RESET_PASSWORD;
    assert.equal(reset.ok, true);
    assert.equal(reset.reset, true);
    assert.ok(reset.password);
    assert.notEqual(reset.password, first.password);
    assert.equal(verifyAdminCredentials("admin", first.password), false);
    assert.equal(verifyAdminCredentials("admin", reset.password), true);
    assert.equal(verifyAdminCredentials("admin", "wrong-password"), false);
    adminPassword = reset.password;
  } finally {
    console.log = realConsoleLog;
    delete process.env.ADMIN_RESET_PASSWORD;
  }

  const owner = await store.createAdminUser({
    openId: OWNER_OPEN_ID,
    nickNameWx: "房主",
    avatarUrlWx: "/uploads/owner.png",
    displayName: "房主"
  });
  assert.equal(owner.ok, true);

  const deletable = await store.createAdminUser({
    openId: DELETE_OPEN_ID,
    nickNameWx: "可删",
    avatarUrlWx: "/uploads/delete.png",
    displayName: "可删"
  });
  assert.equal(deletable.ok, true);

  const room = await store.createRoom(OWNER_OPEN_ID);
  assert.equal(room.ok, true);

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = startServerProcess(port);
  await waitServerReady(baseUrl);
});

test.after(async () => {
  await stopServerProcess(child);
});

test("后台 API：认证、CSRF 与用户 CRUD", async () => {
  {
    const res = await requestAdmin("/admin/api/users");
    assert.equal(res.status, 401);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "UNAUTHORIZED");
  }

  {
    const res = await requestAdmin("/admin/api/login", {
      method: "POST",
      body: {
        username: "admin",
        password: "bad-password"
      }
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "INVALID_CREDENTIALS");
  }

  const login = await requestAdmin("/admin/api/login", {
    method: "POST",
    body: {
      username: "admin",
      password: adminPassword
    }
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.ok, true);
  assert.ok(login.data.csrfToken);
  assert.ok(login.cookie);

  const cookie = login.cookie;
  const csrfToken = login.data.csrfToken;

  {
    const res = await requestAdmin("/admin/api/users", {
      method: "POST",
      cookie,
      body: {
        openId: "csrf_blocked"
      }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "INVALID_CSRF");
  }

  {
    const res = await requestAdmin("/admin/api/users?q=房主", {
      cookie
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.pagination.total >= 1);
  }

  const create = await requestAdmin("/admin/api/users", {
    method: "POST",
    cookie,
    csrfToken,
    body: {
      openId: "admin_created_openid",
      nickNameWx: "新用户",
      avatarUrlWx: "/uploads/new.png",
      displayName: "新用户"
    }
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.ok, true);
  assert.equal(create.data.user.openId, "admin_created_openid");

  const update = await requestAdmin("/admin/api/users/admin_created_openid", {
    method: "PUT",
    cookie,
    csrfToken,
    body: {
      nickNameWx: "新用户2",
      avatarUrlWx: "/uploads/new2.png",
      displayName: "新用户2"
    }
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.ok, true);
  assert.equal(update.data.user.displayName, "新用户2");

  {
    const res = await requestAdmin("/admin/api/users/admin_created_openid", {
      cookie
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.user.nickNameWx, "新用户2");
  }

  {
    const res = await requestAdmin("/admin/api/users/admin_created_openid", {
      method: "DELETE",
      cookie,
      csrfToken
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  }

  {
    const res = await requestAdmin(`/admin/api/users/${OWNER_OPEN_ID}`, {
      method: "DELETE",
      cookie,
      csrfToken
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "IN_ROOM");
  }

  {
    const res = await requestAdmin("/admin/api/logout", {
      method: "POST",
      cookie,
      csrfToken
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  }
});

test("后台 API：畸形 Cookie 按未登录处理", async () => {
  const res = await requestAdmin("/admin/api/session", {
    cookie: "pl_admin_session=%E0%A4%A"
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "UNAUTHORIZED");
});

test("后台 API：登录失败过多会触发限流", async () => {
  let last = null;
  for (let i = 0; i < 11; i += 1) {
    last = await requestAdmin("/admin/api/login", {
      method: "POST",
      body: {
        username: "admin",
        password: `bad-password-${i}`
      }
    });
  }

  assert.equal(last.status, 429);
  assert.equal(last.data.ok, false);
  assert.equal(last.data.code, "RATE_LIMITED");
});
