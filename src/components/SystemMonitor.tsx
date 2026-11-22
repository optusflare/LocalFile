import { useMemo, useState } from 'react';
import { useApp } from '../lib/ctx';
import { getProtectedTids } from '../utils/activity';
import { clearTransferCache, fmtBig, gpuInfo, opfsStatus, useFps, useHeap, useLoopLag, usePressure, useStorage } from '../utils/sysStats';

function Meter({ pct, tone }: { pct: number; tone?: 'warn' | 'err' | '' }) {
  return (
    <div className={'meter ' + (tone || '')} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: Math.max(1, Math.min(100, pct)) + '%' }} />
    </div>
  );
}
const toneFor = (pct: number) => (pct > 90 ? 'err' : pct > 75 ? 'warn' : '');

/** Mounted only while the Tools > System tab is visible, so every poller below stops the moment you leave. */
export default function SystemMonitor() {
  const { notify } = useApp();
  const heap = useHeap(true, 1000);
  const { store, refresh } = useStorage(true, 1000);
  const lag = useLoopLag(true);
  const fps = useFps(true);
  const pressure = usePressure(true);
  const gpu = useMemo(() => gpuInfo(), []);
  const opfs = opfsStatus();
  const [clearing, setClearing] = useState(false);

  const heapPct = heap ? (heap.used / heap.limit) * 100 : 0;
  const storePct = store && store.quota ? (store.usage / store.quota) * 100 : 0;
  const mem = (navigator as any).deviceMemory as number | undefined;
  const pTone = pressure.state === 'critical' ? 'err' : pressure.state === 'serious' ? 'warn' : pressure.state === 'nominal' || pressure.state === 'fair' ? 'ok' : '';

  async function clear() {
    setClearing(true);
    try {
      const n = await clearTransferCache(getProtectedTids());
      window.dispatchEvent(new Event('aydrop:cache-cleared'));
      refresh();
      notify(n ? 'Cleared ' + n + ' item' + (n === 1 ? '' : 's') + ' from the transfer cache.' : 'Nothing to clear.');
    } catch (e: any) {
      notify('Could not clear the cache: ' + (e?.message || 'unknown error'), 'err');
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="tgrid">
      <section className="stat">
        <h3>AyDrop tab memory</h3>
        {heap ? (
          <>
            <div className="big">
              {fmtBig(heap.used)}
              <small>of {fmtBig(heap.limit)}</small>
            </div>
            <Meter pct={heapPct} tone={toneFor(heapPct)} />
            <p className="muted small">JS heap for this tab only. Chromium rounds the value on purpose.</p>
          </>
        ) : (
          <>
            <span className="badge">Not available</span>
            <p className="muted small">Firefox and Safari do not expose JS heap size to pages, for privacy. Chromium browsers (Chrome, Edge, Brave) do.</p>
          </>
        )}
      </section>

      <section className="stat">
        <h3>Browser storage (OPFS)</h3>
        {store ? (
          <>
            <div className="big">
              {fmtBig(store.usage)}
              <small>of {store.quota ? fmtBig(store.quota) : 'unknown'}</small>
            </div>
            <Meter pct={storePct} tone={toneFor(storePct)} />
          </>
        ) : (
          <span className="badge">Not available</span>
        )}
        <div className="row">
          <span className={'badge ' + (opfs.ok ? 'ok' : 'warn')}>{opfs.label}</span>
        </div>
        <p className="muted small">{opfs.detail}</p>
        <button className="btn" disabled={clearing} onClick={clear}>
          Clear OPFS &amp; incomplete transfer cache
        </button>
        <p className="muted small">Removes partial and unsaved transfer files. Anything in the current room is left alone.</p>
      </section>

      <section className="stat">
        <h3>CPU &amp; main thread</h3>
        <dl className="kvs">
          <dt>Logical cores</dt>
          <dd>{navigator.hardwareConcurrency || 'n/a'}</dd>
          <dt>Compute pressure</dt>
          <dd>{pressure.supported ? <span className={'badge ' + pTone}>{pressure.state}</span> : <span className="muted">Not supported in this browser</span>}</dd>
          <dt>Event-loop lag</dt>
          <dd className="mono">
            {lag.avg.toFixed(1)} ms avg · {lag.max.toFixed(0)} ms peak
          </dd>
        </dl>
        <Meter pct={(lag.avg / 50) * 100} tone={lag.avg > 30 ? 'err' : lag.avg > 12 ? 'warn' : ''} />
        <p className="muted small">How late a 100 ms timer fires. Near 0 means the main thread is idle; sustained high values mean the page is busy.</p>
      </section>

      <section className="stat">
        <h3>GPU &amp; rendering</h3>
        <div className="big">
          {fps.fps ? fps.fps.toFixed(0) : '-'}
          <small>FPS</small>
        </div>
        <Meter pct={(fps.fps / 60) * 100} tone={fps.fps && fps.fps < 30 ? 'warn' : ''} />
        <dl className="kvs">
          <dt>Frame time</dt>
          <dd className="mono">
            {fps.frame ? fps.frame.toFixed(1) : '-'} ms (worst {fps.worst ? fps.worst.toFixed(0) : '-'} ms)
          </dd>
          <dt>Renderer</dt>
          <dd>{gpu ? gpu.renderer : 'Hidden by the browser'}</dd>
        </dl>
      </section>

      <section className="stat wide">
        <h3>Device memory &amp; swap</h3>
        <dl className="kvs">
          <dt>Approx. system RAM</dt>
          <dd>{mem ? '≈ ' + mem + ' GB' + (mem >= 8 ? ' or more' : '') : 'Not exposed by this browser'}</dd>
        </dl>
        <p className="muted small">
          Browsers report device memory in coarse tiers (capped at 8 GB). OS swap, VRAM and other apps' memory are sandboxed from web pages for security, so AyDrop can only see its own tab.
        </p>
      </section>
    </div>
  );
}
