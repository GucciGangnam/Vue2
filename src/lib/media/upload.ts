/**
 * Encrypt a video in the browser and upload the ciphertext.
 *
 * The order of operations here is deliberate and load-bearing:
 *
 *   1. probe the file while we still hold plaintext -- duration, dimensions
 *      and the poster frame can never be recovered from the server's copy
 *   2. mint the media id **before** encrypting, because it is bound into every
 *      chunk's AAD (CRYPTO section 3b)
 *   3. write the `media` row, then immediately wrap the content key to the
 *      uploader's own identity key
 *   4. only then encrypt and upload the bytes
 *
 * Step 3 before step 4 is what makes a failed upload recoverable. The content
 * key is random and lives only in memory; if the tab closed mid-upload without
 * it having been persisted, the partial object would be permanently unreadable
 * and the row would be junk. Persisting the wrap first means the key survives,
 * so `resumeUpload` can re-encrypt and finish the job later.
 *
 * Memory: the whole ciphertext is never held in the JS heap. Each encrypted
 * chunk is handed straight to a `Blob`, which the browser owns and spills to
 * disk as it grows; we retain only the small blob handles. That keeps a 2GB
 * upload bounded by one chunk of working memory.
 */

import * as tus from 'tus-js-client'
import { fromBytea, toBytea, wipe } from '@/lib/crypto/bytes'
import {
  CHUNK_SIZE,
  chunkCountFor,
  ciphertextSizeFor,
  encryptChunk,
  generateContentKey,
  generateNoncePrefix,
  maxPlaintextFor,
  plaintextChunkLength,
  type ChunkParams,
} from '@/lib/crypto/chunkCipher'
import { encryptMetadata, encryptThumbnail } from '@/lib/crypto/mediaMetadata'
import { unwrapContentKey, wrapContentKeyFor } from '@/lib/crypto/mediaKeys'
import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'
import { formatBytes } from '@/lib/format'
import { probeVideo, type VideoProbe } from './probe'

/**
 * The largest video this deployment can actually accept.
 *
 * D4 sets the product cap at 2GB, but that assumes a plan whose storage will
 * take a 2GB object. What matters to a user standing in front of a file picker
 * is the smaller of the two, expressed in *plaintext* bytes -- the ciphertext
 * is larger, by one GCM tag per chunk, and it is the ciphertext that storage
 * measures. Checking this before reading the file is the difference between
 * "that video is too large" and a 413 after several minutes of encryption.
 */
export const PRODUCT_MAX_BYTES = 2 * 1024 * 1024 * 1024

export const MAX_UPLOAD_BYTES = Math.min(
  PRODUCT_MAX_BYTES,
  maxPlaintextFor(env.maxCiphertextBytes, CHUNK_SIZE),
)

export const MEDIA_BUCKET = 'media'

/** Supabase's resumable endpoint requires 6MB parts for all but the last. */
const TUS_PART_SIZE = 6 * 1024 * 1024

export type UploadPhase = 'reading' | 'encrypting' | 'uploading' | 'finishing'

export interface UploadProgress {
  phase: UploadPhase
  bytesDone: number
  bytesTotal: number
}

export interface UploadRequest {
  file: File
  title: string
  ownerId: string
  /** SPKI of the uploader's own identity key: they are the first recipient. */
  identityPublicKey: Uint8Array
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelled'
  }
}

export function storagePathFor(ownerId: string, mediaId: string): string {
  return `${ownerId}/${mediaId}.enc`
}

