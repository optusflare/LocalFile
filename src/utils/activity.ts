import { useSyncExternalStore } from 'react';

/** Tiny global flag: true while any transfer is hashing/streaming/verifying. Animations and the speed test subscribe. */
let active = false;
const subs = new Set<() => void>();

export function setTransferActive(v: boolean) {
  if (v === active) return;
  active = v;
  subs.forEach((f) => f());
}
export function useTransferActive(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => active,
    () => false
  );
}

/** Transfer ids that belong to the live room (open or finished-but-unsaved). Cache cleaners must never touch these. */
let provider: () => Set<string> = () => new Set();
export function registerProtected(fn: (() => Set<string>) | null) {
  provider = fn || (() => new Set());
}
export function getProtectedTids(): Set<string> {
  return provider();
}
