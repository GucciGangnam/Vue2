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
- Draw on the screen while watching — strokes fade after a moment

## Development

```bash
npm install
cp .env.example .env    # fill in your Supabase publishable key
npm run dev
```

Requires Node 20+. Schema lives in `supabase/migrations/` and is applied with
`npm run db:push`.

## Stack

React 19 · TypeScript · Vite · Tailwind v4 · Supabase (Postgres, Storage, Realtime)
