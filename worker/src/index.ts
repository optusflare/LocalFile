/**
 * Security Worker. Endpoints (POST, JSON, <= 4 KiB):
 *   /verify-turnstile  { token }                   -> { ok }
 *   /check-file        { token, sha256, ext, size } -> { status: "Safe" | "Flagged" | "Unknown" }
 *   /alert             { token, sha256, ext, reason } -> 202, or 503 if no trusted sink is configured
 * Secrets (set with `wrangler secret put`): TURNSTILE_SECRET, THREAT_API_KEY, ALERT_SINK_TOKEN.
 */
export interface Env {
  ALLOWED_ORIGINS: string; // comma-separated, e.g. https://yourapp.onrender.com
  TURNSTILE_SECRET?: string;
  THREAT_API_URL?: string; // optional provider adapter, see README
  THREAT_API_KEY?: string;
  ALERT_SINK_URL?: string; // optional trusted server-side sink
  ALERT_SINK_TOKEN?: string;
}

export type ThreatStatus = "Safe" | "Flagged" | "Unknown";

const MAX_BODY = 4096;
const hits = new Map<string, { n: number; reset: number }>(); // per-isolate, best effort only

function corsHeaders(origin: string | null, env: Env): Record<string, string> | null {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}

function rateLimited(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now > e.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  e.n++;
  return e.n > limit;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyTurnstile(token: unknown, env: Env, ip: string | null): Promise<boolean> {
  if (typeof token !== "string" || token.length < 10 || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = (await r.json()) as { success?: boolean };
    return d.success === true;
  } catch {
    return false;
  }
}

/** Returns Unknown unless a provider is configured. Never reports Safe without an actual lookup. */
export async function lookupHashThreat(sha256: string, env: Env): Promise<ThreatStatus> {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !env.THREAT_API_URL || !env.THREAT_API_KEY) return "Unknown";
  try {
    const r = await fetch(`${env.THREAT_API_URL.replace(/\/$/, "")}/${sha256}`, {
      headers: { Authorization: `Bearer ${env.THREAT_API_KEY}` },
    });
    if (!r.ok) return "Unknown";
    // Adapter contract: { verdict: "malicious" | "clean" | "unknown" }. "clean" means "not known bad", not "safe".
    const d = (await r.json()) as { verdict?: string };
    if (d.verdict === "malicious") return "Flagged";
    if (d.verdict === "clean") return "Safe";
    return "Unknown";
  } catch {
    return "Unknown";
  }
}

export async function logSecurityAlert(alert: { sha256: string; ext: string; reason: string }, env: Env): Promise<boolean> {
  if (!env.ALERT_SINK_URL || !env.ALERT_SINK_TOKEN) return false; // unavailable rather than insecure
  try {
    const r = await fetch(env.ALERT_SINK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ALERT_SINK_TOKEN}` },
      body: JSON.stringify({ ...alert, at: new Date().toISOString() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(req.headers.get("Origin"), env);
  if (!cors) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { ...cors, Allow: "POST, OPTIONS" });

  const ip = req.headers.get("CF-Connecting-IP");
  if (rateLimited(ip ?? "anon")) return json({ error: "rate_limited" }, 429, cors);

  const path = new URL(req.url).pathname;
  const body = await readBody(req);
  if (!body) return json({ error: "invalid_body" }, 400, cors);

  if (!(await verifyTurnstile(body.token, env, ip))) return json({ error: "turnstile_failed" }, 403, cors);
  if (path === "/verify-turnstile") return json({ ok: true }, 200, cors);

  const sha = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
  const ext = typeof body.ext === "string" ? body.ext.slice(0, 12).replace(/[^a-z0-9]/gi, "") : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ error: "invalid_hash" }, 400, cors);

  if (path === "/check-file") {
    const status = await lookupHashThreat(sha, env);
    if (status === "Flagged") await logSecurityAlert({ sha256: sha, ext, reason: "hash_flagged" }, env);
    return json({ status, advisory: "Advisory only; this does not prove a file is safe." }, 200, cors);
  }
  if (path === "/alert") {
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 120).replace(/[^\w .,:-]/g, "") : "unspecified";
    const ok = await logSecurityAlert({ sha256: sha, ext, reason }, env);
    return ok ? json({ ok: true }, 202, cors) : json({ error: "alert_logging_unavailable" }, 503, cors);
  }
  return json({ error: "not_found" }, 404, cors);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(req, env);
    } catch {
      return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  },
};
