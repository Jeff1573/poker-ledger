const { verifyToken } = require("./auth");
const logger = require("./logger");

/**
 * WebSocket Hub：维护 roomCode -> sockets 的订阅关系，并提供广播能力。
 *
 * 约定：
 * - 连接 URL：ws://host/ws?token=JWT
 * - 客户端订阅消息：{ "type": "subscribe", "roomCode": "XXXXXX" }
 * - 服务端推送：{ "type": "room_snapshot", "room":..., "members":..., "txs":... }
 * - 房间解散：{ "type": "room_dissolved", "roomCode":"XXXXXX", "settlementId":"XXXXXX" }
 */
function createWsHub({ wss, store, heartbeatIntervalMs, maxMissedPongs }) {
  const roomSockets = new Map(); // Map<string, Set<WebSocket>>
  const allSockets = new Set(); // Set<WebSocket>
  let connSeq = 0;

  // 心跳：每 30 秒探测一次，连续 2 次没有收到任何响应（约 60~90 秒）判定为僵尸连接。
  // 同时发送协议级 ping（浏览器/小程序底层自动回 pong）和应用级 ping（客户端显式回 pong），
  // 任一响应都会被视为存活，避免只依赖某一种实现导致误杀。
  const HEARTBEAT_INTERVAL_MS = Number(heartbeatIntervalMs) > 0
    ? Number(heartbeatIntervalMs)
    : 30 * 1000;
  const MAX_MISSED_PONGS = Number(maxMissedPongs) > 0
    ? Number(maxMissedPongs)
    : 2;

  /**
   * 从订阅池中移除指定连接。
   *
   * @param {any} ws
   */
  function removeSocketFromRoom(ws) {
    if (!ws) return;
    const roomCode = String(ws._roomCode || "").trim().toUpperCase();
    if (!roomCode) return;
    const set = roomSockets.get(roomCode);
    if (!set) return;
    set.delete(ws);
    if (set.size <= 0) {
      roomSockets.delete(roomCode);
    }
    ws._roomCode = "";
  }

  /**
   * 标记连接在上一轮心跳后仍然存活。
   * 任意入站消息（包括 pong、订阅、业务消息）都算存活信号。
   *
   * @param {any} ws
   */
  function markAlive(ws) {
    if (!ws) return;
    ws._wsAlive = true;
    ws._missedPongs = 0;
  }

  /**
   * 回收已经失联的连接：先从订阅池移除，再强制断开。
   *
   * @param {any} ws
   * @param {string} reason
   */
  function reapStaleSocket(ws, reason) {
    if (!ws) return;
    logger.warn({
      scope: "ws",
      event: "ws.heartbeat.stale",
      msg: "心跳超时，回收僵尸连接",
      reqId: ws._connId || "",
      roomCode: String(ws._roomCode || ""),
      openId: ws._openId || "",
      extra: {
        reason: String(reason || "missed_pong"),
        missedPongs: Number(ws._missedPongs || 0)
      }
    });
    removeSocketFromRoom(ws);
    allSockets.delete(ws);
    try {
      ws.terminate();
    } catch (err) {
      try {
        ws.close();
      } catch (err2) {
        // ignore
      }
    }
  }

  /**
   * 关闭连接并做统一清理。
   *
   * @param {any} ws
   * @param {{code?:string, message?:string}=} opt
   */
  function closeSocketWithReason(ws, opt) {
    if (!ws) return;
    const code = String((opt && opt.code) || "").trim().toUpperCase();
    const message = String((opt && opt.message) || "").trim();

    if (ws.readyState === 1 && code) {
      try {
        ws.send(JSON.stringify({
          type: "error",
          code,
          message: message || "连接已关闭"
        }));
      } catch (err) {
        // ignore
      }
    }

    removeSocketFromRoom(ws);
    allSockets.delete(ws);
    try {
      ws.close();
    } catch (err) {
      // ignore
    }
  }

  /**
   * @param {string} roomCode
   * @param {any} payload
   * @param {{skipMembershipCheck?: boolean}=} options
   */
  function broadcast(roomCode, payload, options) {
    const set = roomSockets.get(roomCode);
    if (!set || set.size === 0) return 0;
    const msg = JSON.stringify(payload);
    let sent = 0;
    for (const ws of set) {
      if (ws.readyState !== 1) continue;
      if (!(options && options.skipMembershipCheck)) {
        const openId = String(ws._openId || "");
        const mapping = store.getUserRoom(openId);
        const mappedRoomCode = String((mapping && mapping.roomCode) || "").trim().toUpperCase();
        if (!mapping || mappedRoomCode !== roomCode) {
          logger.warn({
            scope: "ws",
            event: "ws.broadcast.forbidden_connection",
            msg: "广播时发现连接已无房间权限，准备断开",
            reqId: ws._connId || "",
            roomCode,
            openId
          });
          closeSocketWithReason(ws, {
            code: "FORBIDDEN",
            message: "你不在该房间中"
          });
          continue;
        }
      }
      ws.send(msg);
      sent += 1;
    }
    return sent;
  }

  /**
   * 把房间最新快照广播给所有订阅者。
   *
   * @param {string} roomCode
   */
  function broadcastSnapshot(roomCode) {
    const snap = store.getRoomSnapshot(roomCode);
    if (!snap) {
      const sent = broadcast(
        roomCode,
        { type: "room_dissolved", roomCode, settlementId: roomCode },
        { skipMembershipCheck: true }
      );
      logger.warn({
        scope: "ws",
        event: "ws.broadcast.snapshot_room_missing",
        msg: "房间不存在，改为广播解散事件",
        roomCode,
        extra: { sent }
      });
      return;
    }
    const sent = broadcast(roomCode, { type: "room_snapshot", ...snap });
    logger.debug({
      scope: "ws",
      event: "ws.broadcast.snapshot",
      msg: "已广播房间快照",
      roomCode,
      extra: {
        sent,
        memberCount: Array.isArray(snap.members) ? snap.members.length : 0,
        txCount: Array.isArray(snap.txs) ? snap.txs.length : 0
      }
    });
  }

  /**
   * 广播新增交易（增量推送）。
   *
   * @param {string} roomCode - 房间号
   * @param {object} tx - 完整交易对象
   * @param {object} totals - 更新后的总账 { openId: total, ... }
   */
  function broadcastTxAdded(roomCode, tx, totals) {
    const sent = broadcast(roomCode, { type: "tx_added", tx, totals });
    logger.info({
      scope: "ws",
      event: "ws.broadcast.tx_added",
      msg: "已广播新增交易",
      roomCode,
      extra: {
        sent,
        txId: String((tx && tx.id) || "")
      }
    });
  }

  /**
   * 房间解散广播。
   *
   * @param {string} roomCode
   * @param {string} settlementId
   */
  function broadcastDissolved(roomCode, settlementId) {
    const sent = broadcast(
      roomCode,
      { type: "room_dissolved", roomCode, settlementId },
      { skipMembershipCheck: true }
    );
    logger.info({
      scope: "ws",
      event: "ws.broadcast.dissolved",
      msg: "已广播房间解散事件",
      roomCode,
      extra: {
        sent,
        settlementId: String(settlementId || "")
      }
    });
  }

  wss.on("connection", (ws, req) => {
    connSeq += 1;
    const connId = `ws_${Date.now()}_${connSeq}`;
    // 1) 解析 token
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";
    const openId = verifyToken(token);

    if (!openId) {
      logger.warn({
        scope: "ws",
        event: "ws.connection.auth_fail",
        msg: "WebSocket 鉴权失败",
        reqId: connId
      });
      ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "未登录或登录已过期" }));
      ws.close();
      return;
    }

    logger.info({
      scope: "ws",
      event: "ws.connection.accept",
      msg: "WebSocket 连接建立",
      reqId: connId,
      openId
    });

    ws._openId = openId;
    ws._roomCode = "";
    ws._connId = connId;
    markAlive(ws);
    allSockets.add(ws);

    // 协议级 pong：浏览器/小程序底层自动回复，作为存活信号。
    ws.on("pong", () => {
      markAlive(ws);
    });

    ws.on("error", (err) => {
      logger.warn({
        scope: "ws",
        event: "ws.connection.error",
        msg: "WebSocket 连接异常",
        reqId: ws._connId || "",
        roomCode: String(ws._roomCode || ""),
        openId: ws._openId || "",
        extra: { errMsg: String((err && err.message) || err || "") }
      });
      // 异常连接大概率不会再触发 close，主动清理避免泄漏。
      removeSocketFromRoom(ws);
      allSockets.delete(ws);
      try {
        ws.terminate();
      } catch (err2) {
        // ignore
      }
    });

    ws.on("message", (data) => {
      // 任何入站消息都说明对端还活着（含应用级 pong）。
      markAlive(ws);
      let msg;
      try {
        msg = JSON.parse(String(data || ""));
      } catch (err) {
        logger.warn({
          scope: "ws",
          event: "ws.message.bad_json",
          msg: "WebSocket 消息格式错误",
          reqId: ws._connId || "",
          openId: ws._openId || ""
        });
        ws.send(JSON.stringify({ type: "error", code: "BAD_MESSAGE", message: "消息格式错误" }));
        return;
      }

      if (!msg || !msg.type) return;

      if (msg.type === "subscribe") {
        const roomCode = String(msg.roomCode || "").trim().toUpperCase();
        if (!roomCode) {
          logger.warn({
            scope: "ws",
            event: "ws.subscribe.invalid_room",
            msg: "订阅失败：房间号为空",
            reqId: ws._connId || "",
            openId: ws._openId || ""
          });
          ws.send(JSON.stringify({ type: "error", code: "INVALID_ROOM_CODE", message: "房间号不能为空" }));
          return;
        }

        // 校验：用户必须在该房间中
        const mapping = store.getUserRoom(openId);
        if (!mapping || mapping.roomCode !== roomCode) {
          logger.warn({
            scope: "ws",
            event: "ws.subscribe.forbidden",
            msg: "订阅失败：用户不在房间中",
            reqId: ws._connId || "",
            roomCode,
            openId: ws._openId || ""
          });
          ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "你不在该房间中" }));
          return;
        }

        // 从旧房间解绑
        removeSocketFromRoom(ws);

        ws._roomCode = roomCode;
        if (!roomSockets.has(roomCode)) roomSockets.set(roomCode, new Set());
        roomSockets.get(roomCode).add(ws);
        const subs = roomSockets.get(roomCode).size;
        logger.info({
          scope: "ws",
          event: "ws.subscribe.ok",
          msg: "订阅房间成功",
          reqId: ws._connId || "",
          roomCode,
          openId: ws._openId || "",
          extra: { subscribers: subs }
        });

        // 订阅成功后立即推一次快照
        broadcastSnapshot(roomCode);
      }
    });

    ws.on("close", () => {
      const roomCode = String(ws._roomCode || "").trim().toUpperCase();
      let left = 0;
      if (roomCode) {
        const set = roomSockets.get(roomCode);
        if (set) {
          set.delete(ws);
          left = set.size;
          if (set.size <= 0) roomSockets.delete(roomCode);
        }
      }
      ws._roomCode = "";
      allSockets.delete(ws);
      logger.info({
        scope: "ws",
        event: "ws.connection.close",
        msg: "WebSocket 连接关闭",
        reqId: ws._connId || "",
        roomCode: roomCode || "",
        openId: ws._openId || "",
        extra: { subscribersLeft: left }
      });
    });
  });

  /**
   * 按 openId 主动断开连接（用于退出房间/注销等场景）。
   *
   * @param {string} openId
   * @param {string=} reasonCode
   * @param {string=} reasonMessage
   * @returns {number}
   */
  function disconnectOpenId(openId, reasonCode, reasonMessage) {
    const targetOpenId = String(openId || "").trim();
    if (!targetOpenId) return 0;

    let disconnected = 0;
    for (const ws of Array.from(allSockets)) {
      const wsOpenId = String((ws && ws._openId) || "").trim();
      if (!ws || wsOpenId !== targetOpenId) continue;
      closeSocketWithReason(ws, {
        code: String(reasonCode || "FORBIDDEN"),
        message: String(reasonMessage || "连接已失效")
      });
      disconnected += 1;
    }

    if (disconnected > 0) {
      logger.info({
        scope: "ws",
        event: "ws.disconnect.openid",
        msg: "已按 openId 主动断开连接",
        openId: targetOpenId,
        extra: {
          disconnected
        }
      });
    }
    return disconnected;
  }

  /**
   * 心跳定时器：探测所有连接，回收连续无响应的僵尸连接。
   * unref 后不会阻止 Node 进程退出。
   */
  const heartbeatTimer = setInterval(() => {
    let probed = 0;
    let reaped = 0;
    for (const ws of Array.from(allSockets)) {
      if (!ws || ws.readyState !== 1) {
        removeSocketFromRoom(ws);
        allSockets.delete(ws);
        reaped += 1;
        continue;
      }
      if (!ws._wsAlive) {
        ws._missedPongs = Number(ws._missedPongs || 0) + 1;
        if (ws._missedPongs >= MAX_MISSED_PONGS) {
          reapStaleSocket(ws, "missed_pong");
          reaped += 1;
          continue;
        }
      } else {
        ws._missedPongs = 0;
        ws._wsAlive = false;
      }
      probed += 1;
      // 应用级 ping：客户端回 {type:"pong"}；老版本客户端不回也没关系，协议级 ping 仍可兜底。
      try {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch (err) {
        // ignore，下一轮会走回收
      }
      // 协议级 ping：浏览器/小程序底层自动回 pong。
      try {
        ws.ping();
      } catch (err) {
        // ignore
      }
    }
    if (probed > 0 || reaped > 0) {
      logger.debug({
        scope: "ws",
        event: "ws.heartbeat.tick",
        msg: "心跳探测完成",
        extra: { probed, reaped, sockets: allSockets.size }
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  /**
   * 停止心跳定时器（进程退出或测试收尾时调用）。
   */
  function stop() {
    clearInterval(heartbeatTimer);
  }

  return {
    broadcastSnapshot,
    broadcastTxAdded,
    broadcastDissolved,
    disconnectOpenId,
    stop
  };
}

module.exports = { createWsHub };
