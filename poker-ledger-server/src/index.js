const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const multer = require("multer");

const config = require("./config");
const store = require("./store");
const { codeToOpenId } = require("./wechat");
const { signToken, authMiddleware } = require("./auth");
const { createWsHub } = require("./wsHub");

const app = express();

// 基础中间件：JSON 请求体
app.use(
  express.json({
    limit: "1mb"
  })
);

// 上传目录（用于头像等资源）
const UPLOAD_ROOT = path.join(__dirname, "..", "data", "uploads");
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

// 静态资源托管：前端可通过 `${API_BASE_URL}/uploads/...` 直接访问
app.use("/uploads", express.static(UPLOAD_ROOT));

// 头像上传：使用内存存储，服务端自行落盘（便于统一命名与校验）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // 头像不需要太大，限制 2MB 足够
    fileSize: 2 * 1024 * 1024
  }
});

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 根据 mime 推断扩展名（仅用于落盘命名）。
 * @param {string} mime
 * @returns {string}
 */
function extFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

/**
 * 统一输出成功。
 */
function ok(res, data) {
  res.json({ ok: true, ...data });
}

/**
 * 统一输出失败（HTTP 200，前端按 ok 判断）。
 */
function fail(res, code, message) {
  res.json({ ok: false, code, message });
}

/**
 * 上传头像：
 * - chooseAvatar 返回的是本地临时路径，必须上传到后端才能在房间内跨设备同步展示
 * - 返回 avatarPath（相对路径），前端展示时应通过 API_BASE_URL 拼接成完整 URL
 */
app.post("/api/uploads/avatar", authMiddleware, upload.single("file"), async (req, res) => {
  const openId = req.openId;
  const file = req.file;

  if (!file) return fail(res, "NO_FILE", "未收到文件");
  if (!ALLOWED_IMAGE_MIME.has(String(file.mimetype || ""))) return fail(res, "INVALID_FILE", "仅支持图片");

  const ext = extFromMime(String(file.mimetype || ""));
  const fileName = `${openId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.${ext}`;
  const diskPath = path.join(AVATAR_DIR, fileName);

  // 由于使用 memoryStorage，这里直接写入 buffer
  fs.writeFileSync(diskPath, file.buffer);

  return ok(res, { avatarPath: `/uploads/avatars/${fileName}` });
});

/**
 * 登录：用 wx.login 的 code 换 openid，并签发 JWT。
 */
app.post("/api/auth/wechat", async (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (!code) return fail(res, "INVALID_CODE", "缺少 code");

  const r = await codeToOpenId(code);
  if (!r.ok) return fail(res, r.code, r.message);

  await store.withLock(() => {
    store.ensureUser(r.openId);
    store.persist();
  });

  const token = signToken(r.openId);
  return ok(res, { token, openId: r.openId });
});

/**
 * 注销账号
 * - 删除用户档案数据 (db.users)
 * - 前端清除本地 token
 * - 注意:如果用户在房间中,需要先退出房间才能注销
 */
app.post("/api/auth/deactivate", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.withLock((db) => {
    // 检查用户是否在房间中
    const mapping = db.userRoom[openId];
    if (mapping) {
      return store.fail("IN_ROOM", "请先退出房间后再注销账号");
    }

    // 删除用户档案数据
    if (db.users[openId]) {
      delete db.users[openId];
    }

    store.persist();
    return { ok: true };
  });

  if (!result.ok) return fail(res, result.code, result.message);
  return ok(res, { message: "注销成功" });
});

/**
 * 获取我的信息（用于首页展示/恢复房间）。
 */
app.get("/api/me", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const db = store._unsafeGetDb();

  const user = db.users[openId] || null;
  const mapping = db.userRoom[openId] || null;

  return ok(res, {
    openId,
    user,
    inRoom: !!mapping,
    roomCode: mapping ? mapping.roomCode : "",
    role: mapping ? mapping.role : ""
  });
});

/**
 * 保存用户资料（微信头像/昵称 + 展示昵称）。
 */
