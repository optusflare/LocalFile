# AyDrop

Fast, direct peer-to-peer file and snippet sharing in the browser—built to move big files without hitting cloud storage walls, sketchy file-sharing sites, or memory crashes.

## What Makes It Different
- **Direct P2P Transfers:** Files move browser-to-browser over WebRTC instead of sitting on a middleman server.
- **Built for Big Files:** Uses a custom 64 KiB chunk protocol with sequence checks, resume support from the last acknowledged chunk, and 1 MiB streaming SHA-256 hash checks.
- **Size & Storage Smarts:** Handles Async Drops with base64 overhead accounted for (`maxAsyncRawBytes()`), plus memory-safe limits when streaming isn't available.
- **No-Internet / Offline PWA Option:** The app shell caches for offline launch, and local/QR WebRTC pairing makes zero-internet local network transfers possible when both devices share a compatible local connection (with copy/paste fallback if a QR code gets too dense).
- **Security Checks via Worker:** Turnstile verification, origin checks, and file/alert checks run through the Cloudflare Worker rather than trusting raw client calls.

## Where Things Stand
Right now the core building blocks are in place, while the full interactive experience is still coming together:
- **Already wired up:** Size/limit helpers (`src/lib/limits.ts`), chunk protocol (`src/lib/protocol.ts`), streaming SHA-256 (`src/lib/sha256.ts`), input/room/friend validation (`src/lib/validation.ts`), Firestore rules (`firestore.rules`), Cloudflare Worker (`worker/src/index.ts`), and PWA shell files (`public/sw.js`, `manifest.webmanifest`).
- **Still in progress:** Full UI screens (`Transfer`, `Friends`, `Feedback`, `Admin`), Firebase auth/data helpers, live WebRTC DataChannel/file-saving wiring, QR scan/generate UI, and full emulator/build verification.

Run existing unit tests anytime (Node 22.6+):
```bash
npm test
