import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import { useTurnstile } from '../components/Turnstile';
import Icon from '../components/Icon';
import Dropzone from '../components/Dropzone';
import TransferQueue from '../components/TransferQueue';
import { QRBox, ScanDialog, parseRoomCode, roomLink } from '../components/QR';
import { labelOf, logTransfer, randomRoomCode } from '../lib/util';
import { TransferEngine } from '../utils/transferEngine';
import type { TItem } from '../utils/transferEngine';
import { clearIncomplete, listPartial } from '../utils/transferLedger';
import { setTransferActive } from '../utils/activity';

type Status = 'idle' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
type Tab = 'files' | 'chat' | 'share';
interface Msg {
  id: string;
  from: string;
  text: string;
}
interface Invite {
  id: string;
  from: string;
  roomCode: string;
}
const STATUS_TEXT: Record<Status, string> = {
  idle: 'No room',
  waiting: 'Waiting for peer',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  closed: 'Disconnected',
};

export default function Room() {
  const { user, settings, notify, isGuest, signInGoogle, pending, clearPending } = useApp();
  const human = useTurnstile(settings);
  const [status, setStatus] = useState<Status>('idle');
  const [tab, setTab] = useState<Tab>('files');
  const [code, setCode] = useState('');
  const [join, setJoin] = useState('');
  const [autoJoin, setAutoJoin] = useState(false);
  const [scan, setScan] = useState(false);
  const [expires, setExpires] = useState<Timestamp | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [items, setItems] = useState<TItem[]>([]);
  const [incomplete, setIncomplete] = useState(0);
  const [friends, setFriends] = useState<string[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteTo, setInviteTo] = useState('');
  const [busy, setBusy] = useState(false);

  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const engineRef = useRef<TransferEngine | null>(null);
  const unsubs = useRef<(() => void)[]>([]);
  const outQ = useRef<RTCIceCandidate[]>([]);
  const inQ = useRef<RTCIceCandidateInit[]>([]);
  const canWrite = useRef(false);
  const roomExp = useRef<Timestamp | null>(null);
  const codeRef = useRef('');
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const lastOffer = useRef('');
  const lastAnswer = useRef('');
  const everUp = useRef(false);
  const attempts = useRef(0);
  const restartTimer = useRef(0);
  const blockedRef = useRef<string[]>([]);
  blockedRef.current = settings.blockedExtensions;

  const refreshIncomplete = useCallback(async () => {
    const act = engineRef.current?.activeTids() ?? new Set<string>();
    setIncomplete((await listPartial()).filter((r) => !act.has(r.tid)).length);
  }, []);
  useEffect(() => {
    void refreshIncomplete();
  }, [refreshIncomplete]);

  const cleanup = useCallback(() => {
    unsubs.current.forEach((f) => f());
    unsubs.current = [];
    window.clearTimeout(restartTimer.current);
    restartTimer.current = 0;
    dc.current?.close();
    pc.current?.close();
    dc.current = null;
    pc.current = null;
    outQ.current = [];
    inQ.current = [];
    canWrite.current = false;
    everUp.current = false;
    attempts.current = 0;
    lastOffer.current = '';
    lastAnswer.current = '';
  }, []);
  useEffect(
    () => () => {
      engineRef.current?.dispose();
      cleanup();
      setTransferActive(false);
    },
    [cleanup]
  );

  function resetUi() {
    setStatus('idle');
    setCode('');
    setExpires(null);
    setMsgs([]);
    setItems([]);
    roomExp.current = null;
    codeRef.current = '';
    roleRef.current = null;
  }
  function leave() {
    engineRef.current?.dispose(); // unfinished incoming files stay on disk so a later room can resume them
    engineRef.current = null;
    cleanup();
    resetUi();
    window.setTimeout(refreshIncomplete, 600);
  }
  function startEngine() {
    engineRef.current?.dispose();
    engineRef.current = new TransferEngine({
      getChannel: () => dc.current,
      room: () => codeRef.current,
      blocked: () => blockedRef.current,
      onItems: setItems,
      notify,
      log: (size, ext, integrity) => logTransfer(user.uid, 'p2p', size, ext, integrity),
    });
  }

  // Keep the screen awake and quiet the ambient animation while a transfer is moving.
  const moving = items.some((i) => i.state === 'active' || i.state === 'preparing' || i.state === 'verifying');
  useEffect(() => {
    setTransferActive(moving);
    let lock: any = null;
    if (moving && 'wakeLock' in navigator) {
      (navigator as any).wakeLock.request('screen').then((l: any) => (lock = l)).catch(() => {});
    }
    return () => {
      lock?.release?.().catch?.(() => {});
    };
  }, [moving]);

  // A scanned room QR / shared link: fill the code and join as soon as the human check passes.
  useEffect(() => {
    if (!pending.room) return;
    setJoin(pending.room);
    setAutoJoin(true);
    notify('Room ' + pending.room + ' found. Joining as soon as the check passes.');
    clearPending('room');
  }, [pending.room]);
  useEffect(() => {
    if (autoJoin && join.length === 6 && human.ready && !busy && status === 'idle') {
      setAutoJoin(false);
      joinRoom(join);
    }
  }, [autoJoin, join, human.ready, busy, status]);

  // Member-only data. Guests never query it.
  useEffect(() => {
    if (isGuest) {
      setFriends([]);
      setInvites([]);
      return;
    }
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
  }, [user.uid, isGuest]);

  useEffect(() => {
    if (isGuest || !code) return;
    return onSnapshot(
      query(collection(db, 'rooms', code, 'messages'), orderBy('createdAt')),
      (s) => setMsgs(s.docs.map((d) => ({ id: d.id, from: d.data().from, text: d.data().text }))),
      () => {}
    );
  }, [isGuest, code]);

  // ---------- signaling ----------
  function pushCand(c: string, cand: RTCIceCandidate) {
    addDoc(collection(db, 'rooms', c, 'candidates'), { from: user.uid, candidate: JSON.stringify(cand.toJSON()), createdAt: serverTimestamp() }).catch(() => {});
  }
  function openWrites(c: string) {
    canWrite.current = true;
    outQ.current.splice(0).forEach((x) => pushCand(c, x));
  }

  /** Host-only ICE restart through the room doc. Covers phone lock, wifi/cell handover and brief drops. */
  function scheduleRestart(delay: number) {
    if (roleRef.current !== 'host' || restartTimer.current) return;
    restartTimer.current = window.setTimeout(async () => {
      restartTimer.current = 0;
      const p = pc.current;
      if (!p || p.connectionState === 'connected' || p.connectionState === 'closed') return;
      if (attempts.current++ >= 5) {
        setStatus('closed');
        notify('Could not reconnect. Make a new room: unfinished files continue where they stopped.', 'err');
        return;
      }
      try {
        await p.setLocalDescription(await p.createOffer({ iceRestart: true }));
        lastOffer.current = JSON.stringify(p.localDescription);
        await updateDoc(doc(db, 'rooms', codeRef.current), { offer: lastOffer.current, answer: '' });
      } catch { /* the retry below handles it */ }
      restartTimer.current = window.setTimeout(() => {
        restartTimer.current = 0;
        if (pc.current && pc.current.connectionState !== 'connected') scheduleRestart(0);
      }, 12000);
    }, delay);
  }

  function newPc(c: string): RTCPeerConnection {
    const p = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    p.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (canWrite.current) pushCand(c, e.candidate);
      else outQ.current.push(e.candidate);
    };
    p.onconnectionstatechange = () => {
      const s = p.connectionState;
      if (s === 'connected') {
        everUp.current = true;
        attempts.current = 0;
        window.clearTimeout(restartTimer.current);
        restartTimer.current = 0;
        if (dc.current?.readyState === 'open') setStatus('connected');
        engineRef.current?.onLinkUp();
      } else if (s === 'disconnected' || s === 'failed') {
        if (!everUp.current) {
          if (s === 'failed') {
            setStatus('closed');
            notify('Connection failed. Both sides may be behind strict NAT. Try a new room.', 'err');
          }
          return;
        }
        engineRef.current?.onLinkDown();
        setStatus('reconnecting');
        scheduleRestart(s === 'failed' ? 0 : 4000);
      }
    };
    pc.current = p;
    return p;
  }

  function bind(ch: RTCDataChannel) {
    dc.current = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      setStatus('connected');
      setTab('files');
      engineRef.current?.onLinkUp();
    };
    ch.onclose = () => {
      engineRef.current?.onLinkDown();
      setStatus((s) => (s === 'idle' || s === 'reconnecting' ? s : 'closed'));
    };
    ch.onmessage = (ev) => engineRef.current?.handle(ev.data);
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
    // Room doc: the host applies answers (first connect and every ICE restart); the guest answers restart offers.
    unsubs.current.push(
      onSnapshot(
        doc(db, 'rooms', c),
        async (s) => {
          const d = s.data();
          if (!d) return;
          try {
            if (host) {
              if (d.answer && d.answer !== lastAnswer.current && p.signalingState === 'have-local-offer') {
                lastAnswer.current = d.answer;
                await p.setRemoteDescription(JSON.parse(d.answer));
                for (const i of inQ.current.splice(0)) await p.addIceCandidate(i).catch(() => {});
                setStatus((st) => (st === 'waiting' ? 'connecting' : st));
              }
            } else if (d.offer && d.offer !== lastOffer.current) {
              lastOffer.current = d.offer;
              await p.setRemoteDescription(JSON.parse(d.offer));
              await p.setLocalDescription(await p.createAnswer());
              lastAnswer.current = JSON.stringify(p.localDescription);
              await updateDoc(doc(db, 'rooms', c), { answer: lastAnswer.current });
            }
          } catch { /* a stale or duplicate description: the next snapshot will correct it */ }
        },
        () => {}
      )
    );
  }

  // Phone unlocked / tab foregrounded: nudge a stalled link back to life.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden || !pc.current) return;
      if (pc.current.connectionState !== 'connected') scheduleRestart(0);
      else if (dc.current?.readyState === 'open') engineRef.current?.onLinkUp();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await human.verify())) {
        notify('Finish the human check first.', 'err');
        return;
      }
      leave();
      startEngine();
      for (let i = 0; i < 5; i++) {
        const c = randomRoomCode();
        roleRef.current = 'host';
        const p = newPc(c);
        bind(p.createDataChannel('aydrop'));
        await p.setLocalDescription(await p.createOffer());
        const exp = Timestamp.fromMillis(Date.now() + 115 * 60000);
        lastOffer.current = JSON.stringify(p.localDescription);
        try {
          await setDoc(doc(db, 'rooms', c), { hostUid: user.uid, guestUid: '', offer: lastOffer.current, createdAt: serverTimestamp(), expiresAt: exp });
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
        setTab('share');
        watch(c, true);
        openWrites(c);
        return;
      }
    } catch (e: any) {
      engineRef.current?.dispose();
      engineRef.current = null;
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
      startEngine();
      const ref = doc(db, 'rooms', c);
      const s = await getDoc(ref);
      if (!s.exists()) throw new Error('No room with that code.');
      const d: any = s.data();
      const exp = d.expiresAt as Timestamp;
      if (exp.toMillis() <= Date.now()) throw new Error('That room has expired.');
      if (!d.offer) throw new Error('That room is not ready yet.');
      roleRef.current = 'guest';
      lastOffer.current = d.offer;
      const p = newPc(c);
      p.ondatachannel = (e) => bind(e.channel);
      await p.setRemoteDescription(JSON.parse(d.offer));
      await p.setLocalDescription(await p.createAnswer());
      lastAnswer.current = JSON.stringify(p.localDescription);
      await updateDoc(ref, { guestUid: user.uid, answer: lastAnswer.current });
      roomExp.current = exp;
      codeRef.current = c;
      setExpires(exp);
      setCode(c);
      setStatus('connecting');
      setTab('files');
      setJoin('');
      watch(c, false);
      openWrites(c);
    } catch (e: any) {
      engineRef.current?.dispose();
      engineRef.current = null;
      cleanup();
      notify(e?.code === 'permission-denied' ? 'Room is full or has expired.' : e?.message || 'Could not join.', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function sendMsg() {
    if (isGuest) return signInGoogle();
    const t = text.trim();
    if (!t || !roomExp.current) return;
    try {
      await addDoc(collection(db, 'rooms', codeRef.current, 'messages'), { from: user.uid, text: t.slice(0, 500), createdAt: serverTimestamp(), expiresAt: roomExp.current });
      setText('');
    } catch (e: any) {
      notify('Message not sent: ' + (e?.code || e?.message), 'err');
    }
  }

  async function invite() {
    if (!inviteTo || !roomExp.current) return;
    try {
      await addDoc(collection(db, 'invites'), { from: user.uid, to: inviteTo, roomCode: codeRef.current, createdAt: serverTimestamp(), expiresAt: roomExp.current });
      notify('Invite sent to ' + labelOf(inviteTo) + '.');
    } catch (e: any) {
      notify('Invite failed: ' + (e?.code || e?.message), 'err');
    }
  }

  async function clearStale() {
    const n = await clearIncomplete(engineRef.current?.activeTids() ?? new Set<string>());
    notify(n ? 'Cleared ' + n + ' incomplete file' + (n === 1 ? '' : 's') + '.' : 'Nothing to clear.');
    void refreshIncomplete();
  }

  const queue = (
    <TransferQueue
      items={items}
      incomplete={incomplete}
      onPause={(id) => engineRef.current?.pause(id)}
      onResume={(id) => engineRef.current?.resume(id)}
      onRemove={(id) => void engineRef.current?.remove(id)}
      onSave={(id) => engineRef.current?.save(id)}
      onClearIncomplete={clearStale}
    />
  );
  const live = status !== 'idle';
  const linked = status === 'connected' || status === 'reconnecting';

  return (
    <div className="panel">
      <div className="ph">
        <h2>Room</h2>
        <span className={'badge ' + (status === 'connected' ? 'ok' : status === 'closed' ? 'err' : live ? 'warn' : '')}>{STATUS_TEXT[status]}</span>
      </div>

      {!live && (
        <div className="stack">
          <p className="muted">Direct browser-to-browser transfer. One side creates a room, the other enters the code or scans its QR.</p>
          {human.widget}
          <button className="btn primary" disabled={busy || !human.ready} onClick={create}>
            Create room
          </button>
          <div className="row join">
            <input className="mono" inputMode="numeric" maxLength={6} placeholder="6-digit code" aria-label="Room code" value={join} onChange={(e) => setJoin(e.target.value.replace(/\D/g, ''))} />
            <button className="btn" disabled={busy || join.length !== 6 || !human.ready} onClick={() => joinRoom(join)}>
              Join
            </button>
            <button className="btn" onClick={() => setScan(true)}>
              Scan
            </button>
          </div>
          {autoJoin && <p className="muted small">Code {join} ready. Joining as soon as the check passes.</p>}
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
          {incomplete > 0 && queue}
        </div>
      )}

      {live && (
        <div className="stack">
          <div className="roomhead">
            <div className="grow">
              <div className="code mono">{code}</div>
              <div className="muted small">Expires {expires?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <button className="btn" onClick={leave}>
              Leave
            </button>
          </div>

          <div className="seg tabs" role="tablist">
            {(['files', 'chat', 'share'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'files' ? 'Files' + (items.length ? ' · ' + items.length : '') : t === 'chat' ? 'Chat' : 'Share'}
              </button>
            ))}
          </div>

          {tab === 'files' && (
            <>
              <Dropzone disabled={!linked} hint="File sending unlocks once the other device connects." notify={notify} onFiles={(f) => engineRef.current?.enqueue(f)} />
              {queue}
            </>
          )}

          {tab === 'chat' &&
            (isGuest ? (
              <div className="card">
                <b>Chat is for members</b>
                <p className="muted small" style={{ margin: '4px 0 12px' }}>
                  Sign in with Google to message in this room. Your room and any running transfer stay open.
                </p>
                <button className="btn primary" onClick={signInGoogle}>
                  Sign in with Google
                </button>
              </div>
            ) : (
              <>
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
              </>
            ))}

          {tab === 'share' && (
            <>
              <QRBox value={roomLink(code)} label={'Scan to join room ' + code} />
              <button className="btn" onClick={() => navigator.clipboard.writeText(roomLink(code)).then(() => notify('Room link copied.')).catch(() => notify('Clipboard blocked.', 'err'))}>
                <Icon name="copy" /> Copy room link
              </button>
              {friends.length > 0 && (
                <div className="row join">
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
            </>
          )}
        </div>
      )}

      {scan && (
        <ScanDialog
          title="Scan a room QR"
          hint="Point the camera at the QR on the other device."
          placeholder="6-digit room code"
          parse={parseRoomCode}
          onResult={(c) => {
            setJoin(c);
            setAutoJoin(true);
          }}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}