app.put("/api/users/profile", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const nickNameWx = Object.prototype.hasOwnProperty.call(req.body || {}, "nickNameWx")
    ? String((req.body && req.body.nickNameWx) || "").trim()
    : null;
  const avatarUrlWx = Object.prototype.hasOwnProperty.call(req.body || {}, "avatarUrlWx")
    ? String((req.body && req.body.avatarUrlWx) || "").trim()
    : null;
  const displayName = String((req.body && req.body.displayName) || "").trim();

  if (!displayName) return fail(res, "INVALID_DISPLAY_NAME", "昵称不能为空");
  if (displayName.length > 20) return fail(res, "INVALID_DISPLAY_NAME", "昵称过长");

  await store.withLock((db) => {
    const user = store.ensureUser(openId);
    const now = Date.now();
    if (nickNameWx !== null) user.nickNameWx = nickNameWx;
    if (avatarUrlWx !== null) user.avatarUrlWx = avatarUrlWx;
    user.displayName = displayName;
    user.updatedAt = now;

    // 若用户在房间中，尝试同步 roomMembers 的展示字段
    const mapping = db.userRoom[openId];
    if (mapping && mapping.roomCode) {
      const roomCode = mapping.roomCode;
      if (!db.roomMembers[roomCode]) db.roomMembers[roomCode] = {};
      const m = db.roomMembers[roomCode][openId];
      if (m) {
        m.displayName = displayName;
        if (avatarUrlWx !== null) m.avatarUrl = avatarUrlWx;
        m.updatedAt = now;
      }
    }

    store.persist();
  });

  const db2 = store._unsafeGetDb();
  return ok(res, { user: db2.users[openId] || null });
});

/**
 * 创建房间（房主）。
 */
app.post("/api/rooms/create", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.withLock((db) => {
    const mapping = db.userRoom[openId];
    if (mapping) return store.fail("ALREADY_IN_ROOM", "你已在房间中，不能重复创建");

    const user = store.ensureUser(openId);
    if (!user.displayName || !user.avatarUrlWx) {
      return store.fail("PROFILE_REQUIRED", "请先在小程序授权获取头像昵称");
    }

    let roomCode = "";
    for (let i = 0; i < 20; i += 1) {
      const c = store.genRoomCode();
      if (!db.rooms[c]) {
        roomCode = c;
        break;
      }
    }
    if (!roomCode) return store.fail("CREATE_ROOM_FAILED", "创建房间失败，请稍后重试");

    const now = Date.now();
    db.rooms[roomCode] = {
      roomCode,
      ownerOpenId: openId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      memberCount: 1,
      totals: { [openId]: 0 },
      lastTxAt: 0
    };

    db.userRoom[openId] = { roomCode, role: "owner", joinedAt: now };

    if (!db.roomMembers[roomCode]) db.roomMembers[roomCode] = {};
    db.roomMembers[roomCode][openId] = {
      openId,
      role: "owner",
      displayName: user.displayName,
      avatarUrl: user.avatarUrlWx,
      joinedAt: now,
      active: true,
      updatedAt: now
    };

    if (!db.roomTxs[roomCode]) db.roomTxs[roomCode] = [];

    store.persist();
    return { ok: true, roomCode };
  });

  if (!result.ok) return fail(res, result.code, result.message);
  return ok(res, { roomCode: result.roomCode });
});

/**
 * 加入房间（成员）。
 */
app.post("/api/rooms/join", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String((req.body && req.body.roomCode) || "").trim().toUpperCase();
  if (!roomCode) return fail(res, "INVALID_ROOM_CODE", "请输入房间号");

  const result = await store.withLock((db) => {
    const mapping = db.userRoom[openId];
    if (mapping) return store.fail("ALREADY_IN_ROOM", "加入新房间前请先退出当前房间");

    const room = db.rooms[roomCode];
    if (!room) return store.fail("ROOM_NOT_FOUND", "房间不存在");
    if (room.status !== "active") return store.fail("ROOM_NOT_ACTIVE", "房间不可加入（可能已解散）");

    const user = store.ensureUser(openId);
    if (!user.displayName || !user.avatarUrlWx) {
      return store.fail("PROFILE_REQUIRED", "请先在小程序授权获取头像昵称");
    }

    const now = Date.now();
    db.userRoom[openId] = { roomCode, role: "member", joinedAt: now };

    if (!db.roomMembers[roomCode]) db.roomMembers[roomCode] = {};
    const existed = db.roomMembers[roomCode][openId];
    const wasActive = !!(existed && existed.active);

    db.roomMembers[roomCode][openId] = {
      openId,
      role: "member",
      displayName: user.displayName,
      avatarUrl: user.avatarUrlWx,
      joinedAt: existed ? existed.joinedAt : now,
      active: true,
      updatedAt: now
    };

    // 维护 memberCount=active 成员数
    room.memberCount = store.calcActiveMemberCount(roomCode);
    room.updatedAt = now;

    // totals：首次出现则补 0，保证总账展示完整
    if (!Object.prototype.hasOwnProperty.call(room.totals || {}, openId)) {
      room.totals[openId] = 0;
    }

    if (!db.roomTxs[roomCode]) db.roomTxs[roomCode] = [];

    store.persist();
    return { ok: true, roomCode, wasActive };
  });

  if (!result.ok) return fail(res, result.code, result.message);

  // join 成功后由 WS 广播最新快照（这里先返回 HTTP，广播在下方统一处理）
  wsHub.broadcastSnapshot(result.roomCode);
  return ok(res, { roomCode: result.roomCode });
});

