import { extOf, isBlocked, saveBlob } from '../lib/util';
import { hashBlob } from './streamHash';
import { openPartial, partName } from './opfsStorage';
import type { PartialFile, StorageKind } from './opfsStorage';
import { advance, clearIncomplete, countBits, delRec, getRec, newBitmap, putRec, setBit, sweepDone } from './transferLedger';

/*
 * Wire protocol (all JSON control messages, plus binary chunk frames):
 *   S→R offer  {tid,sid,name,size,mime,sha256,cs,total}   R→S ready {tid,next}   (next = first missing chunk)
 *   S→R chunk frame: [sid u32][index u32][payload]         R→S ack   {tid,next}   (every 2 MiB, after fsync)
 *   S→R end    {tid}                                       R→S done  {tid,ok}
 *   either: pause {tid} / resume {tid} / cancel {tid}      R→S reject {tid,reason}
 * Re-sending an offer for the same tid is the resume handshake: the receiver answers with its durable position.
 * tid = sha256 prefix + size, so re-selecting the same file after a reload resumes the same partial.
 */
export const CHUNK = 16 * 1024;
const HDR = 8;
const ACK_EVERY = 128;
const WINDOW = 512;
const PERSIST_EVERY = 4;
const MAX_FILE = 8 * 1024 * 1024 * 1024;
const MEMORY_LIMIT = 512 * 1024 * 1024;
const SAVED_CLEANUP_MS = 5 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type TState = 'queued' | 'preparing' | 'active' | 'paused' | 'interrupted' | 'verifying' | 'verified' | 'sent' | 'mismatch' | 'rejected' | 'failed';
export interface TItem {
  id: string;
  dir: 'in' | 'out';
  name: string;
  size: number;
  done: number;
  state: TState;
  storage?: StorageKind;
  file?: Blob;
  note?: string;
  resumed?: boolean;
}
export interface EngineHooks {
  getChannel: () => RTCDataChannel | null;
  room: () => string;
  blocked: () => string[];
  onItems: (items: TItem[]) => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  log: (size: number, ext: string, integrity: 'verified' | 'mismatch' | 'unchecked') => void;
}

interface Out {
  id: string;
  file: File;
  tid: string;
  hash: string;
  total: number;
  sid: number;
  gen: number;
  acked: number;
  started: boolean;
  userPaused: boolean;
  cancelled: boolean;
  finished: boolean;
  resolve: () => void;
  done: Promise<void>;
}
interface In {
  tid: string;
  meta: { name: string; size: number; mime: string; sha256: string; cs: number; total: number };
  sid: number;
  store: PartialFile;
  bitmap: Uint8Array;
  next: number;
  count: number;
  since: number;
  acks: number;
  paused: boolean;
  interrupted: boolean;
  resumed: boolean;
  retried: boolean;
  busy: boolean;
  phase: 'open' | 'done' | 'dead';
}

