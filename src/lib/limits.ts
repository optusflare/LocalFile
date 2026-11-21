export const CHUNK_SIZE = 64 * 1024;
export const FIRESTORE_DOC_LIMIT = 1024 * 1024; // hard Firestore limit
export const ASYNC_DOC_BUDGET = 700 * 1024; // our strict serialized-doc cap
export const ASYNC_METADATA_RESERVE = 4 * 1024; // name, mime, uid, timestamps, field overhead
export const MEMORY_FALLBACK_DEFAULT = 256 * 1024 * 1024;
export const MEMORY_FALLBACK_HARD_MAX = 1024 * 1024 * 1024;

export const base64Length = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

/** Largest raw file size whose base64 form plus metadata stays under the doc budget. */
export function maxAsyncRawBytes(): number {
  const room = ASYNC_DOC_BUDGET - ASYNC_METADATA_RESERVE;
  return Math.floor(room / 4) * 3;
}

export function checkAsyncSize(rawBytes: number): { ok: boolean; maxBytes: number; message: string } {
  const maxBytes = maxAsyncRawBytes();
  const ok = Number.isInteger(rawBytes) && rawBytes >= 0 && rawBytes <= maxBytes;
  return {
    ok,
    maxBytes,
    message: ok
      ? "Within the Async Drop limit."
      : `Async Drop accepts files up to ${Math.floor(maxBytes / 1024)} KiB (base64 adds ~33% and the stored document must stay under ${ASYNC_DOC_BUDGET / 1024} KiB). Use Global P2P for larger files.`,
  };
}

/** Clamp a user-chosen memory-fallback cap (bytes) to safe bounds. */
export function clampMemoryCap(requestedBytes: number, isMobile = false): number {
  const ceiling = isMobile ? MEMORY_FALLBACK_DEFAULT / 2 : MEMORY_FALLBACK_HARD_MAX;
  if (!Number.isFinite(requestedBytes) || requestedBytes <= 0) return Math.min(MEMORY_FALLBACK_DEFAULT, ceiling);
  return Math.min(Math.floor(requestedBytes), ceiling);
}

export function canUseMemoryFallback(fileSize: number, capBytes: number): boolean {
  return Number.isFinite(fileSize) && fileSize >= 0 && fileSize <= capBytes;
}