/**
 * 我是否在房间中。
 */
app.get("/api/rooms/my", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const db = store._unsafeGetDb();
  const mapping = db.userRoom[openId];
  if (!mapping) return ok(res, { inRoom: false });
  return ok(res, { inRoom: true, roomCode: mapping.roomCode, role: mapping.role });
});

/**
 * 获取房间快照（进入房间页时可用，主要用于兜底）。
 */
app.get("/api/rooms/:roomCode/snapshot", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  const db = store._unsafeGetDb();

  const mapping = db.userRoom[openId];
  if (!mapping || mapping.roomCode !== roomCode) return fail(res, "FORBIDDEN", "你不在该房间中");

  const snap = store.getRoomSnapshot(roomCode);
  if (!snap) return fail(res, "ROOM_NOT_FOUND", "房间不存在");
  return ok(res, snap);
});

/**
 * 成员主动退出（房主不能退出，只能解散）。
 */
app.post("/api/rooms/leave", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.withLock((db) => {
    const mapping = db.userRoom[openId];
    if (!mapping) return store.fail("NOT_IN_ROOM", "你不在任何房间中");
    if (mapping.role === "owner") return store.fail("OWNER_CANNOT_LEAVE", "房主不能退出，请使用解散房间");

    const roomCode = mapping.roomCode;
    const room = db.rooms[roomCode];
    if (!room) return store.fail("ROOM_NOT_FOUND", "房间不存在");

    delete db.userRoom[openId];
    if (db.roomMembers[roomCode] && db.roomMembers[roomCode][openId]) {
      db.roomMembers[roomCode][openId].active = false;
      db.roomMembers[roomCode][openId].updatedAt = Date.now();
    }

    room.memberCount = store.calcActiveMemberCount(roomCode);
    room.updatedAt = Date.now();

    store.persist();
    return { ok: true, roomCode };
  });

  if (!result.ok) return fail(res, result.code, result.message);
  wsHub.broadcastSnapshot(result.roomCode);
  return ok(res, {});
});

/**
 * 新增交易（转账）。
 */
