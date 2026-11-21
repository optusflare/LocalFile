import { CHUNK_SIZE } from "./limits.ts";

/**
 * Frame layout (big-endian):
 * magic u16 | version u8 | type u8 | transferId u32 | seq u32 | length u32 | payload
 * Meta = start of transfer (JSON: name, size, mime, totalChunks), End = end of transfer,
 * Chunk carries up to 64 KiB, Ack carries the highest contiguous seq in `seq`.
 */
export const MAGIC = 0x4d46;
export const VERSION = 1;
export const HEADER_BYTES = 16;
export const MAX_META_BYTES = 4096;

export const FrameType = { Meta: 1, Chunk: 2, Ack: 3, End: 4, Pause: 5, Resume: 6 } as const;

export interface Frame {
  type: number;
  transferId: number;
  seq: number;
  payload: Uint8Array;
}

const maxPayload = (type: number): number => (type === FrameType.Chunk ? CHUNK_SIZE : MAX_META_BYTES);

export function encodeFrame(f: Frame): Uint8Array {
  if (f.payload.byteLength > maxPayload(f.type)) throw new RangeError("payload too large");
  const out = new Uint8Array(HEADER_BYTES + f.payload.byteLength);
  const v = new DataView(out.buffer);
  v.setUint16(0, MAGIC);
  v.setUint8(2, VERSION);
  v.setUint8(3, f.type);
  v.setUint32(4, f.transferId >>> 0);
  v.setUint32(8, f.seq >>> 0);
  v.setUint32(12, f.payload.byteLength);
  out.set(f.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: ArrayBuffer | Uint8Array): Frame {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < HEADER_BYTES) throw new Error("frame too short");
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (v.getUint16(0) !== MAGIC) throw new Error("bad magic");
  if (v.getUint8(2) !== VERSION) throw new Error("unsupported version");
  const type = v.getUint8(3);
  if (type < 1 || type > 6) throw new Error("unknown frame type");
  const length = v.getUint32(12);
  if (length > maxPayload(type) || length !== u8.byteLength - HEADER_BYTES) throw new Error("bad length");
  return { type, transferId: v.getUint32(4), seq: v.getUint32(8), payload: u8.slice(HEADER_BYTES) };
}

export const totalChunks = (size: number): number => Math.ceil(size / CHUNK_SIZE);

/** Receiver-side validator. The resume point is the last in-order acknowledged chunk. */
export class SequenceTracker {
  private next = 0;
  readonly transferId: number;
  readonly expectedChunks: number;

  constructor(transferId: number, expectedChunks: number) {
    this.transferId = transferId;
    this.expectedChunks = expectedChunks;
  }

  accept(f: Frame): void {
    if (f.transferId !== this.transferId) throw new Error("wrong transfer id");
    if (f.seq >= this.expectedChunks) throw new Error("chunk beyond declared size");
    if (f.seq !== this.next) throw new Error(`out-of-order chunk: expected ${this.next}, got ${f.seq}`);
    this.next++;
  }

  /** Highest contiguous seq received, or -1 if none. */
  get lastAcked(): number {
    return this.next - 1;
  }

  get complete(): boolean {
    return this.next === this.expectedChunks;
  }

  resumeAt(seq: number): number {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.next) throw new Error("cannot resume there");
    this.next = seq;
    return seq;
  }
}
