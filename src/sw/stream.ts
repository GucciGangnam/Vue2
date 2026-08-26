/// <reference lib="webworker" />
/**
 * The range-decrypting service worker.
 *
 * A `<video src="/__stream/{mediaId}">` behaves exactly as if it were pointed
 * at a plain file: the element issues ordinary HTTP Range requests, and this
 * worker answers them with `206 Partial Content`. It maps the requested
 * plaintext range onto encrypted chunks, fetches only those chunks from
 * Supabase Storage, decrypts them, and streams the result back. Native seeking,
 * native buffering, nothing written to disk. See docs/ARCHITECTURE.md.
 *
 * Two properties this file must never give up:
 *
 *   1. **No unauthenticated bytes reach the media element.** A chunk whose GCM
 *      tag fails is a hard error that tears down the response body. There is no
 *      path here that returns partial, zero-filled or unverified data.
 *   2. **No decrypted byte is ever cached.** Stream responses carry `no-store`
 *      and nothing on the streaming path goes near the Cache API. The whole
 *      point is that the decrypted video exists only while it is being
 *      watched. The worker does keep an app-shell cache (Phase 8) so the app
 *      opens offline, and the two must never meet: `routeFor` decides
 *      `stream` before it considers any caching rule, and `routing.test.ts`
 *      pins that ordering.
 *
 * State lives in IndexedDB, not in this worker's memory. A service worker is
 * terminated and restarted at the browser's discretion; over the length of a
 * film that is a certainty.
 */

import {
  decryptChunk,
  planFetchWindows,
  planRange,
  type ChunkParams,
} from '@/lib/crypto/chunkCipher'
import { GCM_TAG_BYTES } from '@/lib/crypto/primitives'
import { getStreamRecord, type StreamRecord } from '@/lib/crypto/keyStore'
import {
  contentRange,
  parseRangeHeader,
  rangeHeader,
  unsatisfiedContentRange,
} from '@/lib/media/httpRange'
import { probeMp4Bytes } from './probeAsset'
import { isCacheable, routeFor, STREAM_PREFIX } from './routing'

declare const self: ServiceWorkerGlobalScope

export { STREAM_PREFIX }

/**
 * The app shell cache. Bumping the name is how a deploy evicts the old one --
 * see the `activate` handler.
 *
 * Note what is *not* here: any build manifest. The worker is a plain Rollup
 * entry with no precache list injected (D27), so the shell is filled in at
 * runtime, from what the app actually asks for. That means offline works from
 * the second visit rather than the first, which is the right trade for not
 * putting Workbox in the path of the decryptor.
 */
const SHELL_CACHE = 'vue2-shell-v1'
const SHELL_DOCUMENT = '/index.html'

/**
 * Reserved media id for the capability probe. The file itself is inlined so the
 * probe works before any video exists, but the probe is only answered once the
 * worker has read that id's record back out of IndexedDB and used its key --
 * because reaching the worker is not the same thing as being able to serve. See
 * docs/DECISIONS.md D31.
 */
export const PROBE_MEDIA_ID = '__probe'

/** Ciphertext chunks per upstream request. 8 MiB balances latency and memory. */
const WINDOW_CHUNKS = 8

/** How long to wait for the page to mint a fresh signed URL. */
const REFRESH_TIMEOUT_MS = 8000
const REFRESH_POLL_MS = 150

self.addEventListener('install', (event) => {
  // Take over immediately: the player screen that just registered this worker
  // is the one that needs it, and waiting for a navigation would strand it.
  void self.skipWaiting()
  // Best effort. A failed shell fetch must not fail the installation and
  // leave the origin with no decryptor at all.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(SHELL_DOCUMENT))
      .catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // A new build ships a new shell; the old one must not outlive it.
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const route = routeFor(event.request, url, self.location.origin)

  switch (route) {
    case 'stream':
      event.respondWith(serve(event.request, url))
      return
    case 'navigate':
      event.respondWith(serveShell(event.request))
      return
    case 'asset':
      event.respondWith(serveAsset(event.request))
      return
    case 'passthrough':
      return
  }
})

/**
 * Network first, shell second.
 *
 * Deliberately not cache-first: a deploy has to be able to reach the user, and
 * an app that pins itself to yesterday's build is worse than one that is slow
 * to open. The cache is the answer to "offline", not to "slow".
 */
async function serveShell(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    if (isCacheable(response)) {
      const copy = response.clone()
      void caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_DOCUMENT, copy))
    }
    return response
  } catch {
    const cached = await caches.match(SHELL_DOCUMENT)
    if (cached) return cached
    return new Response('This app is offline and has not been opened here before.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    })
  }
}