export async function uploadMedia(request: UploadRequest): Promise<string> {
  const { file, title, ownerId, identityPublicKey, onProgress, signal } = request

  if (file.size === 0) throw new Error('That file is empty.')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That video is ${formatBytes(file.size)}. This server accepts up to ` +
        `${formatBytes(MAX_UPLOAD_BYTES)} per video.`,
    )
  }

  report(onProgress, 'reading', 0, file.size)
  const probe = await probeVideo(file)
  throwIfAborted(signal)

  // The chunk AAD binds the media id, so it must exist before anything is
  // encrypted. Minting it client-side rather than letting the default fire is
  // what makes that possible.
  const mediaId = crypto.randomUUID()
  const content = await generateContentKey()
  const params: ChunkParams = {
    mediaId,
    noncePrefix: generateNoncePrefix(),
    chunkSize: CHUNK_SIZE,
    chunkCount: chunkCountFor(file.size, CHUNK_SIZE),
  }

  try {
    const metadata = await encryptMetadata(content.key, {
      title: title.trim() || file.name,
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
    })

    const { error } = await supabase.from('media').insert({
      id: mediaId,
      owner_id: ownerId,
      // Recomputed by the media_validate trigger; sent so the column is never
      // null and so a mismatch would be visible rather than silent.
      storage_path: storagePathFor(ownerId, mediaId),
      plaintext_size: file.size,
      ciphertext_size: ciphertextSizeFor(file.size, CHUNK_SIZE),
      chunk_size: params.chunkSize,
      chunk_count: params.chunkCount,
      nonce_prefix: toBytea(params.noncePrefix),
      mime_type: file.type || 'video/mp4',
      encrypted_metadata: toBytea(metadata.ciphertext),
      metadata_nonce: toBytea(metadata.nonce),
    })
    if (error) throw error

    // Before the bytes: see the note at the top of this file.
    await grantContentKey({
      mediaId,
      cek: content.raw,
      recipientId: ownerId,
      recipientPublicKey: identityPublicKey,
      grantedBy: ownerId,
    })

    await encryptAndUpload({ file, key: content.key, params, ownerId, onProgress, signal })
    await finish({ mediaId, key: content.key, probe, onProgress })
    return mediaId
  } catch (cause) {
    await handleFailure(mediaId, cause, signal)
    throw cause
  } finally {
    // The raw key was only ever needed to wrap it for a recipient.
    wipe(content.raw)
  }
}

/**
 * Finish an upload that stopped part way.
 *
 * The user has to pick the file again -- a `File` handle cannot be persisted
 * across a reload -- but everything else survives in the database, so the
 * ciphertext this produces is byte-identical to what the first attempt was
 * writing. AES-GCM is deterministic given the same key, nonce and plaintext,
 * and all three are pinned: the key comes back out of the owner's own
 * `media_keys` row and the nonce prefix is immutable on the `media` row. That
 * is what makes overwriting the partial object safe rather than a gamble.
 */
export async function resumeUpload(options: {
  mediaId: string
  file: File
  ownerId: string
  identityPrivateKey: CryptoKey
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}): Promise<void> {
  const { mediaId, file, ownerId, identityPrivateKey, onProgress, signal } = options

  const { data: row, error } = await supabase
    .from('media')
    .select('*')
    .eq('id', mediaId)
    .maybeSingle()
  if (error) throw error
  if (!row) throw new Error('That upload is no longer in your library.')

  if (row.plaintext_size !== file.size) {
    throw new Error('That is a different file from the one this upload started with.')
  }

  const key = await loadOwnContentKey(mediaId, ownerId, identityPrivateKey)
  const params: ChunkParams = {
    mediaId,
    noncePrefix: fromBytea(row.nonce_prefix),
    chunkSize: row.chunk_size,
    chunkCount: row.chunk_count,
  }

  report(onProgress, 'reading', 0, file.size)
  const probe = await probeVideo(file)
  throwIfAborted(signal)

  await encryptAndUpload({ file, key, params, ownerId, onProgress, signal })
  await finish({ mediaId, key, probe, onProgress })
}

/** Wrap this media's content key for one recipient and store the grant. */
export async function grantContentKey(options: {
  mediaId: string
  cek: Uint8Array
  recipientId: string
  recipientPublicKey: Uint8Array
  grantedBy: string
}): Promise<void> {
  const wrapped = await wrapContentKeyFor(
    options.cek,
    options.recipientPublicKey,
    options.mediaId,
    options.recipientId,
  )

  const { error } = await supabase.from('media_keys').insert({
    media_id: options.mediaId,
    recipient_id: options.recipientId,
    ephemeral_public_key: toBytea(wrapped.ephemeralPublicKey),
    hkdf_salt: toBytea(wrapped.hkdfSalt),
    nonce: toBytea(wrapped.nonce),
    wrapped_key: toBytea(wrapped.wrappedKey),
    version: wrapped.version,
    granted_by: options.grantedBy,
  })
  if (error) throw error
}

/** Recover the content key for media the caller already holds a grant for. */
export async function loadOwnContentKey(
  mediaId: string,
  userId: string,
  identityPrivateKey: CryptoKey,
): Promise<CryptoKey> {
  const { data, error } = await supabase
    .from('media_keys')
    .select('*')
    .eq('media_id', mediaId)
    .eq('recipient_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('You do not have the key for this video.')

  return unwrapContentKey(
    {
      ephemeralPublicKey: fromBytea(data.ephemeral_public_key),
      hkdfSalt: fromBytea(data.hkdf_salt),
      nonce: fromBytea(data.nonce),
      wrappedKey: fromBytea(data.wrapped_key),
      version: data.version,
    },
    identityPrivateKey,
    mediaId,
    userId,
  )
}

/* -------------------------------------------------------------------------- */

async function encryptAndUpload(options: {
  file: File
  key: CryptoKey
  params: ChunkParams
  ownerId: string
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}): Promise<void> {
  const { file, key, params, ownerId, onProgress, signal } = options

  const parts: Blob[] = []
  let done = 0

  for (let index = 0; index < params.chunkCount; index++) {
    throwIfAborted(signal)

    const length = plaintextChunkLength(index, file.size, params.chunkSize)
    const start = index * params.chunkSize
    // File.slice is a view, not a copy: the bytes are read here and nowhere else.
    const plaintext = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
    const sealed = await encryptChunk(key, params, index, plaintext)
    wipe(plaintext)

    // Handing each chunk to its own Blob lets the browser take ownership of the
    // bytes immediately; we keep only the handle.
    parts.push(new Blob([sealed as BlobPart]))

    done += length
    report(onProgress, 'encrypting', done, file.size)
  }

  const ciphertext = new Blob(parts, { type: 'application/octet-stream' })
  await resumableUpload({
    path: storagePathFor(ownerId, params.mediaId),
    blob: ciphertext,
    onProgress,
    signal,
  })
}

async function resumableUpload(options: {
  path: string
  blob: Blob
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}): Promise<void> {
  const { path, blob, onProgress, signal } = options

  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('Your session expired. Sign in again to upload.')

  const endpoint = `${env.supabaseUrl}/storage/v1/upload/resumable`

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(blob, {
      endpoint,
      // Retries are the point of using a resumable protocol: a dropped
      // connection picks up from the last acknowledged offset rather than
      // starting a 350MB upload again.
      retryDelays: [0, 1000, 3000, 5000, 10_000],
      headers: {
        authorization: `Bearer ${token}`,
        // The object is deterministic from the media row, so overwriting a
        // partial attempt is always safe. See resumeUpload.
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: TUS_PART_SIZE,
      metadata: {
        bucketName: MEDIA_BUCKET,
        objectName: path,
        contentType: 'application/octet-stream',
      },
      onProgress: (sent, total) => report(onProgress, 'uploading', sent, total),
      onSuccess: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      onError: (cause) => {
        signal?.removeEventListener('abort', onAbort)
        reject(cause)
      },
    })

    const onAbort = () => {
      void upload.abort()
      reject(new UploadCancelled())
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    void upload
      .findPreviousUploads()
      .then((previous) => {
        const resumable = previous[0]
        if (resumable) upload.resumeFromPreviousUpload(resumable)
        upload.start()
      })
      .catch(() => upload.start())
  })
}

/** Attach the poster and flip the row to `ready`. */
async function finish(options: {
  mediaId: string
  key: CryptoKey
  probe: VideoProbe
  onProgress?: (progress: UploadProgress) => void
}): Promise<void> {
  const { mediaId, key, probe, onProgress } = options
  report(onProgress, 'finishing', 0, 1)

  const thumbnail = probe.posterJpeg ? await encryptThumbnail(key, probe.posterJpeg) : null

  const { error } = await supabase
    .from('media')
    .update({
      status: 'ready',
      encrypted_thumbnail: thumbnail ? toBytea(thumbnail.ciphertext) : null,
      thumbnail_nonce: thumbnail ? toBytea(thumbnail.nonce) : null,
    })
    .eq('id', mediaId)
  if (error) throw error

  report(onProgress, 'finishing', 1, 1)
}

/**
 * A cancelled upload leaves nothing behind; a failed one leaves a row the user
 * can see and either finish or delete. Silence beats a second error on top of
 * the first, so everything here is best-effort.
 */
async function handleFailure(mediaId: string, cause: unknown, signal?: AbortSignal): Promise<void> {
  const cancelled = cause instanceof UploadCancelled || signal?.aborted === true
  try {
    if (cancelled) {
      await supabase.storage.from(MEDIA_BUCKET).remove([mediaId])
      await supabase.from('media').delete().eq('id', mediaId)
    } else {
      await supabase.from('media').update({ status: 'failed' }).eq('id', mediaId)
    }
  } catch {
    // Nothing useful to do: the original error is the one worth reporting.
  }
}

function report(
  onProgress: ((progress: UploadProgress) => void) | undefined,
  phase: UploadPhase,
  bytesDone: number,
  bytesTotal: number,
): void {
  onProgress?.({ phase, bytesDone, bytesTotal })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadCancelled()
}
