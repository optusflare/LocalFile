/**
 * Serverless pairing for two devices on the same Wi-Fi / hotspot.
 * No STUN/TURN, so ICE uses local ("host") candidates only. The WebRTC SDP is boiled down to the few fields
 * ICE and DTLS actually need and rebuilt on the other side, which keeps the code ~200 chars and QR-friendly:
 *   AYD1|<o|a|p>|<ice-ufrag>|<ice-pwd>|<sha256 fingerprint, 64 hex>|<ip~port,ip~port,...>
 *   o = offer (setup:actpass), a = answer (active), p = answer (passive)
 */
export const ICE_CONFIG: RTCConfiguration = { iceServers: [] };

export function gather(pc: RTCPeerConnection, ms = 3500): Promise<void> {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCand);
      res();
    };
    const onState = () => pc.iceGatheringState === 'complete' && done();
    const onCand = (e: RTCPeerConnectionIceEvent) => !e.candidate && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
}

export function packSdp(sdp: string): string {
  const one = (re: RegExp) => (sdp.match(re) || [])[1] || '';
  const ufrag = one(/a=ice-ufrag:(\S+)/);
  const pwd = one(/a=ice-pwd:(\S+)/);
  const fp = one(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/).replace(/:/g, '').toLowerCase();
  const setup = one(/a=setup:(\w+)/);
  const kind = setup === 'actpass' ? 'o' : setup === 'passive' ? 'p' : 'a';
  const cands: string[] = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi)) {
    if (/^fe80:/i.test(m[1])) continue; // link-local needs a scope id: useless to the peer
    cands.push(m[1] + '~' + m[2]);
  }
  cands.sort((a, b) => Number(a.split('~')[0].includes(':')) - Number(b.split('~')[0].includes(':'))); // IPv4 / mDNS first
  if (!ufrag || !pwd || fp.length !== 64 || !cands.length) {
    throw new Error('No local network found. Connect both devices to the same Wi-Fi or hotspot, then try again.');
  }
  return ['AYD1', kind, ufrag, pwd, fp, cands.slice(0, 4).join(',')].join('|');
}

/** Normalises whitespace/line-wraps from a paste or scan; null when it is not an AyDrop code. */
export function parseCode(text: string): string | null {
  const c = text.replace(/\s+/g, '');
  return /^AYD1\|[oap]\|[^|]+\|[^|]+\|[0-9a-f]{64}\|[^|]+$/i.test(c) ? c : null;
}

export function unpackSdp(code: string): { sdp: string; kind: 'o' | 'a' | 'p' } {
  const c = parseCode(code);
  if (!c) throw new Error('That is not an AyDrop pairing code.');
  const [, kind, ufrag, pwd, fp, cs] = c.split('|');
  const setup = kind === 'o' ? 'actpass' : kind === 'p' ? 'passive' : 'active';
  const fpColon = fp.toUpperCase().match(/.{2}/g)!.join(':');
  const lines = [
    'v=0',
    'o=- ' + Math.floor(Math.random() * 1e15) + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:' + ufrag,
    'a=ice-pwd:' + pwd,
    'a=fingerprint:sha-256 ' + fpColon,
    'a=setup:' + setup,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ...cs.split(',').filter(Boolean).map((x, i) => {
      const [ip, port] = x.split('~');
      return `a=candidate:${i + 1} 1 udp ${2113937151 - i * 256} ${ip} ${port} typ host generation 0`;
    }),
    'a=end-of-candidates',
  ];
  return { sdp: lines.join('\r\n') + '\r\n', kind: kind as 'o' | 'a' | 'p' };
}