/** Cache first: these filenames contain a content hash, so a hit cannot be stale. */
async function serveAsset(request: Request): Promise<Response> {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (isCacheable(response)) {
    const copy = response.clone()
    void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
  }
  return response
}

async function serve(request: Request, url: URL): Promise<Response> {
  const mediaId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length))
  if (!mediaId) return problem(400, 'No media id')

  if (mediaId === PROBE_MEDIA_ID) return await serveProbe(request)

  const record = await getStreamRecord(mediaId)
  // The page publishes the record before setting `src`, so a miss means the
  // vault is locked, the video was revoked, or this is a stale request.
  if (!record) return problem(404, 'No key for this video')

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: baseHeaders(record) })
  }
  if (request.method !== 'GET') return problem(405, 'Method not allowed')

  const parsed = parseRangeHeader(request.headers.get('Range'), record.plaintextSize)

  if (parsed.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': unsatisfiedContentRange(record.plaintextSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  }

  // No Range, or one we will not serve as 206: answer the whole resource with
  // 200. Still streamed, so this does not mean buffering the film.
  const whole = parsed.kind !== 'range'
  const range = whole ? { start: 0, end: record.plaintextSize - 1 } : parsed.range

  if (record.plaintextSize === 0) return problem(404, 'Empty media')

  let plan
  try {
    plan = planRange(
      { chunkSize: record.chunkSize, chunkCount: record.chunkCount },
      record.plaintextSize,
      range.start,
      range.end,
    )
  } catch {
    return problem(416, 'Unsatisfiable range')
  }

  const headers = baseHeaders(record)
  headers.set('Content-Length', String(plan.length))
  if (!whole) headers.set('Content-Range', contentRange(range, record.plaintextSize))

  return new Response(bodyFor(record, plan), {
    status: whole ? 200 : 206,
    headers,
  })
}

/**
 * Answer the probe with a real, complete little video -- but only if this
 * worker can do everything serving a real video needs.
 *
 * The first version of this answered from the inlined bytes alone, which made
 * it a test of one thing: does a media element's request reach the worker? On
 * WebKit that question has the wrong answer. The request *does* arrive, so the
 * probe passed, and then every real video failed, because a service worker on
 * WebKit cannot read a `CryptoKey` back out of IndexedDB: `getAllKeys()` lists
 * the record and `get()` on the very same key returns `undefined`. The staged
 * fallback existed and was never reached. See docs/DECISIONS.md D31.
 *
 * So the probe now walks the same path a real stream walks -- read the record
 * for this media id, use its key -- and only then serves the file. The page
 * publishes a throwaway record before probing and deletes it afterwards.
 *
 * Range support matters even here: some browsers will not treat a resource as
 * seekable, and will refuse to load it at all, unless the first response
 * advertises `Accept-Ranges` and honours a range request. The body is streamed
 * for the same reason: it is what a real response is made of.
 */
async function serveProbe(request: Request): Promise<Response> {
  const record = await getStreamRecord(PROBE_MEDIA_ID)
  if (!record || !(await keyIsUsable(record.key))) {
    return problem(404, 'The worker cannot read stream keys in this browser')
  }

  const bytes = probeMp4Bytes()
  const parsed = parseRangeHeader(request.headers.get('Range'), bytes.length)
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })

  if (parsed.kind === 'range') {
    const { start, end } = parsed.range
    const slice = bytes.subarray(start, end + 1)
    headers.set('Content-Length', String(slice.length))
    headers.set('Content-Range', contentRange(parsed.range, bytes.length))
    return new Response(streamOf(slice), { status: 206, headers })
  }

  headers.set('Content-Length', String(bytes.length))
  return new Response(streamOf(bytes), { status: 200, headers })
}

/**
 * Not `record.key instanceof CryptoKey`: a key that survives the round trip as
 * an object but cannot be used is the same failure with a friendlier disguise.
 * One AES-GCM operation settles it.
 */
async function keyIsUsable(key: CryptoKey): Promise<boolean> {
  try {
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(1))
    return true
  } catch {
    return false
  }
}

/** Serve a buffer the way real media is served: as a stream, in pieces. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const half = Math.max(1, Math.ceil(bytes.length / 2))
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(sent + half, bytes.length)
      controller.enqueue(bytes.subarray(sent, end))
      sent = end
      if (sent >= bytes.length) controller.close()
    },
  })
}

/**
 * Stream the decrypted range.
 *
 * Chunks are fetched a window at a time and decrypted as they arrive, so peak
 * memory is one window rather than the whole request. A request for `bytes=0-`
 * on a two-hour film is therefore answerable without ever holding the film.
 */
