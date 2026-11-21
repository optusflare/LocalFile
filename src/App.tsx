import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db, google } from './lib/firebase';
import { AppCtx, DEFAULT_SETTINGS } from './lib/ctx';
import type { Profile, Settings } from './lib/ctx';
import { OWNER_UID, randomFriendId } from './lib/util';
import Icon, { Logo } from './components/Icon';
import Transfer from './views/Transfer';
import Friends from './views/Friends';
import Feedback from './views/Feedback';
import Admin from './views/Admin';

type View = 'transfer' | 'friends' | 'feedback' | 'admin';
interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'err';
}

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

async function signIn(notify: (m: string, k?: 'ok' | 'err') => void) {
  try {
    await signInWithPopup(auth, google);
  } catch (e: any) {
    const c = e?.code as string | undefined;
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, google);
    } else if (c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
      notify('Sign-in failed (' + (c || e?.message) + '). If this is a new domain, add it to Firebase Auth authorized domains.', 'err');
    }
  }
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileErr, setProfileErr] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>('transfer');
  const [toasts, setToasts] = useState<Toast[]>([]);

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

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setProfileErr('');
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
  }, [user]);

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

  if (user === null) {
    return (
      <>
        {settings.maintenanceBanner && <div className="banner">{settings.maintenanceBanner}</div>}
        <div className="gate">
          <div className="gate-in">
            <div className="brand big">
              <Logo size={32} />
              <span>AyDrop</span>
            </div>
            <h1>Send a file to another device.</h1>
            <p>
              Open a room and transfer straight between two browsers, or leave a drop that waits for the other person for up to 24 hours.
            </p>
            <button className="btn primary" onClick={() => signIn(notify)}>
              Continue with Google
            </button>
            <dl className="facts">
              <dt>Room</dt>
              <dd>Six-digit code, direct WebRTC transfer, live chat.</dd>
              <dt>Drop</dt>
              <dd>Text or a file up to 522 KiB. SHA-256 checked on arrival.</dd>
              <dt>Friends</dt>
              <dd>Add someone by their 8-character ID, then invite or drop to them.</dd>
            </dl>
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

  const isAdmin = user.uid === OWNER_UID;
  const tabs: { id: View; label: string; icon: string }[] = [
    { id: 'transfer', label: 'Transfer', icon: 'drop' },
    { id: 'friends', label: 'Friends', icon: 'friends' },
    { id: 'feedback', label: 'Feedback', icon: 'feedback' },
  ];
  if (isAdmin) tabs.push({ id: 'admin', label: 'Admin', icon: 'admin' });

  return (
    <AppCtx.Provider value={{ user, profile, settings, isAdmin, notify }}>
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
              </button>
            ))}
          </nav>
          <div className="me">
            <div className="who">
              <b>{profile.displayName || 'You'}</b>
              <span className="mono muted">{profile.friendId}</span>
            </div>
            <button className="btn ghost sq" onClick={() => signOut(auth)} aria-label="Sign out" title="Sign out">
              <Icon name="out" />
            </button>
          </div>
        </aside>
        <main>
          {settings.maintenanceBanner && <div className="banner">{settings.maintenanceBanner}</div>}
          {/* Transfer stays mounted so a live room survives tab switches */}
          <section hidden={view !== 'transfer'}>
            <Transfer />
          </section>
          <section hidden={view !== 'friends'}>
            <Friends />
          </section>
          <section hidden={view !== 'feedback'}>
            <Feedback />
          </section>
          {isAdmin && view === 'admin' && (
            <section>
              <Admin />
            </section>
          )}
        </main>
      </div>
      {toastEls}
    </AppCtx.Provider>
  );
}
