import { useEffect, useRef } from 'react';
import { useTransferActive } from '../utils/activity';

const GAP = 28;

/** Drifting dot-matrix with two "peers" emitting slow signal rings and a pulse travelling between them.
 *  30 fps cap, DPR capped at 1.5, one fillStyle. The loop stops for: reduced motion, hidden tab,
 *  off-screen, and any active transfer (the static frame stays). */
export default function AmbientBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  const busy = useTransferActive();

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0, h = 0, raf = 0, last = 0, onScreen = true;
    const ptr = { x: -999, y: -999, tx: -999, ty: -999 };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const ax = w * 0.2 + Math.sin(t / 9000) * w * 0.03, ay = h * 0.4 + Math.cos(t / 7000) * h * 0.04;
      const bx = w * 0.8 + Math.cos(t / 8000) * w * 0.03, by = h * 0.6 + Math.sin(t / 6500) * h * 0.04;
      const ph = t / 1500;
      ctx.fillStyle = '#ECECEC';
      for (let y = GAP / 2; y < h; y += GAP) {
        for (let x = GAP / 2; x < w; x += GAP) {
          const da = Math.hypot(x - ax, y - ay), db = Math.hypot(x - bx, y - by);
          const wave = Math.max(0, Math.sin(da / 48 - ph)) * Math.exp(-da / 380) + Math.max(0, Math.sin(db / 48 - ph + 2)) * Math.exp(-db / 380);
          let a = 0.07 + wave * 0.5, ox = 0, oy = 0;
          const s = 1 + wave * 1.1;
          const pd = Math.hypot(x - ptr.x, y - ptr.y);
          if (pd < 130) {
            const k = 1 - pd / 130;
            a += k * 0.3;
            ox = ((x - ptr.x) / (pd || 1)) * k * 7;
            oy = ((y - ptr.y) / (pd || 1)) * k * 7;
          }
          ctx.globalAlpha = Math.min(a, 0.85);
          ctx.fillRect(x + ox - s / 2, y + oy - s / 2, s, s);
        }
      }
      ctx.strokeStyle = '#ECECEC';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const k = (t / 3200) % 1;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(ax + (bx - ax) * k - 2, ay + (by - ay) * k - 2, 4, 4);
      ctx.globalAlpha = 0.5;
      for (const [px, py] of [[ax, ay], [bx, by]]) {
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const canRun = () => !busy && !mq.matches && !document.hidden && onScreen;
    const loop = (t: number) => {
      raf = 0;
      if (!canRun()) return;
      if (t - last >= 33) {
        last = t;
        ptr.x += (ptr.tx - ptr.x) * 0.12;
        ptr.y += (ptr.ty - ptr.y) * 0.12;
        draw(t);
      }
      raf = requestAnimationFrame(loop);
    };
    const sync = () => {
      if (canRun()) {
        if (!raf) raf = requestAnimationFrame(loop);
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        draw(performance.now()); // leave one calm static frame instead of a blank canvas
      }
    };
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const r = cv.getBoundingClientRect();
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    };
    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      ptr.tx = e.clientX - r.left;
      ptr.ty = e.clientY - r.top;
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') ptr.tx = ptr.ty = -999;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const io = new IntersectionObserver(([en]) => {
      onScreen = en.isIntersecting;
      sync();
    });
    io.observe(cv);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    document.addEventListener('visibilitychange', sync);
    mq.addEventListener('change', sync);
    resize();
    sync();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.removeEventListener('visibilitychange', sync);
      mq.removeEventListener('change', sync);
    };
  }, [busy]);

  return <canvas ref={ref} className="ambient" aria-hidden="true" />;
}
