import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import SystemMonitor from '../components/SystemMonitor';
import { useTransferActive } from '../utils/activity';
import { fetchMeta, fmtMbps, runSpeedTest, sendTime, setLastResult, useLastSpeed, verdict } from '../utils/speedTest';
import type { Meta, Phase } from '../utils/speedTest';

const PHASE_TEXT: Record<Phase, string> = { ping: 'Measuring latency', download: 'Testing download', upload: 'Testing upload' };

function Gauge({ mbps, label }: { mbps: number; label: string }) {
  const frac = Math.min(1, Math.log10(1 + mbps) / 3); // log scale: 0 to 1000 Mbps
  const L = Math.PI * 80;
  return (
    <svg viewBox="0 0 200 112" className="gauge" role="img" aria-label={fmtMbps(mbps) + ' ' + label}>
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="rgba(255,255,255,.09)" strokeWidth="10" strokeLinecap="round" />
      <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#F2F2F3" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${frac * L} ${L}`} style={{ transition: 'stroke-dasharray .25s' }} />
      <text x="100" y="86" textAnchor="middle" className="g-num">
        {fmtMbps(mbps)}
      </text>
      <text x="100" y="105" textAnchor="middle" className="g-unit">
        {label}
      </text>
    </svg>
  );
}
function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / Math.max(data.length - 1, 1)) * 300},${58 - (v / max) * 54}`).join(' ');
  return (
    <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="spark" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#F2F2F3" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface Props {
  active: boolean;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  onOpenTransfer?: () => void;
}

export default function Tools({ active, isAdmin, onOpenAdmin, onOpenTransfer }: Props) {
  const [sub, setSub] = useState<'net' | 'sys'>('net');

  // IP / location
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState('');
  const [hide, setHide] = useState(() => localStorage.getItem('aydrop.hideip') === '1');
  const fetched = useRef(false);
  const loadMeta = useCallback(async () => {
    setMetaBusy(true);
    setMetaErr('');
    try {
      setMeta(await fetchMeta());
    } catch {
      setMetaErr('Could not look up your IP. Ad blockers and strict network policies can block these services.');
    } finally {
      setMetaBusy(false);
    }
  }, []);
  useEffect(() => {
    if (active && !fetched.current) {
      fetched.current = true;
      void loadMeta();
    }
  }, [active, loadMeta]);
  function toggleHide() {
    setHide((h) => {
      try {
        localStorage.setItem('aydrop.hideip', h ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !h;
    });
  }

  // Speed test
  const last = useLastSpeed();
  const transferBusy = useTransferActive();
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [cur, setCur] = useState(0);
  const [pingLive, setPingLive] = useState<number | null>(null);
  const [series, setSeries] = useState<number[]>([]);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);

  async function start() {
    const c = new AbortController();
    ac.current = c;
    setRunning(true);
    setMsg('');
    setSeries([]);
    setCur(0);
    setPct(0);
    setPingLive(null);
    try {
      const res = await runSpeedTest((e) => {
        if (e.type === 'phase') {
          setPhase(e.phase);
          setSeries([]);
          setCur(0);
        } else if (e.type === 'sample') {
          setCur(e.mbps);
          setSeries((s) => [...s.slice(-59), e.mbps]);
        } else if (e.type === 'ping') setPingLive(e.ms);
        else setPct(e.pct);
      }, c.signal);
      setLastResult(res);
      setPhase(null);
    } catch (e: any) {
      setPhase(null);
      setMsg(e?.name === 'AbortError' ? 'Test cancelled.' : e?.message || 'Speed test failed.');
    } finally {
      setRunning(false);
      ac.current = null;
    }
  }

  const v = last ? verdict(last) : null;
  const rows: [string, string][] = meta
    ? ([
        ['ISP', meta.isp],
        ['ASN', meta.asn],
        ['Location', [meta.city, meta.region, meta.country].filter(Boolean).join(', ')],
        ['Edge', meta.colo ? 'Cloudflare ' + meta.colo : ''],
      ] as [string, string][]).filter(([, val]) => val)
    : [];

  return (
    <div className="tools">
      <div className="seg tabs" role="tablist">
        <button role="tab" aria-selected={sub === 'net'} className={sub === 'net' ? 'on' : ''} onClick={() => setSub('net')}>
          Network &amp; speed
        </button>
        <button role="tab" aria-selected={sub === 'sys'} className={sub === 'sys' ? 'on' : ''} onClick={() => setSub('sys')}>
          System &amp; app usage
        </button>
      </div>

      {/* Network stays mounted so a running test survives tab switches */}
      <div hidden={sub !== 'net'} className="stack">
        <div className="panel">
          <div className="ph">
            <h2>Your connection</h2>
            <div className="row">
              <button className="btn ghost sq" aria-label={hide ? 'Show IP address' : 'Hide IP address'} aria-pressed={hide} onClick={toggleHide}>
                <Icon name={hide ? 'eyeoff' : 'eye'} />
              </button>
              <button className="btn ghost sq" aria-label="Refresh IP and location" disabled={metaBusy} onClick={loadMeta}>
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          {metaErr && <p className="err small">{metaErr}</p>}
          {!meta && !metaErr && <p className="muted small">{metaBusy ? 'Looking up…' : 'No data yet.'}</p>}
          {meta && (
            <dl className="kvs">
              <dt>Public IP</dt>
              <dd className="mono">{hide ? '•••.•••.•••.•••' : meta.ip}</dd>
              {rows.map(([k, val]) => (
                <div className="kvrow" key={k}>
                  <dt>{k}</dt>
                  <dd>{val}</dd>
                </div>
              ))}
              <dt>Source</dt>
              <dd className="muted">{meta.source}</dd>
            </dl>
          )}
        </div>

        <div className="panel">
          <div className="ph">
            <h2>Speed &amp; ping test</h2>
            {running ? (
              <button className="btn" onClick={() => ac.current?.abort()}>
                <Icon name="stop" /> Stop
              </button>
            ) : (
              <button className="btn primary" disabled={transferBusy} onClick={start}>
                <Icon name="play" /> {last ? 'Test again' : 'Start test'}
              </button>
            )}
          </div>
          {transferBusy && !running && <p className="muted small">A transfer is running. Wait for it to finish, or the result would be wrong and the transfer slower.</p>}
          {msg && <p className="err small">{msg}</p>}

          {running && (
            <div className="stack" role="status" aria-live="polite">
              <div className="muted small">{phase ? PHASE_TEXT[phase] : 'Starting'}…</div>
              <Gauge mbps={phase === 'ping' ? 0 : cur} label={phase === 'upload' ? 'Mbps up' : phase === 'download' ? 'Mbps down' : 'Mbps'} />
              {phase === 'ping' ? <div className="mono small">Latency {pingLive != null ? pingLive.toFixed(0) + ' ms' : '…'}</div> : <Spark data={series} />}
              <progress max={100} value={pct} />
            </div>
          )}

          {!running && last && (
            <div className="stack">
              <div className="tgrid">
                <div className="stat">
                  <h3>Ping</h3>
                  <div className="big">
                    {last.ping.median.toFixed(0)}
                    <small>ms</small>
                  </div>
                  <p className="muted small">
                    Jitter {last.ping.jitter.toFixed(1)} ms · {last.ping.min.toFixed(0)} to {last.ping.max.toFixed(0)} ms
                  </p>
                </div>
                <div className="stat">
                  <h3>Bufferbloat</h3>
                  <div className="big">{last.bloat || 'n/a'}</div>
                  <p className="muted small">Latency growth while the link is saturated. A is best.</p>
                </div>
                <div className="stat">
                  <h3>Download</h3>
                  <div className="big">
                    {fmtMbps(last.down.mbps)}
                    <small>Mbps</small>
                  </div>
                  <p className="muted small">{last.down.loaded ? 'Loaded ping ' + last.down.loaded.median.toFixed(0) + ' ms · jitter ' + last.down.loaded.jitter.toFixed(1) + ' ms' : 'Loaded ping n/a'}</p>
                </div>
                <div className="stat">
                  <h3>Upload</h3>
                  <div className="big">
                    {fmtMbps(last.up.mbps)}
                    <small>Mbps</small>
                  </div>
                  <p className="muted small">{last.up.loaded ? 'Loaded ping ' + last.up.loaded.median.toFixed(0) + ' ms · jitter ' + last.up.loaded.jitter.toFixed(1) + ' ms' : 'Loaded ping n/a'}</p>
                </div>
              </div>
              {v && <span className={'badge ' + v.tone}>{v.label}</span>}
              <p className="muted small">
                Sending 1 GB to someone would take {sendTime(last.up.mbps)} at this upload speed. Tested {new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} against Cloudflare. A full test moves up to roughly 150 MB.
              </p>
            </div>
          )}
          {!running && !last && !msg && <p className="muted small">Measures latency, jitter, download and upload against Cloudflare's edge, plus loaded latency. Uses up to roughly 150 MB on a fast connection.</p>}
        </div>
      </div>

      {/* System monitor mounts only while visible, so its 1-second pollers stop when you leave */}
      {sub === 'sys' && active && (
        <div className="panel">
          <div className="ph">
            <h2>This device and AyDrop</h2>
            <span className="badge ok">Live · 1 s</span>
          </div>
          <SystemMonitor />
        </div>
      )}

      {isAdmin && (
        <div className="card row">
          <div className="grow">
            <b>Admin</b>
            <div className="muted small">Settings, feedback, transfers and security alerts.</div>
          </div>
          <button className="btn" onClick={onOpenAdmin}>
            Open
          </button>
        </div>
      )}
    </div>
  );
}
