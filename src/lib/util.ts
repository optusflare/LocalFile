import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export const OWNER_UID = '07VQ16WbbHT825pQZ4ZaXjzaYdn2'; // UI gate only. Firestore rules are the real lock.
export const FALLBACK_SITE_KEY = '0x4AAAAAAGL3lCH8dFDh1S08'; // public Turnstile site key
export const MAX_DROP_BYTES = 534528;
export const MAX_P2P_BYTES = 256 * 1024 * 1024;
export const FID_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars = [A-HJ-NP-Z2-9]

export function randomFriendId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => ALPHA[x % 32]).join('');
}
export function randomRoomCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 1000000).padStart(6, '0');
}
export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}
export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(1) + ' MiB';
}
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase().slice(0, 12);
}
/** Checks every dot-segment so "setup.exe.txt" and "a.tar.exe" are both caught. */
export function isBlocked(name: string, list: string[]): boolean {
  return name.toLowerCase().split('.').slice(1).some((seg) => list.includes(seg));
}
export function cleanExt(v: string): string {
  return v.toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '').slice(0, 12);
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Names of people you looked up or added. users/{uid} is owner-read only, so we remember what we saw.
const NK = 'aydrop.names';
function readNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NK) || '{}');
  } catch {
    return {};
  }
}
export function rememberUser(uid: string, label: string) {
  try {
    localStorage.setItem(NK, JSON.stringify({ ...readNames(), [uid]: label }));
  } catch {
    /* storage blocked: fall back to short uid */
  }
}
export function labelOf(uid: string): string {
  return readNames()[uid] || 'User ' + uid.slice(0, 6);
}

export async function logTransfer(
  uid: string,
  mode: 'p2p' | 'async' | 'local',
  size: number,
  ext: string,
  integrity: 'verified' | 'mismatch' | 'unchecked'
) {
  try {
    await addDoc(collection(db, 'transfers'), {
      uid,
      mode,
      size: Math.max(0, Math.floor(size)),
      ext: ext.slice(0, 12),
      integrity,
      createdAt: serverTimestamp(),
    });
  } catch {
    /* metadata logging must never break a transfer */
  }
}
