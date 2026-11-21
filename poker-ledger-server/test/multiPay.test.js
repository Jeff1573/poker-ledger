const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-multipay-"));
process.env.SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
process.env.DB_FILE = path.join(TMP_DIR, "legacy.json");
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");

/**
 * 建立带昵称头像的用户（未完成资料不能进房）。
 *
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
 * 建房并加入成员。
 *
 * @param {string} ownerOpenId
 * @param {string[]} members
 * @returns {Promise<string>}
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

test("一次付款给多人：生成多条交易且总账正确", async () => {
  const payer = "mp_payer";
  const winners = ["mp_win_a", "mp_win_b", "mp_win_c"];

  await ensureProfile(payer, "点炮的人");
  for (const w of winners) await ensureProfile(w, `赢家${w.slice(-1)}`);
  const roomCode = await createRoomWithMembers(payer, winners);

  const r = await store.addTxBatch(
    payer,
    winners.map((openId) => ({ openId, amount: 100 })),
    { note: "一炮三响", clientToken: "tok_1" }
  );

  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.txs.length, 3);
  assert.ok(r.groupId, "多笔应有共同 groupId");

  // 三条记录共用同一个 groupId
  for (const t of r.txs) assert.equal(t.groupId, r.groupId);

  // 付款人 -300，三家各 +100
  assert.equal(r.totals[payer], -300);
  for (const w of winners) assert.equal(r.totals[w], 100);

  // 快照里的总账也要一致
  const snap = store.getRoomSnapshot(roomCode);
  const totalsInSnap = (snap && snap.room && snap.room.totals) || {};
  assert.equal(Number(totalsInSnap[payer] || 0), -300);
  for (const w of winners) assert.equal(Number(totalsInSnap[w] || 0), 100);
});

test("金额可以各不相同", async () => {
  const payer = "mp2_payer";
  const a = "mp2_a";
  const b = "mp2_b";

  await ensureProfile(payer, "付款人");
  await ensureProfile(a, "甲");
  await ensureProfile(b, "乙");
  await createRoomWithMembers(payer, [a, b]);

  const r = await store.addTxBatch(
    payer,
    [
      { openId: a, amount: 50 },
      { openId: b, amount: 150 }
    ],
    { note: "" }
  );
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.totals[payer], -200);
  assert.equal(r.totals[a], 50);
  assert.equal(r.totals[b], 150);
});

test("同一 clientToken 重复提交只记一次", async () => {
  const payer = "mp3_payer";
  const a = "mp3_a";

  await ensureProfile(payer, "付款人");
  await ensureProfile(a, "甲");
  const roomCode = await createRoomWithMembers(payer, [a]);

  const first = await store.addTxBatch(payer, [{ openId: a, amount: 80 }], { clientToken: "same_token" });
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);

  const second = await store.addTxBatch(payer, [{ openId: a, amount: 80 }], { clientToken: "same_token" });
  assert.equal(second.ok, true);
  assert.equal(second.duplicated, true);
  assert.equal(second.count, 0);

  // 账目只加了一次
  assert.equal(second.totals[payer], -80);
  assert.equal(second.totals[a], 80);

  const page = store.listRoomTxPage(roomCode, null, null, 100);
  assert.equal(page.txs.length, 1);
});

test("非法输入被拒绝且不产生任何记录", async () => {
  const payer = "mp4_payer";
  const a = "mp4_a";
  const b = "mp4_b";

  await ensureProfile(payer, "付款人");
  await ensureProfile(a, "甲");
  await ensureProfile(b, "乙");
  const roomCode = await createRoomWithMembers(payer, [a, b]);

  const dup = await store.addTxBatch(payer, [
    { openId: a, amount: 10 },
    { openId: a, amount: 20 }
  ]);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "DUPLICATE_TARGET");

  const self = await store.addTxBatch(payer, [{ openId: payer, amount: 10 }]);
  assert.equal(self.ok, false);
  assert.equal(self.code, "INVALID_TO");

  const zero = await store.addTxBatch(payer, [{ openId: a, amount: 0 }]);
  assert.equal(zero.ok, false);
  assert.equal(zero.code, "INVALID_AMOUNT");

  const frac = await store.addTxBatch(payer, [{ openId: a, amount: 1.5 }]);
  assert.equal(frac.ok, false);
  assert.equal(frac.code, "INVALID_AMOUNT");

  const empty = await store.addTxBatch(payer, []);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "INVALID_TO");

  // 全部被拒绝，账目应为空
  const page = store.listRoomTxPage(roomCode, null, null, 100);
  assert.equal(page.txs.length, 0);
  const snap = store.getRoomSnapshot(roomCode);
  const totalsInSnap = (snap && snap.room && snap.room.totals) || {};
  for (const openId of Object.keys(totalsInSnap)) {
    assert.equal(Number(totalsInSnap[openId] || 0), 0);
  }
});

test("收款人不在房间时整批回滚", async () => {
  const payer = "mp5_payer";
  const a = "mp5_a";
  const outsider = "mp5_outsider";

  await ensureProfile(payer, "付款人");
  await ensureProfile(a, "甲");
  await ensureProfile(outsider, "局外人");
  const roomCode = await createRoomWithMembers(payer, [a]);

  const r = await store.addTxBatch(payer, [
    { openId: a, amount: 10 },
    { openId: outsider, amount: 10 }
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "TO_NOT_IN_ROOM");

  // 第一条（合法）也必须被回滚
  const page = store.listRoomTxPage(roomCode, null, null, 100);
  assert.equal(page.txs.length, 0);
});
