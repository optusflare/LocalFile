import { PART_PREFIX, listNames, removeByName } from './opfsStorage';

/** Persists transfer sessions + a received-chunk bitmap in IndexedDB so partial files survive reloads and reconnects. */
export interface LedgerRec {
  tid: string;
  room: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  cs: number;
  total: number;
  bitmap: Uint8Array;
  state: 'partial' | 'done';
  part: string;
  updated: number;
}

const DB = 'aydrop-ledger';
const STORE = 'transfers';
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'tid' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch {
        res(null); // private mode etc: resume still works within the session, just not across reloads
      }
    });
  }
  return dbp;
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (d) =>
      new Promise<T | undefined>((res) => {
        if (!d) return res(undefined);
        try {
          const r = fn(d.transaction(STORE, mode).objectStore(STORE));
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(undefined);
        } catch {
          res(undefined);
        }
      })
  );
}

export const putRec = (r: LedgerRec) => tx('readwrite', (s) => s.put(r));
export const delRec = (tid: string) => tx('readwrite', (s) => s.delete(tid));
export const getRec = (tid: string) => tx('readonly', (s) => s.get(tid)) as Promise<LedgerRec | undefined>;
export const allRecs = async (): Promise<LedgerRec[]> => ((await tx('readonly', (s) => s.getAll())) as LedgerRec[] | undefined) || [];
export const listPartial = async () => (await allRecs()).filter((r) => r.state === 'partial');

// ---------- bitmap helpers (1 bit per chunk) ----------
export const newBitmap = (total: number) => new Uint8Array(Math.ceil(total / 8));
/** Returns true if the bit was newly set. */
export function setBit(bm: Uint8Array, i: number): boolean {
  const b = i >> 3;
  const m = 1 << (i & 7);
  if (bm[b] & m) return false;
  bm[b] |= m;
  return true;
}
/** First missing chunk index at or after `from` (amortised O(total) over a whole transfer). */
export function advance(bm: Uint8Array, from: number, total: number): number {
  let i = from;
  while (i < total && bm[i >> 3] & (1 << (i & 7))) i++;
  return i;
}
export function countBits(bm: Uint8Array, total: number): number {
  let n = 0;
  for (let i = 0; i < total; i++) if (bm[i >> 3] & (1 << (i & 7))) n++;
  return n;
}

/** "Clear incomplete transfers": drops partial records and their OPFS files, plus orphaned files. Skips live sessions. */
export async function clearIncomplete(active: Set<string>): Promise<number> {
  let n = 0;
  for (const r of await allRecs()) {
    if (r.state === 'partial' && !active.has(r.tid)) {
      await removeByName(r.part);
      await delRec(r.tid);
      n++;
    }
  }
  const keep = new Set((await allRecs()).map((r) => r.part));
  const live = new Set([...active].map((t) => PART_PREFIX + t));
  for (const name of await listNames()) {
    if (name.startsWith(PART_PREFIX) && !keep.has(name) && !live.has(name)) {
      await removeByName(name);
      n++;
    }
  }
  return n;
}

/** Finished-but-never-saved files from earlier page sessions can no longer be saved, so reclaim them. */
export async function sweepDone(olderThan: number) {
  for (const r of await allRecs()) {
    if (r.state === 'done' && r.updated < olderThan) {
      await removeByName(r.part);
      await delRec(r.tid);
    }
  }
}
