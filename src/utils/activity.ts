import { useSyncExternalStore } from 'react';

/** Tiny global flag: true while any transfer is hashing/streaming/verifying. Animations subscribe and stand down. */
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
