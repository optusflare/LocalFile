import { useCallback, useEffect, useState } from 'react';
import { collection, deleteDoc, doc, getCountFromServer, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import type { Settings } from '../lib/ctx';
import Icon from '../components/Icon';
import { OWNER_UID, cleanExt, fmtSize } from '../lib/util';
import { DEFAULT_CONTROLS, useControls } from '../utils/siteControls';
import type { Controls } from '../utils/siteControls';
import { refreshOfflineStatus, useOnline, usePwa } from '../utils/pwa';
import { PART_PREFIX, listNames, removeByName } from '../utils/opfsStorage';
import { allRecs, delRec } from '../utils/transferLedger';
import type { LedgerRec } from '../utils/transferLedger';
import { clearTransferCache, fmtBig } from '../utils/sysStats';
import { getProtectedTids } from '../utils/activity';

type Tab = 'overview' | 'controls' | 'feedback' | 'transfers' | 'alerts' | 'diagnostics';

function show(v: any): string {
  if (v && typeof v.toDate === 'function') return v.toDate().toLocaleString();
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
const fmtN = (n: number | null) => (n == null ? 'n/a' : n.toLocaleString());

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <h3>{label}</h3>
      <div className="big">{value}</div>
      {sub && <p className="muted small">{sub}</p>}
    </div>
  );
}
function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="ctl">
      <div className="grow">
        <b>{label}</b>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="sw" onClick={() => onChange(!on)} />
    </div>
  );
}
function Num({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (n: number) => void }) {
  return (
    <label>
      {label} ({min} to {max} {unit})
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))} />
    </label>
  );
}

// UI gate only. Real enforcement is the Firestore rule request.auth.uid == ownerUid().
export default function Admin() {
  const { user } = useApp();
  if (user.uid !== OWNER_UID) return null;
  return <AdminInner />;
}

interface Overview {
  users: number | null;
  feedback: number | null;
  transfers: number | null;
  alerts: number | null;
  mode: Record<string, number>;
  n: number;
  bytes: number;
  mismatch: number;
  uids: number;
  hours: number[];
  sample: number;
}
interface Diag {
  usage: number;
  quota: number;
  files: string[];
  recs: LedgerRec[];
  caches: { name: string; n: number }[];
}

