import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ASYNC_DOC_BUDGET, CHUNK_SIZE, base64Length, canUseMemoryFallback, checkAsyncSize, clampMemoryCap,
  maxAsyncRawBytes, MEMORY_FALLBACK_HARD_MAX,
} from "../src/lib/limits.ts";
import { FrameType, HEADER_BYTES, SequenceTracker, decodeFrame, encodeFrame, totalChunks } from "../src/lib/protocol.ts";
import { Sha256 } from "../src/lib/sha256.ts";
import {
  generateFriendId, generateRoomCode, isAdminUid, isRiskyExtension, isRoomExpired, isValidFriendId,
  isValidRoomCode, roomExpiry, ROOM_TTL_MS, sanitizeText, validateFeedback,
} from "../src/lib/validation.ts";

test("async drop: base64 form plus metadata stays under 700 KiB", () => {
  const max = maxAsyncRawBytes();
  assert.ok(base64Length(max) + 4096 <= ASYNC_DOC_BUDGET);
  assert.ok(base64Length(max + 3) + 4096 > ASYNC_DOC_BUDGET);
  assert.equal(checkAsyncSize(max).ok, true);
  assert.equal(checkAsyncSize(max + 1).ok, false);
  assert.equal(checkAsyncSize(-1).ok, false);
  assert.equal(checkAsyncSize(1.5).ok, false);
});

test("memory fallback cap is clamped and enforced", () => {
  assert.equal(clampMemoryCap(Number.NaN), 256 * 1024 * 1024);
  assert.equal(clampMemoryCap(10 ** 12), MEMORY_FALLBACK_HARD_MAX);
  assert.ok(clampMemoryCap(10 ** 12, true) < MEMORY_FALLBACK_HARD_MAX);
  assert.equal(canUseMemoryFallback(3 * 1024 ** 3, MEMORY_FALLBACK_HARD_MAX), false);
  assert.equal(canUseMemoryFallback(1024, 2048), true);
});

test("frame encode/decode round-trips", () => {
  const payload = new Uint8Array(CHUNK_SIZE).fill(7);
  const f = decodeFrame(encodeFrame({ type: FrameType.Chunk, transferId: 42, seq: 9, payload }));
  assert.equal(f.transferId, 42);
  assert.equal(f.seq, 9);
  assert.equal(f.payload.length, CHUNK_SIZE);
});

test("decoder rejects malformed frames", () => {
  const good = encodeFrame({ type: FrameType.Ack, transferId: 1, seq: 0, payload: new Uint8Array(0) });
  assert.throws(() => decodeFrame(good.slice(0, 8)), /too short/);
  const badMagic = good.slice();
  badMagic[0] = 0;
  assert.throws(() => decodeFrame(badMagic), /magic/);
  const badLen = encodeFrame({ type: FrameType.Meta, transferId: 1, seq: 0, payload: new Uint8Array(10) });
  assert.throws(() => decodeFrame(badLen.slice(0, HEADER_BYTES + 5)), /length/);
  assert.throws(() => encodeFrame({ type: FrameType.Chunk, transferId: 1, seq: 0, payload: new Uint8Array(CHUNK_SIZE + 1) }), RangeError);
});

test("sequence tracker enforces order, bounds and resume point", () => {
  const t = new SequenceTracker(5, totalChunks(CHUNK_SIZE * 4));
  const frame = (seq: number, id = 5) => ({ type: FrameType.Chunk, transferId: id, seq, payload: new Uint8Array(1) });
  assert.equal(t.lastAcked, -1);
  t.accept(frame(0));
  t.accept(frame(1));
  assert.throws(() => t.accept(frame(3)), /out-of-order/);
  assert.throws(() => t.accept(frame(2, 6)), /wrong transfer/);
  assert.equal(t.lastAcked, 1);
  assert.equal(t.resumeAt(1), 1);
  assert.throws(() => t.resumeAt(5), /cannot resume/);
  t.accept(frame(1));
  t.accept(frame(2));
  t.accept(frame(3));
  assert.equal(t.complete, true);
  assert.throws(() => t.accept(frame(4)), /beyond/);
});

test("incremental SHA-256 matches node:crypto across chunk boundaries", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 200_000]) {
    const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
    const h = new Sha256();
    for (let o = 0; o < size; o += 77) h.update(data.subarray(o, o + 77));
    assert.equal(h.digestHex(), createHash("sha256").update(data).digest("hex"), `size ${size}`);
  }
});

test("room codes, friend IDs, expiry", () => {
  assert.match(generateRoomCode(), /^\d{6}$/);
  assert.ok(isValidFriendId(generateFriendId()));
  assert.equal(isValidRoomCode("12345"), false);
  assert.equal(isValidRoomCode("12345a"), false);
  const now = 1_000_000;
  assert.equal(roomExpiry(now), now + ROOM_TTL_MS);
  assert.equal(isRoomExpired(now + ROOM_TTL_MS, now + ROOM_TTL_MS), true);
  assert.equal(isRoomExpired(now + ROOM_TTL_MS, now), false);
});

test("input sanitising and feedback validation", () => {
  assert.equal(sanitizeText("a\u0000b\u0007c", 10), "abc");
  assert.equal(sanitizeText(123, 10), "");
  assert.equal(sanitizeText("x".repeat(50), 10).length, 10);
  assert.equal(validateFeedback("nope", "hello world").ok, false);
  assert.equal(validateFeedback("bug", "hi").ok, false);
  assert.equal(validateFeedback("bug", "this is broken").ok, true);
});

test("admin helper never trusts the placeholder UID", () => {
  assert.equal(isAdminUid("abc", "abc"), true);
  assert.equal(isAdminUid("abc", "def"), false);
  assert.equal(isAdminUid(null, "abc"), false);
  assert.equal(isAdminUid("REPLACE_WITH_OWNER_UID", "REPLACE_WITH_OWNER_UID"), false);
});

test("risky extension check is advisory and extendable", () => {
  assert.equal(isRiskyExtension("setup.EXE"), true);
  assert.equal(isRiskyExtension("photo.png"), false);
  assert.equal(isRiskyExtension("a.xyz", [".xyz"]), true);
});
