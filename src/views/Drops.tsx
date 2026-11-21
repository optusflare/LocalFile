import { useEffect, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, Timestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import { useTurnstile } from '../components/Turnstile';
import Icon from '../components/Icon';
import { QRBox } from '../components/QR';
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
interface QItem {
  name: string;
  size: number;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  err?: string;
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const QR_MAX_CHARS = 1200;

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
  const [files, setFiles] = useState<File[]>([]);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const [qrFor, setQrFor] = useState('');
  const seen = useRef<Set<string>>(new Set());

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

  // Text and links are verified and shown automatically, so the receiver only has to tap Copy.
  useEffect(() => {
    inbox
      .filter((d) => d.kind === 'text' && (d.expiresAt?.toMillis() || 0) > Date.now() && !seen.current.has(d.id))
      .slice(0, 20)
      .forEach(async (d) => {
        seen.current.add(d.id);
        try {
          const bytes = fromB64(d.data);
          const ok = (await sha256Hex(bytes)) === d.sha256 && bytes.length === d.size;
          logTransfer(user.uid, 'async', bytes.length, '', ok ? 'verified' : 'mismatch');
          if (ok) setOpened((o) => ({ ...o, [d.id]: new TextDecoder().decode(bytes) }));
          else setBad((b) => ({ ...b, [d.id]: true }));
        } catch {
          setBad((b) => ({ ...b, [d.id]: true }));
        }
      });
  }, [inbox, user.uid]);

  const textBytes = new TextEncoder().encode(text).length;
  const filesTotal = files.reduce((n, f) => n + f.size, 0);

  async function putDrop(kind: 'file' | 'text', bytes: Uint8Array, name: string, mime: string) {
    await addDoc(collection(db, 'drops'), {
      from: user.uid,
      to,
      name,
      mime,
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      data: toB64(bytes),
      kind,
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 23 * 3600 * 1000),
    });
    logTransfer(user.uid, 'async', bytes.length, extOf(name), 'unchecked');
  }

  async function send() {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'text') {
        const bytes = new TextEncoder().encode(text);
        if (!text.trim()) return notify('Write or paste something first.', 'err');
        if (bytes.length > MAX_DROP_BYTES) return notify('Text is over 522 KiB.', 'err');
        if (!(await human.verify())) return notify('Finish the human check first.', 'err');
        await putDrop('text', bytes, '', 'text/plain');
        notify(to === user.uid ? 'Saved to your own inbox.' : 'Sent to ' + labelOf(to) + '.');
        setText('');
        return;
      }
      if (files.length === 0) return notify('Choose at least one file.', 'err');
      if (!(await human.verify())) return notify('Finish the human check first.', 'err');
      const q: QItem[] = files.map((f) => ({ name: f.name, size: f.size, state: 'queued' }));
      setQueue(q);
      const set = (i: number, patch: Partial<QItem>) => setQueue((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      let ok = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        set(i, { state: 'sending' });
        try {
          if (f.size > MAX_DROP_BYTES) throw new Error('Over 522 KiB. Use a room.');
          if (isBlocked(f.name, settings.blockedExtensions)) throw new Error('Blocked file type');
          await putDrop('file', new Uint8Array(await f.arrayBuffer()), f.name.slice(0, 200), (f.type || 'application/octet-stream').slice(0, 100));
          set(i, { state: 'sent' });
          ok++;
        } catch (e: any) {
          set(i, { state: 'failed', err: e?.code || e?.message || 'Failed' });
        }
      }
      notify(ok + ' of ' + files.length + ' sent.', ok === files.length ? 'ok' : 'err');
      setFiles([]);
    } catch (e: any) {
      notify('Drop failed: ' + (e?.code || e?.message), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveFile(d: Drop) {
    try {
      if ((d.expiresAt?.toMillis() || 0) <= Date.now()) return notify('This drop has expired. Delete it.', 'err');
      if (isBlocked(d.name, settings.blockedExtensions)) return notify('That file type is blocked.', 'err');
      const bytes = fromB64(d.data);
      const ok = (await sha256Hex(bytes)) === d.sha256 && bytes.length === d.size;
      logTransfer(user.uid, 'async', bytes.length, extOf(d.name), ok ? 'verified' : 'mismatch');
      if (!ok) return notify('Checksum mismatch. Not opening this drop.', 'err');
      saveBlob(new Blob([bytes as BlobPart], { type: d.mime }), d.name || 'drop');
    } catch (e: any) {
      notify('Could not open drop: ' + (e?.message || 'bad data'), 'err');
    }
  }

  const copy = (t: string) =>
    navigator.clipboard
      .writeText(t)
      .then(() => notify('Copied.'))
      .catch(() => notify('Clipboard blocked. Select the text and copy it by hand.', 'err'));

  async function paste() {
    try {
      setText(await navigator.clipboard.readText());
    } catch {
      notify('Clipboard blocked. Paste into the box instead.', 'err');
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
    const body = opened[d.id];
    const link = body !== undefined && isUrl(body);
    return (
      <div className="card" key={d.id}>
        <div className="row">
          <div className="grow clip">
            <b>{d.kind === 'text' ? (body !== undefined && link ? 'Link' : 'Text') : d.name || 'File'}</b>
            <div className="muted small">
              {mine ? 'To ' + labelOf(d.to) : 'From ' + (d.from === user.uid ? 'you' : labelOf(d.from))} · {fmtSize(d.size)} · {expired ? 'expired' : 'until ' + d.expiresAt?.toDate().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          {expired && <span className="badge err">Expired</span>}
          {bad[d.id] && <span className="badge err">Checksum mismatch</span>}
          {!mine && !expired && d.kind === 'file' && (
            <button className="btn" onClick={() => saveFile(d)}>
              Save
            </button>
          )}
          <button className="btn ghost sq" aria-label="Delete drop" onClick={() => remove(d)}>
            <Icon name="trash" />
          </button>
        </div>
        {!mine && body !== undefined && (
          <div className="textout">
            <pre>{body}</pre>
            <div className="row">
              <button className="btn primary" onClick={() => copy(body)}>
                <Icon name="copy" /> Copy
              </button>
              {link && (
                <a className="btn" href={body.trim()} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              )}
              {body.length <= QR_MAX_CHARS && (
                <button className="btn" onClick={() => setQrFor(qrFor === d.id ? '' : d.id)} aria-expanded={qrFor === d.id}>
                  QR
                </button>
              )}
            </div>
            {qrFor === d.id && <QRBox value={body} label={link ? 'Scan to open the link on another device' : 'Scan to read this text on another device'} />}
          </div>
        )}
      </div>
    );
  }

  const qDone = queue.filter((q) => q.state === 'sent' || q.state === 'failed').length;
  return (
    <div className="panel">
      <div className="ph">
        <h2>Drops</h2>
        <span className="muted small">Up to 522 KiB each, kept 24 h</span>
      </div>
      <div className="stack">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
            Text / link
          </button>
          <button role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
            Files
          </button>
        </div>
        <select aria-label="Recipient" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value={user.uid}>Me (my other devices)</option>
          {friends.map((f) => (
            <option key={f} value={f}>
              {labelOf(f)}
            </option>
          ))}
        </select>

        {mode === 'text' ? (
          <>
            <textarea rows={4} placeholder="Paste a link or a snippet" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row">
              <div className={'grow small ' + (textBytes > MAX_DROP_BYTES ? 'err' : 'muted')}>{fmtSize(textBytes)} of 522 KiB</div>
              <button className="btn ghost sm" onClick={paste}>
                Paste from clipboard
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="drop">
              <Icon name="file" size={18} />
              <span>{files.length ? files.length + (files.length === 1 ? ' file' : ' files') + ' · ' + fmtSize(filesTotal) : 'Choose files (select several to queue them)'}</span>
              <input
                type="file"
                multiple
                onChange={(e) => {
                  setFiles(Array.from(e.target.files || []));
                  setQueue([]);
                  e.target.value = '';
                }}
              />
            </label>
            {files.length > 0 && queue.length === 0 && (
              <div className="qlist">
                {files.map((f, i) => (
                  <div className="qrow" key={i}>
                    <span className="clip">
                      <b style={{ fontWeight: 500 }}>{f.name}</b>
                    </span>
                    <span className={'small ' + (f.size > MAX_DROP_BYTES ? 'err' : 'muted')}>{f.size > MAX_DROP_BYTES ? 'Too big' : fmtSize(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
            {queue.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="qsum">
                  <span>
                    {qDone} of {queue.length} done
                  </span>
                  <span className="pct">{Math.round((qDone / queue.length) * 100)}%</span>
                </div>
                <progress max={queue.length} value={qDone} style={{ marginTop: 0 }} />
                <div className="qlist">
                  {queue.map((q, i) => (
                    <div className="qrow" key={i}>
                      <span className="clip">
                        <b style={{ fontWeight: 500 }}>{q.name}</b>
                        {q.err && <div className="err small">{q.err}</div>}
                      </span>
                      <span className={'badge ' + (q.state === 'sent' ? 'ok' : q.state === 'failed' ? 'err' : q.state === 'sending' ? 'warn' : '')}>
                        {q.state === 'sent' ? 'Sent' : q.state === 'failed' ? 'Failed' : q.state === 'sending' ? 'Sending' : 'Queued'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {human.widget}
        <button className="btn primary" disabled={busy || !human.ready} onClick={send}>
          {mode === 'text' ? 'Send' : files.length > 1 ? 'Send ' + files.length + ' files' : 'Send file'}
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
