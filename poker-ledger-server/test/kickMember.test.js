const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poker-ledger-kick-"));
const SQLITE_FILE = path.join(TMP_DIR, "db.sqlite");
const LEGACY_JSON_FILE = path.join(TMP_DIR, "legacy.json");

process.env.SQLITE_FILE = SQLITE_FILE;
process.env.DB_FILE = LEGACY_JSON_FILE;
process.env.LOG_LEVEL = "error";
process.env.LOG_HTTP_ACCESS = "0";

const store = require("../src/store");

/**
 * 创建带头像昵称的测试用户。
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
 * 创建房间并加入指定成员。
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

  for (const memberOpenId of members || []) {
    const j = await store.joinRoom(memberOpenId, roomCode);
    assert.equal(j.ok, true);
  }

  return roomCode;
}

/**
 * 从成员快照中查找指定用户。
 *
 * @param {any[]} members
 * @param {string} openId
 */
function findMember(members, openId) {
  return (members || []).find((m) => String((m && m.openId) || "") === openId) || null;
}

test("房主可以踢普通成员，被踢成员无法继续记账且允许重新加入", async () => {
  const owner = "kick_owner_ok";
  const member = "kick_member_ok";

  await ensureProfile(owner, "房主甲");
  await ensureProfile(member, "成员甲");

  const roomCode = await createRoomWithMembers(owner, [member]);
  const tx = await store.addTx(owner, member, 50, "");
  assert.equal(tx.ok, true);

  const kicked = await store.kickMember(owner, member);
  assert.equal(kicked.ok, true);
  assert.equal(kicked.roomCode, roomCode);

  assert.equal(store.getUserRoom(member), null);

  const snap = store.getRoomSnapshot(roomCode);
  assert.equal(snap.room.memberCount, 1);
  assert.equal(snap.room.totals[owner], -50);
  assert.equal(snap.room.totals[member], 50);

  const memberRow = findMember(snap.members, member);
  assert.ok(memberRow);
  assert.equal(memberRow.active, false);

  const afterKickTx = await store.addTx(member, owner, 1, "");
  assert.equal(afterKickTx.ok, false);
  assert.equal(afterKickTx.code, "NOT_IN_ROOM");

  const rejoin = await store.joinRoom(member, roomCode);
  assert.equal(rejoin.ok, true);

  const snapAfterRejoin = store.getRoomSnapshot(roomCode);
  const rejoinedMember = findMember(snapAfterRejoin.members, member);
  assert.equal(snapAfterRejoin.room.memberCount, 2);
  assert.equal(rejoinedMember.active, true);
});

test("非房主不能踢人", async () => {
  const owner = "kick_owner_forbidden";
  const memberA = "kick_member_forbidden_a";
  const memberB = "kick_member_forbidden_b";

  await ensureProfile(owner, "房主乙");
  await ensureProfile(memberA, "成员乙");
  await ensureProfile(memberB, "成员丙");

  const roomCode = await createRoomWithMembers(owner, [memberA, memberB]);
  const denied = await store.kickMember(memberA, memberB);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "FORBIDDEN");

  const snap = store.getRoomSnapshot(roomCode);
  assert.equal(findMember(snap.members, memberB).active, true);
});

test("房主不能踢自己", async () => {
  const owner = "kick_owner_self";

  await ensureProfile(owner, "房主丙");
  await createRoomWithMembers(owner, []);

  const denied = await store.kickMember(owner, owner);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "INVALID_MEMBER");
});

test("踢人后解散房间仍保留被踢成员总账与结算快照", async () => {
  const owner = "kick_owner_settlement";
  const member = "kick_member_settlement";

  await ensureProfile(owner, "房主丁");
  await ensureProfile(member, "成员丁");

  const roomCode = await createRoomWithMembers(owner, [member]);
  const tx = await store.addTx(owner, member, 75, "");
  assert.equal(tx.ok, true);

  const kicked = await store.kickMember(owner, member);
  assert.equal(kicked.ok, true);

  const dissolved = await store.dissolveRoom(owner);
  assert.equal(dissolved.ok, true);
  assert.equal(dissolved.settlementId, roomCode);

  const settlementResult = store.getSettlement(owner, roomCode);
  assert.equal(settlementResult.ok, true);
  assert.equal(settlementResult.settlement.totals[owner], -75);
  assert.equal(settlementResult.settlement.totals[member], 75);

  const memberSnapshot = findMember(settlementResult.settlement.membersSnapshot, member);
  assert.ok(memberSnapshot);
  assert.equal(memberSnapshot.active, false);
});
