// @vitest-environment node
//
// Node has a complete WebCrypto; jsdom does not expose crypto.subtle.
// A tiny chunk size keeps the suite fast -- the thing under test is the format
// and the arithmetic, not the throughput.

import { describe, expect, it } from 'vitest'
import {
  chunkAad,
  chunkCountFor,
  chunkNonce,
  ciphertextSizeFor,
  decryptChunk,
  decryptRange,
  encryptChunk,
  generateContentKey,
  generateNoncePrefix,
  maxPlaintextFor,
  planRange,
  plaintextChunkLength,
  type ChunkParams,
} from './chunkCipher'
import { GCM_TAG_BYTES } from './primitives'
import { concatBytes } from './bytes'

const CHUNK = 64
const MEDIA_ID = '6f1c2a3e-0000-4000-8000-000000000001'

/** Corrupt one byte, to prove the GCM tag actually catches it. */
function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes)
  copy.set([(copy.at(index) ?? 0) ^ 0xff], index)
  return copy
}

/** Recognisable bytes, so a mis-sliced range is visible and not just wrong. */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = i % 251
  return out
}

function paramsFor(plaintextSize: number, noncePrefix: Uint8Array): ChunkParams {
  return {
    mediaId: MEDIA_ID,
    noncePrefix,
    chunkSize: CHUNK,
    chunkCount: chunkCountFor(plaintextSize, CHUNK),
  }
}

/** Encrypt a whole buffer into the stored object: a bare concatenation. */
async function seal(plaintext: Uint8Array) {
  const { key } = await generateContentKey()
  const noncePrefix = generateNoncePrefix()
  const params = paramsFor(plaintext.length, noncePrefix)

  const pieces: Uint8Array[] = []
  for (let i = 0; i < params.chunkCount; i++) {
    const slice = plaintext.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, plaintext.length))
    pieces.push(await encryptChunk(key, params, i, slice))
  }
  return { key, params, stored: concatBytes(...pieces) }
}

describe('chunk sizing', () => {
  it('counts chunks with a short final one', () => {
    expect(chunkCountFor(0, CHUNK)).toBe(0)
    expect(chunkCountFor(1, CHUNK)).toBe(1)
    expect(chunkCountFor(CHUNK, CHUNK)).toBe(1)
    expect(chunkCountFor(CHUNK + 1, CHUNK)).toBe(2)
    expect(chunkCountFor(CHUNK * 3, CHUNK)).toBe(3)
  })

  it('adds one GCM tag per chunk to the stored size', () => {
    expect(ciphertextSizeFor(CHUNK, CHUNK)).toBe(CHUNK + GCM_TAG_BYTES)
    expect(ciphertextSizeFor(CHUNK + 1, CHUNK)).toBe(CHUNK + 1 + 2 * GCM_TAG_BYTES)
  })

  it('reports the short length of the final chunk', () => {
    const size = CHUNK * 2 + 7
    expect(plaintextChunkLength(0, size, CHUNK)).toBe(CHUNK)
    expect(plaintextChunkLength(1, size, CHUNK)).toBe(CHUNK)
    expect(plaintextChunkLength(2, size, CHUNK)).toBe(7)
  })

  it('finds the largest plaintext that fits a ciphertext budget exactly', () => {
    // The real case: Supabase's free plan refuses anything over 50 MiB, and it
    // measures the ciphertext, not the file the user picked.
    const limit = 50 * 1024 * 1024
    const max = maxPlaintextFor(limit, 1_048_576)

    expect(max).toBe(52_428_000)
    expect(ciphertextSizeFor(max, 1_048_576)).toBe(limit)
    // One byte more must not fit -- that is the whole point of the function.
    expect(ciphertextSizeFor(max + 1, 1_048_576)).toBeGreaterThan(limit)
  })

  it('never proposes a plaintext whose ciphertext exceeds the budget', () => {
    for (const limit of [17, 100, 1024, CHUNK, CHUNK + 16, CHUNK * 4 + 7, 6_291_456]) {
      const max = maxPlaintextFor(limit, CHUNK)
      expect(ciphertextSizeFor(max, CHUNK)).toBeLessThanOrEqual(limit)
      if (max > 0) expect(ciphertextSizeFor(max + 1, CHUNK)).toBeGreaterThan(limit)
    }
  })

  it('allows nothing when the budget cannot even cover one tag', () => {
    expect(maxPlaintextFor(GCM_TAG_BYTES, CHUNK)).toBe(0)
    expect(maxPlaintextFor(0, CHUNK)).toBe(0)
  })

  it('refuses a chunk index outside the media', () => {
    expect(() => plaintextChunkLength(2, CHUNK, CHUNK)).toThrow(/outside/)
    expect(() => plaintextChunkLength(-1, CHUNK, CHUNK)).toThrow(/outside/)
  })
})

