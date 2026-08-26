# Vue2

A private screening room.

Upload a video — it is encrypted in your browser before it leaves your device. Invite
friends into a room and watch together in lockstep: when one person pauses, it pauses for
everyone, like sharing a sofa in front of the same TV.

## How the privacy works

- Videos are encrypted client-side with **AES-256-GCM** in 1 MiB chunks before upload.
- Each video has its own random content key, shared with viewers using **ECDH P-256**
  key agreement with ephemeral keys (ECIES).
- Your identity key is wrapped with a key derived from your password via **Argon2id**, so
  it syncs between your devices without the server ever seeing it.
- Titles and thumbnails are encrypted too.

The server stores ciphertext and nothing else.

**An honest caveat:** this is a web app, so the server also delivers the JavaScript that
does the encrypting. A compromised host could ship code that leaks keys — this is true of
all browser-based end-to-end encryption, and is why apps like Signal ship signed native
binaries. This repository is public so the code can be checked.

## Features

- End-to-end encrypted video upload and streaming
- Synchronised playback with sub-second drift correction
- Friend codes and invite-only rooms
- Room owner master controls
- Hold-to-unlock player, so a stray tap never pauses the film

Planned, not yet built: drawing on the screen while watching, with strokes that fade after
a moment.

## Development

```bash
npm install
cp .env.example .env    # fill in your Supabase publishable key
npm run dev
```

Requires Node 20+. Schema lives in `supabase/migrations/` and is applied with
`npm run db:push`.

## Deploying

The app is a static build (`npm run build` → `dist/`) plus a Supabase project. `vercel.json`
carries the host configuration; the same three rules apply to any static host.

**Environment variables**, set on the host and baked in at build time:

| Variable                    | Notes                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `VITE_SUPABASE_URL`         | e.g. `https://<ref>.supabase.co`                             |
| `VITE_SUPABASE_ANON_KEY`    | the publishable key                                          |
| `VITE_MAX_CIPHERTEXT_BYTES` | optional; defaults to 50 MiB, the free plan's per-object cap |

The `service_role` key is never used by this app and must never be set here.

**Three things the host has to get right.** Each fails quietly rather than loudly:

1. **`/sw.js` must be served from the origin root, untouched.** A service worker cannot
   claim a scope broader than its own path, so the build emits the worker as a second
   Rollup entry at the root specifically to let it intercept `/__stream/`. A catch-all SPA
   rewrite that swallows `/sw.js` does not error — registration "succeeds" against an HTML
   document, the capability probe fails, and every browser silently downgrades to the slower
   staged-decrypt path. Vercel checks the filesystem before applying rewrites, so the real
   file wins; the rewrite in `vercel.json` also excludes it explicitly. After any deploy,
   confirm with `curl -I https://<origin>/sw.js` and check for a JavaScript content type.
2. **SPA routing.** `/room/:id` and `/watch/:id` must serve `index.html`, or a refresh 404s.
3. **CSP.** `connect-src` needs the Supabase REST origin and its realtime websocket
   (`wss://`), `worker-src 'self'` for the stream worker, and `media-src 'self' blob:` for
   the staged path's object URLs. `script-src` also needs **`'wasm-unsafe-eval'`**: Argon2id
   runs as WebAssembly, and a bare `script-src 'self'` blocks it outright — the vault then
   never unlocks, and because the failure happens inside the key-derivation worker, nothing
   reaches the page console. `'wasm-unsafe-eval'` permits WebAssembly without permitting
   `eval()` of JavaScript, so no third-party script can run on the player route.

`src/deploy.test.ts` asserts all of the above against `vercel.json` so an edit cannot
quietly widen the rewrite or drop a directive.

**Supabase Auth** needs the deployed origin added to its Site URL and redirect allow-list,
or sign-in from the deployed app fails in a way that looks like an application bug.

## Stack

React 19 · TypeScript · Vite · Tailwind v4 · Supabase (Postgres, Storage, Realtime)
