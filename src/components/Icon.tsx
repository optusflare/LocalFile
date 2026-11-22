const P: Record<string, string> = {
  drop: 'M12 4v10m0 0l-4-4m4 4l4-4M4 19h16',
  room: 'M9 12h6M6 9a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100 6 3 3 0 000-6z',
  friends: 'M16 19v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3 3 0 100-6 3 3 0 000 6zM20 19v-1a3 3 0 00-2-2.8M15 5.2a3 3 0 010 5.6',
  feedback: 'M4 5h16v11H9l-5 4z',
  admin: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  check: 'M5 12l5 5 9-9',
  x: 'M6 6l12 12M18 6L6 18',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  send: 'M4 12l16-8-6 16-3-7z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  tools: 'M4 16a8 8 0 1116 0M12 16l4-5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeoff: 'M3 3l18 18M10.6 6.1A9.7 9.7 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.9M6.1 7.7A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004-.9',
  stop: 'M7 7h10v10H7z',
  play: 'M8 5l11 7-11 7z',
};
export default function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || ''} />
    </svg>
  );
}
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#ECECEC" />
      <g fill="none" stroke="#0A0A0A" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 7v12" />
        <path d="M10.5 14l5.5 5.5 5.5-5.5" />
        <path d="M8 24.5h16" />
      </g>
    </svg>
  );
}