describe('nonce and AAD construction', () => {
  it('builds a 12-byte nonce from the prefix and the index', () => {
    const prefix = Uint8Array.from([1, 2, 3, 4])
    expect([...chunkNonce(prefix, 0)]).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0])
    expect([...chunkNonce(prefix, 258)]).toEqual([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 1, 2])
  })

  it('gives every chunk of an item a distinct nonce', () => {
    const prefix = generateNoncePrefix()
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(chunkNonce(prefix, i).join(','))
    expect(seen.size).toBe(500)
  })

  it('rejects a prefix that is not four bytes', () => {
    expect(() => chunkNonce(Uint8Array.from([1, 2, 3]), 0)).toThrow(/4 bytes/)
  })

  it('binds all three of media id, index and count', () => {
    const base = chunkAad(MEDIA_ID, 1, 4).join(',')
    expect(chunkAad(MEDIA_ID, 2, 4).join(',')).not.toBe(base)
    expect(chunkAad(MEDIA_ID, 1, 5).join(',')).not.toBe(base)
    expect(chunkAad(`${MEDIA_ID}x`, 1, 4).join(',')).not.toBe(base)
  })
})

describe('chunk round trip', () => {
  it('round trips a single short chunk', async () => {
    const plaintext = pattern(10)
    const { key, params, stored } = await seal(plaintext)

    expect(stored.length).toBe(10 + GCM_TAG_BYTES)
    expect([...(await decryptChunk(key, params, 0, stored))]).toEqual([...plaintext])
  })

  it('round trips several chunks with a short final chunk', async () => {
    const plaintext = pattern(CHUNK * 3 + 5)
    const { key, params, stored } = await seal(plaintext)

    expect(params.chunkCount).toBe(4)
    expect(stored.length).toBe(plaintext.length + 4 * GCM_TAG_BYTES)

    const out: number[] = []
    const storedChunk = CHUNK + GCM_TAG_BYTES
    for (let i = 0; i < params.chunkCount; i++) {
      const piece = stored.subarray(i * storedChunk, Math.min((i + 1) * storedChunk, stored.length))
      out.push(...(await decryptChunk(key, params, i, piece)))
    }
    expect(out).toEqual([...plaintext])
  })

  it('round trips a size that is an exact multiple of the chunk size', async () => {
    const plaintext = pattern(CHUNK * 2)
    const { key, params, stored } = await seal(plaintext)

    expect(params.chunkCount).toBe(2)
    const storedChunk = CHUNK + GCM_TAG_BYTES
    expect([...(await decryptChunk(key, params, 1, stored.subarray(storedChunk)))]).toEqual([
      ...plaintext.subarray(CHUNK),
    ])
  })

  it('refuses to seal a short chunk that is not the last one', async () => {
    const { key, params } = await seal(pattern(CHUNK * 2))
    await expect(encryptChunk(key, params, 0, pattern(CHUNK - 1))).rejects.toThrow(
      /short but is not the final chunk/,
    )
  })

  it('refuses a chunk index past the declared count', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK))
    await expect(encryptChunk(key, params, 1, pattern(CHUNK))).rejects.toThrow(/past the declared/)
    await expect(decryptChunk(key, params, 1, stored)).rejects.toThrow(/past the declared/)
  })
})

