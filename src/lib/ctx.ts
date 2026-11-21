import { createContext, useContext } from 'react';
import type { User } from 'firebase/auth';
import type { Timestamp } from 'firebase/firestore';

export interface Settings {
  workerUrl: string;
  turnstileSiteKey: string;
  maintenanceBanner: string;
  blockedExtensions: string[];
  updatedAt: Timestamp | null;
}
export const DEFAULT_SETTINGS: Settings = {
  workerUrl: '',
  turnstileSiteKey: '',
  maintenanceBanner: '',
  blockedExtensions: [],
  updatedAt: null,
};
export interface Profile {
  friendId: string;
  displayName: string;
}
export interface Ctx {
  user: User;
  profile: Profile;
  settings: Settings;
  isAdmin: boolean;
  /** true for anonymous guest sessions: transfers only, no chat/friends/feedback */
  isGuest: boolean;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
  /** Upgrades a guest to a Google account (keeps the same uid), or signs in normally */
  signInGoogle: () => void;
}
export const AppCtx = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppCtx missing');
  return c;
}
