import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../lib/ctx';
import { FALLBACK_SITE_KEY } from '../lib/util';

declare global {
  interface Window {
    turnstile?: any;
  }
}

let loader: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (!loader) {
    loader = new Promise((res, rej) => {
      if (window.turnstile) return res();
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => res();
      s.onerror = () => {
        loader = null;
        rej(new Error('Turnstile failed to load'));
      };
      document.head.appendChild(s);
    });
  }
  return loader;
}

/** Order: env var, then config/appSettings, then the public fallback key. Never a secret key. */
export function siteKeyFor(s: Settings): string {
  return (import.meta.env.VITE_TURNSTILE_SITE_KEY as string) || s.turnstileSiteKey || FALLBACK_SITE_KEY;
}

export function useTurnstile(settings: Settings) {
  // The container is tracked in state (callback ref) so the widget is re-rendered
  // whenever its DOM node is re-created, instead of dying silently with the old node.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const wid = useRef<string | null>(null);
  const token = useRef('');
  const [ready, setReady] = useState(false);
  const key = siteKeyFor(settings);

  useEffect(() => {
    if (!box) return;
    let dead = false;
    token.current = '';
    setReady(false);
    loadScript()
      .then(() => {
        if (dead || !window.turnstile) return;
        wid.current = window.turnstile.render(box, {
          sitekey: key,
          theme: 'dark',
          retry: 'auto',
          'refresh-expired': 'auto',
          callback: (t: string) => {
            token.current = t;
            setReady(true);
          },
          'expired-callback': () => {
            token.current = '';
            setReady(false);
          },
          'error-callback': () => {
            token.current = '';
            setReady(false);
          },
        });
      })
      .catch(() => {});
    return () => {
      dead = true;
      token.current = '';
      setReady(false);
      if (wid.current && window.turnstile) {
        try {
          window.turnstile.remove(wid.current);
        } catch {
          /* widget already gone */
        }
      }
      wid.current = null;
    };
  }, [box, key]);

  /** Throws away the current token and asks Turnstile for a fresh one. */
  const reset = useCallback(() => {
    token.current = '';
    setReady(false);
    if (wid.current && window.turnstile) {
      try {
        window.turnstile.reset(wid.current);
      } catch {
        /* ignore */
      }
    }
  }, []);

  /** Spends the one-time token. If a Worker URL is configured, the token is POSTed there for server-side verification. */
  const verify = useCallback(async (): Promise<boolean> => {
    const t = token.current;
    if (!t) return false;
    token.current = '';
    setReady(false);
    try {
      if (settings.workerUrl) {
        const r = await fetch(settings.workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: t }),
        });
        return r.ok;
      }
      return true;
    } catch {
      return false;
    } finally {
      reset(); // tokens are single-use: always fetch the next one
    }
  }, [settings.workerUrl, reset]);

  const widget = (
    <div className="human">
      <div ref={setBox} />
      <span className={ready ? 'ok' : 'muted'}>{ready ? 'Check passed' : 'Complete the check to continue'}</span>
    </div>
  );
  return { widget, verify, reset, ready };
}