function AdminInner() {
  const { settings, notify } = useApp();
  const controls = useControls();
  const pwa = usePwa();
  const online = useOnline();
  const [tab, setTab] = useState<Tab>('overview');
  const [form, setForm] = useState<Settings>(settings);
  const [cform, setCform] = useState<Controls>(controls);
  const [ext, setExt] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [ov, setOv] = useState<Overview | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => setForm(settings), [settings]);
  useEffect(() => setCform(controls), [controls]);

  const loadDiag = useCallback(async () => {
    let usage = 0;
    let quota = 0;
    try {
      const e = await navigator.storage.estimate();
      usage = e.usage || 0;
      quota = e.quota || 0;
    } catch { /* unsupported */ }
    const caches_: { name: string; n: number }[] = [];
    try {
      for (const k of await caches.keys()) caches_.push({ name: k, n: (await (await caches.open(k)).keys()).length });
    } catch { /* Cache Storage unavailable */ }
    setDiag({ usage, quota, files: (await listNames()).filter((n) => n.startsWith(PART_PREFIX)), recs: await allRecs(), caches: caches_ });
    void refreshOfflineStatus();
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    const count = async (name: string) => {
      try {
        return (await getCountFromServer(collection(db, name))).data().count;
      } catch {
        return null; // e.g. users: needs the owner-read rule
      }
    };
    const [users, feedback, transfers, alerts] = await Promise.all([count('users'), count('feedback'), count('transfers'), count('securityAlerts')]);
    const mode: Record<string, number> = { p2p: 0, async: 0, local: 0 };
    const hours = Array<number>(24).fill(0);
    const uids = new Set<string>();
    let n = 0, bytes = 0, mismatch = 0, sample = 0;
    try {
      const s = await getDocs(query(collection(db, 'transfers'), orderBy('createdAt', 'desc'), limit(500)));
      const now = Date.now();
      s.docs.forEach((d) => {
        const t: any = d.data();
        const ms = t.createdAt?.toMillis?.();
        if (!ms) return;
        sample++;
        const age = now - ms;
        if (age > 86400000) return;
        n++;
        mode[t.mode] = (mode[t.mode] || 0) + 1;
        bytes += t.size || 0;
        if (t.integrity === 'mismatch') mismatch++;
        uids.add(t.uid);
        hours[23 - Math.min(23, Math.floor(age / 3600000))]++;
      });
    } catch { /* no transfers yet, or offline */ }
    setOv({ users, feedback, transfers, alerts, mode, n, bytes, mismatch, uids: uids.size, hours, sample });
    setLoading(false);
  }, []);

  const loadRows = useCallback(
    async (t: Tab) => {
      setLoading(true);
      try {
        const col = t === 'feedback' ? 'feedback' : t === 'transfers' ? 'transfers' : 'securityAlerts';
        const q = t === 'alerts' ? query(collection(db, col), limit(100)) : query(collection(db, col), orderBy('createdAt', 'desc'), limit(100));
        setRows((await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (e: any) {
        setRows([]);
        notify('Could not load: ' + (e?.code || e?.message), 'err');
      } finally {
        setLoading(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    setRows([]);
    if (tab === 'overview') {
      void loadOverview();
      void loadDiag();
    } else if (tab === 'diagnostics') void loadDiag();
    else if (tab === 'feedback' || tab === 'transfers' || tab === 'alerts') void loadRows(tab);
  }, [tab, loadOverview, loadDiag, loadRows]);

  async function saveControls() {
    try {
      await setDoc(doc(db, 'config', 'siteControls'), { ...cform, updatedAt: serverTimestamp() });
      notify('Controls saved. They apply to everyone straight away.');
    } catch (e: any) {
      notify('Save failed: ' + (e?.code || e?.message) + (e?.code === 'permission-denied' ? ' (deploy the config/siteControls rule first)' : ''), 'err');
    }
  }
  async function saveSettings() {
    const f = { ...form, workerUrl: form.workerUrl.trim(), turnstileSiteKey: form.turnstileSiteKey.trim(), maintenanceBanner: form.maintenanceBanner.trim() };
    if (f.workerUrl.length > 200) return notify('Worker URL is over 200 characters.', 'err');
    if (f.turnstileSiteKey.length > 100) return notify('Site key is over 100 characters.', 'err');
    if (f.maintenanceBanner.length > 300) return notify('Banner is over 300 characters.', 'err');
    try {
      await setDoc(doc(db, 'config', 'appSettings'), {
        workerUrl: f.workerUrl,
        turnstileSiteKey: f.turnstileSiteKey,
        maintenanceBanner: f.maintenanceBanner,
        blockedExtensions: f.blockedExtensions,
        updatedAt: serverTimestamp(),
      });
      notify('Settings saved.');
    } catch (e: any) {
      notify('Save failed: ' + (e?.code || e?.message), 'err');
    }
  }
  function addExt() {
    const e = cleanExt(ext);
    if (!e) return;
    if (form.blockedExtensions.includes(e)) return setExt('');
    if (form.blockedExtensions.length >= 50) return notify('The list holds 50 extensions at most.', 'err');
    setForm({ ...form, blockedExtensions: [...form.blockedExtensions, e] });
    setExt('');
  }
  async function delFeedback(id: string) {
    try {
      await deleteDoc(doc(db, 'feedback', id));
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e: any) {
      notify('Delete failed: ' + (e?.code || e?.message), 'err');
    }
  }

  // ----- cleanup actions (this browser only) -----
  async function run(fn: () => Promise<string>) {
    setWorking(true);
    try {
      notify(await fn());
      await loadDiag();
    } catch (e: any) {
      notify('Failed: ' + (e?.message || 'unknown error'), 'err');
    } finally {
      setWorking(false);
    }
  }
  const clearCache = () =>
    run(async () => {
      const n = await clearTransferCache(getProtectedTids());
      window.dispatchEvent(new Event('aydrop:cache-cleared'));
      return n ? 'Cleared ' + n + ' item(s) from the transfer cache.' : 'Nothing to clear.';
    });
  const resetOffline = () =>
    run(async () => {
      for (const r of (await navigator.serviceWorker?.getRegistrations()) || []) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
      return 'Service worker and offline cache removed. Reload to cache the app again.';
    });
  const clearPrefs = () =>
    run(async () => {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('aydrop.'));
      keys.forEach((k) => localStorage.removeItem(k));
      return 'Removed ' + keys.length + ' local preference(s).';
    });
  const deleteRec = (r: LedgerRec) =>
    run(async () => {
      if (getProtectedTids().has(r.tid)) throw new Error('That transfer is in use by a live session.');
      await removeByName(r.part);
      await delRec(r.tid);
      return 'Deleted ' + r.name + '.';
    });

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['controls', 'Controls'],
    ['feedback', 'Feedback'],
    ['transfers', 'Transfers'],
    ['alerts', 'Alerts'],
    ['diagnostics', 'Diagnostics'],
  ];
  const maxH = Math.max(1, ...(ov?.hours || [1]));

  return (
    <div className="panel">
      <div className="ph">
        <h2>Admin</h2>
        {tab !== 'controls' && (
          <button className="btn ghost sq" aria-label="Refresh" onClick={() => setTab((t) => { setTimeout(() => setTab(t), 0); return 'controls'; })}>
            <Icon name="refresh" />
          </button>
        )}
      </div>
      <div className="seg tabs" role="tablist" style={{ marginBottom: 14, overflowX: 'auto' }}>
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {loading && <p className="muted small">Loading…</p>}

      {tab === 'overview' && ov && (
        <div className="stack">
          <div className="statgrid">
            <Tile label="Users" value={fmtN(ov.users)} sub={ov.users == null ? 'Add the owner read rule on users' : undefined} />
            <Tile label="Feedback" value={fmtN(ov.feedback)} />
            <Tile label="Transfers logged" value={fmtN(ov.transfers)} />
            <Tile label="Security alerts" value={fmtN(ov.alerts)} />
            <Tile label="Rooms, 24 h" value={String(ov.mode.p2p || 0)} sub="Peer-to-peer transfers" />
            <Tile label="Drops, 24 h" value={String(ov.mode.async || 0)} sub="Async transfers" />
            <Tile label="Offline, 24 h" value={String(ov.mode.local || 0)} sub="Local pairing transfers" />
            <Tile label="Active users, 24 h" value={String(ov.uids)} />
            <Tile label="Data moved, 24 h" value={fmtSize(ov.bytes)} />
            <Tile label="Mismatch rate" value={ov.n ? ((ov.mismatch / ov.n) * 100).toFixed(1) + '%' : '0%'} sub="Checksum failures" />
          </div>
          <div className="stat">
            <h3>Transfers per hour, last 24 h</h3>
            <div className="bars" role="img" aria-label="Transfers per hour">
              {ov.hours.map((n, i) => (
                <i key={i} title={n + ' transfers'} style={{ height: Math.max(3, (n / maxH) * 100) + '%' }} />
              ))}
            </div>
            <p className="muted small">Based on the latest {ov.sample} logged transfers. Drop contents are never read here.</p>
          </div>
          <div className="statgrid">
            <Tile label="This device: app" value={pwa.installed ? 'Installed' : 'In browser'} sub={online ? 'Online' : 'Offline'} />
            <Tile label="This device: offline cache" value={pwa.offlineReady ? 'Ready' : pwa.swActive ? 'Caching' : 'Not cached'} sub={pwa.swActive ? 'Service worker active' : 'No service worker'} />
            <Tile label="Browser storage" value={diag ? fmtBig(diag.usage) : '-'} sub={diag && diag.quota ? 'of ' + fmtBig(diag.quota) + ' quota' : undefined} />
            <Tile label="Partial transfers" value={diag ? String(diag.recs.filter((r) => r.state === 'partial').length) : '-'} sub={diag ? diag.files.length + ' OPFS file(s)' : undefined} />
          </div>
          <p className="muted small">Install and cache status describe this browser only. Per-user install counts are not visible to a website.</p>
        </div>
      )}

      {tab === 'controls' && (
        <div className="stack form">
          <div>
            <h3 style={{ marginTop: 0 }}>Site controls (live for everyone)</h3>
            <Switch on={cform.roomsEnabled} onChange={(v) => setCform({ ...cform, roomsEnabled: v })} label="Rooms" hint="Peer-to-peer rooms" />
            <Switch on={cform.dropsEnabled} onChange={(v) => setCform({ ...cform, dropsEnabled: v })} label="Drops" hint="Async text, link and file drops" />
            <Switch on={cform.offlineEnabled} onChange={(v) => setCform({ ...cform, offlineEnabled: v })} label="Offline transfer" hint="QR pairing with no internet" />
            <Switch on={cform.autoZipFolders} onChange={(v) => setCform({ ...cform, autoZipFolders: v })} label="Auto-zip folders" hint="Off: folder drops are refused" />
          </div>
          <Num label="Max drop size" value={cform.maxDropKiB} min={1} max={522} unit="KiB" onChange={(n) => setCform({ ...cform, maxDropKiB: n })} />
          <Num label="Max room / offline file size" value={cform.maxRoomFileMiB} min={1} max={8192} unit="MiB" onChange={(n) => setCform({ ...cform, maxRoomFileMiB: n })} />
          <Num label="Drop lifetime" value={cform.dropTtlHours} min={1} max={23} unit="hours" onChange={(n) => setCform({ ...cform, dropTtlHours: n })} />
          <div className="row">
            <button className="btn primary" onClick={saveControls}>
              Save controls
            </button>
            <button className="btn ghost" onClick={() => setCform(DEFAULT_CONTROLS)}>
              Reset to defaults
            </button>
          </div>

          <h3>Announcement &amp; filters</h3>
          <label>
            Maintenance banner
            <textarea rows={2} maxLength={300} value={form.maintenanceBanner} onChange={(e) => setForm({ ...form, maintenanceBanner: e.target.value })} placeholder="Leave empty to hide the banner" />
          </label>
          <label>
            Worker URL
            <input maxLength={200} value={form.workerUrl} onChange={(e) => setForm({ ...form, workerUrl: e.target.value })} placeholder="https://your-worker.workers.dev" />
          </label>
          <label>
            Turnstile site key (public)
            <input className="mono" maxLength={100} value={form.turnstileSiteKey} onChange={(e) => setForm({ ...form, turnstileSiteKey: e.target.value })} />
          </label>
          <div>
            <div className="lbl">Blocked extensions ({form.blockedExtensions.length}/50)</div>
            <div className="chips">
              {form.blockedExtensions.map((x) => (
                <span className="chip mono" key={x}>
                  {x}
                  <button aria-label={'Remove ' + x} onClick={() => setForm({ ...form, blockedExtensions: form.blockedExtensions.filter((y) => y !== x) })}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              {form.blockedExtensions.length === 0 && <span className="muted small">None blocked.</span>}
            </div>
            <div className="row">
              <input className="mono" maxLength={12} placeholder="exe" value={ext} onChange={(e) => setExt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addExt()} aria-label="Extension to block" />
              <button className="btn" onClick={addExt}>
                Add
              </button>
            </div>
          </div>
          <div className="muted small">Last saved: {settings.updatedAt ? settings.updatedAt.toDate().toLocaleString() : 'never'}</div>
          <button className="btn primary" onClick={saveSettings}>
            Save banner &amp; filters
          </button>
        </div>
      )}

      {tab === 'feedback' && (
        <div className="list">
          {!loading && rows.length === 0 && <p className="muted">Nothing here.</p>}
          {rows.map((r) => (
            <div className="card" key={r.id}>
              <div className="row">
                <span className={'badge ' + (r.category === 'abuse' ? 'err' : r.category === 'bug' ? 'warn' : '')}>{r.category}</span>
                <span className="grow muted small">
                  {show(r.createdAt)} · <span className="mono">{String(r.uid).slice(0, 8)}</span>
                </span>
                <button className="btn ghost sq" aria-label="Delete feedback" onClick={() => delFeedback(r.id)}>
                  <Icon name="trash" />
                </button>
              </div>
              <p className="msg">{r.message}</p>
            </div>
          ))}
        </div>
      )}

      {tab === 'transfers' && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Mode</th>
                <th>Size</th>
                <th>Ext</th>
                <th>Integrity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{show(r.createdAt)}</td>
                  <td className="mono">{String(r.uid).slice(0, 8)}</td>
                  <td>{r.mode}</td>
                  <td>{fmtSize(r.size || 0)}</td>
                  <td className="mono">{r.ext || '-'}</td>
                  <td>
                    <span className={'badge ' + (r.integrity === 'verified' ? 'ok' : r.integrity === 'mismatch' ? 'err' : '')}>{r.integrity}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'alerts' && (
        <div className="list">
          {!loading && rows.length === 0 && <p className="muted">No alerts.</p>}
          {rows.map((r) => (
            <div className="card" key={r.id}>
              <div className="mono muted small">{r.id}</div>
              {Object.entries(r)
                .filter(([k]) => k !== 'id')
                .map(([k, v]) => (
                  <div key={k} className="kv">
                    <span className="muted">{k}</span>
                    <span className="mono">{show(v)}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'diagnostics' && diag && (
        <div className="stack">
          <p className="muted small">These tools act on this browser only: its OPFS files, IndexedDB ledger and offline cache.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" disabled={working} onClick={clearCache}>
              Clear OPFS &amp; incomplete transfers
            </button>
            <button className="btn" disabled={working} onClick={resetOffline}>
              Reset offline cache
            </button>
            <button className="btn" disabled={working} onClick={clearPrefs}>
              Clear local preferences
            </button>
          </div>

          <h3>Transfer ledger ({diag.recs.length})</h3>
          <div className="list">
            {diag.recs.length === 0 && <p className="muted small">Empty.</p>}
            {diag.recs.map((r) => (
              <div className="card row" key={r.tid}>
                <div className="grow clip">
                  <b>{r.name}</b>
                  <div className="muted small">
                    {fmtSize(r.size)} · {r.state} · {new Date(r.updated).toLocaleString()}
                  </div>
                </div>
                <button className="btn ghost sq" aria-label={'Delete ' + r.name} disabled={working} onClick={() => deleteRec(r)}>
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>

          <h3>Cache storage ({diag.caches.length})</h3>
          <div className="list">
            {diag.caches.length === 0 && <p className="muted small">No caches. The app has not been cached for offline use here yet.</p>}
            {diag.caches.map((c) => (
              <div className="card row" key={c.name}>
                <div className="grow mono small">{c.name}</div>
                <span className="muted small">{c.n} entries</span>
              </div>
            ))}
          </div>
          <p className="muted small">
            Storage {fmtBig(diag.usage)}
            {diag.quota ? ' of ' + fmtBig(diag.quota) : ''} · {diag.files.length} OPFS transfer file(s)
          </p>
        </div>
      )}
    </div>
  );
}
