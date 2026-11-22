import { sha256 } from '@noble/hashes/sha256';

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/** Incremental SHA-256 over a File/Blob in 4 MiB slices, so huge files never sit in RAM. */
export async function hashBlob(blob: Blob, onProgress?: (done: number) => void): Promise<string> {
  const h = sha256.create();
  const STEP = 4 * 1024 * 1024;
  for (let o = 0; o < blob.size; o += STEP) {
    h.update(new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer()));
    onProgress?.(Math.min(o + STEP, blob.size));
  }
  return hex(h.digest());
}
