import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, lookupHashThreat } from "../worker/src/index.ts";

const env = { ALLOWED_ORIGINS: "https://app.example.com", TURNSTILE_SECRET: "test-secret" };
const HASH = "a".repeat(64);
const post = (path: string, body: unknown, origin = "https://app.example.com") =>
  new Request(`https://w.example.com${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

function mockTurnstile(success: boolean) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success }))) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test("rejects disallowed origins and wrong methods", async () => {
  assert.equal((await handleRequest(post("/check-file", {}, "https://evil.example"), env)).status, 403);
  const get = new Request("https://w.example.com/check-file", { method: "GET", headers: { Origin: "https://app.example.com" } });
  assert.equal((await handleRequest(get, env)).status, 405);
});

test("rejects oversized and malformed bodies", async () => {
  assert.equal((await handleRequest(post("/check-file", { x: "y".repeat(5000) }), env)).status, 400);
  const bad = new Request("https://w.example.com/check-file", { method: "POST", headers: { Origin: "https://app.example.com" }, body: "not json" });
  assert.equal((await handleRequest(bad, env)).status, 400);
});

test("fails closed when Turnstile verification fails or secret is missing", async () => {
  const restore = mockTurnstile(false);
  try {
    assert.equal((await handleRequest(post("/check-file", { token: "t".repeat(20), sha256: HASH }), env)).status, 403);
    assert.equal((await handleRequest(post("/check-file", { token: "t".repeat(20), sha256: HASH }), { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS })).status, 403);
  } finally { restore(); }
});

test("returns Unknown (not Safe) when no threat provider is configured", async () => {
  const restore = mockTurnstile(true);
  try {
    const res = await handleRequest(post("/check-file", { token: "t".repeat(20), sha256: HASH, ext: "zip" }), env);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "Unknown");
    assert.equal(await lookupHashThreat(HASH, env), "Unknown");
  } finally { restore(); }
});

test("alert logging is unavailable (503) without a trusted sink", async () => {
  const restore = mockTurnstile(true);
  try {
    const res = await handleRequest(post("/alert", { token: "t".repeat(20), sha256: HASH, reason: "test" }), env);
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /stack|secret/i);
  } finally { restore(); }
});
