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
 *   2. **Nothing is cached.** Responses carry `no-store`, and we never put
 *      plaintext into the Cache API. The whole point is that the decrypted
 *      video exists only for as long as it is being watched.
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

declare const self: ServiceWorkerGlobalScope

export const STREAM_PREFIX = '/__stream/'

/**
 * Reserved media id for the capability probe. Answered from an inlined file
 * rather than from IndexedDB, so the probe works before any video exists and
 * tests exactly one thing: whether a media element's request reaches us.
 */
export const PROBE_MEDIA_ID = '__probe'

/** Ciphertext chunks per upstream request. 8 MiB balances latency and memory. */
const WINDOW_CHUNKS = 8

/** How long to wait for the page to mint a fresh signed URL. */
const REFRESH_TIMEOUT_MS = 8000
const REFRESH_POLL_MS = 150

self.addEventListener('install', () => {
  // Take over immediately: the player screen that just registered this worker
  // is the one that needs it, and waiting for a navigation would strand it.
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Anything that is not ours passes straight through to the network. This
  // worker is a media decryptor, not a cache.
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(STREAM_PREFIX)) return

  event.respondWith(serve(event.request, url))
})

async function serve(request: Request, url: URL): Promise<Response> {
  const mediaId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length))
  if (!mediaId) return problem(400, 'No media id')

  if (mediaId === PROBE_MEDIA_ID) return serveProbe(request)

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
 * Answer the probe with a real, complete little video.
 *
 * Range support matters even here: some browsers will not treat a resource as
 * seekable, and will refuse to load it at all, unless the first response
 * advertises `Accept-Ranges` and honours a range request.
 */
function serveProbe(request: Request): Response {
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
    return new Response(slice as BlobPart, { status: 206, headers })
  }

  headers.set('Content-Length', String(bytes.length))
  return new Response(bytes as BlobPart, { status: 200, headers })
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
