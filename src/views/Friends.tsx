import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import Icon from '../components/Icon';
import { QRBox, ScanDialog, friendLink, parseFriendId } from '../components/QR';
import { FID_RE, labelOf, rememberUser } from '../lib/util';

interface Req {
  id: string;
  from: string;
  to: string;
  status: 'pending' | 'accepted' | 'declined';
}
interface Found {
  uid: string;
  displayName: string;
  friendId: string;
}

export default function Friends() {
  const { user, profile, notify, pending, clearPending } = useApp();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [reqIn, setReqIn] = useState<Req[]>([]);
  const [reqOut, setReqOut] = useState<Req[]>([]);
  const [fr, setFr] = useState<{ id: string; uid: string }[]>([]);
  const [scan, setScan] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    const mapReq = (s: any): Req[] => s.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    const u1 = onSnapshot(query(collection(db, 'friendRequests'), where('to', '==', user.uid)), (s) => setReqIn(mapReq(s)), () => {});
    const u2 = onSnapshot(query(collection(db, 'friendRequests'), where('from', '==', user.uid)), (s) => setReqOut(mapReq(s)), () => {});
    const u3 = onSnapshot(
      query(collection(db, 'friendships'), where('members', 'array-contains', user.uid)),
      (s) => setFr(s.docs.map((d) => ({ id: d.id, uid: ((d.data().members as string[]) || []).find((m) => m !== user.uid) || '' }))),
      () => {}
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, [user.uid]);

  const err = (what: string) => (e: any) => notify(what + ': ' + (e?.code || e?.message), 'err');

  async function lookupId(id: string) {
    setFound(null);
    setCode(id);
    if (!FID_RE.test(id)) return notify('Friend IDs are 8 characters: letters (no I or O) and digits 2 to 9.', 'err');
    if (id === profile.friendId) return notify('That is your own ID.', 'err');
    try {
      const s = await getDoc(doc(db, 'friendIds', id));
      if (!s.exists()) return notify('No one has that ID.', 'err');
      const d: any = s.data();
      rememberUser(d.uid, d.displayName || id);
      setFound({ uid: d.uid, displayName: d.displayName || id, friendId: id });
    } catch (e) {
      err('Lookup failed')(e);
    }
  }
  const lookup = () => lookupId(code.trim().toUpperCase());

  // A scanned friend QR / shared link lands here already looked up.
  useEffect(() => {
    if (!pending.friend) return;
    const id = pending.friend;
    clearPending('friend');
    lookupId(id);
  }, [pending.friend]);

  async function request() {
    if (!found) return;
    if (fr.some((f) => f.uid === found.uid)) return notify('You are already friends.', 'err');
    if (reqIn.some((r) => r.from === found.uid && r.status === 'pending')) return notify('They already sent you a request. Accept it below.', 'err');
    try {
      await setDoc(doc(db, 'friendRequests', `${user.uid}_${found.uid}`), {
        from: user.uid,
        to: found.uid,
        status: 'pending',
        createdAt: serverTimestamp(),
      });
      notify('Request sent to ' + found.displayName + '.');
      setFound(null);
      setCode('');
    } catch (e: any) {
      notify(e?.code === 'permission-denied' ? 'You already have a request with this person.' : 'Request failed: ' + e?.message, 'err');
    }
  }

  async function accept(r: Req) {
    try {
      await updateDoc(doc(db, 'friendRequests', r.id), { status: 'accepted' });
      await setDoc(doc(db, 'friendships', r.id), { members: [r.from, r.to], createdAt: serverTimestamp() });
      notify('Friend added.');
    } catch (e) {
      err('Accept failed')(e);
    }
  }
  const decline = (r: Req) => updateDoc(doc(db, 'friendRequests', r.id), { status: 'declined' }).catch(err('Decline failed'));
  const cancel = (r: Req) => deleteDoc(doc(db, 'friendRequests', r.id)).catch(err('Remove failed'));

  async function unfriend(f: { id: string; uid: string }) {
    try {
      await deleteDoc(doc(db, 'friendships', f.id));
      const [a, b] = [user.uid, f.uid];
      await Promise.all([deleteDoc(doc(db, 'friendRequests', `${a}_${b}`)), deleteDoc(doc(db, 'friendRequests', `${b}_${a}`))].map((p) => p.catch(() => {})));
      notify('Friend removed.');
    } catch (e) {
      err('Remove failed')(e);
    }
  }

  const pendingIn = reqIn.filter((r) => r.status === 'pending');
  return (
    <div className="cols">
      <div className="panel">
        <div className="ph">
          <h2>Add a friend</h2>
        </div>
        <div className="stack">
          <div className="card">
            <div className="row">
              <div className="grow">
                <div className="muted small">Your friend ID</div>
                <div className="code mono sm">{profile.friendId}</div>
              </div>
              <button className="btn ghost sq" aria-label="Copy your friend link" title="Copy friend link" onClick={() => navigator.clipboard.writeText(friendLink(profile.friendId)).then(() => notify('Friend link copied.')).catch(() => notify('Clipboard blocked.', 'err'))}>
                <Icon name="copy" />
              </button>
              <button className="btn" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
                QR
              </button>
            </div>
            {showQr && <QRBox value={friendLink(profile.friendId)} label="Scan to add me on AyDrop" />}
          </div>
          <div className="row">
            <input className="mono" maxLength={8} placeholder="Their 8-character ID" aria-label="Friend ID" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && lookup()} />
            <button className="btn" onClick={lookup}>
              Find
            </button>
            <button className="btn" onClick={() => setScan(true)}>
              Scan
            </button>
          </div>
          {found && (
            <div className="card row">
              <div className="grow">
                <b>{found.displayName}</b>
                <div className="mono muted small">{found.friendId}</div>
              </div>
              <button className="btn primary" onClick={request}>
                Send request
              </button>
            </div>
          )}
        </div>
        <h3>Requests for you</h3>
        <div className="list">
          {pendingIn.length === 0 && <p className="muted small">No pending requests.</p>}
          {pendingIn.map((r) => (
            <div className="card row" key={r.id}>
              <div className="grow">{labelOf(r.from)}</div>
              <button className="btn primary" onClick={() => accept(r)}>
                Accept
              </button>
              <button className="btn" onClick={() => decline(r)}>
                Decline
              </button>
            </div>
          ))}
        </div>
        {reqOut.length > 0 && (
          <>
            <h3>Sent requests</h3>
            <div className="list">
              {reqOut.map((r) => (
                <div className="card row" key={r.id}>
                  <div className="grow">{labelOf(r.to)}</div>
                  <span className={'badge ' + (r.status === 'accepted' ? 'ok' : r.status === 'declined' ? 'err' : 'warn')}>{r.status}</span>
                  <button className="btn ghost sq" aria-label="Remove request" onClick={() => cancel(r)}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="panel">
        <div className="ph">
          <h2>Friends</h2>
          <span className="muted small">{fr.length}</span>
        </div>
        <div className="list">
          {fr.length === 0 && <p className="muted small">No friends yet. Share your QR or enter theirs.</p>}
          {fr.map((f) => (
            <div className="card row" key={f.id}>
              <div className="grow">{labelOf(f.uid)}</div>
              <button className="btn" onClick={() => unfriend(f)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      {scan && (
        <ScanDialog
          title="Scan a friend QR"
          hint="Point the camera at the QR on their Friends screen."
          placeholder="8-character friend ID"
          parse={parseFriendId}
          onResult={(id) => lookupId(id)}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}
