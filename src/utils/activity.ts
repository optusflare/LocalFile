import { useSyncExternalStore } from 'react';

/** True while any source (room, offline pairing...) is moving a transfer. Sources are counted separately so they can't cancel each other. */
const sources = new Set<string>();
let active = false;
const subs = new Set<() => void>();

export function setTransferActive(v: boolean, source = 'room') {
  if (v) sources.add(source);
  else sources.delete(source);
  const next = sources.size > 0;
  if (next === active) return;
  active = next;
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

/** Transfer ids that belong to live sessions (open or finished-but-unsaved). Cache cleaners must never touch these. */
const providers = new Map<string, () => Set<string>>();
export function addProtected(key: string, fn: (() => Set<string>) | null) {
  if (fn) providers.set(key, fn);
  else providers.delete(key);
}
export const registerProtected = (fn: (() => Set<string>) | null) => addProtected('room', fn);
export function getProtectedTids(): Set<string> {
  const out = new Set<string>();
  providers.forEach((f) => f().forEach((t) => out.add(t)));
  return out;
}
