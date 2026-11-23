import { useCallback, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db, google } from './lib/firebase';
import { AppCtx, DEFAULT_SETTINGS, useApp } from './lib/ctx';
import type { Pending, Profile, Settings } from './lib/ctx';
import { FID_RE, OWNER_UID, randomFriendId } from './lib/util';
import Icon, { Logo } from './components/Icon';
import AmbientBackground from './components/AmbientBackground';
import OfflineTransfer from './components/OfflineTransfer';
import MiniStatus from './components/MiniStatus';
import Transfer from './views/Transfer';
import Friends from './views/Friends';
import Feedback from './views/Feedback';
import Tools from './views/Tools';
import Admin from './views/Admin';
import './home.css';

type View = 'transfer' | 'friends' | 'feedback' | 'tools' | 'admin';
interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err';
}

const GUEST_PROFILE: Profile = { friendId: '', displayName: 'Guest' };

/** Reads ?room= / ?friend= once at load (from a scanned QR or shared link), then cleans the URL. */
function readLink(): Pending {
  const p = new URLSearchParams(window.location.search);
  const room = p.get('room') || '';
  const friend = (p.get('friend') || '').toUpperCase();
  const out: Pending = { room: /^\d{6}$/.test(room) ? room : '', friend: FID_RE.test(friend) ? friend : '' };
  if (p.has('room') || p.has('friend')) window.history.replaceState(null, '', window.location.pathname);
  return out;
}
const INITIAL_LINK = readLink();

/** Allocates an 8-char friend ID. friendIds docs are create-only, so a taken ID is detected first and retried. */
async function createProfile(user: User): Promise<Profile> {
  const displayName = (user.displayName || 'Anonymous').slice(0, 60);
  let last: any = null;
  for (let i = 0; i < 8; i++) {
    const friendId = randomFriendId();
    try {
      await runTransaction(db, async (tx) => {
        const fref = doc(db, 'friendIds', friendId);
        if ((await tx.get(fref)).exists()) throw new Error('taken');
        tx.set(fref, { uid: user.uid, displayName });
        tx.set(doc(db, 'users', user.uid), { friendId, displayName, createdAt: serverTimestamp() });
      });
      return { friendId, displayName };
    } catch (e: any) {
      last = e;
      if (e?.code === 'permission-denied') break;
    }
  }
  throw last || new Error('Could not allocate a friend ID');
}

