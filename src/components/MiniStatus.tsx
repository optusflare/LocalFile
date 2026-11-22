import { fmtBig, opfsStatus, useDesktop, useHeap } from '../utils/sysStats';
import { fmtMbps, useLastSpeed } from '../utils/speedTest';

/** Desktop-only sidebar widget. Click it to jump to Tools. Polls only when it is actually visible. */
export default function MiniStatus({ onOpen }: { onOpen: () => void }) {
  const desktop = useDesktop();
  const heap = useHeap(desktop, 2000);
  const last = useLastSpeed();
  const o = opfsStatus();
  const pct = heap ? (heap.used / heap.limit) * 100 : 0;

  return (
    <button className="mini" onClick={onOpen} aria-label="Open Tools: memory, storage and network status">
      <div className="mini-row">
        <span>RAM</span>
        <b>{heap ? fmtBig(heap.used) : 'n/a'}</b>
      </div>
      {heap && (
        <div className={'meter ' + (pct > 75 ? 'warn' : '')}>
          <i style={{ width: Math.max(1, Math.min(100, pct)) + '%' }} />
        </div>
      )}
      <div className="mini-row">
        <span>Disk</span>
        <b>
          <span className={'dot ' + (o.ok ? 'ok' : 'warn')} />
          {o.label}
        </b>
      </div>
      <div className="mini-row">
        <span>Net</span>
        <b>{last ? Math.round(last.ping.median) + ' ms · ↓' + fmtMbps(last.down.mbps) + ' ↑' + fmtMbps(last.up.mbps) : 'Run a test'}</b>
      </div>
    </button>
  );
}
