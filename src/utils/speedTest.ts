import { useSyncExternalStore } from 'react';

const BASE = 'https://speed.cloudflare.com';
const rnd = () => Math.random().toString(36).slice(2);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- IP / location ----------
export interface Meta {
  ip: string;
  isp: string;
  asn: string;
  city: string;
  region: string;
  country: string;
  colo?: string;
  source: 'cloudflare' | 'ipwho.is';
}

async function getJson(url: string, outer?: AbortSignal) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  outer?.addEventListener('abort', () => c.abort(), { once: true });
  try {
    const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchMeta(signal?: AbortSignal): Promise<Meta> {
  try {
    const m = await getJson(BASE + '/meta', signal);
    if (!m.clientIp) throw new Error('empty');
    return { ip: m.clientIp, isp: m.asOrganization || '', asn: m.asn != null ? 'AS' + m.asn : '', city: m.city || '', region: m.region || '', country: m.country || '', colo: m.colo, source: 'cloudflare' };
  } catch (e) {
    if (signal?.aborted) throw e;
    const m = await getJson('https://ipwho.is/', signal);
    if (m.success === false) throw new Error(m.message || 'lookup failed');
    return { ip: m.ip, isp: m.connection?.isp || m.connection?.org || '', asn: m.connection?.asn != null ? 'AS' + m.connection.asn : '', city: m.city || '', region: m.region || '', country: m.country || m.country_code || '', source: 'ipwho.is' };
  }
}

// ---------- stats ----------
export interface Stats {
  median: number;
  min: number;
  max: number;
  jitter: number;
  n: number;
}
function stats(v: number[]): Stats | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  let j = 0;
  for (let i = 1; i < v.length; i++) j += Math.abs(v[i] - v[i - 1]); // mean |Δ| between consecutive samples
  return { median, min: s[0], max: s[s.length - 1], jitter: v.length > 1 ? j / (v.length - 1) : 0, n: v.length };
}
const pctile = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

// ---------- latency ----------
function serverMs(r: Response): number {
  const m = /dur=([\d.]+)/.exec(r.headers.get('server-timing') || '');
  return m ? parseFloat(m[1]) : 0; // edge processing time, when Cloudflare exposes it
}
async function pingOnce(signal: AbortSignal): Promise<number> {
  const t = performance.now();
  const r = await fetch(`${BASE}/__down?bytes=0&r=${rnd()}`, { cache: 'no-store', signal });
  await r.arrayBuffer();
  return Math.max(0.1, performance.now() - t - serverMs(r));
}
/** Pings in the background while a transfer phase saturates the link (bufferbloat). */
function loadedPing(signal: AbortSignal) {
  const out: number[] = [];
  let on = true;
  (async () => {
    while (on && !signal.aborted) {
      try {
        out.push(await pingOnce(signal));
      } catch {
        /* ignore failed probes */
      }
      await sleep(300);
    }
  })();
  return {
    stop: () => {
      on = false;
      return out;
    },
  };
}

// ---------- throughput ----------
interface Live {
  bytes: number;
}
/** Timeline of cumulative bytes for one batch. Sustained rate skips the first 25% (TCP slow-start). */
class Meter {
  total = 0;
  pts: { t: number; b: number }[] = [];
  constructor(private live: Live) {}
  add(n: number) {
    if (n <= 0) return;
    this.total += n;
    this.live.bytes += n;
    this.pts.push({ t: performance.now(), b: this.total });
  }
  rate(t0: number) {
    const p = this.pts;
    if (p.length < 2) return { mbps: 0, ms: performance.now() - t0 };
    const end = p[p.length - 1];
    const dur = end.t - t0;
    const skip = t0 + dur * 0.25;
    let i = p.findIndex((x) => x.t >= skip);
    if (i < 0 || i >= p.length - 1) i = 0;
    const dt = end.t - p[i].t;
    return { mbps: dt > 0 ? ((end.b - p[i].b) * 8) / dt / 1000 : 0, ms: dur };
  }
}

async function downBatch(size: number, par: number, live: Live, signal: AbortSignal) {
  const m = new Meter(live);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: par }, async () => {
      const r = await fetch(`${BASE}/__down?bytes=${size}&r=${rnd()}`, { cache: 'no-store', signal });
      if (!r.body) {
        m.add((await r.arrayBuffer()).byteLength);
        return;
      }
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        m.add(value.byteLength);
      }
    })
  );
  return m.rate(t0);
}

const blobs = new Map<number, Blob>();
function getBlob(size: number): Blob {
  let b = blobs.get(size);
  if (!b) {
    const chunk = new Uint8Array(65536);
    crypto.getRandomValues(chunk);
    b = new Blob(Array.from({ length: Math.ceil(size / 65536) }, () => chunk)).slice(0, size);
    blobs.set(size, b);
  }
  return b;
}
// XHR, because fetch() cannot report upload progress.
function upOne(size: number, body: Blob, m: Meter, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    let last = 0;
    x.open('POST', `${BASE}/__up?r=${rnd()}`);
    x.upload.onprogress = (e) => {
      m.add(e.loaded - last);
      last = e.loaded;
    };
    x.onload = () => {
      if (last < size) m.add(size - last);
      res();
    };
    x.onerror = () => rej(new Error('upload failed'));
    x.onabort = () => rej(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return x.abort();
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}
async function upBatch(size: number, par: number, live: Live, signal: AbortSignal) {
  const body = getBlob(size);
  const m = new Meter(live);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: par }, () => upOne(size, body, m, signal)));
  return m.rate(t0);
}

