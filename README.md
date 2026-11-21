# manusAI file transfer (work in progress)

**Status: foundation only. The React UI and Firebase data-access modules are NOT built yet.** See "Implemented / Not implemented".

## Implemented (and tested)

| Area | File | Notes |
| --- | --- | --- |
| Size limits | `src/lib/limits.ts` | Async Drop raw limit derived from base64 overhead (~522 KiB raw for a 700 KiB doc budget); memory-fallback caps |
| Chunk protocol | `src/lib/protocol.ts` | 16-byte header (magic, version, type, transferId, seq, length), 64 KiB chunks, sequence validation, resume point = last in-order ack |
| Streaming SHA-256 | `src/lib/sha256.ts` | Incremental, verified against `node:crypto`; file hashed in 1 MiB slices |
| Validation | `src/lib/validation.ts` | Room codes, Friend IDs (unbiased RNG), feedback, sanitising, 2 h expiry, admin helper (UI hint only) |
| Firestore Rules | `firestore.rules` | Auth, ownership, participants, field validation, expiry, owner-only admin. **Not yet run in the emulator** |
| Worker | `worker/src/index.ts` | Origin allowlist, method/size/shape checks, server-side Turnstile, `Unknown` without a provider, `503` alert logging without a sink |
| PWA | `public/sw.js`, `manifest.webmanifest` | App-shell cache only; cross-origin traffic is never intercepted |

Run tests (no install needed, Node 22.6+): `npm test`

## Not implemented yet

- React/Vite UI (Transfer, Friends, Feedback, Admin views) and the named UI functions (`navigate`, `setTransferMode`, ...)
- Firebase init and data-access modules (`signInWithGoogle`, `sendFriendRequest`, `createTransferRoom`, ...)
- WebRTC wiring (backpressure loop, DataChannel handlers, `showSaveFilePicker` streaming), QR generation/scanning
- Firestore emulator rule tests; lint, formatter, `tsc`, and production build (no registry access was available when this was written, so none of these have been run)
- Persisting Worker alerts into Firestore: the Worker posts to an optional `ALERT_SINK_URL`; connecting that to Firestore needs a service-account flow you must design. Until then `securityAlerts` stays empty and `/alert` returns 503.

## Conflicts with the original notes, and what was chosen

- **Turnstile cannot gate Firestore writes.** Rules cannot verify a Turnstile token. The Worker is the authoritative verifier for `/check-file` and `/alert`; client-side Turnstile only slows casual bots. A user with a valid Firebase login can still call Firestore directly, so rules enforce size, shape, ownership and expiry.
- **Turnstile secret** lives only in Worker secrets, never in Firestore (`config/appSettings` holds public, non-secret settings).
- **700 KB Async Drop**: base64 adds ~33%, so the raw cap is lower than 700 KiB. The UI must show the computed limit from `maxAsyncRawBytes()`.
- **2-hour expiry** is enforced in rules on read/write (`expiresAt > request.time`). Firestore TTL deletion is optional, not instant, and must be enabled per collection in the console (`expiresAt` field on `rooms`, `messages`, `drops`). Cleanup on room close is done client-side by the host and is best-effort.
- **6-digit room codes are guessable.** They gate signaling only; no file data passes through Firestore. Treat them as short-lived pairing hints, not secrets.
- **Hash and extension checks are advisory.** `Unknown` is returned when no provider is configured; `Safe` only ever means "not known bad".
- **TURN**: none configured. Some networks block direct P2P; a TURN relay is needed there and may cost money.
- **Offline mode** needs manual/QR exchange and a compatible local network path (client isolation on guest Wi-Fi often blocks it). SDP may exceed QR capacity, so copy/paste is required as a fallback. Firebase, Google sign-in, Turnstile and the Worker do not work offline; only the cached app shell does.

## Setup steps (when the UI exists)

1. **Firebase**: create a project (Spark), enable Google sign-in, create Firestore, add your Render domain under Authentication > Settings > Authorized domains.
2. **Rules**: set the owner UID in `firestore.rules` (`ownerUid()`) and `VITE_OWNER_UID`, then `firebase deploy --only firestore:rules`. Do not invent a UID; copy yours from Authentication > Users after first sign-in.
3. **Cloudflare**: create a Turnstile widget (site key to `VITE_TURNSTILE_SITE_KEY`). In `worker/`: edit `ALLOWED_ORIGINS` in `wrangler.toml`, run `wrangler secret put TURNSTILE_SECRET`, then `wrangler deploy`.
4. **Render**: static site, build `npm run build`, publish `dist`, add a rewrite `/* -> /index.html`, set the `VITE_*` variables from `.env.example`.
5. **TTL (optional)**: Firebase console > Firestore > TTL policies on `expiresAt`.

## Troubleshooting

- `Missing or insufficient permissions`: check `ownerUid()`, room expiry, and that both peers are signed in.
- Worker returns 403: the page origin is missing from `ALLOWED_ORIGINS`, or the Turnstile token failed.
- Tests fail to start: you need Node 22.6+ (type stripping).
