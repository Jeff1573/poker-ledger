const { verifyToken } = require("./auth");

/**
 * WebSocket Hub：维护 roomCode -> sockets 的订阅关系，并提供广播能力。
 *
 * 约定：
 * - 连接 URL：ws://host/ws?token=JWT
 * - 客户端订阅消息：{ "type": "subscribe", "roomCode": "XXXXXX" }
 * - 服务端推送：{ "type": "room_snapshot", "room":..., "members":..., "txs":... }
 * - 房间解散：{ "type": "room_dissolved", "roomCode":"XXXXXX", "settlementId":"XXXXXX" }
 */
function createWsHub({ wss, store }) {
  const roomSockets = new Map(); // Map<string, Set<WebSocket>>

  /**
   * @param {string} roomCode
   * @param {any} payload
   */
  function broadcast(roomCode, payload) {
    const set = roomSockets.get(roomCode);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  /**
   * 把房间最新快照广播给所有订阅者。
   *
   * @param {string} roomCode
   */
  function broadcastSnapshot(roomCode) {
    const snap = store.getRoomSnapshot(roomCode);
    if (!snap) {
      broadcast(roomCode, { type: "room_dissolved", roomCode, settlementId: roomCode });
      return;
    }
    broadcast(roomCode, { type: "room_snapshot", ...snap });
  }

  /**
   * 房间解散广播。
   *
   * @param {string} roomCode
   * @param {string} settlementId
   */
  function broadcastDissolved(roomCode, settlementId) {
    broadcast(roomCode, { type: "room_dissolved", roomCode, settlementId });
  }

  wss.on("connection", (ws, req) => {
    // 1) 解析 token
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";
    const openId = verifyToken(token);

    if (!openId) {
      ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "未登录或登录已过期" }));
      ws.close();
      return;
    }

    ws._openId = openId;
    ws._roomCode = "";

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data || ""));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", code: "BAD_MESSAGE", message: "消息格式错误" }));
        return;
      }

      if (!msg || !msg.type) return;

      if (msg.type === "subscribe") {
        const roomCode = String(msg.roomCode || "").trim().toUpperCase();
        if (!roomCode) {
          ws.send(JSON.stringify({ type: "error", code: "INVALID_ROOM_CODE", message: "房间号不能为空" }));
          return;
        }

        // 校验：用户必须在该房间中
        const db = store._unsafeGetDb();
        const mapping = db.userRoom[openId];
        if (!mapping || mapping.roomCode !== roomCode) {
          ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "你不在该房间中" }));
          return;
        }

        // 从旧房间解绑
        if (ws._roomCode) {
          const old = roomSockets.get(ws._roomCode);
          if (old) old.delete(ws);
        }

        ws._roomCode = roomCode;
        if (!roomSockets.has(roomCode)) roomSockets.set(roomCode, new Set());
        roomSockets.get(roomCode).add(ws);

        // 订阅成功后立即推一次快照
        broadcastSnapshot(roomCode);
      }
    });

    ws.on("close", () => {
      const roomCode = ws._roomCode;
      if (roomCode) {
        const set = roomSockets.get(roomCode);
        if (set) set.delete(ws);
      }
    });
  });

  return {
    broadcastSnapshot,
    broadcastDissolved
  };
}

module.exports = { createWsHub };