// ---------- orchestration ----------
export type Phase = 'ping' | 'download' | 'upload';
export type SpeedEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'sample'; phase: Phase; mbps: number }
  | { type: 'ping'; ms: number }
  | { type: 'progress'; pct: number };

export interface SpeedResult {
  at: number;
  ping: Stats;
  down: { mbps: number; loaded: Stats | null };
  up: { mbps: number; loaded: Stats | null };
  bloat: 'A' | 'B' | 'C' | 'D' | null;
}
interface Step {
  size: number;
  par: number;
  reps: number;
}
const DOWN: Step[] = [
  { size: 1e5, par: 6, reps: 2 },
  { size: 1e6, par: 6, reps: 2 },
  { size: 1e7, par: 4, reps: 2 },
  { size: 2.5e7, par: 3, reps: 1 },
];
const UP: Step[] = [
  { size: 2.56e5, par: 6, reps: 2 },
  { size: 1e6, par: 6, reps: 2 },
  { size: 5e6, par: 4, reps: 2 },
  { size: 1e7, par: 4, reps: 1 },
];

async function throughput(phase: 'download' | 'upload', steps: Step[], base: number, emit: (e: SpeedEvent) => void, signal: AbortSignal) {
  emit({ type: 'phase', phase });
  const live: Live = { bytes: 0 };
  let lastB = 0;
  let lastT = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    emit({ type: 'sample', phase, mbps: ((live.bytes - lastB) * 8) / (now - lastT) / 1000 });
    lastB = live.bytes;
    lastT = now;
  }, 200);
  const lp = loadedPing(signal);
  const all: number[] = [];
  const big: number[] = [];
  const total = steps.reduce((n, s) => n + s.reps, 0);
  const t0 = performance.now();
  let done = 0;
  let loaded: Stats | null = null;
  try {
    let slow = false;
    outer: for (const s of steps) {
      for (let r = 0; r < s.reps; r++) {
        if (performance.now() - t0 > 14000) break outer;
        const res = phase === 'download' ? await downBatch(s.size, s.par, live, signal) : await upBatch(s.size, s.par, live, signal);
        emit({ type: 'progress', pct: base + 45 * Math.min(1, ++done / total) });
        if (res.mbps > 0) {
          all.push(res.mbps);
          if (s.size >= 1e6) big.push(res.mbps);
        }
        if (res.ms > 2500) slow = true; // slow link: do not escalate to bigger payloads
      }
      if (slow) break;
    }
  } finally {
    clearInterval(timer);
    loaded = stats(lp.stop());
  }
  emit({ type: 'progress', pct: base + 45 });
  return { mbps: pctile(big.length ? big : all, 0.9), loaded };
}

export async function runSpeedTest(emit: (e: SpeedEvent) => void, signal: AbortSignal): Promise<SpeedResult> {
  emit({ type: 'phase', phase: 'ping' });
  emit({ type: 'progress', pct: 0 });
  try {
    await pingOnce(signal); // warm-up: opens the connection, result discarded
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error('Cloudflare speed endpoints are unreachable (ad blocker or network policy?).');
  }
  const lat: number[] = [];
  for (let i = 0; i < 10; i++) {
    const ms = await pingOnce(signal);
    lat.push(ms);
    emit({ type: 'ping', ms });
    emit({ type: 'progress', pct: i + 1 });
    await sleep(60);
  }
  const ping = stats(lat)!;
  const down = await throughput('download', DOWN, 10, emit, signal);
  const up = await throughput('upload', UP, 55, emit, signal);
  emit({ type: 'progress', pct: 100 });
  const loadedMed = Math.max(down.loaded?.median ?? 0, up.loaded?.median ?? 0);
  const delta = loadedMed ? loadedMed - ping.median : null;
  const bloat = delta == null ? null : delta < 30 ? 'A' : delta < 100 ? 'B' : delta < 250 ? 'C' : 'D';
  return { at: Date.now(), ping, down, up, bloat };
}

export function verdict(r: SpeedResult): { label: string; tone: 'ok' | 'warn' | 'err' } {
  const d = r.down.mbps;
  const u = r.up.mbps;
  if (d >= 100 && u >= 25 && r.ping.median < 60) return { label: 'Great for 4K and large P2P transfers', tone: 'ok' };
  if (d >= 25 && u >= 10) return { label: 'Good for HD video and everyday transfers', tone: 'ok' };
  if (d >= 10 && u >= 3) return { label: 'Fine for browsing and small transfers', tone: 'warn' };
  return { label: 'Slow: expect long waits on big files', tone: 'err' };
}
export const fmtMbps = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
/** Time to push 1 GB at the measured upload speed. */
export function sendTime(upMbps: number): string {
  if (upMbps <= 0) return 'n/a';
  const s = 8000 / upMbps;
  return s < 90 ? '~' + Math.round(s) + ' s' : '~' + Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
}

// ---------- last result (shared with the sidebar mini widget) ----------
const KEY = 'aydrop.speed';
let last: SpeedResult | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
})();
const subs = new Set<() => void>();
export function setLastResult(r: SpeedResult) {
  last = r;
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage blocked */
  }
  subs.forEach((f) => f());
}
export function useLastSpeed(): SpeedResult | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => last,
    () => null
  );
}