describe('the AAD is what makes the stream authenticated', () => {
  it('rejects a chunk decrypted at the wrong index (reordering)', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK * 2))
    const storedChunk = CHUNK + GCM_TAG_BYTES
    const second = stored.subarray(storedChunk)

    // Correct at 1, and must not verify at 0.
    await expect(decryptChunk(key, params, 1, second)).resolves.toBeInstanceOf(Uint8Array)
    await expect(decryptChunk(key, params, 0, second)).rejects.toThrow()
  })

  it('rejects a truncated file, because chunkCount is bound in', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK * 3))
    const firstChunk = stored.subarray(0, CHUNK + GCM_TAG_BYTES)

    // An attacker drops the tail and claims the file was always one chunk long.
    const truncated: ChunkParams = { ...params, chunkCount: 1 }
    await expect(decryptChunk(key, truncated, 0, firstChunk)).rejects.toThrow()
  })

  it('rejects a chunk spliced in from another media item', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK))
    const impostor: ChunkParams = { ...params, mediaId: '6f1c2a3e-0000-4000-8000-000000000002' }
    await expect(decryptChunk(key, impostor, 0, stored)).rejects.toThrow()
  })

  it('rejects a single flipped ciphertext byte', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK))
    await expect(decryptChunk(key, params, 0, flipByte(stored, 3))).rejects.toThrow()
  })

  it('rejects a flipped byte inside the GCM tag', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK))
    const last = stored.length - 1
    await expect(decryptChunk(key, params, 0, flipByte(stored, last))).rejects.toThrow()
  })

  it('rejects a chunk read under the wrong nonce prefix', async () => {
    const { key, params, stored } = await seal(pattern(CHUNK))
    const wrong: ChunkParams = { ...params, noncePrefix: Uint8Array.from([9, 9, 9, 9]) }
    await expect(decryptChunk(key, wrong, 0, stored)).rejects.toThrow()
  })

  it('rejects a chunk read under a different content key', async () => {
    const { params, stored } = await seal(pattern(CHUNK))
    const other = await generateContentKey()
    await expect(decryptChunk(other.key, params, 0, stored)).rejects.toThrow()
  })

  it('rejects a chunk too short to hold a tag', async () => {
    const { key, params } = await seal(pattern(CHUNK))
    await expect(decryptChunk(key, params, 0, new Uint8Array(GCM_TAG_BYTES))).rejects.toThrow(
      /too short/,
    )
  })
})

