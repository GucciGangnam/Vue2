/**
 * Getting a decrypted video in front of a `<video>` element.
 *
 * Two routes to the same place, chosen at runtime:
 *
 *   **service-worker** — `<video src="/__stream/{id}">`, and the worker answers
 *   Range requests by decrypting only the chunks asked for. Instant start, real
 *   seeking, nothing written to disk. This is the path we want.
 *
 *   **staged** — decrypt the whole file up front, hand the result to
 *   `createObjectURL`. Costs an upfront pass and temporary storage, but needs
 *   nothing from the browser beyond blobs. This exists because iOS Safari has
 *   historically bypassed service workers for media element loads (D5), and
 *   because a browser that cannot register a worker at all still deserves to
 *   play the video.
 *
 * The choice is made by measurement, not by user-agent sniffing: `probePlayback`
 * points a real media element at a real video served by the worker and waits to
 * see whether metadata arrives.
 */

import { fromBytea } from '@/lib/crypto/bytes'
import {
  decryptChunk,
  planFetchWindows,
  planRange,
  type ChunkParams,
} from '@/lib/crypto/chunkCipher'
import { GCM_TAG_BYTES } from '@/lib/crypto/primitives'
import {
  deleteStreamRecord,
  getStreamRecord,
  putStreamRecord,
  type StreamRecord,
} from '@/lib/crypto/keyStore'
import { supabase } from '@/lib/supabase'
import { rangeHeader } from './httpRange'
import { MEDIA_BUCKET, loadOwnContentKey } from './upload'

export const STREAM_PREFIX = '/__stream/'
const PROBE_MEDIA_ID = '__probe'
const WORKER_URL = '/sw.js'

/** Signed URLs last an hour; the worker renews through the page on expiry. */
const SIGNED_URL_TTL_SECONDS = 3600

const WINDOW_CHUNKS = 8
const PROBE_TIMEOUT_MS = 6000
/**
 * Versioned: a cached answer is only meaningful for the probe that produced it,
 * and this probe asks a strictly harder question than the first one did (D31).
 */
const PROBE_RESULT_KEY = 'vue2:sw-playback:v2'

export type PlaybackMode = 'service-worker' | 'staged'

/**
 * Which open is currently the live one, per media id.
 *
 * Releasing a stream deletes its key record, which is what stops the worker
 * being able to decrypt after the player closes. But two opens for the same
 * video can overlap -- React runs an effect, cleans it up and runs it again on
 * every mount in development, and a user can reopen the same film -- and the
 * first open's cleanup lands *after* the second has published its record. That
 * deletes the key out from under a player that is still on screen, and the
 * symptom is bizarre: the video plays, then the first seek 404s, because
 * seeking is when the element asks for bytes it has not already buffered.
 *
 * So a release only takes effect if it is releasing the newest open.
 */
const openGenerations = new Map<string, number>()

export interface OpenStream {
  mode: PlaybackMode
  /** Assign to `<video src>`. */
  src: string
  release: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Worker registration and the capability probe                                */
/* -------------------------------------------------------------------------- */

export async function registerStreamWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    const registration = await navigator.serviceWorker.register(WORKER_URL, {
      type: 'module',
      scope: '/',
    })
    // `ready` resolves only once a worker is active and controlling; without
    // waiting, the first stream request can race past an installing worker.
    await navigator.serviceWorker.ready
    return registration
  } catch {
    // A browser without module workers, a hard-reload with the worker
    // unregistered, private browsing -- all land here, and all mean "use the
    // other path" rather than "fail".
    return null
  }
}

/**
 * Can this browser actually play a video the worker serves?
 *
 * `fetch()` being intercepted is not evidence: iOS Safari has intercepted
 * `fetch` while bypassing the worker for `<video>` loads. So point a real video
 * element at a real file the worker serves, and see whether metadata arrives.
 *
 * That much was true from the start, and it was still not enough. On WebKit the
 * media element's request *does* reach the worker -- and then the worker cannot
 * read the stream record back out of IndexedDB, because a `CryptoKey` stored by
 * the page deserialises as `undefined` there. Routing worked, serving did not,
 * and the probe cheerfully reported success on a browser that could not play a
 * single frame. See docs/DECISIONS.md D31.
 *
 * So the probe publishes a throwaway record with a real non-extractable key
 * first, and the worker refuses to answer until it has read that record and
 * used its key. The probe now fails wherever a real video would fail, which is
 * the only property that makes it worth having.
 *
 * The answer is cached per origin. It is a property of the browser, and
 * re-running it on every visit costs a media load for no new information.
 */
