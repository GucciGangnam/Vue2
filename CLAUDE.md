# Working agreement

Read this before making changes.

## What this is

A privacy-first "watch together" app. Users upload videos that are **encrypted in the
browser** before upload, invite friends into a room, and watch in lockstep — one person
pauses, it pauses for everyone. The server stores only ciphertext.

## Planning docs live outside this repo

Detailed architecture, the cryptography spec, schema intent, the phase plan, and the
handover notes are in **`docs/`**, which is **gitignored on purpose** (this repo is
public). They exist on the developer's machine only.

**If you are starting a session: read `docs/HANDOVER.md` first**, then `ARCHITECTURE.md`,
`CRYPTO.md`, `SCHEMA.md`, `PHASES.md`, `DECISIONS.md`. If `docs/` is missing, stop and ask
— do not guess at the crypto design or invent schema.

## Hard rules

1. **No direct SQL against the database.** Every schema change is a tracked file in
   `supabase/migrations/`, applied with `supabase db push`. The database must be
   rebuildable from an empty project using only this repo. Do not use the Supabase MCP
   `execute_sql` or `apply_migration` tools for DDL — read-only MCP calls are fine.
2. **RLS on every table.** Policies ship in the same migration as the table they protect.
   Run the security advisors after each migration.
3. **Plaintext key material never crosses the network boundary.** No key in any `.from()`,
   `.rpc()` or `.storage` argument. If you are about to send something derived from a
   password or a content key, stop.
4. **The `service_role` key never appears in client code or in `.env`.**
5. **`npm run verify` must be green before any commit.**
6. **Never `git add -f docs/`.**

## Commands

```bash
npm run dev        # dev server
npm run verify     # lint + typecheck + test  (gate before committing)
npm run test       # vitest
npm run db:push    # apply migrations
npm run db:types   # regenerate src/lib/database.types.ts
```

## Conventions

- TypeScript strict. Path alias `@/` → `src/`.
- Prettier: no semicolons, single quotes, 100 columns, trailing commas.
- Tailwind v4 — **no JS config file**. Design tokens are `@theme` in `src/index.css`.
  Surfaces use `ink-*`, the amber accent uses `lamp-*`.
- Mobile-first. Test touch targets at 375px wide before desktop.
- Crypto and sync logic stay framework-agnostic in `src/lib/` so they remain portable.

## Phase discipline

Work is delivered one phase at a time (see `docs/PHASES.md`). At the end of each phase:
update `docs/PHASES.md` checkboxes, rewrite `docs/HANDOVER.md` for the next session,
run `npm run verify`, and push. Do not start the next phase in the same session.
