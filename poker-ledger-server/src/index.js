const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const multer = require("multer");

const config = require("./config");
const store = require("./store");
const { codeToOpenId, generateRoomMiniCode } = require("./wechat");
const {
  signToken,
  authMiddleware,
  signRoomImageAccessToken,
  verifyRoomImageAccessToken
} = require("./auth");
const { createWsHub } = require("./wsHub");
const logger = require("./logger");

const app = express();

// 基础中间件：JSON 请求体
app.use(
  express.json({
    limit: "1mb"
  })
);

// 访问日志中间件：为请求打上 reqId，并在响应完成后输出耗时。
app.use((req, res, next) => {
  req._reqId = makeReqId();
  req._startAt = Date.now();

  res.on("finish", () => {
    if (!config.LOG_HTTP_ACCESS) return;
    const durationMs = Date.now() - Number(req._startAt || Date.now());
    logger.info({
      scope: "http.access",
      event: "http.access.done",
      msg: "HTTP 请求完成",
      reqId: String(req._reqId || ""),
      openId: String(req.openId || ""),
      durationMs,
      extra: {
        method: String(req.method || ""),
        path: String(req.path || ""),
        statusCode: Number(res.statusCode || 0),
        ip: getClientIp(req)
      }
    });
  });

  next();
});

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
const TX_PAGE_DEFAULT_LIMIT = 100;
const TX_PAGE_MAX_LIMIT = 100;
const LEADERBOARD_DEFAULT_LIMIT = 100;
const LEADERBOARD_MAX_LIMIT = 200;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const MINICODE_HTTP_CACHE_MAX_AGE_SEC = 24 * 60 * 60;
const MINICODE_MEM_CACHE_MAX_AGE_MS = MINICODE_HTTP_CACHE_MAX_AGE_SEC * 1000;
const ROOM_IMAGE_ACCESS_TTL_SEC = Number(config.ROOM_IMAGE_ACCESS_TTL_SEC || 300);
const ROOM_IMAGE_RATE_LIMIT_WINDOW_MS = Number(config.ROOM_IMAGE_RATE_LIMIT_WINDOW_MS || 60000);
const ROOM_IMAGE_RATE_LIMIT_MAX = Number(config.ROOM_IMAGE_RATE_LIMIT_MAX || 30);
const roomMiniCodeCache = new Map();
const roomImageIssueRateLimit = new Map();

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
 * 解析正整数参数（空值返回 null）。
 *
 * @param {any} raw
 * @returns {number|null}
 */
