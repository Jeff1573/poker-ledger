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

  const r2 = await store.ensureUserForLogin(r.openId);
  if (!r2.ok) return fail(res, r2.code, r2.message);

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

  const result = await store.deactivateUser(openId);

  if (!result.ok) return fail(res, result.code, result.message);
  return ok(res, { message: "注销成功" });
});

/**
 * 获取我的信息（用于首页展示/恢复房间）。
 */
app.get("/api/me", authMiddleware, async (req, res) => {
  const openId = req.openId;

  return ok(res, store.getMe(openId));
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

  const result = await store.updateUserProfile(openId, { nickNameWx, avatarUrlWx, displayName });
  if (!result.ok) return fail(res, result.code, result.message);
  return ok(res, { user: result.user || null });
});

/**
 * 创建房间（房主）。
 */
app.post("/api/rooms/create", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.createRoom(openId);

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

  const result = await store.joinRoom(openId, roomCode);

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
  const mapping = store.getUserRoom(openId);
  if (!mapping) return ok(res, { inRoom: false });
  return ok(res, { inRoom: true, roomCode: mapping.roomCode, role: mapping.role });
});

/**
 * 获取房间快照（进入房间页时可用，主要用于兜底）。
 */
app.get("/api/rooms/:roomCode/snapshot", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();

  const mapping = store.getUserRoom(openId);
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

  const result = await store.leaveRoom(openId);

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

  const result = await store.addTx(fromOpenId, toOpenId, amount, note);

  if (!result.ok) return fail(res, result.code, result.message);

  // 增量推送：如果返回了完整交易对象和总账，则推送增量更新；否则兜底推送完整快照
  if (result.tx && result.totals) {
    wsHub.broadcastTxAdded(result.roomCode, result.tx, result.totals);
  } else {
    wsHub.broadcastSnapshot(result.roomCode);
  }

  return ok(res, { txId: result.txId });
});

/**
 * 房主解散房间：生成结算快照并清空房间数据。
 */
app.post("/api/rooms/dissolve", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.dissolveRoom(openId);

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

  const r = store.getSettlement(openId, roomCode);
  if (!r.ok) return fail(res, r.code, r.message);
  return ok(res, { settlement: r.settlement });
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
