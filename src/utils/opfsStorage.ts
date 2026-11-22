/**
 * Disk-backed storage for incoming file chunks, with three tiers:
 *   1. opfs-worker: Web Worker + createSyncAccessHandle (Safari, Firefox, Chromium)
 *   2. opfs-main:   createWritable on the main thread (Chromium-style fallback)
 *   3. memory:      in-RAM chunks, used when OPFS is missing, blocked or out of quota
 * All writes are positional, so re-writing a chunk after a resume is harmless.
 */
export type StorageKind = 'opfs-worker' | 'opfs-main' | 'memory';
export const PART_PREFIX = 'aydrop_';
export const partName = (tid: string) => PART_PREFIX + tid;

export interface PartialFile {
  kind: StorageKind;
  write(position: number, data: Uint8Array): void;
  /** Resolves once everything written so far is durable. Rejects if any earlier write failed. */
  flush(): Promise<void>;
  /** Closes the file for writing and returns it as a disk-backed File (or in-memory Blob). */
  finish(): Promise<Blob>;
  close(): Promise<void>;
  remove(): Promise<void>;
}

const root = (): Promise<any> => (navigator.storage as any).getDirectory();
const hasOpfs = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.storage &&
  typeof (navigator.storage as any).getDirectory === 'function' &&
  window.isSecureContext;

// ---------- worker RPC ----------
let worker: Worker | null | undefined; // undefined = untried, null = unavailable
let seq = 1;
const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
const writeErrors = new Map<string, Error>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.id === undefined) {
        if (m.err && m.name) writeErrors.set(m.name, Object.assign(new Error(m.err), { name: m.errName }));
        return;
      }
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (m.err) p.rej(Object.assign(new Error(m.err), { name: m.errName }));
      else p.res(m);
    };
    w.onerror = () => {
      waiting.forEach((p) => p.rej(new Error('OPFS worker crashed')));
      waiting.clear();
      worker = null;
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker ?? null;
}
function call(op: string, payload: Record<string, unknown>): Promise<any> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  return new Promise((res, rej) => {
    const id = seq++;
    waiting.set(id, { res, rej });
    w.postMessage({ id, op, ...payload });
  });
}

let tierP: Promise<'worker' | 'main' | 'none'> | null = null;
function detectTier() {
  if (!tierP) {
    tierP = (async () => {
      if (!hasOpfs()) return 'none' as const;
      try {
        await call('probe', {});
        return 'worker' as const;
      } catch { /* worker or sync handles unavailable */ }
      try {
        const r = await root();
        const fh = await r.getFileHandle('.probe', { create: true });
        if (typeof fh.createWritable === 'function') {
          const w = await fh.createWritable();
          await w.close();
          await r.removeEntry('.probe').catch(() => {});
          return 'main' as const;
        }
      } catch { /* blocked */ }
      return 'none' as const;
    })();
  }
  return tierP;
}

async function hasRoom(size: number): Promise<boolean> {
  try {
    const e = await navigator.storage.estimate();
    if (e.quota != null && e.usage != null) return e.quota - e.usage > size * 1.02 + 16 * 1024 * 1024;
  } catch { /* estimate unsupported: let the real write decide */ }
  return true;
}

// ---------- tier 1: worker ----------
class WorkerPartial implements PartialFile {
  kind: StorageKind = 'opfs-worker';
  constructor(private name: string) {}
  write(pos: number, data: Uint8Array) {
    const w = getWorker();
    if (!w) return;
    const buf = data.buffer as ArrayBuffer; // transferred, not copied
    w.postMessage({ op: 'write', name: this.name, buf, off: data.byteOffset, len: data.byteLength, at: pos }, [buf]);
  }
  private check() {
    const e = writeErrors.get(this.name);
    if (e) {
      writeErrors.delete(this.name);
      throw e;
    }
  }
  async flush() {
    await call('flush', { name: this.name });
    this.check();
  }
  async finish() {
    await call('close', { name: this.name });
    this.check();
    return (await (await root()).getFileHandle(this.name)).getFile() as Promise<File>;
  }
  async close() {
    await call('close', { name: this.name }).catch(() => {});
  }
  async remove() {
    await call('remove', { name: this.name }).catch(() => {});
  }
}

// ---------- tier 2: main thread createWritable ----------
class MainPartial implements PartialFile {
  kind: StorageKind = 'opfs-main';
  private w: any = null;
  private chain: Promise<unknown> = Promise.resolve();
  private err: Error | null = null;
  constructor(private name: string, private fh: any) {}
  async init(reset: boolean, size: number) {
    this.w = await this.fh.createWritable({ keepExistingData: !reset });
    if (reset) await this.w.truncate(size);
  }
  write(pos: number, data: Uint8Array) {
    this.chain = this.chain
      .then(() => this.w.write({ type: 'write', position: pos, data }))
      .catch((e) => {
        this.err = this.err || e;
      });
  }
  // createWritable only commits on close(), so "flush" = close and reopen over the existing bytes.
  async flush() {
    this.chain = this.chain.then(async () => {
      await this.w.close();
      this.w = await this.fh.createWritable({ keepExistingData: true });
    });
    await this.chain;
    if (this.err) throw this.err;
  }
  async finish() {
    await this.chain;
    if (this.err) throw this.err;
    await this.w.close();
    return this.fh.getFile() as Promise<File>;
  }
  async close() {
    await this.chain;
    try { await this.w.close(); } catch { /* ignore */ }
  }
  async remove() {
    await this.chain;
    try { await this.w.abort(); } catch { /* ignore */ }
    await (await root()).removeEntry(this.name).catch(() => {});
  }
}

// ---------- tier 3: memory ----------
class MemoryPartial implements PartialFile {
  kind: StorageKind = 'memory';
  private parts: Uint8Array[] = [];
  constructor(private cs: number) {}
  write(pos: number, data: Uint8Array) {
    this.parts[Math.floor(pos / this.cs)] = data;
  }
  async flush() {}
  async finish() {
    return new Blob(this.parts as BlobPart[]); // only called when every chunk is present
  }
  async close() {}
  async remove() {
    this.parts = [];
  }
}

/** Opens (or resumes) a partial file. `memoryOk` says whether falling back to RAM is acceptable for this size. */
export async function openPartial(key: string, size: number, chunkSize: number, reset: boolean, memoryOk: boolean): Promise<PartialFile> {
  const tier = await detectTier();
  const name = partName(key);
  if (tier !== 'none' && (await hasRoom(size))) {
    try {
      if (tier === 'worker') {
        await call('open', { name, size, reset });
        return new WorkerPartial(name);
      }
      const fh = await (await root()).getFileHandle(name, { create: true });
      const p = new MainPartial(name, fh);
      await p.init(reset, size);
      return p;
    } catch {
      /* quota, locked file or API refusal: fall through to memory */
    }
  }
  if (!memoryOk) throw new Error('Not enough disk space, and the file is too big to hold in memory.');
  return new MemoryPartial(chunkSize);
}

export async function removeByName(name: string) {
  try {
    const tier = await detectTier();
    if (tier === 'worker') await call('remove', { name });
    else if (tier === 'main') await (await root()).removeEntry(name);
  } catch { /* already gone */ }
}

export async function listNames(): Promise<string[]> {
  try {
    const tier = await detectTier();
    if (tier === 'worker') return (await call('list', {})).names as string[];
    if (tier === 'main') {
      const out: string[] = [];
      for await (const [n] of (await root()).entries()) out.push(n);
      return out;
    }
  } catch { /* ignore */ }
  return [];
}
