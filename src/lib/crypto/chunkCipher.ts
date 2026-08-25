/**
 * The media chunk cipher -- docs/CRYPTO.md section 3a-3c.
 *
 * A video is split into fixed-size plaintext chunks, each sealed independently
 * with AES-256-GCM under the item's content key. The stored object is the bare
 * concatenation `ct_0 || ct_1 || ... || ct_n-1` with **no file header**: every
 * parameter needed to read it lives in the `media` row instead. That is what
 * keeps the range maths in `planRange` trivial enough to run inside a service
 * worker on a phone.
 *
 * Three values are bound into each chunk's AAD -- the media id, the chunk
 * index, and the total chunk count. Together they are what makes the stream as
 * a whole authenticated rather than just each chunk individually:
 *
 *   - the index stops chunks being reordered or swapped,
 *   - the count stops the file being truncated,
 *   - the media id stops a chunk from one video being spliced into another.
 *
 * Omit any one of the three and the tag still verifies on the doctored file.
 *
 * Nothing here reads a constant for a value that varies per item. `chunkSize`
 * and `chunkCount` are passed in, always from the `media` row, so raising the
 * chunk size later cannot silently break media already uploaded -- the same
 * discipline `kdf_params` gets in the vault.
 */

import { concatBytes, randomBytes, uint64BE, utf8 } from './bytes'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
  importAesKey,
} from './primitives'

/** 1 MiB of plaintext per chunk. Stored per item in `media.chunk_size`. */
export const CHUNK_SIZE = 1_048_576
export const NONCE_PREFIX_BYTES = 4
export const CEK_BYTES = 32

/** Everything needed to read or write one media item's chunk stream. */
export interface ChunkParams {
  mediaId: string
  /** 4 random bytes, per media item. */
  noncePrefix: Uint8Array
  chunkSize: number
  chunkCount: number
}

export interface ContentKey {
  /**
   * The raw CEK. Needed only to wrap this key for a recipient (CRYPTO section
   * 4); `wipe()` it as soon as that is done.
   */
  raw: Uint8Array
  /** Non-extractable, for bulk encryption and decryption. */
  key: CryptoKey
}

/**
 * A fresh content key and nonce prefix for one media item.
 *
 * Never reuse either across items, and never re-encrypt an item under the same
 * key: the chunk nonces are unique only because the index is unique per key.
 */
export async function generateContentKey(): Promise<ContentKey> {
  const raw = randomBytes(CEK_BYTES)
  return { raw, key: await importAesKey(raw) }
}

export function generateNoncePrefix(): Uint8Array {
  return randomBytes(NONCE_PREFIX_BYTES)
}

export function chunkCountFor(plaintextSize: number, chunkSize: number): number {
  assertChunkSize(chunkSize)
  if (plaintextSize < 0) throw new RangeError('plaintextSize cannot be negative')
  return Math.ceil(plaintextSize / chunkSize)
}

/** Every chunk carries a 16-byte GCM tag, so the object grows by one tag each. */
export function ciphertextSizeFor(plaintextSize: number, chunkSize: number): number {
  return plaintextSize + chunkCountFor(plaintextSize, chunkSize) * GCM_TAG_BYTES
}

/**
 * The largest plaintext that still fits inside a ciphertext budget.
 *
 * Not simply `limit - 16`: every chunk carries its own tag, so the overhead
 * depends on the chunk count, which depends on the answer. Solve for it rather
 * than approximating -- an approximation here means an upload that encrypts
 * happily and is then refused by storage at the last moment.
 */
export function maxPlaintextFor(ciphertextLimit: number, chunkSize: number): number {
  assertChunkSize(chunkSize)
  const perChunk = chunkSize + GCM_TAG_BYTES
  const wholeChunks = Math.floor(ciphertextLimit / perChunk)
  const remainder = ciphertextLimit - wholeChunks * perChunk
  // A short final chunk still costs a whole tag, so it only buys anything if
  // there is room for at least one plaintext byte once that tag is paid for.
  const tail = remainder > GCM_TAG_BYTES ? remainder - GCM_TAG_BYTES : 0
  return wholeChunks * chunkSize + tail
}

/** The plaintext length of chunk `index`. The final chunk is short. */
export function plaintextChunkLength(
  index: number,
  plaintextSize: number,
  chunkSize: number,
): number {
  const count = chunkCountFor(plaintextSize, chunkSize)
  if (index < 0 || index >= count) throw new RangeError(`chunk ${index} is outside this media`)
  const consumed = index * chunkSize
  return Math.min(chunkSize, plaintextSize - consumed)
}

