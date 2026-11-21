import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import { useTurnstile } from '../components/Turnstile';
import Icon from '../components/Icon';
import { MAX_P2P_BYTES, extOf, fmtSize, isBlocked, labelOf, logTransfer, randomRoomCode, saveBlob, sha256Hex } from '../lib/util';

type Status = 'idle' | 'waiting' | 'connecting' | 'connected' | 'closed';
interface Msg {
  id: string;
  from: string;
  text: string;
}
interface Item {
  id: number;
  dir: 'in' | 'out';
  name: string;
  size: number;
  done: number;
  state: 'active' | 'verified' | 'mismatch' | 'sent' | 'rejected';
  blob?: Blob;
}
interface Invite {
  id: string;
  from: string;
  roomCode: string;
}
const CHUNK = 16 * 1024;
const STATUS_TEXT: Record<Status, string> = {
  idle: 'No room',
  waiting: 'Waiting for peer',
  connecting: 'Connecting',
  connected: 'Connected',
  closed: 'Disconnected',
};

export default function Room() {
  const { user, settings, notify } = useApp();
  const human = useTurnstile(settings);
  const [status, setStatus] = useState<Status>('idle');
  const [code, setCode] = useState('');
  const [join, setJoin] = useState('');
  const [expires, setExpires] = useState<Timestamp | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [friends, setFriends] = useState<string[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteTo, setInviteTo] = useState('');
  const [busy, setBusy] = useState(false);

  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const unsubs = useRef<(() => void)[]>([]);
  const outQ = useRef<RTCIceCandidate[]>([]);
  const inQ = useRef<RTCIceCandidateInit[]>([]);
  const canWrite = useRef(false);
  const rx = useRef<{ item: number; meta: any; chunks: ArrayBuffer[]; got: number } | null>(null);
  const roomExp = useRef<Timestamp | null>(null);
  const codeRef = useRef('');
  const nextId = useRef(1);
  const abortSend = useRef(false);
  const blockedRef = useRef<string[]>([]);
  blockedRef.current = settings.blockedExtensions;

  const cleanup = useCallback(() => {
    unsubs.current.forEach((f) => f());
    unsubs.current = [];
    dc.current?.close();
    pc.current?.close();
    dc.current = null;
    pc.current = null;
    outQ.current = [];
    inQ.current = [];
    canWrite.current = false;
    rx.current = null;
  }, []);
  useEffect(() => cleanup, [cleanup]);

  function resetUi() {
    setStatus('idle');
    setCode('');
    setExpires(null);
    setMsgs([]);
    setItems([]);
    roomExp.current = null;
    codeRef.current = '';
  }
  function leave() {
    cleanup();
    resetUi();
  }

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, 'friendships'), where('members', 'array-contains', user.uid)),
      (s) => setFriends(s.docs.map((d) => ((d.data().members as string[]) || []).find((m) => m !== user.uid) || '').filter(Boolean)),
      () => {}
    );
    const u2 = onSnapshot(
      query(collection(db, 'invites'), where('to', '==', user.uid)),
      (s) =>
        setInvites(
          s.docs
            .map((d) => ({ id: d.id, ...(d.data() as any) }))
            .filter((i: any) => i.expiresAt && i.expiresAt.toMillis() > Date.now())
            .map((i: any) => ({ id: i.id as string, from: i.from as string, roomCode: i.roomCode as string }))
        ),
      () => {}
    );
    return () => {
      u1();
      u2();
    };
  }, [user.uid]);

  function pushCand(c: string, cand: RTCIceCandidate) {
    addDoc(collection(db, 'rooms', c, 'candidates'), {
      from: user.uid,
      candidate: JSON.stringify(cand.toJSON()),
      createdAt: serverTimestamp(),
    }).catch(() => {});
  }
  function openWrites(c: string) {
    canWrite.current = true;
    outQ.current.splice(0).forEach((x) => pushCand(c, x));
  }

  function newPc(c: string): RTCPeerConnection {
    const p = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    p.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (canWrite.current) pushCand(c, e.candidate);
      else outQ.current.push(e.candidate);
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === 'failed') {
        setStatus('closed');
        notify('Connection failed. Both sides may be behind strict NAT. Try a new room.', 'err');
      }
    };
    pc.current = p;
    return p;
  }

  function bind(ch: RTCDataChannel) {
    dc.current = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => setStatus('connected');
    ch.onclose = () => setStatus((s) => (s === 'idle' ? s : 'closed'));
    ch.onmessage = onData;
  }

  function watch(c: string, host: boolean) {
    const p = pc.current!;
    unsubs.current.push(
      onSnapshot(
        collection(db, 'rooms', c, 'candidates'),
        (s) =>
          s.docChanges().forEach((ch) => {
            if (ch.type !== 'added') return;
            const d = ch.doc.data();
            if (d.from === user.uid) return;
            const init = JSON.parse(d.candidate);
            if (p.remoteDescription) p.addIceCandidate(init).catch(() => {});
            else inQ.current.push(init);
          }),
        () => {}
      )
    );
    unsubs.current.push(
      onSnapshot(
        query(collection(db, 'rooms', c, 'messages'), orderBy('createdAt')),
        (s) => setMsgs(s.docs.map((d) => ({ id: d.id, from: d.data().from, text: d.data().text }))),
        () => {}
      )
    );
    if (host) {
      unsubs.current.push(
        onSnapshot(
          doc(db, 'rooms', c),
          async (s) => {
            const a = s.data()?.answer;
            if (a && !p.remoteDescription) {
              await p.setRemoteDescription(JSON.parse(a));
              for (const i of inQ.current.splice(0)) await p.addIceCandidate(i).catch(() => {});
              setStatus('connecting');
            }
          },
          () => {}
        )
      );
    }
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await human.verify())) {
        notify('Finish the human check first.', 'err');
        return;
      }
      leave();
      for (let i = 0; i < 5; i++) {
        const c = randomRoomCode();
        const p = newPc(c);
        bind(p.createDataChannel('aydrop'));
        await p.setLocalDescription(await p.createOffer());
        const exp = Timestamp.fromMillis(Date.now() + 115 * 60000);
        try {
          await setDoc(doc(db, 'rooms', c), {
            hostUid: user.uid,
            guestUid: '',
            offer: JSON.stringify(p.localDescription),
            createdAt: serverTimestamp(),
            expiresAt: exp,
          });
        } catch (e) {
          cleanup();
          if (i === 4) throw e;
          continue;
        }
        roomExp.current = exp;
        codeRef.current = c;
        setExpires(exp);
        setCode(c);
        setStatus('waiting');
        watch(c, true);
        openWrites(c);
        return;
      }
    } catch (e: any) {
      cleanup();
      notify('Could not create a room: ' + (e?.code || e?.message), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(c: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (!/^\d{6}$/.test(c)) throw new Error('Enter the 6-digit code.');
      if (!(await human.verify())) {
        notify('Finish the human check first.', 'err');
        return;
      }
      leave();
      const ref = doc(db, 'rooms', c);
      const s = await getDoc(ref);
      if (!s.exists()) throw new Error('No room with that code.');
      const d: any = s.data();
      const exp = d.expiresAt as Timestamp;
      if (exp.toMillis() <= Date.now()) throw new Error('That room has expired.');
      if (!d.offer) throw new Error('That room is not ready yet.');
      const p = newPc(c);
      p.ondatachannel = (e) => bind(e.channel);
      await p.setRemoteDescription(JSON.parse(d.offer));
      await p.setLocalDescription(await p.createAnswer());
      await updateDoc(ref, { guestUid: user.uid, answer: JSON.stringify(p.localDescription) });
      roomExp.current = exp;
      codeRef.current = c;
      setExpires(exp);
      setCode(c);
      setStatus('connecting');
      setJoin('');
      watch(c, false);
      openWrites(c);
    } catch (e: any) {
      cleanup();
      notify(e?.code === 'permission-denied' ? 'Room is full or has expired.' : e?.message || 'Could not join.', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function onData(ev: MessageEvent) {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.t === 'meta') {
        if (isBlocked(String(m.name), blockedRef.current) || m.size > MAX_P2P_BYTES) {
          dc.current?.send(JSON.stringify({ t: 'reject' }));
          notify('Blocked an incoming file: ' + m.name, 'err');
          return;
        }
        const id = nextId.current++;
        rx.current = { item: id, meta: m, chunks: [], got: 0 };
        setItems((a) => [{ id, dir: 'in', name: String(m.name), size: m.size, done: 0, state: 'active' }, ...a]);
      } else if (m.t === 'end' && rx.current) {
        const r = rx.current;
        rx.current = null;
        const blob = new Blob(r.chunks);
        const hash = await sha256Hex(await blob.arrayBuffer());
        const ok = hash === r.meta.sha256 && blob.size === r.meta.size;
        setItems((a) => a.map((x) => (x.id === r.item ? { ...x, done: blob.size, state: ok ? 'verified' : 'mismatch', blob: ok ? blob : undefined } : x)));
        logTransfer(user.uid, 'p2p', blob.size, extOf(String(r.meta.name)), ok ? 'verified' : 'mismatch');
        if (!ok) notify('Checksum mismatch on ' + r.meta.name + '. File discarded.', 'err');
      } else if (m.t === 'reject') {
        abortSend.current = true;
        notify('The other side blocked that file type.', 'err');
        setItems((a) => a.map((x) => (x.dir === 'out' && x.state === 'active' ? { ...x, state: 'rejected' } : x)));
      }
    } else if (rx.current) {
      const r = rx.current;
      r.chunks.push(ev.data);
      r.got += (ev.data as ArrayBuffer).byteLength;
      const id = r.item;
      const g = r.got;
      setItems((a) => a.map((x) => (x.id === id ? { ...x, done: g } : x)));
    }
  }

  async function sendFile(f: File) {
    const ch = dc.current;
    if (!ch || ch.readyState !== 'open') return notify('Not connected yet.', 'err');
    if (isBlocked(f.name, settings.blockedExtensions)) return notify('That file type is blocked.', 'err');
    if (f.size > MAX_P2P_BYTES) return notify('Max 256 MiB per file.', 'err');
    const id = nextId.current++;
    abortSend.current = false;
    setItems((a) => [{ id, dir: 'out', name: f.name, size: f.size, done: 0, state: 'active' }, ...a]);
    try {
      const hash = await sha256Hex(await f.arrayBuffer());
      ch.send(JSON.stringify({ t: 'meta', name: f.name.slice(0, 200), size: f.size, mime: f.type, sha256: hash }));
      let n = 0;
      for (let o = 0; o < f.size; o += CHUNK) {
        if (abortSend.current) return;
        while (ch.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 25));
        ch.send(await f.slice(o, o + CHUNK).arrayBuffer());
        if (++n % 16 === 0) {
          const d = Math.min(o + CHUNK, f.size);
          setItems((a) => a.map((x) => (x.id === id ? { ...x, done: d } : x)));
        }
      }
      ch.send(JSON.stringify({ t: 'end' }));
      setItems((a) => a.map((x) => (x.id === id ? { ...x, done: f.size, state: 'sent' } : x)));
      logTransfer(user.uid, 'p2p', f.size, extOf(f.name), 'unchecked');
    } catch (e: any) {
      notify('Send failed: ' + (e?.message || 'connection closed'), 'err');
      setItems((a) => a.map((x) => (x.id === id ? { ...x, state: 'rejected' } : x)));
    }
  }

  async function sendMsg() {
    const t = text.trim();
    if (!t || !roomExp.current) return;
    try {
      await addDoc(collection(db, 'rooms', codeRef.current, 'messages'), {
        from: user.uid,
        text: t.slice(0, 500),
        createdAt: serverTimestamp(),
        expiresAt: roomExp.current,
      });
      setText('');
    } catch (e: any) {
      notify('Message not sent: ' + (e?.code || e?.message), 'err');
    }
  }

  async function invite() {
    if (!inviteTo || !roomExp.current) return;
    try {
      await addDoc(collection(db, 'invites'), {
        from: user.uid,
        to: inviteTo,
        roomCode: codeRef.current,
        createdAt: serverTimestamp(),
        expiresAt: roomExp.current,
      });
      notify('Invite sent to ' + labelOf(inviteTo) + '.');
    } catch (e: any) {
      notify('Invite failed: ' + (e?.code || e?.message), 'err');
    }
  }

  const live = status !== 'idle';
  return (
    <div className="panel">
      <div className="ph">
        <h2>Room</h2>
        <span className={'badge ' + (status === 'connected' ? 'ok' : status === 'closed' ? 'err' : live ? 'warn' : '')}>{STATUS_TEXT[status]}</span>
      </div>

      {!live && (
        <div className="stack">
          <p className="muted">Direct browser-to-browser transfer. One side creates a room, the other enters the code.</p>
          {human.widget}
          <button className="btn primary" disabled={busy || !human.ready} onClick={create}>
            Create room
          </button>
          <div className="row">
            <input className="mono" inputMode="numeric" maxLength={6} placeholder="6-digit code" aria-label="Room code" value={join} onChange={(e) => setJoin(e.target.value.replace(/\D/g, ''))} />
            <button className="btn" disabled={busy || join.length !== 6 || !human.ready} onClick={() => joinRoom(join)}>
              Join
            </button>
          </div>
          {invites.length > 0 && (
            <div className="list">
              {invites.map((i) => (
                <div className="card row" key={i.id}>
                  <div className="grow">
                    <b>{labelOf(i.from)}</b> invited you
                    <div className="mono muted">{i.roomCode}</div>
                  </div>
                  <button className="btn" disabled={busy || !human.ready} onClick={() => joinRoom(i.roomCode)}>
                    Join
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {live && (
        <div className="stack">
          <div className="row">
            <div className="grow">
              <div className="code mono">{code}</div>
              <div className="muted small">Expires {expires?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <button className="btn ghost sq" aria-label="Copy room code" onClick={() => navigator.clipboard.writeText(code).then(() => notify('Code copied.'))}>
              <Icon name="copy" />
            </button>
            <button className="btn" onClick={leave}>
              Leave
            </button>
          </div>

          {friends.length > 0 && (
            <div className="row">
              <select aria-label="Friend to invite" value={inviteTo} onChange={(e) => setInviteTo(e.target.value)}>
                <option value="">Invite a friend…</option>
                {friends.map((f) => (
                  <option key={f} value={f}>
                    {labelOf(f)}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!inviteTo} onClick={invite}>
                Invite
              </button>
            </div>
          )}

          <label className={'drop' + (status !== 'connected' ? ' off' : '')}>
            <Icon name="file" size={18} />
            <span>{status === 'connected' ? 'Choose a file to send' : 'File sending unlocks when connected'}</span>
            <input
              type="file"
              disabled={status !== 'connected'}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) sendFile(f);
              }}
            />
          </label>

          {items.length > 0 && (
            <div className="list">
              {items.map((it) => (
                <div className="card" key={it.id}>
                  <div className="row">
                    <div className="grow clip">
                      <b>{it.name}</b>
                      <div className="muted small">
                        {it.dir === 'in' ? 'Receiving' : 'Sending'} · {fmtSize(it.size)}
                      </div>
                    </div>
                    <span className={'badge ' + (it.state === 'verified' || it.state === 'sent' ? 'ok' : it.state === 'active' ? 'warn' : 'err')}>
                      {it.state === 'verified' ? 'Verified' : it.state === 'sent' ? 'Sent' : it.state === 'active' ? 'In progress' : it.state === 'mismatch' ? 'Checksum mismatch' : 'Stopped'}
                    </span>
                    {it.blob && (
                      <button className="btn" onClick={() => saveBlob(it.blob!, it.name)}>
                        Save
                      </button>
                    )}
                  </div>
                  {it.state === 'active' && <progress max={Math.max(it.size, 1)} value={it.done} />}
                </div>
              ))}
            </div>
          )}

          <div className="chat" aria-label="Room chat">
            {msgs.length === 0 && <span className="muted small">No messages yet.</span>}
            {msgs.map((m) => (
              <div key={m.id} className={m.from === user.uid ? 'mine' : ''}>
                <span className="muted small">{m.from === user.uid ? 'You' : labelOf(m.from)}</span> {m.text}
              </div>
            ))}
          </div>
          <div className="row">
            <input aria-label="Message" maxLength={500} placeholder="Message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMsg()} />
            <button className="btn sq" aria-label="Send message" disabled={!text.trim()} onClick={sendMsg}>
              <Icon name="send" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