function parsePositiveIntParam(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 归一化小程序码环境版本。
 *
 * @param {any} raw
 * @returns {"develop"|"trial"|"release"}
 */
function normalizeMiniCodeEnvVersion(raw) {
  const envVersion = String(raw || "").trim().toLowerCase();
  if (envVersion === "develop" || envVersion === "trial" || envVersion === "release") {
    return envVersion;
  }
  return "release";
}

/**
 * 清理过期的小程序码缓存，避免缓存无限增长。
 *
 * @param {number} nowMs
 */
function pruneExpiredRoomMiniCodeCache(nowMs) {
  for (const [key, entry] of roomMiniCodeCache.entries()) {
    const cachedAt = Number((entry && entry.cachedAt) || 0);
    if (!cachedAt || nowMs - cachedAt > MINICODE_MEM_CACHE_MAX_AGE_MS) {
      roomMiniCodeCache.delete(key);
    }
  }
}

/**
 * 校验房间号格式。
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function isValidRoomCode(roomCode) {
  return /^[0-9A-Z]{4,12}$/.test(String(roomCode || "").trim().toUpperCase());
}

/**
 * 校验用户当前是否仍在指定房间。
 *
 * @param {string} openId
 * @param {string} roomCode
 * @returns {boolean}
 */
function isUserInRoom(openId, roomCode) {
  const mapping = store.getUserRoom(openId);
  const userRoomCode = String((mapping && mapping.roomCode) || "").trim().toUpperCase();
  return !!userRoomCode && userRoomCode === roomCode;
}

/**
 * 清理过期限流窗口，避免内存增长。
 *
 * @param {number} nowMs
 */
function pruneRoomImageRateLimit(nowMs) {
  for (const [key, entry] of roomImageIssueRateLimit.entries()) {
    const windowStartAt = Number((entry && entry.windowStartAt) || 0);
    if (!windowStartAt || nowMs - windowStartAt >= ROOM_IMAGE_RATE_LIMIT_WINDOW_MS) {
      roomImageIssueRateLimit.delete(key);
    }
  }
}

/**
 * 对“签发邀请码图片链接”做基础限流（openId + sourceIp）。
 *
 * @param {import("express").Request} req
 * @param {string} openId
 * @returns {{ok: true} | {ok: false, retryAfterMs: number}}
 */
function consumeRoomImageIssueRateLimit(req, openId) {
  const nowMs = Date.now();
  pruneRoomImageRateLimit(nowMs);

  const sourceIp = getRateLimitIp(req);
  const key = `${String(openId || "").trim()}|${sourceIp}`;
  const hit = roomImageIssueRateLimit.get(key);
  if (!hit || nowMs - Number(hit.windowStartAt || 0) >= ROOM_IMAGE_RATE_LIMIT_WINDOW_MS) {
    roomImageIssueRateLimit.set(key, {
      windowStartAt: nowMs,
      count: 1
    });
    return { ok: true };
  }

  const nextCount = Number(hit.count || 0) + 1;
  if (nextCount > ROOM_IMAGE_RATE_LIMIT_MAX) {
    const retryAfterMs = Math.max(
      0,
      ROOM_IMAGE_RATE_LIMIT_WINDOW_MS - (nowMs - Number(hit.windowStartAt || nowMs))
    );
    return { ok: false, retryAfterMs };
  }

  roomImageIssueRateLimit.set(key, {
    windowStartAt: Number(hit.windowStartAt || nowMs),
    count: nextCount
  });
  return { ok: true };
}

/**
 * 校验图片访问签名（短时 token）。
 *
 * @param {import("express").Request} req
 * @param {"minicode"|"qrcode"} asset
 * @param {string} roomCode
 * @returns {{
 *   ok: true,
 *   openId: string,
 *   envVersion: "develop"|"trial"|"release"
 * } | {
 *   ok: false,
 *   httpStatus: number,
 *   code: "INVALID_ACCESS_TOKEN"|"FORBIDDEN",
 *   openId: string
 * }}
 */
function verifyRoomImageRequestAccess(req, asset, roomCode) {
  const access = String((req.query && req.query.access) || "").trim();
  if (!access) {
    return {
      ok: false,
      httpStatus: 401,
      code: "INVALID_ACCESS_TOKEN",
      openId: ""
    };
  }

  const payload = verifyRoomImageAccessToken(access);
  if (!payload) {
    return {
      ok: false,
      httpStatus: 401,
      code: "INVALID_ACCESS_TOKEN",
      openId: ""
    };
  }

  if (payload.asset !== asset || payload.roomCode !== roomCode) {
    return {
      ok: false,
      httpStatus: 401,
      code: "INVALID_ACCESS_TOKEN",
      openId: payload.openId
    };
  }

  if (!isUserInRoom(payload.openId, roomCode)) {
    return {
      ok: false,
      httpStatus: 403,
      code: "FORBIDDEN",
      openId: payload.openId
    };
  }

  return {
    ok: true,
    openId: payload.openId,
    envVersion: normalizeMiniCodeEnvVersion(payload.envVersion || "")
  };
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
 * 生成请求日志 ID，便于串联一次 HTTP 调用链路。
 */
function makeReqId() {
  return `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * 读取客户端 IP（支持反向代理场景）。
 *
 * @param {import("express").Request} req
 */
function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").trim();
  if (xff) return String(xff.split(",")[0] || "").trim();
  return String(req.socket && req.socket.remoteAddress || "");
}

/**
 * 获取“限流键”使用的来源 IP（不可直接受 x-forwarded-for 影响）。
 * 优先取 socket 来源地址；缺失时退回 Express 的 req.ip。
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
function getRateLimitIp(req) {
  const socketIp = String((req && req.socket && req.socket.remoteAddress) || "").trim();
  if (socketIp) return socketIp;
  const expressIp = String((req && req.ip) || "").trim();
  return expressIp || "unknown";
}

/**
 * 输出路由业务日志（统一格式）。
 *
 * @param {import("express").Request} req
 * @param {string} level
 * @param {string} event
 * @param {string} msg
 * @param {any} extra
 */
function routeLog(req, level, event, msg, extra) {
  let openId = String(req.openId || "");
  let roomCode = "";
  let safeExtra = extra;

  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    safeExtra = { ...extra };
    if (Object.prototype.hasOwnProperty.call(safeExtra, "openId")) {
      openId = String(safeExtra.openId || "");
      delete safeExtra.openId;
    }
    if (Object.prototype.hasOwnProperty.call(safeExtra, "roomCode")) {
      roomCode = String(safeExtra.roomCode || "");
      delete safeExtra.roomCode;
    }
  }

  const payload = {
    scope: "http.biz",
    event,
    msg,
    reqId: String(req._reqId || ""),
    openId,
    roomCode,
    extra: safeExtra
  };
  if (level === "error") {
    logger.error(payload);
    return;
  }
  if (level === "warn") {
    logger.warn(payload);
    return;
  }
  if (level === "debug") {
    logger.debug(payload);
    return;
  }
  logger.info(payload);
}

/**
 * 上传头像：
 * - chooseAvatar 返回的是本地临时路径，必须上传到后端才能在房间内跨设备同步展示
 * - 返回 avatarPath（相对路径），前端展示时应通过 API_BASE_URL 拼接成完整 URL
 */
app.post("/api/uploads/avatar", authMiddleware, upload.single("file"), async (req, res) => {
  const openId = req.openId;
  const file = req.file;

  if (!file) {
    routeLog(req, "warn", "avatar.upload.fail", "头像上传失败：未收到文件", {
      code: "NO_FILE"
    });
    return fail(res, "NO_FILE", "未收到文件");
  }
  if (!ALLOWED_IMAGE_MIME.has(String(file.mimetype || ""))) {
    routeLog(req, "warn", "avatar.upload.fail", "头像上传失败：文件类型不支持", {
      code: "INVALID_FILE",
      mime: String(file.mimetype || "")
    });
    return fail(res, "INVALID_FILE", "仅支持图片");
  }

  const ext = extFromMime(String(file.mimetype || ""));
  const fileName = `${openId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.${ext}`;
  const diskPath = path.join(AVATAR_DIR, fileName);

  // 由于使用 memoryStorage，这里直接写入 buffer
  fs.writeFileSync(diskPath, file.buffer);

  routeLog(req, "info", "avatar.upload.ok", "头像上传成功", {
    size: Number(file.size || 0)
  });

  return ok(res, { avatarPath: `/uploads/avatars/${fileName}` });
});

/**
 * 登录：用 wx.login 的 code 换 openid，并签发 JWT。
 */
app.post("/api/auth/wechat", async (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (!code) {
    routeLog(req, "warn", "auth.wechat.fail", "微信登录失败：缺少 code", {
      code: "INVALID_CODE"
    });
    return fail(res, "INVALID_CODE", "缺少 code");
  }

  const r = await codeToOpenId(code);
  if (!r.ok) {
    routeLog(req, "warn", "auth.wechat.fail", "微信登录失败：code 换取 openid 失败", {
      code: String(r.code || "")
    });
    return fail(res, r.code, r.message);
  }

  const r2 = await store.ensureUserForLogin(r.openId);
  if (!r2.ok) {
    routeLog(req, "warn", "auth.wechat.fail", "微信登录失败：用户初始化失败", {
      code: String(r2.code || ""),
      openId: r.openId
    });
    return fail(res, r2.code, r2.message);
  }

  const token = signToken(r.openId);
  routeLog(req, "info", "auth.wechat.ok", "微信登录成功", {
    openId: r.openId
  });
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

  if (!result.ok) {
    routeLog(req, "warn", "auth.deactivate.fail", "注销失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }
  wsHub.disconnectOpenId(openId, "UNAUTHORIZED", "账号已注销");
  routeLog(req, "info", "auth.deactivate.ok", "注销成功", {});
  return ok(res, { message: "注销成功" });
});

/**
 * 获取我的信息（用于首页展示/恢复房间）。
 */
app.get("/api/me", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const me = store.getMe(openId);
  routeLog(req, "debug", "me.fetch.ok", "获取我的信息成功", {
    inRoom: !!me.inRoom,
    roomCode: me.roomCode || ""
  });
  return ok(res, me);
});

/**
 * 获取全局排行榜（已登录用户可读）。
 */
app.get("/api/leaderboard", authMiddleware, async (req, res) => {
  const limitText = String((req.query && req.query.limit) || "").trim();
  let limit = LEADERBOARD_DEFAULT_LIMIT;

  if (limitText) {
    const parsedLimit = parsePositiveIntParam(limitText);
    if (!parsedLimit || parsedLimit > LEADERBOARD_MAX_LIMIT) {
      routeLog(req, "warn", "leaderboard.fetch.fail", "获取排行榜失败：limit 非法", {
        code: "INVALID_LIMIT",
        limitText
      });
      return fail(res, "INVALID_LIMIT", `limit 必须是 1~${LEADERBOARD_MAX_LIMIT} 的整数`);
    }
    limit = parsedLimit;
  }

  const leaderboard = store.getLeaderboard(limit);
  routeLog(req, "debug", "leaderboard.fetch.ok", "获取排行榜成功", {
    limit,
    rowCount: Array.isArray(leaderboard.rows) ? leaderboard.rows.length : 0,
    totalPlayers: Number(leaderboard.totalPlayers || 0)
  });
  return ok(res, { leaderboard });
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

  if (!displayName) {
    routeLog(req, "warn", "profile.update.fail", "更新资料失败：昵称不能为空", {
      code: "INVALID_DISPLAY_NAME"
    });
    return fail(res, "INVALID_DISPLAY_NAME", "昵称不能为空");
  }
  if (displayName.length > 20) {
    routeLog(req, "warn", "profile.update.fail", "更新资料失败：昵称过长", {
      code: "INVALID_DISPLAY_NAME"
    });
    return fail(res, "INVALID_DISPLAY_NAME", "昵称过长");
  }

  const result = await store.updateUserProfile(openId, { nickNameWx, avatarUrlWx, displayName });
  if (!result.ok) {
    routeLog(req, "warn", "profile.update.fail", "更新资料失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }

  // 如果用户在房间中,广播完整快照以同步成员资料更新
  const mapping = store.getUserRoom(openId);
  if (mapping && mapping.roomCode) {
    routeLog(req, "info", "profile.update.broadcast_snapshot", "资料更新后广播房间快照", {
      roomCode: mapping.roomCode
    });
    wsHub.broadcastSnapshot(mapping.roomCode);
  }

  routeLog(req, "info", "profile.update.ok", "更新资料成功", {});
  return ok(res, { user: result.user || null });
});

/**
 * 创建房间（房主）。
 */
app.post("/api/rooms/create", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.createRoom(openId);

  if (!result.ok) {
    routeLog(req, "warn", "room.create.fail", "创建房间失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }
  routeLog(req, "info", "room.create.ok", "创建房间成功", {
    roomCode: result.roomCode
  });
  return ok(res, { roomCode: result.roomCode });
});

/**
 * 加入房间（成员）。
 */
app.post("/api/rooms/join", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String((req.body && req.body.roomCode) || "").trim().toUpperCase();
  if (!roomCode) {
    routeLog(req, "warn", "room.join.fail", "加入房间失败：缺少房间号", {
      code: "INVALID_ROOM_CODE"
    });
    return fail(res, "INVALID_ROOM_CODE", "请输入房间号");
  }

  const result = await store.joinRoom(openId, roomCode);

  if (!result.ok) {
    routeLog(req, "warn", "room.join.fail", "加入房间失败", {
      code: String(result.code || ""),
      roomCode
    });
    return fail(res, result.code, result.message);
  }

  // join 成功后由 WS 广播最新快照（这里先返回 HTTP，广播在下方统一处理）
  wsHub.broadcastSnapshot(result.roomCode);
  routeLog(req, "info", "room.join.ok", "加入房间成功", {
    roomCode: result.roomCode
  });
  return ok(res, { roomCode: result.roomCode });
});

/**
 * 我是否在房间中。
 */
app.get("/api/rooms/my", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const mapping = store.getUserRoom(openId);
  if (!mapping) {
    routeLog(req, "debug", "room.my.empty", "用户当前不在房间中", {});
    return ok(res, { inRoom: false });
  }
  routeLog(req, "debug", "room.my.ok", "获取当前房间成功", {
    roomCode: mapping.roomCode,
    role: mapping.role
  });
  return ok(res, { inRoom: true, roomCode: mapping.roomCode, role: mapping.role });
});

/**
 * 获取房间快照（进入房间页时可用，主要用于兜底）。
 */
app.get("/api/rooms/:roomCode/snapshot", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();

  const mapping = store.getUserRoom(openId);
  if (!mapping || mapping.roomCode !== roomCode) {
    routeLog(req, "warn", "room.snapshot.fail", "获取快照失败：无权限", {
      code: "FORBIDDEN",
      roomCode
    });
    return fail(res, "FORBIDDEN", "你不在该房间中");
  }

  const snap = store.getRoomSnapshot(roomCode);
  if (!snap) {
    routeLog(req, "warn", "room.snapshot.fail", "获取快照失败：房间不存在", {
      code: "ROOM_NOT_FOUND",
      roomCode
    });
    return fail(res, "ROOM_NOT_FOUND", "房间不存在");
  }
  routeLog(req, "debug", "room.snapshot.ok", "获取快照成功", {
    roomCode,
    memberCount: Array.isArray(snap.members) ? snap.members.length : 0,
    txCount: Array.isArray(snap.txs) ? snap.txs.length : 0
  });
  return ok(res, snap);
});

/**
 * 获取房间交易分页（触底加载历史）。
 */
app.get("/api/rooms/:roomCode/txs", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();

  const mapping = store.getUserRoom(openId);
  if (!mapping || mapping.roomCode !== roomCode) {
    routeLog(req, "warn", "room.txs.page.fail", "获取交易分页失败：无权限", {
      code: "FORBIDDEN",
      roomCode
    });
    return fail(res, "FORBIDDEN", "你不在该房间中");
  }

  const beforeCreatedAtText = String((req.query && req.query.beforeCreatedAt) || "").trim();
  const beforeIdText = String((req.query && req.query.beforeId) || "").trim();
  const limitText = String((req.query && req.query.limit) || "").trim();

  let limit = TX_PAGE_DEFAULT_LIMIT;
  if (limitText) {
    const parsedLimit = parsePositiveIntParam(limitText);
    if (!parsedLimit || parsedLimit > TX_PAGE_MAX_LIMIT) {
      routeLog(req, "warn", "room.txs.page.fail", "获取交易分页失败：limit 非法", {
        code: "INVALID_LIMIT",
        roomCode,
        limitText
      });
      return fail(res, "INVALID_LIMIT", `limit 必须是 1~${TX_PAGE_MAX_LIMIT} 的整数`);
    }
    limit = parsedLimit;
  }

  const hasBeforeCreatedAt = !!beforeCreatedAtText;
  const hasBeforeId = !!beforeIdText;
  let beforeCreatedAt = null;
  let beforeId = null;

  // 游标必须“要么都传，要么都不传”，避免出现翻页边界不确定。
  if (hasBeforeCreatedAt || hasBeforeId) {
    if (!hasBeforeCreatedAt || !hasBeforeId) {
      routeLog(req, "warn", "room.txs.page.fail", "获取交易分页失败：游标参数不完整", {
        code: "INVALID_CURSOR",
        roomCode
      });
      return fail(res, "INVALID_CURSOR", "beforeCreatedAt 与 beforeId 必须同时提供");
    }

    const parsedBeforeCreatedAt = parsePositiveIntParam(beforeCreatedAtText);
    if (!parsedBeforeCreatedAt) {
      routeLog(req, "warn", "room.txs.page.fail", "获取交易分页失败：beforeCreatedAt 非法", {
        code: "INVALID_CURSOR",
        roomCode,
        beforeCreatedAtText
      });
      return fail(res, "INVALID_CURSOR", "beforeCreatedAt 必须是正整数");
    }
    beforeCreatedAt = parsedBeforeCreatedAt;
    beforeId = beforeIdText;
  }

  const page = store.listRoomTxPage(roomCode, beforeCreatedAt, beforeId, limit);
  routeLog(req, "debug", "room.txs.page.ok", "获取交易分页成功", {
    roomCode,
    txCount: Array.isArray(page.txs) ? page.txs.length : 0,
    hasMore: !!page.hasMore,
    limit
  });
  return ok(res, page);
});

/**
 * 成员主动退出（房主不能退出，只能解散）。
 */
app.post("/api/rooms/leave", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.leaveRoom(openId);

  if (!result.ok) {
    routeLog(req, "warn", "room.leave.fail", "退出房间失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }
  wsHub.disconnectOpenId(openId, "FORBIDDEN", "你已退出房间");
  wsHub.broadcastSnapshot(result.roomCode);
  routeLog(req, "info", "room.leave.ok", "退出房间成功", {
    roomCode: result.roomCode
  });
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

  if (!toOpenId) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败：缺少收款人", { code: "INVALID_TO" });
    return fail(res, "INVALID_TO", "请选择收款人");
  }
  if (toOpenId === fromOpenId) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败：不能转给自己", { code: "INVALID_TO" });
    return fail(res, "INVALID_TO", "不能转给自己");
  }
  if (!Number.isInteger(amount)) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败：金额非整数", {
      code: "INVALID_AMOUNT"
    });
    return fail(res, "INVALID_AMOUNT", "金额必须为整数");
  }
  if (amount <= 0) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败：金额小于等于 0", {
      code: "INVALID_AMOUNT"
    });
    return fail(res, "INVALID_AMOUNT", "金额必须大于 0");
  }
  if (amount > 99999999) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败：金额过大", {
      code: "INVALID_AMOUNT"
    });
    return fail(res, "INVALID_AMOUNT", "金额过大");
  }

  const result = await store.addTx(fromOpenId, toOpenId, amount, note);

  if (!result.ok) {
    routeLog(req, "warn", "tx.add.fail", "新增交易失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }

  // 增量推送：如果返回了完整交易对象和总账，则推送增量更新；否则兜底推送完整快照
  if (result.tx && result.totals) {
    wsHub.broadcastTxAdded(result.roomCode, result.tx, result.totals);
  } else {
    wsHub.broadcastSnapshot(result.roomCode);
  }

  routeLog(req, "info", "tx.add.ok", "新增交易成功", {
    roomCode: result.roomCode,
    txId: String(result.txId || ""),
    amount
  });

  return ok(res, { txId: result.txId });
});

/**
 * 房主解散房间：生成结算快照并清空房间数据。
 */
app.post("/api/rooms/dissolve", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const result = await store.dissolveRoom(openId);

  if (!result.ok) {
    routeLog(req, "warn", "room.dissolve.fail", "解散房间失败", {
      code: String(result.code || "")
    });
    return fail(res, result.code, result.message);
  }
  wsHub.disconnectOpenId(openId, "FORBIDDEN", "房间已解散");
  wsHub.broadcastDissolved(result.roomCode, result.settlementId);
  routeLog(req, "info", "room.dissolve.ok", "解散房间成功", {
    roomCode: result.roomCode,
    settlementId: result.settlementId
  });
  return ok(res, { settlementId: result.settlementId });
});

/**
 * 获取时间线历史分页（支持 scope=mine|all）。
 */
app.get("/api/history/timeline", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const scopeText = String((req.query && req.query.scope) || "mine").trim().toLowerCase();
  const limitText = String((req.query && req.query.limit) || "").trim();
  const beforeDissolvedAtText = String((req.query && req.query.beforeDissolvedAt) || "").trim();
  const beforeRoomCodeText = String((req.query && req.query.beforeRoomCode) || "").trim().toUpperCase();

  if (scopeText !== "mine" && scopeText !== "all") {
    routeLog(req, "warn", "timeline.list.fail", "获取时间线失败：scope 非法", {
      code: "INVALID_SCOPE",
      scopeText
    });
    return fail(res, "INVALID_SCOPE", "scope 仅支持 mine 或 all");
  }

  let limit = HISTORY_DEFAULT_LIMIT;
  if (limitText) {
    const parsedLimit = parsePositiveIntParam(limitText);
    if (!parsedLimit || parsedLimit > HISTORY_MAX_LIMIT) {
      routeLog(req, "warn", "timeline.list.fail", "获取时间线失败：limit 非法", {
        code: "INVALID_LIMIT",
        limitText
      });
      return fail(res, "INVALID_LIMIT", `limit 必须是 1~${HISTORY_MAX_LIMIT} 的整数`);
    }
    limit = parsedLimit;
  }

  const hasBeforeDissolvedAt = !!beforeDissolvedAtText;
  const hasBeforeRoomCode = !!beforeRoomCodeText;
  let beforeDissolvedAt = null;
  let beforeRoomCode = null;

  // 游标必须“要么都传，要么都不传”，避免出现翻页边界不确定。
  if (hasBeforeDissolvedAt || hasBeforeRoomCode) {
    if (!hasBeforeDissolvedAt || !hasBeforeRoomCode) {
      routeLog(req, "warn", "timeline.list.fail", "获取时间线失败：游标参数不完整", {
        code: "INVALID_CURSOR"
      });
      return fail(res, "INVALID_CURSOR", "beforeDissolvedAt 与 beforeRoomCode 必须同时提供");
    }

    const parsedBeforeDissolvedAt = parsePositiveIntParam(beforeDissolvedAtText);
    if (!parsedBeforeDissolvedAt) {
      routeLog(req, "warn", "timeline.list.fail", "获取时间线失败：beforeDissolvedAt 非法", {
        code: "INVALID_CURSOR",
        beforeDissolvedAtText
      });
      return fail(res, "INVALID_CURSOR", "beforeDissolvedAt 必须是正整数");
    }

    beforeDissolvedAt = parsedBeforeDissolvedAt;
    beforeRoomCode = beforeRoomCodeText;
  }

  const timeline = store.listTimelineHistory(openId, scopeText, beforeDissolvedAt, beforeRoomCode, limit);
  routeLog(req, "debug", "timeline.list.ok", "获取时间线成功", {
    scope: scopeText,
    limit,
    rowCount: Array.isArray(timeline.rows) ? timeline.rows.length : 0,
    hasMore: !!timeline.hasMore
  });
  return ok(res, { timeline });
});

/**
 * 获取“我的历史记录”分页（仅返回当前用户参与过的结算）。
 */
app.get("/api/history/me", authMiddleware, async (req, res) => {
  const openId = req.openId;

  const limitText = String((req.query && req.query.limit) || "").trim();
  const beforeDissolvedAtText = String((req.query && req.query.beforeDissolvedAt) || "").trim();
  const beforeRoomCodeText = String((req.query && req.query.beforeRoomCode) || "").trim().toUpperCase();

  let limit = HISTORY_DEFAULT_LIMIT;
  if (limitText) {
    const parsedLimit = parsePositiveIntParam(limitText);
    if (!parsedLimit || parsedLimit > HISTORY_MAX_LIMIT) {
      routeLog(req, "warn", "history.list.fail", "获取历史记录失败：limit 非法", {
        code: "INVALID_LIMIT",
        limitText
      });
      return fail(res, "INVALID_LIMIT", `limit 必须是 1~${HISTORY_MAX_LIMIT} 的整数`);
    }
    limit = parsedLimit;
  }

  const hasBeforeDissolvedAt = !!beforeDissolvedAtText;
  const hasBeforeRoomCode = !!beforeRoomCodeText;
  let beforeDissolvedAt = null;
  let beforeRoomCode = null;

  // 游标必须“要么都传，要么都不传”，避免出现翻页边界不确定。
  if (hasBeforeDissolvedAt || hasBeforeRoomCode) {
    if (!hasBeforeDissolvedAt || !hasBeforeRoomCode) {
      routeLog(req, "warn", "history.list.fail", "获取历史记录失败：游标参数不完整", {
        code: "INVALID_CURSOR"
      });
      return fail(res, "INVALID_CURSOR", "beforeDissolvedAt 与 beforeRoomCode 必须同时提供");
    }

    const parsedBeforeDissolvedAt = parsePositiveIntParam(beforeDissolvedAtText);
    if (!parsedBeforeDissolvedAt) {
      routeLog(req, "warn", "history.list.fail", "获取历史记录失败：beforeDissolvedAt 非法", {
        code: "INVALID_CURSOR",
        beforeDissolvedAtText
      });
      return fail(res, "INVALID_CURSOR", "beforeDissolvedAt 必须是正整数");
    }

    beforeDissolvedAt = parsedBeforeDissolvedAt;
    beforeRoomCode = beforeRoomCodeText;
  }

  const history = store.listMySettlementHistory(openId, beforeDissolvedAt, beforeRoomCode, limit);
  routeLog(req, "debug", "history.list.ok", "获取历史记录成功", {
    limit,
    rowCount: Array.isArray(history.rows) ? history.rows.length : 0,
    hasMore: !!history.hasMore
  });
  return ok(res, { history });
});

/**
 * 获取“我的某次历史详情”（仅参与该次结算的成员可读）。
 */
app.get("/api/history/me/:settlementId", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const settlementId = String(req.params.settlementId || "").trim().toUpperCase();

  const r = store.getMySettlement(openId, settlementId);
  if (!r.ok) {
    routeLog(req, "warn", "history.detail.fail", "获取历史详情失败", {
      code: String(r.code || ""),
      roomCode: settlementId
    });
    return fail(res, r.code, r.message);
  }
  routeLog(req, "info", "history.detail.ok", "获取历史详情成功", {
    roomCode: settlementId
  });
  return ok(res, { settlement: r.settlement });
});

/**
 * 获取结算（仅房主可读）。
 */
app.get("/api/settlements/:roomCode", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();

  const r = store.getSettlement(openId, roomCode);
  if (!r.ok) {
    routeLog(req, "warn", "settlement.fetch.fail", "获取结算失败", {
      code: String(r.code || ""),
      roomCode
    });
    return fail(res, r.code, r.message);
  }
  routeLog(req, "info", "settlement.fetch.ok", "获取结算成功", {
    roomCode
  });
  return ok(res, { settlement: r.settlement });
});

/**
 * 签发房间邀请码图片访问链接（需要登录 + 必须在房间内）。
 */
app.get("/api/rooms/:roomCode/share-codes", authMiddleware, async (req, res) => {
  const openId = req.openId;
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  const envVersion = normalizeMiniCodeEnvVersion((req.query && req.query.envVersion) || "");
  if (!isValidRoomCode(roomCode)) {
    routeLog(req, "warn", "room.share_codes.issue.fail", "签发邀请码失败：房间号无效", {
      code: "INVALID_ROOM_CODE"
    });
    return fail(res, "INVALID_ROOM_CODE", "房间号无效");
  }

  if (!isUserInRoom(openId, roomCode)) {
    routeLog(req, "warn", "room.share_codes.issue.fail", "签发邀请码失败：用户不在房间中", {
      code: "FORBIDDEN",
      roomCode
    });
    return fail(res, "FORBIDDEN", "你不在该房间中");
  }

  const rateLimitResult = consumeRoomImageIssueRateLimit(req, openId);
  if (!rateLimitResult.ok) {
    routeLog(req, "warn", "room.share_codes.issue.fail", "签发邀请码失败：请求过于频繁", {
      code: "RATE_LIMITED",
      roomCode,
      retryAfterMs: rateLimitResult.retryAfterMs
    });
    return fail(res, "RATE_LIMITED", "请求过于频繁，请稍后重试");
  }

  try {
    const minicodeAccess = signRoomImageAccessToken({
      asset: "minicode",
      roomCode,
      openId,
      envVersion
    });
    const qrcodeAccess = signRoomImageAccessToken({
      asset: "qrcode",
      roomCode,
      openId
    });
    const expireAt = Date.now() + ROOM_IMAGE_ACCESS_TTL_SEC * 1000;
    const minicodeUrl =
      `/api/rooms/${encodeURIComponent(roomCode)}/minicode.png` +
      `?access=${encodeURIComponent(minicodeAccess)}`;
    const qrcodeUrl =
      `/api/rooms/${encodeURIComponent(roomCode)}/qrcode.png` +
      `?access=${encodeURIComponent(qrcodeAccess)}`;

    routeLog(req, "info", "room.share_codes.issue.ok", "签发邀请码成功", {
      roomCode,
      envVersion,
      expireAt
    });

    return ok(res, {
      joinCode: {
        minicodeUrl,
        qrcodeUrl,
        expireAt
      }
    });
  } catch (err) {
    routeLog(req, "error", "room.share_codes.issue.fail", "签发邀请码异常", {
      code: "INTERNAL_ERROR",
      roomCode,
      envVersion,
      errMsg: String((err && err.message) || err || "")
    });
    return fail(res, "INTERNAL_ERROR", "邀请码生成失败，请稍后重试");
  }
});

/**
 * 房间小程序码图片（需要短时签名 access）。
 */
app.get("/api/rooms/:roomCode/minicode.png", async (req, res) => {
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  if (!isValidRoomCode(roomCode)) {
    routeLog(req, "warn", "room.minicode.fail", "生成房间小程序码失败：房间号无效", {
      code: "INVALID_ROOM_CODE"
    });
    res.status(400).end();
    return;
  }

  const accessResult = verifyRoomImageRequestAccess(req, "minicode", roomCode);
  if (!accessResult.ok) {
    routeLog(req, "warn", "room.image_access.deny", "房间图片访问拒绝", {
      code: accessResult.code,
      roomCode,
      asset: "minicode",
      openId: accessResult.openId
    });
    res.status(accessResult.httpStatus).end();
    return;
  }
  const envVersion = accessResult.envVersion;

  const nowMs = Date.now();
  const cacheKey = `${roomCode}:${envVersion}`;
  pruneExpiredRoomMiniCodeCache(nowMs);
  const cached = roomMiniCodeCache.get(cacheKey);
  if (cached && Buffer.isBuffer(cached.png)) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", `public, max-age=${MINICODE_HTTP_CACHE_MAX_AGE_SEC}`);
    res.end(cached.png);
    routeLog(req, "debug", "room.minicode.cache_hit", "命中房间小程序码缓存", {
      roomCode,
      envVersion
    });
    return;
  }

  try {
    const result = await generateRoomMiniCode(roomCode, envVersion);
    if (!result.ok) {
      routeLog(req, "warn", "room.minicode.fail", "生成房间小程序码失败", {
        code: String(result.code || ""),
        roomCode,
        envVersion
      });
      const statusCode = result.code === "WECHAT_SECRET_MISSING" ? 500 : 502;
      res.status(statusCode).end();
      return;
    }

    roomMiniCodeCache.set(cacheKey, {
      png: result.png,
      cachedAt: Date.now()
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", `public, max-age=${MINICODE_HTTP_CACHE_MAX_AGE_SEC}`);
    res.end(result.png);
    routeLog(req, "debug", "room.minicode.ok", "生成房间小程序码成功", {
      roomCode,
      envVersion
    });
  } catch (err) {
    routeLog(req, "error", "room.minicode.fail", "生成房间小程序码异常", {
      roomCode,
      envVersion,
      errMsg: String((err && err.message) || err || "")
    });
    res.status(500).end();
  }
});

/**
 * 入房二维码（需要短时签名 access）：二维码内容为 PLROOM:ROOMCODE
 */
app.get("/api/rooms/:roomCode/qrcode.png", async (req, res) => {
  const roomCode = String(req.params.roomCode || "").trim().toUpperCase();
  if (!isValidRoomCode(roomCode)) {
    routeLog(req, "warn", "room.qrcode.fail", "生成入房二维码失败：房间号无效", {
      code: "INVALID_ROOM_CODE"
    });
    res.status(400).end();
    return;
  }

  const accessResult = verifyRoomImageRequestAccess(req, "qrcode", roomCode);
  if (!accessResult.ok) {
    routeLog(req, "warn", "room.image_access.deny", "房间图片访问拒绝", {
      code: accessResult.code,
      roomCode,
      asset: "qrcode",
      openId: accessResult.openId
    });
    res.status(accessResult.httpStatus).end();
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
    routeLog(req, "debug", "room.qrcode.ok", "生成入房二维码成功", {
      roomCode
    });
  } catch (err) {
    routeLog(req, "error", "room.qrcode.fail", "生成入房二维码异常", {
      roomCode,
      errMsg: String((err && err.message) || err || "")
    });
    res.status(500).end();
  }
});

// ---------- WebSocket ----------
const server = http.createServer(app);
server.on("upgrade", (req) => {
  const rawUrl = String(req.url || "");
  let pathName = "";
  let tokenLen = 0;

  try {
    const parsedUrl = new URL(rawUrl, "http://localhost");
    pathName = String(parsedUrl.pathname || "");
    tokenLen = String(parsedUrl.searchParams.get("token") || "").length;
  } catch (err) {
    pathName = String((rawUrl.split("?")[0]) || "");
  }

  // 仅记录握手元信息，帮助定位真机连接是否到达服务端，不打印 token 明文。
  logger.info({
    scope: "ws",
    event: "ws.upgrade.incoming",
    msg: "收到 WebSocket Upgrade 请求",
    extra: {
      path: pathName,
      tokenLen,
      ip: String((req.socket && req.socket.remoteAddress) || ""),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200)
    }
  });
});
const wss = new WebSocketServer({ server, path: "/ws" });
const wsHub = createWsHub({ wss, store });

server.listen(config.PORT, () => {
  logger.info({
    scope: "server",
    event: "server.start",
    msg: "poker-ledger-server 已启动",
    extra: {
      port: config.PORT
    }
  });
});