/**
 * `noncePrefix (4) || uint64BE(index) (8)`.
 *
 * The prefix is per item and the counter is per chunk, so a (key, nonce) pair
 * can never repeat within one media item -- which is the whole safety argument
 * for GCM here.
 */
export function chunkNonce(noncePrefix: Uint8Array, index: number): Uint8Array {
  if (noncePrefix.length !== NONCE_PREFIX_BYTES) {
    throw new Error(`nonce prefix must be ${NONCE_PREFIX_BYTES} bytes, got ${noncePrefix.length}`)
  }
  assertIndex(index)
  const nonce = concatBytes(noncePrefix, uint64BE(index))
  /* c8 ignore next */
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error('chunk nonce is the wrong length')
  return nonce
}

/** `utf8(mediaId) || uint64BE(index) || uint64BE(chunkCount)`. */
export function chunkAad(mediaId: string, index: number, chunkCount: number): Uint8Array {
  if (!mediaId) throw new Error('mediaId is required for chunk AAD')
  assertIndex(index)
  return concatBytes(utf8(mediaId), uint64BE(index), uint64BE(chunkCount))
}

export async function encryptChunk(
  key: CryptoKey,
  params: ChunkParams,
  index: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (index >= params.chunkCount) {
    throw new RangeError(`chunk ${index} is past the declared count ${params.chunkCount}`)
  }
  if (plaintext.length > params.chunkSize) {
    throw new RangeError(`chunk ${index} is larger than the declared chunk size`)
  }
  // Only the last chunk may be short. If an earlier one is, every subsequent
  // offset in the stored object is wrong and seeking silently breaks -- so
  // refuse to write the file rather than discover it during playback.
  if (plaintext.length < params.chunkSize && index !== params.chunkCount - 1) {
    throw new RangeError(`chunk ${index} is short but is not the final chunk`)
  }

  return aesGcmEncrypt(
    key,
    chunkNonce(params.noncePrefix, index),
    plaintext,
    chunkAad(params.mediaId, index, params.chunkCount),
  )
}

/**
 * Decrypt one chunk. Throws if the tag does not verify.
 *
 * A failed tag is a hard error -- never fall back to returning the ciphertext,
 * a zero-filled block, or a partial result. Unauthenticated bytes reaching a
 * `<video>` element is the failure mode this whole scheme exists to prevent.
 */
export async function decryptChunk(
  key: CryptoKey,
  params: ChunkParams,
  index: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (index >= params.chunkCount) {
    throw new RangeError(`chunk ${index} is past the declared count ${params.chunkCount}`)
  }
  if (ciphertext.length <= GCM_TAG_BYTES) {
    throw new Error(`chunk ${index} is too short to contain a GCM tag`)
  }

  return aesGcmDecrypt(
    key,
    chunkNonce(params.noncePrefix, index),
    ciphertext,
    chunkAad(params.mediaId, index, params.chunkCount),
  )
}

/* -------------------------------------------------------------------------- */
/* Range mapping -- CRYPTO section 3c                                          */
/* -------------------------------------------------------------------------- */

/**
 * How to satisfy a plaintext byte range from the stored ciphertext.
 *
 * Both `start`/`end` and `ctStart`/`ctEnd` are **inclusive**, matching HTTP
 * Range semantics, because this plan is turned straight into a `Range` header
 * and a `206` response.
 */
export interface RangePlan {
  firstChunk: number
  lastChunk: number
  /** Inclusive ciphertext byte range to fetch. */
  ctStart: number
  ctEnd: number
  /** Bytes to drop from the front of the decrypted concatenation. */
  offsetInFirstChunk: number
  /** Plaintext bytes to return, after trimming both ends. */
  length: number
}

/**
 * Map an inclusive plaintext range onto whole chunks.
 *
 * `end` is clamped to the last byte of the media: a `<video>` element will
 * happily ask for `bytes=0-` or read past what it thinks the file size is, and
 * that is a normal request to answer, not an error.
 */
