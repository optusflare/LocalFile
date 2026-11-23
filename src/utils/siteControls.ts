import { useSyncExternalStore } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';

/** Admin-controlled switches and limits, stored in config/siteControls (public read, owner write). */
export interface Controls {
  roomsEnabled: boolean;
  dropsEnabled: boolean;
  offlineEnabled: boolean;
  autoZipFolders: boolean;
  maxDropKiB: number; // 1..522 (the Firestore rule caps a drop at 534528 bytes)
  maxRoomFileMiB: number; // 1..8192
  dropTtlHours: number; // 1..23
}
export const DEFAULT_CONTROLS: Controls = {
  roomsEnabled: true,
  dropsEnabled: true,
  offlineEnabled: true,
  autoZipFolders: true,
  maxDropKiB: 522,
  maxRoomFileMiB: 8192,
  dropTtlHours: 23,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
export function sanitizeControls(d: any = {}): Controls {
  return {
    roomsEnabled: d.roomsEnabled !== false,
    dropsEnabled: d.dropsEnabled !== false,
    offlineEnabled: d.offlineEnabled !== false,
    autoZipFolders: d.autoZipFolders !== false,
    maxDropKiB: clamp(d.maxDropKiB, 1, 522, 522),
    maxRoomFileMiB: clamp(d.maxRoomFileMiB, 1, 8192, 8192),
    dropTtlHours: clamp(d.dropTtlHours, 1, 23, 23),
  };
}

// The last known controls are cached locally, so the offline PWA still honours them.
const LS = 'aydrop.controls';
let current: Controls = (() => {
  try {
    return sanitizeControls(JSON.parse(localStorage.getItem(LS) || '{}'));
  } catch {
    return DEFAULT_CONTROLS;
  }
})();
const subs = new Set<() => void>();
let stop: (() => void) | null = null;

function start() {
  stop = onSnapshot(
    doc(db, 'config', 'siteControls'),
    (s) => {
      current = sanitizeControls(s.data());
      try {
        localStorage.setItem(LS, JSON.stringify(current));
      } catch {
        /* storage blocked */
      }
      subs.forEach((f) => f());
    },
    () => {} // doc missing / rule not deployed / offline: keep the last known values
  );
}
function subscribe(cb: () => void) {
  subs.add(cb);
  if (!stop) start();
  return () => {
    subs.delete(cb);
    if (!subs.size && stop) {
      stop();
      stop = null;
    }
  };
}

export function useControls(): Controls {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_CONTROLS);
}
/** Non-React read (no subscription): last value seen online, or the cached one. */
export const getControls = () => current;