/** Shown in place of a member-only view when a guest opens it. */
function MemberGate({ what, why }: { what: string; why: string }) {
  const { signInGoogle } = useApp();
  return (
    <div className="panel narrow">
      <div className="ph">
        <h2>{what}</h2>
        <span className="badge">Members</span>
      </div>
      <div className="stack">
        <p className="muted">{why}</p>
        <button className="btn primary" onClick={signInGoogle}>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [rev, setRev] = useState(0); // bumped after a guest is upgraded in place (same User object)
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileErr, setProfileErr] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>(INITIAL_LINK.friend ? 'friends' : 'transfer');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<Pending>(INITIAL_LINK);

  const clearPending = useCallback((k: keyof Pending) => setPending((p) => ({ ...p, [k]: '' })), []);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 6000 : 3500);
  }, []);

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u)), []);

  useEffect(
    () =>
      onSnapshot(
        doc(db, 'config', 'appSettings'),
        (s) => {
          const d: any = s.data() || {};
          setSettings({
            workerUrl: d.workerUrl || '',
            turnstileSiteKey: d.turnstileSiteKey || '',
            maintenanceBanner: d.maintenanceBanner || '',
            blockedExtensions: Array.isArray(d.blockedExtensions) ? d.blockedExtensions : [],
            updatedAt: d.updatedAt || null,
          });
        },
        () => {}
      ),
    []
  );

  // Profile: guests have none (no users/friendIds docs). Members get one created on first sign-in.
  useEffect(() => {
    if (!user) {
      setProfile(null);
      setProfileErr('');
      return;
    }
    if (user.isAnonymous) {
      setProfile(GUEST_PROFILE);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const s = await getDoc(doc(db, 'users', user.uid));
        const p: Profile = s.exists()
          ? { friendId: (s.data() as any).friendId, displayName: (s.data() as any).displayName || '' }
          : await createProfile(user);
        if (!dead) setProfile(p);
      } catch (e: any) {
        if (!dead) setProfileErr(e?.code || e?.message || 'Profile setup failed');
      }
    })();
    return () => {
      dead = true;
    };
  }, [user, rev]);

  const signInGoogle = useCallback(async () => {
    const cur = auth.currentUser;
    try {
      if (cur && cur.isAnonymous) {
        // Upgrade in place: same uid, so a live room and the user's drops survive.
        await linkWithPopup(cur, google);
        await cur.reload();
        await cur.getIdToken(true); // refresh claims so rules see a non-anonymous provider
        setRev((r) => r + 1);
      } else {
        await signInWithPopup(auth, google);
      }
    } catch (e: any) {
      const c = e?.code as string | undefined;
      if (c === 'auth/credential-already-in-use') {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (cred) {
          try {
            await signInWithCredential(auth, cred);
          } catch (e2: any) {
            notify('Sign-in failed (' + (e2?.code || e2?.message) + ').', 'err');
          }
        }
      } else if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, google);
      } else if (c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
        notify('Sign-in failed (' + (c || e?.message) + '). If this is a new domain, add it to Firebase Auth authorized domains.', 'err');
      }
    }
  }, [notify]);

  async function continueAsGuest() {
    try {
      await signInAnonymously(auth);
    } catch (e: any) {
      notify(
        e?.code === 'auth/admin-restricted-operation'
          ? 'Guest mode is off. Enable Anonymous sign-in in Firebase Authentication.'
          : 'Could not start a guest session: ' + (e?.code || e?.message),
        'err'
      );
    }
  }

  const toastEls = (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.msg}
        </div>
      ))}
    </div>
  );

  if (user === undefined) return <div className="center muted">Loading…</div>;

  // ---------- Home ----------
  if (user === null) {
    const guestPoints = [
      'Rooms: direct browser-to-browser, joined by a 6-digit code or a QR scan',
      'Queue several files at once, with live progress on each',
      'Drops: text, links and files up to 522 KiB, one-tap copy on the other end',
      'No account, no email',
    ];
    const memberPoints = [
      'Chat inside a room',
      'Friends by 8-character ID or QR, plus room invites',
      'Drops to friends and to your own other devices',
      'Send feedback and report abuse',
    ];
    return (
      <>
        {settings.maintenanceBanner && <div className="banner" style={{ margin: 16 }}>{settings.maintenanceBanner}</div>}
        <div className="home">
          <AmbientBackground />
          <div className="home-wrap">
            <header className="home-head">
              <div className="brand">
                <Logo size={28} />
                <span>AyDrop</span>
              </div>
            </header>

            <section className="home-hero">
              <h1>Get it onto the other device.</h1>
              <p className="lead">Files, links and text. Straight between browsers in a room, or parked in a drop for up to 24 hours.</p>
              {pending.room && <div className="home-pending">Room {pending.room} is waiting. Continue to join it.</div>}
              {pending.friend && <div className="home-pending">Friend link detected. Sign in with Google to add them.</div>}
              <div className="home-actions">
                <button className="btn light" onClick={() => signInGoogle()}>
                  Continue with Google
                </button>
                <div className="home-note">Everything below, plus chat and friends.</div>
                <button className="btn dark" onClick={continueAsGuest}>
                  Continue as Guest
                </button>
                <div className="home-note">Transfers only. You can sign in later without losing your room.</div>
              </div>
            </section>

            <section className="home-cards">
              <div className="glass feat">
                <div className="feat-h">
                  <b>Guest</b>
                  <span className="badge">No account</span>
                </div>
                <ul>
                  {guestPoints.map((t) => (
                    <li key={t}>
                      <Icon name="check" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="glass feat dim">
                <div className="feat-h">
                  <b>Member</b>
                  <span className="badge">Google sign-in</span>
                </div>
                <ul>
                  {memberPoints.map((t) => (
                    <li key={t}>
                      <Icon name="check" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <footer className="home-foot">Drops are capped at 522 KiB and expire after 24 hours. Room transfers go directly between the two browsers.</footer>
          </div>
        </div>
        {toastEls}
      </>
    );
  }

  if (!profile) {
    return (
      <div className="center stack">
        {profileErr ? (
          <>
            <p className="err">Could not set up your profile: {profileErr}</p>
            <button className="btn" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </>
        ) : (
          <span className="muted">Setting up your profile…</span>
        )}
      </div>
    );
  }

  const isGuest = user.isAnonymous;
  const isAdmin = !isGuest && user.uid === OWNER_UID;
  // Exactly four primary destinations on every screen size. Admin is reached from the sidebar (desktop) or from Tools (mobile).
  const tabs: { id: View; label: string; icon: string; members?: boolean }[] = [
    { id: 'transfer', label: 'Transfer', icon: 'drop' },
    { id: 'friends', label: 'Friends', icon: 'friends', members: true },
    { id: 'feedback', label: 'Feedback', icon: 'feedback', members: true },
    { id: 'tools', label: 'Tools', icon: 'tools' },
  ];

  return (
    <AppCtx.Provider value={{ user, profile, settings, isAdmin, isGuest, notify, signInGoogle, pending, clearPending }}>
      <div className="app">
        <aside className="rail">
          <div className="brand">
            <Logo />
            <span>AyDrop</span>
          </div>
          <nav>
            {tabs.map((t) => (
              <button key={t.id} className={'nav' + (view === t.id ? ' on' : '')} aria-current={view === t.id ? 'page' : undefined} onClick={() => setView(t.id)}>
                <Icon name={t.icon} size={18} />
                <span>{t.label}</span>
                {isGuest && t.members && <span className="tag">Members</span>}
              </button>
            ))}
          </nav>
          <MiniStatus onOpen={() => setView('tools')} />
          {isAdmin && (
            <button className={'nav admin-link' + (view === 'admin' ? ' on' : '')} onClick={() => setView('admin')}>
              <Icon name="admin" size={18} />
              <span>Admin</span>
            </button>
          )}
          <div className="me">
            <div className="who">
              <b>{isGuest ? 'Guest' : profile.displayName || 'You'}</b>
              <span className="mono muted">{isGuest ? 'no account' : profile.friendId}</span>
            </div>
            {isGuest && (
              <button className="btn sm" onClick={signInGoogle}>
                Sign in
              </button>
            )}
            <button className="btn ghost sq" onClick={() => signOut(auth)} aria-label={isGuest ? 'Exit guest session' : 'Sign out'} title={isGuest ? 'Exit guest session' : 'Sign out'}>
              <Icon name="out" />
            </button>
          </div>
        </aside>
        <main>
          {settings.maintenanceBanner && <div className="banner">{settings.maintenanceBanner}</div>}
          {/* Transfer and Tools stay mounted so a live room and a running speed test survive tab switches */}
          <section hidden={view !== 'transfer'}>
            <Transfer />
          </section>
          <section hidden={view !== 'friends'}>
            {isGuest ? <MemberGate what="Friends" why="Adding friends and inviting them to rooms needs an account. Sign in with Google to get your friend ID and QR code." /> : <Friends />}
          </section>
          <section hidden={view !== 'feedback'}>
            {isGuest ? <MemberGate what="Feedback" why="Feedback is tied to an account so reports can be followed up and abuse can be traced. Sign in with Google to send one." /> : <Feedback />}
          </section>
          <section hidden={view !== 'tools'}>
            <Tools active={view === 'tools'} isAdmin={isAdmin} onOpenAdmin={() => setView('admin')} />
          </section>
          {isAdmin && view === 'admin' && (
            <section>
              <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => setView('tools')}>
                ← Tools
              </button>
              <Admin />
            </section>
          )}
        </main>
      </div>
      {toastEls}
    </AppCtx.Provider>
  );
}
