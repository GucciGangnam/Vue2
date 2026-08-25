/**
 * Title, dimensions and poster frame -- docs/CRYPTO.md section 3d.
 *
 * These are encrypted under the same content key as the video itself, so
 * Supabase cannot see what a video is called or what it looks like. Leaving
 * them in the clear would undo most of the point: "an encrypted file named
 * holiday-2019.mp4 with this thumbnail" is very nearly the content.
 *
 * Separate AAD strings keep the two apart. Without them a metadata blob and a
 * thumbnail blob are both just GCM ciphertext under one key, and swapping the
 * columns would decrypt cleanly into the wrong field.
 */

import { fromUtf8, randomBytes, utf8 } from './bytes'
import { aesGcmDecrypt, aesGcmEncrypt, GCM_NONCE_BYTES } from './primitives'

const AAD_METADATA = utf8('media:meta:v1')
const AAD_THUMBNAIL = utf8('media:thumb:v1')

export interface MediaMetadata {
  title: string
  durationMs: number
  width: number
  height: number
}

export interface SealedBlob {
  ciphertext: Uint8Array
  nonce: Uint8Array
}

export async function encryptMetadata(
  key: CryptoKey,
  metadata: MediaMetadata,
): Promise<SealedBlob> {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  // Serialised field by field rather than passing the object straight to
  // JSON.stringify, so an extra property picked up somewhere upstream cannot
  // ride along into storage.
  const payload = utf8(
    JSON.stringify({
      title: metadata.title,
      durationMs: metadata.durationMs,
      width: metadata.width,
      height: metadata.height,
    }),
  )
  return { ciphertext: await aesGcmEncrypt(key, nonce, payload, AAD_METADATA), nonce }
}

export async function decryptMetadata(key: CryptoKey, blob: SealedBlob): Promise<MediaMetadata> {
  const plaintext = await aesGcmDecrypt(key, blob.nonce, blob.ciphertext, AAD_METADATA)
  return parseMetadata(fromUtf8(plaintext))
}

export async function encryptThumbnail(key: CryptoKey, jpeg: Uint8Array): Promise<SealedBlob> {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  return { ciphertext: await aesGcmEncrypt(key, nonce, jpeg, AAD_THUMBNAIL), nonce }
}

export async function decryptThumbnail(key: CryptoKey, blob: SealedBlob): Promise<Uint8Array> {
  return aesGcmDecrypt(key, blob.nonce, blob.ciphertext, AAD_THUMBNAIL)
}

/**
 * GCM proves these bytes are ours and unmodified. It does not prove they are
 * the shape this version of the app expects -- an older client could have
 * written them. Validate rather than trusting the cast.
 */
function parseMetadata(json: string): MediaMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Media metadata is not valid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Media metadata is not an object')
  }

  const record = parsed as Record<string, unknown>
  const title = record.title
  if (typeof title !== 'string') throw new Error('Media metadata has no title')

  return {
    title,
    durationMs: finiteNumber(record.durationMs),
    width: finiteNumber(record.width),
    height: finiteNumber(record.height),
  }
}

/** A missing or broken dimension should not stop a video from playing. */
function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
