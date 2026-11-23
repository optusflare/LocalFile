import { useSyncExternalStore } from 'react';

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const mq = window.matchMedia('(display-mode: standalone)');
const isStandalone = () => mq.matches || (navigator as any).standalone === true;
const ua = navigator.userAgent;
const IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID = /Android/i.test(ua);
const FIREFOX = /Firefox\//.test(ua);

export interface PwaState {
  installed: boolean;
  canPrompt: boolean;
  ios: boolean;
  android: boolean;
  firefoxDesktop: boolean;
  swActive: boolean;
  offlineReady: boolean;
}

let deferred: InstallEvent | null = null;
let state: PwaState = {
  installed: isStandalone(),
  canPrompt: false,
  ios: IOS,
  android: ANDROID,
  firefoxDesktop: FIREFOX && !ANDROID && !IOS,
  swActive: false,
  offlineReady: false,
};
const subs = new Set<() => void>();
function set(p: Partial<PwaState>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own button instead of the mini-infobar
  deferred = e as InstallEvent;
  set({ canPrompt: true });
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  set({ installed: true, canPrompt: false });
});
mq.addEventListener?.('change', () => set({ installed: isStandalone() }));

/** Is the service worker active and has it precached the app shell? */
export async function refreshOfflineStatus() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const keys = await caches.keys();
    set({ swActive: !!reg?.active, offlineReady: !!reg?.active && keys.some((k) => k.includes('precache')) });
  } catch {
    /* insecure context or storage blocked */
  }
}
void refreshOfflineStatus();
navigator.serviceWorker?.ready.then(() => setTimeout(refreshOfflineStatus, 1500)).catch(() => {});
navigator.serviceWorker?.addEventListener('controllerchange', () => void refreshOfflineStatus());

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null; // the event is single-use
  await e.prompt();
  const { outcome } = await e.userChoice;
  set({ canPrompt: false, installed: outcome === 'accepted' ? true : state.installed });
  return outcome;
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => state,
    () => state
  );
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true
  );
}