function bodyFor(
  record: StreamRecord,
  plan: ReturnType<typeof planRange>,
): ReadableStream<Uint8Array> {
  const params: ChunkParams = {
    mediaId: record.mediaId,
    noncePrefix: record.noncePrefix,
    chunkSize: record.chunkSize,
    chunkCount: record.chunkCount,
  }
  const storedChunkSize = record.chunkSize + GCM_TAG_BYTES
  const windows = planFetchWindows(plan, params, record.plaintextSize, WINDOW_CHUNKS)

  let windowIndex = 0
  // Bytes to drop from the front of the first chunk, and the budget remaining.
  let skip = plan.offsetInFirstChunk
  let remaining = plan.length
  let source = record

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0 || windowIndex >= windows.length) {
        controller.close()
        return
      }

      const window = windows[windowIndex++]
      if (!window) {
        controller.close()
        return
      }

      const fetched = await fetchWindow(source, window.ctStart, window.ctEnd, (fresh) => {
        source = fresh
      })

      for (let index = window.firstChunk; index <= window.lastChunk && remaining > 0; index++) {
        const offset = (index - window.firstChunk) * storedChunkSize
        const piece = fetched.subarray(offset, Math.min(offset + storedChunkSize, fetched.length))

        // A failed tag throws out of `pull`, which errors the stream and makes
        // the media element report a decode failure. That is the correct
        // outcome; never swallow it.
        let plain = await decryptChunk(source.key, params, index, piece)

        if (skip > 0) {
          const drop = Math.min(skip, plain.length)
          plain = plain.subarray(drop)
          skip -= drop
        }
        if (plain.length > remaining) plain = plain.subarray(0, remaining)
        if (plain.length > 0) {
          controller.enqueue(plain)
          remaining -= plain.length
        }
      }

      if (remaining <= 0) controller.close()
    },
  })
}

/**
 * Fetch one ciphertext window, renewing the signed URL if it has expired.
 *
 * Signed URLs are short-lived by design, and a film outlives them. Rather than
 * guessing a TTL long enough to cover any video, the worker asks the page for a
 * fresh one when storage stops accepting the old one. The page is the only side
 * that can mint one -- it holds the session.
 */
async function fetchWindow(
  record: StreamRecord,
  start: number,
  end: number,
  onRenewed: (record: StreamRecord) => void,
): Promise<Uint8Array> {
  let response = await fetch(record.sourceUrl, { headers: { Range: rangeHeader(start, end) } })

  if (!response.ok && isExpiry(response.status)) {
    const fresh = await renew(record.mediaId, record.expiresAt)
    if (fresh) {
      onRenewed(fresh)
      response = await fetch(fresh.sourceUrl, { headers: { Range: rangeHeader(start, end) } })
    }
  }

  if (!response.ok) {
    throw new Error(`Storage refused the ciphertext range (${response.status})`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const expected = end - start + 1
  // A short read would silently misalign every chunk boundary after it, so
  // treat it as a hard failure rather than decrypting garbage.
  if (bytes.length !== expected) {
    throw new Error(`Storage returned ${bytes.length} bytes, expected ${expected}`)
  }
  return bytes
}

/** 400 is what Supabase Storage returns for an expired signature. */
function isExpiry(status: number): boolean {
  return status === 400 || status === 401 || status === 403
}

async function renew(mediaId: string, staleExpiry: number): Promise<StreamRecord | null> {
  const clients = await self.clients.matchAll({ type: 'window' })
  if (clients.length === 0) return null
  for (const client of clients) {
    client.postMessage({ type: 'vue2:stream-url-expired', mediaId })
  }

  // Poll rather than await a reply: the page writes the new record to
  // IndexedDB, and reading it back is what actually matters. A reply message
  // would still leave us re-reading the store.
  const deadline = Date.now() + REFRESH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(REFRESH_POLL_MS)
    const fresh = await getStreamRecord(mediaId)
    if (fresh && fresh.expiresAt > staleExpiry) return fresh
  }
  return null
}

function baseHeaders(record: StreamRecord): Headers {
  return new Headers({
    'Content-Type': record.mimeType,
    'Accept-Ranges': 'bytes',
    // Decrypted video must not be written to any HTTP cache.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
}

function problem(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
