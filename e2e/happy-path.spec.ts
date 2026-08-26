import { expect, test, type Page } from '@playwright/test'

/**
 * The happy path, against the production build and the real project.
 *
 * Nearly read-only: it signs in, unlocks, reads the library and plays a video.
 * It still never uploads, invites, or sends a friend request, because those
 * write to the same project the developer uses by hand.
 *
 * **One write is now unavoidable and is fine.** Since Phase 9 a video *is* its
 * session, so the owner opening one gets or creates its room. That was the
 * reason this suite avoided rooms -- creation is limited to ten an hour (D35)
 * and a suite that made one per run would eventually refuse to run at all.
 * `get_or_create_room` retires the concern: there is a unique constraint on
 * `rooms(media_id)`, so the first run of this suite creates one row for
 * `test-pattern-40s` and every run after it reuses that row.
 *
 * Grace is the account to drive: her vault password matches her auth password,
 * so signing in unlocks in one step (D16). Ada's deliberately does not.
 */

const GRACE = {
  email: 'grace.phase1@gmail.com',
  password: 'grace-phase1-password',
  displayName: 'Grace',
  friendCode: 'DNEQQPTM',
}
/** 46 MB across 46 chunks, with a burnt-in timecode. */
const TEST_PATTERN_MEDIA_ID = '21b09679-6074-41a9-b1c0-03f087877b88'
/** 20 minutes of real content. The room kept when Phase 9 collapsed the five. */
const EPISODE_ONE_MEDIA_ID = 'a26b9606-75ed-4c98-b32d-029afc83e714'
const EPISODE_ONE_ROOM_ID = '358cfa1f-216c-490c-987b-0a479c304e4c'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(GRACE.email)
  await page.getByLabel(/password/i).fill(GRACE.password)
  await page.getByRole('button', { name: /sign in/i }).click()

  // The friend code is generated server-side by the signup trigger and only
  // reaches this screen once the session, the vault and the profile read have
  // all worked. Argon2id at m=64MiB is deliberately slow, hence the long wait
  // -- and this is also exactly where a CSP that forbids WebAssembly strands
  // the app on the unlock screen.
  await expect(page.getByText(GRACE.friendCode)).toBeVisible({ timeout: 45_000 })
}

test.describe('the happy path', () => {
  test('signs in, unlocks the vault, and lists decrypted media', async ({ page }) => {
    await signIn(page)

    // Titles are ciphertext on the server, so seeing one is proof the whole
    // chain worked: session, vault unlock, key unwrap, metadata decrypt.
    await expect(page.getByText('test-pattern-40s')).toBeVisible()
    await expect(page.getByRole('heading', { name: GRACE.displayName })).toBeVisible()

    // Once, not five times. This is the symptom that started Phase 9: five
    // rooms against one video made the library look like five copies of it.
    await expect(page.getByText('Episode 1')).toHaveCount(1)
  })

  test('plays an encrypted video and seeks to the right place', async ({ page }) => {
    await signIn(page)
    await page.goto(`/watch/${TEST_PATTERN_MEDIA_ID}`)

    const video = page.locator('video')
    await expect(video).toBeVisible()

    // HAVE_ENOUGH_DATA. Whichever path this browser took -- worker or staged
    // decrypt -- the element has to end up with real, playable media.
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(3)

    expect(await video.evaluate((el: HTMLVideoElement) => el.error)).toBeNull()
    const duration = await video.evaluate((el: HTMLVideoElement) => el.duration)
    expect(duration).toBeGreaterThan(39)
    expect(duration).toBeLessThan(41)

    // Seeking is the operation that has broken before while playback looked
    // healthy: a media element aborts and re-requests when it seeks, so a
    // stream torn down between requests fails here and nowhere else.
    //
    // It is driven through the transport rather than by writing `currentTime`,
    // and that is not squeamishness. Since Phase 9 the owner opening their own
    // video is a shared session, and a shared session's drift loop pulls the
    // element back to the anchor twice a second -- so a position poked straight
    // onto the element is dragged off again within 500ms, exactly as designed.
    // Going through the scrubber moves the anchor itself, which is what a
    // person does.
    await page.getByRole('button', { name: 'Show the controls' }).click()
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    if (await pause.isVisible()) await pause.click()

    // Paused, the chrome no longer fades, so the scrubber stays reachable.
    await page.getByRole('slider', { name: 'Seek' }).fill('31')

    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.seeking), { timeout: 30_000 })
      .toBe(false)
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), {
        timeout: 30_000,
      })
      .toBeCloseTo(31, 0)
    expect(await video.evaluate((el: HTMLVideoElement) => el.error)).toBeNull()
  })

  test('registers the streaming worker from the origin root', async ({ page }) => {
    await signIn(page)

    // The worker has to be a real file at the root to claim '/' as its scope
    // (D27). A host that rewrote /sw.js to index.html would fail right here,
    // which is the whole reason this assertion exists.
    const response = await page.request.get('/sw.js')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('javascript')
    expect(await response.text()).not.toContain('<!doctype html>')

    await page.goto(`/watch/${TEST_PATTERN_MEDIA_ID}`)
    // Registration is asynchronous and the player kicks it off on mount, so
    // this has to be polled rather than read once.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration()
            return registration?.scope ?? null
          }),
        { timeout: 30_000 },
      )
      .toBe(`${new URL(page.url()).origin}/`)
  })

  test('serves a deep link on refresh rather than a 404', async ({ page }) => {
    await signIn(page)
    // A hard navigation, not client-side routing: this is what a refresh does,
    // and it is what an SPA rewrite has to get right.
    const response = await page.goto(`/watch/${EPISODE_ONE_MEDIA_ID}`)
    expect(response?.status()).toBe(200)
    await expect(page.locator('video')).toBeVisible()
  })

  test('sends an old /room link to the video it was a room for', async ({ page }) => {
    await signIn(page)
    // /room/:id was the shared-watching screen until Phase 9 folded it into
    // /watch/:mediaId. Links to it exist, so it redirects rather than 404s.
    const response = await page.goto(`/room/${EPISODE_ONE_ROOM_ID}`)
    expect(response?.status()).toBe(200)
    await expect(page).toHaveURL(new RegExp(`/watch/${EPISODE_ONE_MEDIA_ID}$`), {
      timeout: 30_000,
    })
  })

  test('never says the word "room" to the person watching', async ({ page }) => {
    await signIn(page)
    await page.goto(`/watch/${EPISODE_ONE_MEDIA_ID}`)
    await expect(page.locator('video')).toBeVisible()

    // The owner's controls are where the old /room page went, so open every
    // one of them before looking. On a desktop viewport they are all in the
    // sidebar already, which is what this runs at.
    await expect(page.getByRole('heading', { name: 'Watching' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Invite a friend' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    const words = (await page.locator('body').innerText()).match(/\broom\b/gi)
    expect(words, 'the interface should never say "room"').toBeNull()
  })

  test('permits no third-party connection', async ({ page }) => {
    await signIn(page)
    // ARCHITECTURE's honest-limit claim rests on this. Asserted against the
    // running app rather than against the config, because the header only
    // counts if it is actually served.
    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/', { mode: 'cors' })
        return 'allowed'
      } catch {
        return 'refused'
      }
    })
    expect(blocked).toBe('refused')
  })
})
