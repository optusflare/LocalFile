export const FEEDBACK_CATEGORIES = ["bug", "idea", "abuse", "other"] as const;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const CHAT_MAX = 500;
export const FEEDBACK_MAX = 2000;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

type Rng = (n: number) => number;
const secureRandom: Rng = (n) => {
  // rejection sampling avoids modulo bias
  const limit = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a);
  while (a[0] >= limit);
  return a[0] % n;
};

export const isValidRoomCode = (c: string): boolean => /^\d{6}$/.test(c);
export const isValidFriendId = (id: string): boolean => /^[A-HJ-NP-Z2-9]{8}$/.test(id);

export const generateFriendId = (random: Rng = secureRandom): string =>
  Array.from({ length: 8 }, () => ID_ALPHABET[random(ID_ALPHABET.length)]).join("");

export const generateRoomCode = (random: Rng = secureRandom): string =>
  Array.from({ length: 6 }, () => String(random(10))).join("");

export function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  // strip control characters (keeps \n and \t), trim, cap length
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

export type FeedbackResult = { ok: true; category: string; message: string } | { ok: false; error: string };

export function validateFeedback(category: unknown, message: unknown): FeedbackResult {
  if (typeof category !== "string" || !(FEEDBACK_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: "Invalid category" };
  }
  const m = sanitizeText(message, FEEDBACK_MAX);
  if (m.length < 5) return { ok: false, error: "Message must be at least 5 characters" };
  return { ok: true, category, message: m };
}

export const isRoomExpired = (expiresAtMs: number, now = Date.now()): boolean => now >= expiresAtMs;
export const roomExpiry = (now = Date.now()): number => now + ROOM_TTL_MS;

/** UI hint only. Real authorization is enforced by Firestore Rules and Worker checks. */
export const isAdminUid = (uid: string | null | undefined, ownerUid: string): boolean =>
  !!uid && !!ownerUid && ownerUid !== "REPLACE_WITH_OWNER_UID" && uid === ownerUid;

const RISKY_EXT = new Set(["exe", "msi", "bat", "cmd", "scr", "com", "js", "vbs", "ps1", "jar", "apk", "dmg", "pkg", "sh", "lnk"]);
export const fileExtension = (name: string): string => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

/** Advisory only: an extension check never proves a file is safe or unsafe. */
export const isRiskyExtension = (name: string, blocked: string[] = []): boolean => {
  const e = fileExtension(name);
  return RISKY_EXT.has(e) || blocked.map((b) => b.toLowerCase().replace(/^\./, "")).includes(e);
};
