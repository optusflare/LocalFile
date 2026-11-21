import { useEffect, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, Timestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import { useTurnstile } from '../components/Turnstile';
import Icon from '../components/Icon';
import { MAX_DROP_BYTES, extOf, fmtSize, fromB64, isBlocked, labelOf, logTransfer, saveBlob, sha256Hex, toB64 } from '../lib/util';

interface Drop {
  id: string;
  from: string;
  to: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  data: string;
  kind: 'file' | 'text';
  expiresAt?: Timestamp;
}

function toDrops(docs: any[]): Drop[] {
  return docs
    .map((d) => ({ id: d.id, ...d.data() }) as Drop)
    .sort((a, b) => (b.expiresAt?.toMillis() || 0) - (a.expiresAt?.toMillis() || 0));
}

export default function Drops() {
  const { user, settings, notify } = useApp();
  const human = useTurnstile(settings);
  const [inbox, setInbox] = useState<Drop[]>([]);
  const [sent, setSent] = useState<Drop[]>([]);
  const [friends, setFriends] = useState<string[]>([]);
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [to, setTo] = useState(user.uid);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Record<string, string>>({});

  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, 'drops'), where('to', '==', user.uid)), (s) => setInbox(toDrops(s.docs)), () => {});
    const u2 = onSnapshot(query(collection(db, 'drops'), where('from', '==', user.uid)), (s) => setSent(toDrops(s.docs).filter((d) => d.to !== user.uid)), () => {});
    const u3 = onSnapshot(
      query(collection(db, 'friendships'), where('members', 'array-contains', user.uid)),
      (s) => setFriends(s.docs.map((d) => ((d.data().members as string[]) || []).find((m) => m !== user.uid) || '').filter(Boolean)),
      () => {}
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, [user.uid]);

  const textBytes = new TextEncoder().encode(text).length;

  async function send() {
    if (busy) return;
    setBusy(true);
    try {
      let bytes: Uint8Array;
      let name = '';
      let mime = 'text/plain';
      if (mode === 'file') {
        if (!file) return notify('Choose a file first.', 'err');
        if (file.size > MAX_DROP_BYTES) return notify('Drops max out at 522 KiB. Use a room for bigger files.', 'err');
        if (isBlocked(file.name, settings.blockedExtensions)) return notify('That file type is blocked.', 'err');
        bytes = new Uint8Array(await file.arrayBuffer());
        name = file.name.slice(0, 200);
        mime = (file.type || 'application/octet-stream').slice(0, 100);
      } else {
        if (!text.trim()) return notify('Write something to send.', 'err');
        bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_DROP_BYTES) return notify('Text is over 522 KiB.', 'err');
      }
      if (!(await human.verify())) return notify('Finish the human check first.', 'err');
      const sha = await sha256Hex(bytes);
      await addDoc(collection(db, 'drops'), {
        from: user.uid,
        to,
        name,
        mime,
        size: bytes.length,
        sha256: sha,
        data: toB64(bytes),
        kind: mode === 'file' ? 'file' : 'text',
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 23 * 3600 * 1000),
      });
      logTransfer(user.uid, 'async', bytes.length, extOf(name), 'unchecked');
      notify(to === user.uid ? 'Saved to your own inbox.' : 'Drop sent to ' + labelOf(to) + '.');
      setText('');
      setFile(null);
    } catch (e: any) {
      notify('Drop failed: ' + (e?.code || e?.message), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function open(d: Drop) {
    try {
      if ((d.expiresAt?.toMillis() || 0) <= Date.now()) return notify('This drop has expired. Delete it.', 'err');
      if (d.kind === 'file' && isBlocked(d.name, settings.blockedExtensions)) return notify('That file type is blocked.', 'err');
      const bytes = fromB64(d.data);
      const ok = (await sha256Hex(bytes)) === d.sha256 && bytes.length === d.size;
      logTransfer(user.uid, 'async', bytes.length, extOf(d.name), ok ? 'verified' : 'mismatch');
      if (!ok) return notify('Checksum mismatch. Not opening this drop.', 'err');
      if (d.kind === 'text') setOpened((o) => ({ ...o, [d.id]: new TextDecoder().decode(bytes) }));
      else saveBlob(new Blob([bytes as BlobPart], { type: d.mime }), d.name || 'drop');
    } catch (e: any) {
      notify('Could not open drop: ' + (e?.message || 'bad data'), 'err');
    }
  }

  async function remove(d: Drop) {
    try {
      await deleteDoc(doc(db, 'drops', d.id));
    } catch (e: any) {
      notify('Delete failed: ' + (e?.code || e?.message), 'err');
    }
  }

  function card(d: Drop, mine: boolean) {
    const expired = (d.expiresAt?.toMillis() || 0) <= Date.now();
    return (
      <div className="card" key={d.id}>
        <div className="row">
          <div className="grow clip">
            <b>{d.kind === 'text' ? 'Text' : d.name || 'File'}</b>
            <div className="muted small">
              {mine ? 'To ' + labelOf(d.to) : 'From ' + (d.from === user.uid ? 'you' : labelOf(d.from))} · {fmtSize(d.size)} · {expired ? 'expired' : 'until ' + d.expiresAt?.toDate().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          {expired && <span className="badge err">Expired</span>}
          {!mine && !expired && (
            <button className="btn" onClick={() => open(d)}>
              {d.kind === 'text' ? 'Read' : 'Save'}
            </button>
          )}
          <button className="btn ghost sq" aria-label="Delete drop" onClick={() => remove(d)}>
            <Icon name="trash" />
          </button>
        </div>
        {opened[d.id] !== undefined && (
          <div className="textout">
            <pre>{opened[d.id]}</pre>
            <button className="btn" onClick={() => navigator.clipboard.writeText(opened[d.id]).then(() => notify('Copied.'))}>
              <Icon name="copy" /> Copy
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="ph">
        <h2>Drops</h2>
        <span className="muted small">Up to 522 KiB, kept 24 h</span>
      </div>
      <div className="stack">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
            Text
          </button>
          <button role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
            File
          </button>
        </div>
        <select aria-label="Recipient" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value={user.uid}>Me (another device)</option>
          {friends.map((f) => (
            <option key={f} value={f}>
              {labelOf(f)}
            </option>
          ))}
        </select>
        {mode === 'text' ? (
          <>
            <textarea rows={4} placeholder="Paste a link, a snippet, anything" value={text} onChange={(e) => setText(e.target.value)} />
            <div className={'small ' + (textBytes > MAX_DROP_BYTES ? 'err' : 'muted')}>
              {fmtSize(textBytes)} of 522 KiB
            </div>
          </>
        ) : (
          <label className="drop">
            <Icon name="file" size={18} />
            <span>{file ? file.name + ' (' + fmtSize(file.size) + ')' : 'Choose a file'}</span>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        )}
        {human.widget}
        <button className="btn primary" disabled={busy || !human.ready} onClick={send}>
          Send drop
        </button>
      </div>

      <h3>Inbox</h3>
      <div className="list">{inbox.length ? inbox.map((d) => card(d, false)) : <p className="muted small">Nothing waiting for you.</p>}</div>
      {sent.length > 0 && (
        <>
          <h3>Sent</h3>
          <div className="list">{sent.map((d) => card(d, true))}</div>
        </>
      )}
    </div>
  );
}