describe('planRange', () => {
  const size = CHUNK * 3 + 5 // 4 chunks, last one short
  const params = { chunkSize: CHUNK, chunkCount: chunkCountFor(size, CHUNK) }
  const stored = ciphertextSizeFor(size, CHUNK)

  it('maps the whole file', () => {
    const plan = planRange(params, size, 0, size - 1)
    expect(plan).toMatchObject({ firstChunk: 0, lastChunk: 3, ctStart: 0, offsetInFirstChunk: 0 })
    expect(plan.ctEnd).toBe(stored - 1)
    expect(plan.length).toBe(size)
  })

  it('maps a single byte in the middle of a chunk', () => {
    const plan = planRange(params, size, CHUNK + 10, CHUNK + 10)
    expect(plan.firstChunk).toBe(1)
    expect(plan.lastChunk).toBe(1)
    expect(plan.ctStart).toBe(CHUNK + GCM_TAG_BYTES)
    expect(plan.ctEnd).toBe(2 * (CHUNK + GCM_TAG_BYTES) - 1)
    expect(plan.offsetInFirstChunk).toBe(10)
    expect(plan.length).toBe(1)
  })

  it('keeps a request that lands exactly on a chunk boundary in one chunk', () => {
    const plan = planRange(params, size, CHUNK, CHUNK * 2 - 1)
    expect(plan.firstChunk).toBe(1)
    expect(plan.lastChunk).toBe(1)
    expect(plan.offsetInFirstChunk).toBe(0)
    expect(plan.length).toBe(CHUNK)
  })

  it('spans chunks when the request straddles a boundary by one byte', () => {
    const plan = planRange(params, size, CHUNK - 1, CHUNK)
    expect(plan.firstChunk).toBe(0)
    expect(plan.lastChunk).toBe(1)
    expect(plan.length).toBe(2)
  })

  it('clamps the ciphertext end to the object, since the last chunk is short', () => {
    const plan = planRange(params, size, CHUNK * 3, size - 1)
    expect(plan.lastChunk).toBe(3)
    expect(plan.ctEnd).toBe(stored - 1)
    // Naively, (3 + 1) * (CHUNK + tag) - 1 would run past the end of the object.
    expect(plan.ctEnd).toBeLessThan(4 * (CHUNK + GCM_TAG_BYTES) - 1)
  })

  it('clamps an open-ended request past the end of the media', () => {
    const plan = planRange(params, size, 0, Number.MAX_SAFE_INTEGER)
    expect(plan.length).toBe(size)
    expect(plan.ctEnd).toBe(stored - 1)
  })

  it('handles media smaller than one chunk', () => {
    const tiny = { chunkSize: CHUNK, chunkCount: 1 }
    const plan = planRange(tiny, 10, 0, 9)
    expect(plan).toMatchObject({ firstChunk: 0, lastChunk: 0, ctStart: 0, length: 10 })
    expect(plan.ctEnd).toBe(10 + GCM_TAG_BYTES - 1)
  })

  it('rejects nonsense ranges', () => {
    expect(() => planRange(params, size, -1, 10)).toThrow(/invalid range start/)
    expect(() => planRange(params, size, size, size)).toThrow(/past the end/)
    expect(() => planRange(params, size, 10, 4)).toThrow(/ends before it starts/)
    expect(() => planRange(params, 0, 0, 0)).toThrow(/empty media/)
  })
})

describe('decryptRange', () => {
  const size = CHUNK * 3 + 5

  async function readBack(start: number, end: number) {
    const plaintext = pattern(size)
    const { key, params, stored } = await seal(plaintext)
    const plan = planRange(params, size, start, end)
    const fetched = stored.subarray(plan.ctStart, plan.ctEnd + 1)
    const got = await decryptRange(key, params, plan, fetched)
    return { got: [...got], want: [...plaintext.subarray(start, start + plan.length)] }
  }

  it('returns exactly the bytes asked for, mid-chunk', async () => {
    const { got, want } = await readBack(CHUNK + 7, CHUNK + 20)
    expect(got).toEqual(want)
    expect(got.length).toBe(14)
  })

  it('returns exactly the bytes asked for across three chunks', async () => {
    const { got, want } = await readBack(CHUNK - 3, CHUNK * 2 + 3)
    expect(got).toEqual(want)
  })

  it('reads the whole file', async () => {
    const { got, want } = await readBack(0, size - 1)
    expect(got).toEqual(want)
    expect(got.length).toBe(size)
  })

  it('reads a range entirely inside the short final chunk', async () => {
    const { got, want } = await readBack(CHUNK * 3 + 1, size - 1)
    expect(got).toEqual(want)
    expect(got.length).toBe(4)
  })

  it('reads the very last byte', async () => {
    const { got, want } = await readBack(size - 1, size - 1)
    expect(got).toEqual(want)
    expect(got.length).toBe(1)
  })

  it('fails loudly when handed a short read rather than returning partial bytes', async () => {
    const plaintext = pattern(size)
    const { key, params, stored } = await seal(plaintext)
    const plan = planRange(params, size, 0, size - 1)
    const truncated = stored.subarray(plan.ctStart, plan.ctEnd) // one byte short

    await expect(decryptRange(key, params, plan, truncated)).rejects.toThrow()
  })
})