export class TransferEngine {
  private items = new Map<string, TItem>();
  private order: string[] = [];
  private outs = new Map<string, Out>();
  private ins = new Map<string, In>();
  private seq = 0;
  private sidSeq = Math.floor(Math.random() * 2 ** 30);
  private dead = false;
  private running = false;
  private dirty = false;
  private linkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private h: EngineHooks) {
    void sweepDone(Date.now() - 10 * 60 * 1000);
  }

  // ---------- state plumbing ----------
  private emit(now = false) {
    if (now) return this.flush();
    if (this.dirty) return;
    this.dirty = true;
    setTimeout(() => this.flush(), 120);
  }
  private flush() {
    this.dirty = false;
    if (!this.dead) this.h.onItems(this.order.map((id) => ({ ...this.items.get(id)! })));
  }
  private upd(id: string, patch: Partial<TItem>, now = false) {
    const it = this.items.get(id);
    if (!it) return;
    Object.assign(it, patch);
    this.emit(now);
  }
  private sendJson(o: unknown): boolean {
    const ch = this.h.getChannel();
    if (!ch || ch.readyState !== 'open') return false;
    try {
      ch.send(JSON.stringify(o));
      return true;
    } catch {
      return false;
    }
  }
  private findOut(tid: string) {
    for (const o of this.outs.values()) if (o.tid === tid) return o;
    return undefined;
  }
  activeTids(): Set<string> {
    return new Set([...this.ins.values()].filter((s) => s.phase === 'open').map((s) => s.tid));
  }
  clearIncomplete() {
    return clearIncomplete(this.activeTids());
  }

  // ---------- link lifecycle (called by Room) ----------
  onLinkUp() {
    if (this.dead || this.linkTimer) return;
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      for (const o of this.outs.values()) {
        if (o.started && o.tid && !o.finished && !o.cancelled && !o.userPaused) this.handshake(o);
      }
    }, 250);
  }
  onLinkDown() {
    if (this.dead) return;
    for (const o of this.outs.values()) {
      if (!o.finished && this.items.get(o.id)?.state === 'active') this.upd(o.id, { state: 'interrupted' }, true);
    }
    for (const s of this.ins.values()) {
      if (s.phase === 'open' && !s.paused) {
        s.interrupted = true;
        this.upd(s.tid, { state: 'interrupted' }, true);
        void this.checkpoint(s, true);
      }
    }
  }
  dispose() {
    if (this.dead) return;
    this.dead = true;
    if (this.linkTimer) clearTimeout(this.linkTimer);
    for (const o of this.outs.values()) {
      o.cancelled = true;
      o.gen++;
      o.resolve();
    }
    for (const s of this.ins.values()) void this.shutdownIn(s);
  }
  private async shutdownIn(s: In) {
    try {
      if (s.phase === 'open' && s.store.kind !== 'memory') {
        const snap = s.bitmap.slice(); // partial file stays on disk so a later room can resume it
        await s.store.flush();
        await this.persist(s, 'partial', snap);
        await s.store.close();
      } else {
        await s.store.remove();
        await delRec(s.tid);
      }
    } catch { /* best effort */ }
  }

  // ---------- user actions ----------
  enqueue(files: File[]) {
    for (const file of files) {
      const id = 'o' + ++this.seq;
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      this.outs.set(id, { id, file, tid: '', hash: '', total: 0, sid: 0, gen: 0, acked: 0, started: false, userPaused: false, cancelled: false, finished: false, resolve, done });
      this.items.set(id, { id, dir: 'out', name: file.name, size: file.size, done: 0, state: 'queued' });
      this.order.push(id);
    }
    this.emit(true);
    void this.kick();
  }
  pause(id: string) {
    const o = this.outs.get(id);
    const s = this.ins.get(id);
    if (o && !o.finished) {
      o.userPaused = true;
      o.gen++;
      this.sendJson({ t: 'pause', tid: o.tid });
      this.upd(id, { state: 'paused' }, true);
    } else if (s && s.phase === 'open') {
      s.paused = true;
      this.sendJson({ t: 'pause', tid: s.tid });
      this.upd(id, { state: 'paused' }, true);
      void this.checkpoint(s, true);
    }
  }
  resume(id: string) {
    const o = this.outs.get(id);
    const s = this.ins.get(id);
    if (o && !o.finished) {
      o.userPaused = false;
      this.upd(id, { state: 'active' }, true);
      this.handshake(o);
    } else if (s && s.phase === 'open') {
      s.paused = false;
      this.upd(id, { state: 'active' }, true);
      if (!this.sendJson({ t: 'resume', tid: s.tid })) this.h.notify('Not connected. It will continue when the link is back.', 'err');
    }
  }
  async remove(id: string) {
    const it = this.items.get(id);
    if (!it) return;
    const o = this.outs.get(id);
    if (o) {
      if (!o.finished) {
        o.cancelled = true;
        this.sendJson({ t: 'cancel', tid: o.tid });
        this.finish(o, 'rejected', 'Cancelled');
      }
      this.outs.delete(id);
    }
    const s = this.ins.get(id);
    if (s) {
      if (s.phase === 'open') this.sendJson({ t: 'cancel', tid: id });
      s.phase = 'dead';
      await s.store.remove().catch(() => {});
      await delRec(id);
      this.ins.delete(id);
    }
    this.items.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit(true);
  }
  /** Triggers the browser download straight from the OPFS-backed File, then frees the temp file a few minutes later. */
  save(id: string) {
    const it = this.items.get(id);
    if (!it?.file) return;
    saveBlob(it.file, it.name || 'download');
    setTimeout(() => void this.afterSave(id), SAVED_CLEANUP_MS);
  }
  private async afterSave(id: string) {
    const s = this.ins.get(id);
    if (!s || this.dead) return;
    s.phase = 'dead';
    await s.store.remove().catch(() => {});
    await delRec(id);
    this.ins.delete(id);
    this.upd(id, { file: undefined, note: 'Saved to your device' }, true);
  }

  // ---------- sender ----------
  private async kick() {
    if (this.running || this.dead) return;
    this.running = true;
    try {
      for (;;) {
        const o = [...this.outs.values()].find((x) => !x.started && !x.finished);
        if (!o || this.dead) break;
        o.started = true;
        await this.runOut(o);
      }
    } finally {
      this.running = false;
    }
  }
  private finish(o: Out, r: 'sent' | 'rejected' | 'failed', note?: string) {
    if (o.finished) return;
    o.finished = true;
    o.gen++;
    this.upd(o.id, { state: r, note, ...(r === 'sent' ? { done: o.file.size } : {}) }, true);
    o.resolve();
  }
  private async runOut(o: Out) {
    if (isBlocked(o.file.name, this.h.blocked())) return this.finish(o, 'rejected', 'Blocked file type');
    if (o.file.size > MAX_FILE) return this.finish(o, 'rejected', 'Over 8 GiB');
    this.upd(o.id, { state: 'preparing', done: 0 }, true);
    try {
      o.hash = await hashBlob(o.file, (d) => this.upd(o.id, { done: d }));
    } catch {
      return this.finish(o, 'failed', 'Could not read the file');
    }
    if (o.cancelled || this.dead) return;
    o.total = Math.max(1, Math.ceil(o.file.size / CHUNK));
    o.tid = o.hash.slice(0, 20) + '-' + o.file.size.toString(36);
    this.upd(o.id, { state: 'active', done: 0 }, true);
    this.handshake(o);
    await o.done;
  }
  private handshake(o: Out) {
    o.sid = ++this.sidSeq;
    o.gen++;
    const ok = this.sendJson({ t: 'offer', tid: o.tid, sid: o.sid, name: o.file.name.slice(0, 200), size: o.file.size, mime: o.file.type, sha256: o.hash, cs: CHUNK, total: o.total });
    if (!ok) this.upd(o.id, { state: 'interrupted' }, true);
  }
  private onReady(m: any) {
    const o = this.findOut(m.tid);
    if (!o || o.finished || o.cancelled) return;
    o.gen++;
    o.acked = m.next | 0;
    const done = Math.min(o.acked * CHUNK, o.file.size);
    if (o.userPaused) return this.upd(o.id, { state: 'paused', done }, true);
    this.upd(o.id, { state: 'active', done, resumed: o.acked > 0 }, true);
    void this.pump(o, o.acked, o.gen);
  }
  private async pump(o: Out, from: number, gen: number) {
    const BLOCK = 64 * CHUNK;
    let block: Uint8Array | null = null;
    let blockStart = 0;
    try {
      for (let i = from; i < o.total; i++) {
        for (;;) {
          if (o.gen !== gen || o.cancelled || o.userPaused || this.dead) return;
          const ch = this.h.getChannel();
          if (!ch || ch.readyState !== 'open') {
            this.upd(o.id, { state: 'interrupted' }, true);
            return;
          }
          if (ch.bufferedAmount < 1 << 20 && i - o.acked < WINDOW) break;
          await sleep(15);
        }
        const start = i * CHUNK;
        const len = Math.min(CHUNK, o.file.size - start);
        if (!block || start >= blockStart + block.length) {
          blockStart = start;
          block = new Uint8Array(await o.file.slice(start, Math.min(o.file.size, start + BLOCK)).arrayBuffer());
        }
        const frame = new Uint8Array(HDR + len);
        const dv = new DataView(frame.buffer);
        dv.setUint32(0, o.sid);
        dv.setUint32(4, i);
        frame.set(block.subarray(start - blockStart, start - blockStart + len), HDR);
        this.h.getChannel()!.send(frame);
        if ((i & 31) === 0) this.upd(o.id, { done: Math.min((i + 1) * CHUNK, o.file.size) });
      }
      if (o.gen === gen) this.sendJson({ t: 'end', tid: o.tid });
    } catch {
      if (o.gen === gen) this.upd(o.id, { state: 'interrupted' }, true); // channel dropped mid-send; relink resumes
    }
  }
  private onDone(m: any) {
    const o = this.findOut(m.tid);
    if (!o) return;
    if (m.ok) {
      this.h.log(o.file.size, extOf(o.file.name), 'verified');
      this.finish(o, 'sent');
    } else {
      this.h.log(o.file.size, extOf(o.file.name), 'mismatch');
      this.finish(o, 'failed', 'Checksum mismatch on the other side');
    }
  }
  private onReject(m: any) {
    const o = this.findOut(m.tid);
    if (o) this.finish(o, 'rejected', m.reason || 'Rejected by the other side');
  }

  // ---------- receiver ----------
  private async persist(s: In, state: 'partial' | 'done', bm?: Uint8Array) {
    if (s.store.kind === 'memory') return;
    await putRec({ tid: s.tid, room: this.h.room(), name: s.meta.name, size: s.meta.size, mime: s.meta.mime, sha256: s.meta.sha256, cs: s.meta.cs, total: s.meta.total, bitmap: (bm || s.bitmap).slice(), state, part: partName(s.tid), updated: Date.now() });
  }
  private async onOffer(m: any) {
    const reject = (reason: string) => {
      this.sendJson({ t: 'reject', tid: m.tid, reason });
      this.h.notify(reason + ': ' + m.name, 'err');
    };
    const cur = this.ins.get(m.tid);
    if (cur && cur.phase === 'open') {
      // Same transfer, new handshake (pause/resume or reconnect): reply with our durable position.
      cur.sid = m.sid;
      cur.paused = false;
      cur.interrupted = false;
      this.upd(cur.tid, { state: 'active' }, true);
      this.sendJson({ t: 'ready', tid: cur.tid, next: cur.next });
      return;
    }
    const size = Number(m.size);
    if (isBlocked(String(m.name), this.h.blocked())) return reject('Blocked file type');
    if (!(size >= 0) || size > MAX_FILE || m.cs !== CHUNK || m.total !== Math.max(1, Math.ceil(size / CHUNK)) || typeof m.tid !== 'string') return reject('Invalid offer');

    const rec = await getRec(m.tid);
    const canResume = !!rec && rec.state === 'partial' && rec.sha256 === m.sha256 && rec.size === size && rec.cs === m.cs;
    let store: PartialFile;
    try {
      store = await openPartial(m.tid, size, m.cs, !canResume, size <= MEMORY_LIMIT);
    } catch (e: any) {
      return reject(e?.message || 'No space for this file');
    }
    if (this.dead) return void store.close();
    const resumed = canResume && store.kind !== 'memory';
    const bitmap = resumed ? rec!.bitmap.slice() : newBitmap(m.total);
    const next = advance(bitmap, 0, m.total);
    const s: In = { tid: m.tid, meta: { name: String(m.name), size, mime: String(m.mime || ''), sha256: m.sha256, cs: m.cs, total: m.total }, sid: m.sid, store, bitmap, next, count: resumed ? countBits(bitmap, m.total) : 0, since: 0, acks: 0, paused: false, interrupted: false, resumed, retried: false, busy: false, phase: 'open' };
    this.ins.set(m.tid, s);
    if (!this.items.has(m.tid)) this.order.push(m.tid);
    this.items.set(m.tid, { id: m.tid, dir: 'in', name: s.meta.name, size, done: Math.min(s.count * m.cs, size), state: 'active', storage: store.kind, resumed: next > 0 });
    this.emit(true);
    await this.persist(s, 'partial');
    this.sendJson({ t: 'ready', tid: m.tid, next });
  }
  private onChunk(buf: ArrayBuffer) {
    if (buf.byteLength < HDR) return;
    const dv = new DataView(buf);
    const sid = dv.getUint32(0);
    const idx = dv.getUint32(4);
    let s: In | undefined;
    for (const x of this.ins.values()) if (x.sid === sid) s = x;
    if (!s || s.phase !== 'open' || s.paused || idx >= s.meta.total) return;
    const pos = idx * s.meta.cs;
    const payload = new Uint8Array(buf, HDR);
    if (payload.length !== Math.min(s.meta.cs, s.meta.size - pos)) return;
    s.store.write(pos, payload); // positional, so replays after a resume are harmless
    if (setBit(s.bitmap, idx)) s.count++;
    if (idx === s.next) s.next = advance(s.bitmap, s.next, s.meta.total);
    if (s.interrupted) {
      s.interrupted = false;
      this.upd(s.tid, { state: 'active' }, true);
    }
    if (++s.since >= ACK_EVERY) {
      s.since = 0;
      void this.checkpoint(s, false);
    }
    if ((idx & 31) === 0) this.upd(s.tid, { done: Math.min(s.count * s.meta.cs, s.meta.size) });
  }
  /** fsync, persist the bitmap snapshot, and tell the sender how far we are durable. */
  private async checkpoint(s: In, force: boolean) {
    if (s.busy && !force) return;
    s.busy = true;
    try {
      const snap = s.bitmap.slice();
      const nxt = s.next;
      await s.store.flush();
      s.acks++;
      if (force || s.acks % PERSIST_EVERY === 0) await this.persist(s, 'partial', snap);
      this.sendJson({ t: 'ack', tid: s.tid, next: nxt });
    } catch (e: any) {
      this.failIn(s, 'Disk write failed: ' + (e?.name || e?.message || 'unknown'));
    } finally {
      s.busy = false;
    }
  }
  private failIn(s: In, reason: string) {
    if (s.phase !== 'open') return;
    s.phase = 'dead';
    this.sendJson({ t: 'reject', tid: s.tid, reason });
    this.upd(s.tid, { state: 'failed', note: reason }, true);
    this.h.notify(reason, 'err');
    void s.store.remove().catch(() => {});
    void delRec(s.tid);
  }
  private async onEnd(m: any) {
    const s = this.ins.get(m.tid);
    if (!s || s.phase !== 'open') return;
    if (s.next < s.meta.total) return void this.sendJson({ t: 'ready', tid: s.tid, next: s.next }); // gap: ask for a resend
    this.upd(s.tid, { state: 'verifying', done: 0 }, true);
    try {
      const file = await s.store.finish();
      const hash = await hashBlob(file, (d) => this.upd(s.tid, { done: d }));
      if (hash === s.meta.sha256 && file.size === s.meta.size) {
        s.phase = 'done';
        await this.persist(s, 'done');
        this.upd(s.tid, { state: 'verified', done: s.meta.size, file }, true);
        this.sendJson({ t: 'done', tid: s.tid, ok: true });
        this.h.log(s.meta.size, extOf(s.meta.name), 'verified');
      } else if (s.resumed && !s.retried) {
        // A resumed partial that fails the hash was probably evicted or corrupted: restart once from zero.
        s.retried = true;
        await s.store.remove();
        s.store = await openPartial(s.tid, s.meta.size, s.meta.cs, true, s.meta.size <= MEMORY_LIMIT);
        s.bitmap = newBitmap(s.meta.total);
        s.next = 0;
        s.count = 0;
        this.upd(s.tid, { state: 'active', done: 0, storage: s.store.kind }, true);
        this.sendJson({ t: 'ready', tid: s.tid, next: 0 });
      } else {
        s.phase = 'dead';
        await s.store.remove();
        await delRec(s.tid);
        this.upd(s.tid, { state: 'mismatch' }, true);
        this.sendJson({ t: 'done', tid: s.tid, ok: false });
        this.h.log(s.meta.size, extOf(s.meta.name), 'mismatch');
        this.h.notify('Checksum mismatch on ' + s.meta.name + '. File discarded.', 'err');
      }
    } catch (e: any) {
      this.failIn(s, 'Could not finish the file: ' + (e?.message || 'storage error'));
    }
  }

  // ---------- peer control ----------
  private onPeerPause(m: any) {
    const o = this.findOut(m.tid);
    if (o && !o.finished) {
      o.userPaused = true;
      o.gen++;
      return this.upd(o.id, { state: 'paused' }, true);
    }
    const s = this.ins.get(m.tid);
    if (s && s.phase === 'open') {
      s.paused = true;
      this.upd(s.tid, { state: 'paused' }, true);
      void this.checkpoint(s, true);
    }
  }
  private onPeerResume(m: any) {
    const o = this.findOut(m.tid);
    if (o && !o.finished) {
      o.userPaused = false;
      this.handshake(o);
    }
  }
  private onCancel(m: any) {
    const o = this.findOut(m.tid);
    if (o) return this.finish(o, 'rejected', 'Cancelled by the receiver');
    const s = this.ins.get(m.tid);
    if (s && s.phase === 'open') {
      s.phase = 'dead';
      void s.store.remove().catch(() => {});
      void delRec(s.tid);
      this.upd(s.tid, { state: 'rejected', note: 'Cancelled by the sender' }, true);
    }
  }

  handle(d: unknown) {
    if (this.dead) return;
    if (typeof d === 'string') {
      let m: any;
      try {
        m = JSON.parse(d);
      } catch {
        return;
      }
      switch (m.t) {
        case 'offer': return void this.onOffer(m);
        case 'ready': return this.onReady(m);
        case 'ack': {
          const o = this.findOut(m.tid);
          if (o) o.acked = Math.max(o.acked, m.next | 0);
          return;
        }
        case 'end': return void this.onEnd(m);
        case 'done': return this.onDone(m);
        case 'reject': return this.onReject(m);
        case 'pause': return this.onPeerPause(m);
        case 'resume': return this.onPeerResume(m);
        case 'cancel': return this.onCancel(m);
      }
    } else if (d instanceof ArrayBuffer) {
      this.onChunk(d);
    }
  }
}