export async function probePlayback(force = false): Promise<boolean> {
  if (!force) {
    const cached = readCachedProbe()
    if (cached !== null) return cached
  }

  const registration = await registerStreamWorker()
  if (!registration) return cacheProbe(false)

  try {
    await putStreamRecord(await probeRecord())
  } catch {
    // If the page cannot even write the record, the worker will certainly not
    // read one. Take the fallback.
    return cacheProbe(false)
  }

  const ok = await new Promise<boolean>((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'

    const done = (result: boolean) => {
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }

    // A browser that bypasses the worker requests /__stream/__probe from the
    // network, gets the SPA's index.html back, and fails to decode it. A
    // browser that reaches the worker but cannot hand it a usable key gets a
    // 404. Both show up as `error`, or as nothing at all -- hence the timeout.
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', () => done(true), { once: true })
    video.addEventListener('error', () => done(false), { once: true })

    video.src = `${STREAM_PREFIX}${PROBE_MEDIA_ID}`
  })

  await deleteStreamRecord(PROBE_MEDIA_ID)
  return cacheProbe(ok)
}

/**
 * A record that is real in every way that matters -- a non-extractable AES-GCM
 * key, stored the same way a film's key is stored -- and points at nothing. The
 * worker never fetches for the probe; it only has to read this back.
 */
async function probeRecord(): Promise<StreamRecord> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return {
    mediaId: PROBE_MEDIA_ID,
    key,
    noncePrefix: new Uint8Array(4),
    chunkSize: 1,
    chunkCount: 1,
    plaintextSize: 1,
    ciphertextSize: 1 + GCM_TAG_BYTES,
    mimeType: 'video/mp4',
    sourceUrl: '',
    expiresAt: 0,
  }
}

function readCachedProbe(): boolean | null {
  try {
    const raw = localStorage.getItem(PROBE_RESULT_KEY)
    return raw === null ? null : raw === 'true'
  } catch {
    return null
  }
}