app.post("/api/txs", authMiddleware, async (req, res) => {
  const fromOpenId = req.openId;
  const toOpenId = String((req.body && req.body.toOpenId) || "").trim();
  const note = String((req.body && req.body.note) || "").trim().slice(0, 50);
  const amount = Number((req.body && req.body.amount) || 0);

  if (!toOpenId) return fail(res, "INVALID_TO", "请选择收款人");
  if (toOpenId === fromOpenId) return fail(res, "INVALID_TO", "不能转给自己");
  if (!Number.isInteger(amount)) return fail(res, "INVALID_AMOUNT", "金额必须为整数");
  if (amount <= 0) return fail(res, "INVALID_AMOUNT", "金额必须大于 0");
  if (amount > 99999999) return fail(res, "INVALID_AMOUNT", "金额过大");

  const result = await store.withLock((db) => {
    const mapping = db.userRoom[fromOpenId];
    if (!mapping) return store.fail("NOT_IN_ROOM", "你不在房间中");
    const roomCode = mapping.roomCode;

    const room = db.rooms[roomCode];
    if (!room) return store.fail("ROOM_NOT_FOUND", "房间不存在");
    if (room.status !== "active") return store.fail("ROOM_NOT_ACTIVE", "房间不可记账（可能已解散）");

    const membersMap = db.roomMembers[roomCode] || {};
    const fromMember = membersMap[fromOpenId];
    const toMember = membersMap[toOpenId];
    if (!fromMember || !fromMember.active) return store.fail("MEMBER_INACTIVE", "你已退出房间，不能记账");
    if (!toMember || !toMember.active) return store.fail("TO_NOT_IN_ROOM", "收款人不在房间中");

    const txId = `tx_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    const tx = {
      id: txId,
      roomCode,
      fromOpenId,
      toOpenId,
      amount,
      note,
      createdAt: Date.now(),
      fromName: fromMember.displayName,
      toName: toMember.displayName,
      fromAvatar: fromMember.avatarUrl,
      toAvatar: toMember.avatarUrl
    };

    if (!db.roomTxs[roomCode]) db.roomTxs[roomCode] = [];
    db.roomTxs[roomCode].push(tx);

    if (!room.totals) room.totals = {};
    if (!Object.prototype.hasOwnProperty.call(room.totals, fromOpenId)) room.totals[fromOpenId] = 0;
    if (!Object.prototype.hasOwnProperty.call(room.totals, toOpenId)) room.totals[toOpenId] = 0;
    room.totals[fromOpenId] -= amount;
    room.totals[toOpenId] += amount;
    room.lastTxAt = tx.createdAt;
    room.updatedAt = tx.createdAt;

    store.persist();
    return { ok: true, roomCode, txId };
  });

  if (!result.ok) return fail(res, result.code, result.message);
  wsHub.broadcastSnapshot(result.roomCode);
  return ok(res, { txId: result.txId });
});

/**
 * 房主解散房间：生成结算快照并清空房间数据。
 */
app.post("/api/rooms/dissolve", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.withLock((db) => {
    const mapping = db.userRoom[openId];
    if (!mapping) return store.fail("NOT_IN_ROOM", "你不在房间中");
    if (mapping.role !== "owner") return store.fail("FORBIDDEN", "仅房主可解散房间");

    const roomCode = mapping.roomCode;
    const room = db.rooms[roomCode];
    if (!room) return store.fail("ROOM_NOT_FOUND", "房间不存在");

    const membersMap = db.roomMembers[roomCode] || {};
    const members = Object.values(membersMap);
    const totals = { ...(room.totals || {}) };

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

    const txCount = (db.roomTxs[roomCode] || []).length;
    const dissolvedAt = Date.now();

    db.settlements[roomCode] = {
      roomCode,
      ownerOpenId: openId,
      totals,
      membersSnapshot,
      txCount,
      dissolvedAt
    };

    // 广播解散（先广播后清理，客户端能及时收到）
    // 注意：此时 room 仍存在，WS 收到解散消息后会自行跳转

    // 清理房间数据
    delete db.rooms[roomCode];
    delete db.roomMembers[roomCode];
    delete db.roomTxs[roomCode];

    // 释放一人一房映射：清理仍在该房间的映射
    for (const [oid, m] of Object.entries(db.userRoom)) {
      if (m && m.roomCode === roomCode) delete db.userRoom[oid];
    }

    store.persist();
    return { ok: true, roomCode, settlementId: roomCode };
  });

  if (!result.ok) return fail(res, result.code, result.message);
  wsHub.broadcastDissolved(result.roomCode, result.settlementId);
  return ok(res, { settlementId: result.settlementId });
});

/**
 * 获取结算（仅房主可读）。
 */
app.get("/api/settlements/:roomCode", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();

  const db = store._unsafeGetDb();
  const s = db.settlements[roomCode];
  if (!s) return fail(res, "NOT_FOUND", "结算不存在");
  if (s.ownerOpenId !== openId) return fail(res, "FORBIDDEN", "仅房主可查看结算");
  return ok(res, { settlement: s });
});

/**
 * 入房二维码（公共资源）：二维码内容为 PLROOM:ROOMCODE
 * 说明：图片资源无法方便地携带 Authorization header，因此这里不强制鉴权。
 */
app.get("/api/rooms/:roomCode/qrcode.png", async (req, res) => {
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  if (!roomCode) {
    res.status(400).end();
    return;
  }

  const text = `PLROOM:${roomCode}`;
  try {
    const png = await QRCode.toBuffer(text, {
      type: "png",
      width: 600,
      margin: 1
    });
    res.setHeader("Content-Type", "image/png");
    res.end(png);
  } catch (err) {
    res.status(500).end();
  }
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const wsHub = createWsHub({ wss, store });

server.listen(config.PORT, () => {
  console.log(`poker-ledger-server 已启动：http://127.0.0.1:${config.PORT}`);
});
