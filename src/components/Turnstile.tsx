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
  const box = useRef<HTMLDivElement>(null);
  const wid = useRef<string | null>(null);
  const token = useRef('');
  const [ready, setReady] = useState(false);
  const key = siteKeyFor(settings);

  useEffect(() => {
    let dead = false;
    loadScript()
      .then(() => {
        if (dead || !box.current || !window.turnstile) return;
        wid.current = window.turnstile.render(box.current, {
          sitekey: key,
          theme: 'dark',
          callback: (t: string) => {
            token.current = t;
            setReady(true);
          },
          'expired-callback': () => {
            token.current = '';
            setReady(false);
          },
          'error-callback': () => setReady(false),
        });
      })
      .catch(() => {});
    return () => {
      dead = true;
      if (wid.current && window.turnstile) window.turnstile.remove(wid.current);
      wid.current = null;
    };
  }, [key]);

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
      if (wid.current && window.turnstile) window.turnstile.reset(wid.current);
    }
  }, [settings.workerUrl]);

  const widget = (
    <div className="human">
      <div ref={box} />
      <span className={ready ? 'ok' : 'muted'}>{ready ? 'Check passed' : 'Complete the check to continue'}</span>
    </div>
  );
  return { widget, verify, ready };
}
