import { useCallback, useEffect, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import type { Settings } from '../lib/ctx';
import Icon from '../components/Icon';
import { OWNER_UID, cleanExt, fmtSize } from '../lib/util';

type Tab = 'settings' | 'feedback' | 'transfers' | 'alerts';

function show(v: any): string {
  if (v && typeof v.toDate === 'function') return v.toDate().toLocaleString();
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// UI gate only. Real enforcement is the Firestore rule request.auth.uid == ownerUid().
export default function Admin() {
  const { user } = useApp();
  if (user.uid !== OWNER_UID) return null;
  return <AdminInner />;
}

function AdminInner() {
  const { settings, notify } = useApp();
  const [tab, setTab] = useState<Tab>('settings');
  const [form, setForm] = useState<Settings>(settings);
  const [ext, setExt] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => setForm(settings), [settings]);

  const load = useCallback(
    async (t: Tab) => {
      if (t === 'settings') return;
      setLoading(true);
      try {
        const col = t === 'feedback' ? 'feedback' : t === 'transfers' ? 'transfers' : 'securityAlerts';
        const q = t === 'alerts' ? query(collection(db, col), limit(100)) : query(collection(db, col), orderBy('createdAt', 'desc'), limit(100));
        const s = await getDocs(q);
        setRows(s.docs.map((d) => ({ id: d.id, ...d.data() })));
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
    load(tab);
  }, [tab, load]);

  function addExt() {
    const e = cleanExt(ext);
    if (!e) return;
    if (form.blockedExtensions.includes(e)) return setExt('');
    if (form.blockedExtensions.length >= 50) return notify('The list holds 50 extensions at most.', 'err');
    setForm({ ...form, blockedExtensions: [...form.blockedExtensions, e] });
    setExt('');
  }

  async function save() {
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

  async function delFeedback(id: string) {
    try {
      await deleteDoc(doc(db, 'feedback', id));
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e: any) {
      notify('Delete failed: ' + (e?.code || e?.message), 'err');
    }
  }

  const tabs: [Tab, string][] = [
    ['settings', 'Settings'],
    ['feedback', 'Feedback'],
    ['transfers', 'Transfers'],
    ['alerts', 'Security alerts'],
  ];

  return (
    <div className="panel">
      <div className="ph">
        <h2>Admin</h2>
        {tab !== 'settings' && (
          <button className="btn ghost sq" aria-label="Refresh" onClick={() => load(tab)}>
            <Icon name="refresh" />
          </button>
        )}
      </div>
      <div className="seg" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'settings' && (
        <div className="stack form">
          <label>
            Worker URL
            <input maxLength={200} value={form.workerUrl} onChange={(e) => setForm({ ...form, workerUrl: e.target.value })} placeholder="https://your-worker.workers.dev" />
          </label>
          <label>
            Turnstile site key (public)
            <input className="mono" maxLength={100} value={form.turnstileSiteKey} onChange={(e) => setForm({ ...form, turnstileSiteKey: e.target.value })} />
          </label>
          <label>
            Maintenance banner
            <textarea rows={2} maxLength={300} value={form.maintenanceBanner} onChange={(e) => setForm({ ...form, maintenanceBanner: e.target.value })} placeholder="Leave empty to hide the banner" />
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
          <button className="btn primary" onClick={save}>
            Save settings
          </button>
        </div>
      )}

      {tab !== 'settings' && loading && <p className="muted">Loading…</p>}
      {tab !== 'settings' && !loading && rows.length === 0 && <p className="muted">Nothing here.</p>}

      {tab === 'feedback' && (
        <div className="list">
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

      {tab === 'transfers' && rows.length > 0 && (
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
    </div>
  );
}