export function planRange(
  params: Pick<ChunkParams, 'chunkSize' | 'chunkCount'>,
  plaintextSize: number,
  start: number,
  end: number,
): RangePlan {
  assertChunkSize(params.chunkSize)
  if (plaintextSize <= 0) throw new RangeError('cannot serve a range from empty media')
  if (!Number.isInteger(start) || start < 0) throw new RangeError(`invalid range start ${start}`)
  if (start >= plaintextSize) throw new RangeError(`range start ${start} is past the end of media`)

  const lastByte = plaintextSize - 1
  const clampedEnd = Math.min(end, lastByte)
  if (clampedEnd < start) throw new RangeError(`range ${start}-${end} ends before it starts`)

  const firstChunk = Math.floor(start / params.chunkSize)
  const lastChunk = Math.floor(clampedEnd / params.chunkSize)
  const storedChunkSize = params.chunkSize + GCM_TAG_BYTES
  const ciphertextSize = plaintextSize + params.chunkCount * GCM_TAG_BYTES

  return {
    firstChunk,
    lastChunk,
    ctStart: firstChunk * storedChunkSize,
    // The final chunk is short, so the computed end can overshoot the object.
    ctEnd: Math.min((lastChunk + 1) * storedChunkSize, ciphertextSize) - 1,
    offsetInFirstChunk: start - firstChunk * params.chunkSize,
    length: clampedEnd - start + 1,
  }
}

/** One contiguous ciphertext fetch covering a run of whole chunks. */
export interface FetchWindow {
  firstChunk: number
  lastChunk: number
  /** Inclusive ciphertext byte range for this window. */
  ctStart: number
  ctEnd: number
}

/**
 * Split a plan into contiguous ciphertext fetches.
 *
 * One request per chunk would be correct and unusably slow: the project runs in
 * Tokyo, so a full read of a 46-chunk file would spend eleven seconds in round
 * trips alone before any decryption happened. Fetching a run of chunks at once
 * amortises that, while still letting the response be streamed and the memory
 * stay bounded by one window rather than the whole range.
 *
 * Windows never straddle a chunk boundary, so each one decrypts independently.
 */
export function planFetchWindows(
  plan: RangePlan,
  params: Pick<ChunkParams, 'chunkSize' | 'chunkCount'>,
  plaintextSize: number,
  windowChunks: number,
): FetchWindow[] {
  if (!Number.isInteger(windowChunks) || windowChunks < 1) {
    throw new RangeError(`window must be at least one chunk, got ${windowChunks}`)
  }

  const storedChunkSize = params.chunkSize + GCM_TAG_BYTES
  const ciphertextSize = plaintextSize + params.chunkCount * GCM_TAG_BYTES
  const windows: FetchWindow[] = []

  for (let first = plan.firstChunk; first <= plan.lastChunk; first += windowChunks) {
    const last = Math.min(first + windowChunks - 1, plan.lastChunk)
    windows.push({
      firstChunk: first,
      lastChunk: last,
      ctStart: first * storedChunkSize,
      // The final chunk is short, so the computed end can overshoot the object.
      ctEnd: Math.min((last + 1) * storedChunkSize, ciphertextSize) - 1,
    })
  }

  return windows
}

/**
 * Decrypt the ciphertext a `RangePlan` asked for and return exactly the
 * requested plaintext bytes.
 *
 * `ciphertext` must be precisely the `ctStart..ctEnd` slice the plan named --
 * chunk boundaries are found by counting from its start, so a short read or an
 * off-by-one offset surfaces as a tag failure rather than as bad data.
 */
export async function decryptRange(
  key: CryptoKey,
  params: ChunkParams,
  plan: RangePlan,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const storedChunkSize = params.chunkSize + GCM_TAG_BYTES
  const pieces: Uint8Array[] = []

  for (let index = plan.firstChunk; index <= plan.lastChunk; index++) {
    const offset = (index - plan.firstChunk) * storedChunkSize
    // subarray, not slice: this avoids copying every megabyte a second time.
    // The final chunk is short, so the tail is bounded by what we were given.
    const piece = ciphertext.subarray(offset, Math.min(offset + storedChunkSize, ciphertext.length))
    pieces.push(await decryptChunk(key, params, index, piece))
  }

  const joined = concatBytes(...pieces)
  const from = plan.offsetInFirstChunk
  if (from + plan.length > joined.length) {
    throw new Error('decrypted less plaintext than the range asked for')
  }
  return joined.subarray(from, from + plan.length)
}

/* -------------------------------------------------------------------------- */

function assertChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunk size must be a positive integer, got ${chunkSize}`)
  }
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`chunk index must be a non-negative integer, got ${index}`)
  }
}
