import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Dropzone from './Dropzone';
import TransferQueue from './TransferQueue';
import InstallPwa from './InstallPwa';
import { QRBox, ScanDialog } from './QR';
import { TransferEngine } from '../utils/transferEngine';
import type { TItem } from '../utils/transferEngine';
import { ICE_CONFIG, gather, packSdp, parseCode, unpackSdp } from '../utils/offlineSignal';
import { addProtected, setTransferActive } from '../utils/activity';
import { logTransfer } from '../lib/util';

type Stage = 'idle' | 'host' | 'join' | 'reply' | 'linking' | 'connected' | 'closed';
interface Props {
  blocked: string[];
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  /** When signed in, transfer metadata is logged (mode "local"). Omit when fully offline / signed out. */
  uid?: string;
}

/** No server, no internet: a two-step QR/code handshake, then the same engine as rooms
 *  (OPFS streaming, folder zip, SHA-256, resume). Uses no auth and no Firestore, so it runs from the installed PWA. */
export default function OfflineTransfer({ blocked, notify, uid }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [role, setRole] = useState<'host' | 'guest' | null>(null);
  const [myCode, setMyCode] = useState('');
  const [paste, setPaste] = useState('');
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [items, setItems] = useState<TItem[]>([]);

  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const engineRef = useRef<TransferEngine | null>(null);
  const itemsRef = useRef<TItem[]>([]);
  itemsRef.current = items;
  const everUp = useRef(false);
  const blockedRef = useRef<string[]>([]);
  blockedRef.current = blocked;

  function teardown() {
    engineRef.current?.dispose(); // unfinished incoming files stay on disk: re-adding the same file later resumes them
    engineRef.current = null;
    addProtected('offline', null);
    dc.current?.close();
    pc.current?.close();
    dc.current = null;
    pc.current = null;
    everUp.current = false;
  }
  function reset() {
    teardown();
    setItems([]);
    setMyCode('');
    setPaste('');
    setRole(null);
    setNote('');
    setStage('idle');
  }
  useEffect(
    () => () => {
      teardown();
      setTransferActive(false, 'offline');
    },
    []
  );

  const moving = items.some((i) => i.state === 'active' || i.state === 'preparing' || i.state === 'verifying');
  useEffect(() => {
    setTransferActive(moving, 'offline');
    let lock: any = null;
    if (moving && 'wakeLock' in navigator) (navigator as any).wakeLock.request('screen').then((l: any) => (lock = l)).catch(() => {});
    return () => {
      lock?.release?.().catch?.(() => {});
    };
  }, [moving]);

  // Pairing hint if it hangs.
  useEffect(() => {
    if (stage !== 'linking' && stage !== 'reply') return;
    const t = setTimeout(() => setNote('Still connecting. Both devices must be on the same Wi-Fi or hotspot, and the network must allow device-to-device traffic.'), 15000);
    return () => clearTimeout(t);
  }, [stage]);

  function startEngine() {
    engineRef.current?.dispose();
    engineRef.current = new TransferEngine({
      getChannel: () => dc.current,
      room: () => 'offline',
      blocked: () => blockedRef.current,
      onItems: setItems,
      notify,
      log: (size, ext, integrity) => {
        if (uid) void logTransfer(uid, 'local', size, ext, integrity);
      },
    });
    addProtected('offline', () => new Set([...(engineRef.current?.activeTids() ?? []), ...itemsRef.current.filter((i) => i.dir === 'in').map((i) => i.id)]));
  }
  function newPc(): RTCPeerConnection {
    const p = new RTCPeerConnection(ICE_CONFIG);
    p.onconnectionstatechange = () => {
      const s = p.connectionState;
      if (s === 'connected') {
        everUp.current = true;
        engineRef.current?.onLinkUp();
      } else if (s === 'disconnected') engineRef.current?.onLinkDown();
      else if (s === 'failed') {
        engineRef.current?.onLinkDown();
        setNote(everUp.current ? 'The link dropped. Pair again: unfinished files resume when you add the same file.' : 'Could not connect. Check that both devices are on the same network, then pair again.');
        setStage('closed');
      }
    };
    pc.current = p;
    return p;
  }
  function bind(ch: RTCDataChannel) {
    dc.current = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      setStage('connected');
      setNote('');
      engineRef.current?.onLinkUp();
    };
    ch.onclose = () => {
      engineRef.current?.onLinkDown();
      setStage((s) => (s === 'idle' ? s : 'closed'));
    };
    ch.onmessage = (ev) => engineRef.current?.handle(ev.data);
  }

  async function startHost() {
    setBusy(true);
    try {
      reset();
      startEngine();
      const p = newPc();
      bind(p.createDataChannel('aydrop'));
      await p.setLocalDescription(await p.createOffer());
      await gather(p);
      setMyCode(packSdp(p.localDescription!.sdp));
      setRole('host');
      setStage('host');
    } catch (e: any) {
      reset();
      notify(e?.message || 'Could not start pairing.', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function onCode(raw: string) {
    const code = parseCode(raw);
    if (!code) return notify('That does not look like an AyDrop code.', 'err');
    setBusy(true);
    try {
      const { sdp, kind } = unpackSdp(code);
      if (stage === 'host') {
        if (kind === 'o') throw new Error("That is the other device's first code. Paste its reply code instead.");
        await pc.current!.setRemoteDescription({ type: 'answer', sdp });
        setPaste('');
        setStage('linking');
      } else if (stage === 'join') {
        if (kind !== 'o') throw new Error('That is a reply code. Enter the first code shown on the other device.');
        startEngine();
        const p = newPc();
        p.ondatachannel = (e) => bind(e.channel);
        await p.setRemoteDescription({ type: 'offer', sdp });
        await p.setLocalDescription(await p.createAnswer());
        await gather(p);
        setMyCode(packSdp(p.localDescription!.sdp));
        setPaste('');
        setStage('reply');
      }
    } catch (e: any) {
      notify(e?.message || 'Pairing failed.', 'err');
    } finally {
      setBusy(false);
    }
  }

  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => notify('Code copied.')).catch(() => notify('Clipboard blocked. Select the code and copy it by hand.', 'err'));

  const entry = (
    <div className="stack">
      <div className="row join">
        <input className="mono" aria-label="Pairing code" placeholder="Paste the code" value={paste} onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void onCode(paste)} />
        <button className="btn" disabled={busy || !paste.trim()} onClick={() => void onCode(paste)}>
          Use code
        </button>
        <button className="btn" onClick={() => setScan(true)}>
          Scan
        </button>
      </div>
    </div>
  );
  const codeBlock = (label: string) => (
    <div className="stack">
      <b>{label}</b>
      <QRBox value={myCode} size={200} />
      <div className="code-box mono">{myCode}</div>
      <button className="btn" onClick={() => copy(myCode)}>
        <Icon name="copy" /> Copy code
      </button>
    </div>
  );

  return (
    <div className="stack">
      {stage === 'idle' && (
        <>
          <p className="muted small">
            Send files between two devices on the same Wi-Fi or phone hotspot, with no internet. Files stream to disk, folders are zipped, and every file is SHA-256 checked.
          </p>
          <button className="btn primary" disabled={busy} onClick={startHost}>
            Show pairing code
          </button>
          <button
            className="btn"
            onClick={() => {
              reset();
              setRole('guest');
              setStage('join');
            }}
          >
            I have a code
          </button>
          <InstallPwa label="Download PWA for Full Offline Access" notify={notify} />
        </>
      )}

      {stage === 'host' && (
        <>
          {codeBlock('1. Show this to the other device')}
          <b>2. Then enter the reply it shows</b>
          {entry}
          <button className="btn ghost" onClick={reset}>
            Cancel
          </button>
        </>
      )}

      {stage === 'join' && (
        <>
          <b>Scan or paste the code shown on the other device</b>
          {entry}
          <button className="btn ghost" onClick={reset}>
            Cancel
          </button>
        </>
      )}

      {stage === 'reply' && (
        <>
          {codeBlock('Show this reply to the first device')}
          <p className="muted small">Waiting for it to scan this…</p>
          {note && <p className="err small">{note}</p>}
          <button className="btn ghost" onClick={reset}>
            Cancel
          </button>
        </>
      )}

      {stage === 'linking' && (
        <>
          <p className="muted">Connecting…</p>
          {note && <p className="err small">{note}</p>}
          <button className="btn ghost" onClick={reset}>
            Cancel
          </button>
        </>
      )}

      {stage === 'connected' && (
        <>
          <div className="row">
            <span className="badge ok">Connected · no internet needed</span>
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={reset}>
              Disconnect
            </button>
          </div>
          <Dropzone notify={notify} onFiles={(f) => engineRef.current?.enqueue(f)} />
          <TransferQueue
            items={items}
            incomplete={0}
            onPause={(id) => engineRef.current?.pause(id)}
            onResume={(id) => engineRef.current?.resume(id)}
            onRemove={(id) => void engineRef.current?.remove(id)}
            onSave={(id) => engineRef.current?.save(id)}
            onClearIncomplete={() => {}}
          />
        </>
      )}

      {stage === 'closed' && (
        <>
          <p className="err small">{note || 'The connection closed.'}</p>
          {items.length > 0 && (
            <TransferQueue
              items={items}
              incomplete={0}
              onPause={() => {}}
              onResume={() => {}}
              onRemove={(id) => void engineRef.current?.remove(id)}
              onSave={(id) => engineRef.current?.save(id)}
              onClearIncomplete={() => {}}
            />
          )}
          <button className="btn primary" onClick={reset}>
            Pair again
          </button>
        </>
      )}

      {scan && (
        <ScanDialog
          title={role === 'host' ? "Scan the other device's reply" : 'Scan the pairing code'}
          hint="Point the camera at the QR on the other screen."
          placeholder="Paste the code"
          parse={parseCode}
          onResult={(c) => void onCode(c)}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}
