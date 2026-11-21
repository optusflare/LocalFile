import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';
import Icon from './Icon';
import { FID_RE } from '../lib/util';

export const roomLink = (code: string) => `${window.location.origin}/?room=${code}`;
export const friendLink = (id: string) => `${window.location.origin}/?friend=${id}`;

function param(text: string, key: string): string {
  try {
    return new URL(text.trim()).searchParams.get(key) || '';
  } catch {
    return '';
  }
}
/** Accepts a raw 6-digit code or an AyDrop room link. */
export function parseRoomCode(text: string): string | null {
  const raw = text.trim().replace(/\s/g, '');
  const c = /^\d{6}$/.test(raw) ? raw : param(text, 'room');
  return /^\d{6}$/.test(c) ? c : null;
}
/** Accepts a raw 8-character friend ID or an AyDrop friend link. */
export function parseFriendId(text: string): string | null {
  const raw = text.trim().toUpperCase();
  const c = FID_RE.test(raw) ? raw : param(text, 'friend').toUpperCase();
  return FID_RE.test(c) ? c : null;
}

export function QRBox({ value, label, size = 176 }: { value: string; label?: string; size?: number }) {
  return (
    <figure className="qr">
      <div className="qr-img">
        <QRCodeSVG value={value} size={size} level="M" bgColor="#FFFFFF" fgColor="#0A0A0A" />
      </div>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}

interface ScanProps {
  title: string;
  hint: string;
  placeholder: string;
  parse: (text: string) => string | null;
  onResult: (value: string) => void;
  onClose: () => void;
}

/** Camera QR scanner with a manual code fallback. Needs HTTPS (Vercel is). */
export function ScanDialog({ title, hint, placeholder, parse, onResult, onClose }: ScanProps) {
  const [camErr, setCamErr] = useState(false);
  const [msg, setMsg] = useState('');
  const [manual, setManual] = useState('');
  const cb = useRef({ parse, onResult, onClose });
  cb.current = { parse, onResult, onClose };
  const done = useRef(false);

  function finish(v: string) {
    if (done.current) return;
    done.current = true;
    cb.current.onResult(v);
    cb.current.onClose();
  }

  useEffect(() => {
    const sc = new Html5Qrcode('aydrop-qr-reader');
    let started = false;
    let dead = false;
    sc.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (text) => {
        const v = cb.current.parse(text);
        if (v) finish(v);
      },
      () => {}
    )
      .then(() => {
        if (dead) sc.stop().then(() => sc.clear()).catch(() => {});
        else started = true;
      })
      .catch(() => {
        setCamErr(true);
        setMsg('Camera not available. Allow camera access, or type the code below.');
      });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cb.current.onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      dead = true;
      window.removeEventListener('keydown', onKey);
      if (started) sc.stop().then(() => sc.clear()).catch(() => {});
    };
  }, []);

  function submit() {
    const v = parse(manual);
    if (v) finish(v);
    else setMsg('That does not look like a valid code.');
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ph">
          <h2>{title}</h2>
          <button className="btn ghost sq" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div id="aydrop-qr-reader" className={'scan-view' + (camErr ? ' off' : '')} />
        <p className={'small ' + (msg ? 'err' : 'muted')}>{msg || hint}</p>
        <div className="row">
          <input className="mono" aria-label="Enter code manually" placeholder={placeholder} value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <button className="btn" onClick={submit}>
            Use code
          </button>
        </div>
      </div>
    </div>
  );
}
