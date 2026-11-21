const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { WebSocketServer, WebSocket } = require("ws");

process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const { signToken } = require("../src/auth");
const { createWsHub } = require("../src/wsHub");

const ROOM_CODE = "HBTEST";
const store = {
  getUserRoom() {
    return { roomCode: ROOM_CODE };
  },
  getRoomSnapshot(roomCode) {
    return { roomCode, members: [], txs: [] };
  }
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 用裸 TCP 完成 WebSocket 握手，之后完全不应答 ping —— 模拟被系统杀掉的客户端。
 */
function openSilentSocket(port, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let handshaken = false;
    let buffer = "";
    socket.on("data", (chunk) => {
      if (handshaken) return;
      buffer += chunk.toString("latin1");
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx >= 0) {
        handshaken = true;
        resolve(socket);
      }
    });
    socket.on("error", reject);
    socket.write(
      `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
    );
  });
}

test("心跳回收失联连接，同时保留正常应答的客户端", async (t) => {
  const server = http.createServer((_req, res) => res.end("ok"));
  const wss = new WebSocketServer({ server, path: "/ws" });
  const hub = createWsHub({
    wss,
    store,
    heartbeatIntervalMs: 60,
    maxMissedPongs: 2
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    hub.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const token = signToken("heartbeat_test_user");
  const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;

  // 正常客户端：ws 库会自动应答协议级 ping。
  const healthy = new WebSocket(url);
  await new Promise((resolve, reject) => {
    healthy.once("open", resolve);
    healthy.once("error", reject);
  });
  healthy.send(JSON.stringify({ type: "subscribe", roomCode: ROOM_CODE }));

  // 僵尸客户端：完成握手后再也不应答。
  const silent = await openSilentSocket(port, token);
  let silentClosed = false;
  silent.on("close", () => {
    silentClosed = true;
  });

  await wait(500);

  assert.equal(
    healthy.readyState,
    WebSocket.OPEN,
    "正常应答的客户端不应被心跳误杀"
  );
  assert.equal(
    silent.destroyed || silentClosed,
    true,
    "不应答心跳的僵尸连接应被服务端强制回收"
  );
});