function cacheProbe(result: boolean): boolean {
  try {
    localStorage.setItem(PROBE_RESULT_KEY, String(result))
  } catch {
    // Private browsing. Re-probing each time is wasteful but correct.
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Opening a stream                                                            */
/* -------------------------------------------------------------------------- */

interface MediaParams {
  mediaId: string
  storagePath: string
  mimeType: string
  plaintextSize: number
  ciphertextSize: number
  chunkSize: number
  chunkCount: number
  noncePrefix: Uint8Array
}

async function loadMediaParams(mediaId: string): Promise<MediaParams> {
  const { data, error } = await supabase
    .from('media')
    .select(
      'id, storage_path, mime_type, plaintext_size, ciphertext_size, chunk_size, chunk_count, nonce_prefix, status',
    )
    .eq('id', mediaId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('That video is no longer available to you.')
  if (data.status !== 'ready') throw new Error('That upload has not finished.')

  return {
    mediaId: data.id,
    storagePath: data.storage_path,
    mimeType: data.mime_type,
    plaintextSize: data.plaintext_size,
    ciphertextSize: data.ciphertext_size,
    chunkSize: data.chunk_size,
    chunkCount: data.chunk_count,
    noncePrefix: fromBytea(data.nonce_prefix),
  }
}

async function signObject(storagePath: string): Promise<{ url: string; expiresAt: number }> {
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
  if (error) throw error
  if (!data?.signedUrl) throw new Error('Could not get a link to that video.')
  return {
    url: data.signedUrl,
    // Renew a minute early rather than discovering expiry mid-seek.
    expiresAt: Date.now() + (SIGNED_URL_TTL_SECONDS - 60) * 1000,
  }
}

export async function openStream(options: {
  mediaId: string
  userId: string
  identityPrivateKey: CryptoKey
  /** Only called on the staged path, which has real work to report. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}): Promise<OpenStream> {
  const { mediaId, userId, identityPrivateKey, onProgress, signal } = options

  // Claimed before any await, so ordering follows call order rather than
  // whichever network round trip happens to finish first.
  const generation = (openGenerations.get(mediaId) ?? 0) + 1
  openGenerations.set(mediaId, generation)
  const isCurrent = () => openGenerations.get(mediaId) === generation

  const params = await loadMediaParams(mediaId)
  const key = await loadOwnContentKey(mediaId, userId, identityPrivateKey)
  const signed = await signObject(params.storagePath)

  const record: StreamRecord = {
    mediaId,
    key,
    noncePrefix: params.noncePrefix,
    chunkSize: params.chunkSize,
    chunkCount: params.chunkCount,
    plaintextSize: params.plaintextSize,
    ciphertextSize: params.ciphertextSize,
    mimeType: params.mimeType,
    sourceUrl: signed.url,
    expiresAt: signed.expiresAt,
  }

  if (await probePlayback()) {
    // The record must be readable before the element asks for a byte.
    await putStreamRecord(record)
    return {
      mode: 'service-worker',
      src: `${STREAM_PREFIX}${encodeURIComponent(mediaId)}`,
      // Dropping the record is what makes the video stop being readable: the
      // worker has no other source for the key. Skip it when a newer open has
      // taken over, or this tears down a player that is still running.
      release: async () => {
        if (!isCurrent()) return
        await deleteStreamRecord(mediaId)
      },
    }
  }

  const objectUrl = await stageDecrypted(record, onProgress, signal)
  return {
    mode: 'staged',
    src: objectUrl,
    release: async () => {
      URL.revokeObjectURL(objectUrl)
    },
  }
}

/**
 * Mint a fresh signed URL and republish the record.
 *
 * The worker cannot do this itself -- it has no Supabase session -- so it asks
 * the page, which is what `vue2:stream-url-expired` is for.
 */
export async function refreshStreamUrl(mediaId: string): Promise<void> {
  const params = await loadMediaParams(mediaId)
  const signed = await signObject(params.storagePath)

  const existing = await getStreamRecord(mediaId)
  // The key is already in the record; re-deriving it would need the vault, and
  // the worker may be asking while the user is mid-film.
  if (!existing) return

  await putStreamRecord({ ...existing, sourceUrl: signed.url, expiresAt: signed.expiresAt })
}

/** Wire the page up to answer the worker's renewal requests. */
export function listenForStreamRenewals(): () => void {
  if (!('serviceWorker' in navigator)) return () => {}

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; mediaId?: string } | null
    if (!data || data.type !== 'vue2:stream-url-expired' || !data.mediaId) return
    void refreshStreamUrl(data.mediaId).catch(() => {
      // The worker times out and the element reports an error; nothing better
      // to do from here.
    })
  }

  navigator.serviceWorker.addEventListener('message', onMessage)
  return () => navigator.serviceWorker.removeEventListener('message', onMessage)
}

/* -------------------------------------------------------------------------- */
/* The staged fallback                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decrypt the whole object and return an object URL for it.
 *
 * Each decrypted chunk goes straight into its own `Blob`, so the browser owns
 * the bytes and pages them to disk as the file grows; the JS heap holds one
 * window at a time regardless of the video's size. That is the same trick the
 * uploader uses in reverse, and it is why this path does not need OPFS to stay
 * memory-bounded. OPFS would additionally let a decrypted file survive across
 * sessions -- deliberately not done, because a plaintext film left on disk is a
 * privacy regression, not a feature.
 */
async function stageDecrypted(
  record: StreamRecord,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const params: ChunkParams = {
    mediaId: record.mediaId,
    noncePrefix: record.noncePrefix,
    chunkSize: record.chunkSize,
    chunkCount: record.chunkCount,
  }
  const plan = planRange(params, record.plaintextSize, 0, record.plaintextSize - 1)
  const windows = planFetchWindows(plan, params, record.plaintextSize, WINDOW_CHUNKS)
  const storedChunkSize = record.chunkSize + GCM_TAG_BYTES

  const parts: Blob[] = []
  let done = 0

  for (const window of windows) {
    if (signal?.aborted) throw new Error('Playback cancelled')

    const response = await fetch(record.sourceUrl, {
      headers: { Range: rangeHeader(window.ctStart, window.ctEnd) },
      signal,
    })
    if (!response.ok) throw new Error(`Could not read the video (${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())

    for (let index = window.firstChunk; index <= window.lastChunk; index++) {
      const offset = (index - window.firstChunk) * storedChunkSize
      const piece = bytes.subarray(offset, Math.min(offset + storedChunkSize, bytes.length))
      const plain = await decryptChunk(record.key, params, index, piece)
      parts.push(new Blob([plain as BlobPart]))
      done += plain.length
      onProgress?.(done, record.plaintextSize)
    }
  }

  return URL.createObjectURL(new Blob(parts, { type: record.mimeType }))
}
