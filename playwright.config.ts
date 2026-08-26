import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end coverage of the one path that has to work.
 *
 * Deliberately kept out of `npm run verify`. These tests sign in to the real
 * Supabase project -- there is no local stack (D11) -- so they need `.env`, a
 * network, and about a minute. `verify` is the gate before every commit and
 * has to stay fast and offline. Run these with `npm run test:e2e`.
 *
 * They are as close to read-only as the app allows: no upload, no invitation,
 * no friend requests, because writes mutate the same production project the
 * developer tests on by hand.
 *
 * The one exception is unavoidable and is bounded. Since Phase 9 a video *is*
 * its session, so opening one as its owner gets or creates its room. That used
 * to be the thing this suite avoided -- creation is limited to ten an hour
 * (D35) and one per run would eventually fail on its own success -- but
 * `rooms(media_id)` is unique now, so the first run creates a single row and
 * every run after it reuses that row.
 *
 * The build is served rather than the dev server, because the service worker
 * is a different artefact in each: dev serves a one-line shim that Vite
 * transforms, the build emits a real module worker at the root. The worker is
 * the riskiest thing in the app, so the tests should exercise the one that
 * ships.
 */
/**
 * Point the suite at a deployed origin with `PLAYWRIGHT_TEST_BASE_URL`:
 *
 *   PLAYWRIGHT_TEST_BASE_URL=https://vue2-amber.vercel.app npm run test:e2e
 *
 * That is the fastest honest answer to "did the deploy work", because it
 * checks the things a host gets wrong -- /sw.js served as JavaScript from the
 * root, deep links surviving a refresh, the CSP actually being sent -- against
 * the origin itself rather than against a local imitation of it. No local
 * server is started in that mode.
 */
const deployedTarget = process.env.PLAYWRIGHT_TEST_BASE_URL

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: deployedTarget ?? 'http://localhost:4173',
    trace: 'on-first-retry',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(deployedTarget
    ? {}
    : {
        webServer: {
          command: 'npm run build && npm run preview -- --port 4173 --strictPort',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
})
