import { useEffect, useState } from 'react';
import { allRecs, clearIncomplete, delRec } from './transferLedger';
import { removeByName } from './opfsStorage';

export function fmtBig(n: number): string {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KiB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(0) + ' MiB';
  return (n / 1024 ** 3).toFixed(1) + ' GiB';
}

// ---------- JS heap (Chromium only) ----------
export interface Heap {
  used: number;
  total: number;
  limit: number;
}
export function readHeap(): Heap | null {
  const m = (performance as any).memory;
  return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}
export function useHeap(on: boolean, ms: number): Heap | null {
  const [h, setH] = useState<Heap | null>(() => readHeap());
  useEffect(() => {
    if (!on) return;
    setH(readHeap());
    const id = setInterval(() => setH(readHeap()), ms);
    return () => clearInterval(id);
  }, [on, ms]);
  return h;
}

// ---------- storage ----------
export interface Store {
  usage: number;
  quota: number;
}
export function useStorage(on: boolean, ms: number) {
  const [store, setStore] = useState<Store | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    let dead = false;
    const read = async () => {
      try {
        const e = await navigator.storage.estimate();
        if (!dead) setStore({ usage: e.usage || 0, quota: e.quota || 0 });
      } catch {
        /* estimate unsupported */
      }
    };
    read();
    const id = setInterval(read, ms);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [on, ms, tick]);
  return { store, refresh: () => setTick((t) => t + 1) };
}

export function opfsStatus(): { ok: boolean; label: string; detail: string } {
  const ok = typeof navigator !== 'undefined' && !!navigator.storage && typeof (navigator.storage as any).getDirectory === 'function' && window.isSecureContext;
  return ok
    ? { ok: true, label: 'OPFS ready', detail: 'Incoming files stream to disk. If the quota runs out they fall back to RAM (up to 512 MiB).' }
    : { ok: false, label: 'RAM only', detail: 'OPFS is unavailable here, so incoming files are held in memory (up to 512 MiB).' };
}

/** Removes partial + finished-unsaved transfer files from OPFS and IndexedDB. Never touches the live room's transfers. */
export async function clearTransferCache(protect: Set<string>): Promise<number> {
  let n = await clearIncomplete(protect);
  for (const r of await allRecs()) {
    if (r.state === 'done' && !protect.has(r.tid)) {
      await removeByName(r.part);
      await delRec(r.tid);
      n++;
    }
  }
  return n;
}

// ---------- viewport ----------
export function useDesktop(): boolean {
  const q = '(min-width: 768px)';
  const [d, setD] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setD(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return d;
}

// ---------- GPU ----------
export function gpuInfo(): { renderer: string; vendor: string } | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return out;
  } catch {
    return null;
  }
}

// ---------- main-thread event-loop lag ----------
export function useLoopLag(on: boolean) {
  const [v, setV] = useState({ avg: 0, max: 0 });
  useEffect(() => {
    if (!on) return;
    let samples: number[] = [];
    let expected = performance.now() + 100;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      const now = performance.now();
      samples.push(Math.max(0, now - expected)); // how late the timer fired = how busy the main thread was
      expected = now + 100;
      t = setTimeout(loop, 100);
    };
    t = setTimeout(loop, 100);
    const report = setInterval(() => {
      if (samples.length) setV({ avg: samples.reduce((a, b) => a + b, 0) / samples.length, max: Math.max(...samples) });
      samples = [];
    }, 1000);
    return () => {
      clearTimeout(t);
      clearInterval(report);
    };
  }, [on]);
  return v;
}

// ---------- UI frame rate ----------
export function useFps(on: boolean) {
  const [v, setV] = useState({ fps: 0, frame: 0, worst: 0 });
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    let frames = 0;
    let start = performance.now();
    let prev = start;
    let worst = 0;
    const loop = (t: number) => {
      frames++;
      worst = Math.max(worst, t - prev);
      prev = t;
      if (t - start >= 1000) {
        setV({ fps: (frames * 1000) / (t - start), frame: (t - start) / frames, worst });
        frames = 0;
        worst = 0;
        start = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return v;
}

// ---------- Compute Pressure ----------
export function usePressure(on: boolean) {
  const [s, setS] = useState<{ supported: boolean; state: string }>(() => ({ supported: 'PressureObserver' in window, state: '-' }));
  useEffect(() => {
    const PO = (window as any).PressureObserver;
    if (!on || !PO) return;
    let obs: any;
    try {
      obs = new PO((recs: any[]) => {
        const r = recs[recs.length - 1];
        if (r) setS({ supported: true, state: r.state });
      });
      Promise.resolve(obs.observe('cpu', { sampleInterval: 1000 })).catch(() => setS({ supported: false, state: 'blocked' }));
    } catch {
      setS({ supported: false, state: '-' });
    }
    return () => {
      try {
        obs?.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [on]);
  return s;
}
