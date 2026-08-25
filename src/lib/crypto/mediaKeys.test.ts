// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { generateContentKey } from './chunkCipher'
import {
  decryptMetadata,
  decryptThumbnail,
  encryptMetadata,
  encryptThumbnail,
  type MediaMetadata,
} from './mediaMetadata'
import {
  MEDIA_KEY_VERSION,
  unwrapContentKey,
  unwrapContentKeyRaw,
  wrapContentKeyFor,
} from './mediaKeys'
import {
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair,
  importPrivateKey,
} from './primitives'
import { bytesEqual, utf8 } from './bytes'

const MEDIA_ID = '6f1c2a3e-0000-4000-8000-000000000001'
const RECIPIENT_ID = 'd0a62a72-8326-44a6-9c94-b3efaae3c57d'

/** A recipient: SPKI to grant to, non-extractable private key to open with. */
async function identity() {
  const pair = await generateIdentityKeyPair(true)
  return {
    publicKey: await exportPublicKey(pair.publicKey),
    privateKey: await importPrivateKey(await exportPrivateKey(pair.privateKey)),
  }
}

function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes)
  copy.set([(copy.at(index) ?? 0) ^ 0xff], index)
  return copy
}

/** Two AES keys are the same if one can read what the other wrote. */
async function opensTheSameData(writer: CryptoKey, reader: CryptoKey): Promise<boolean> {
  const blob = await encryptThumbnail(writer, utf8('poster bytes'))
  try {
    return bytesEqual(await decryptThumbnail(reader, blob), utf8('poster bytes'))
  } catch {
    return false
  }
}

describe('wrapping a content key for a recipient', () => {
  it('round trips: the recipient recovers a key that opens the media', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()

    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)
    const opened = await unwrapContentKey(grant, recipient.privateKey, MEDIA_ID, RECIPIENT_ID)

    expect(await opensTheSameData(cek.key, opened)).toBe(true)
  })

  it('hands back a non-extractable key, so a recipient cannot re-share the raw CEK', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)
    const opened = await unwrapContentKey(grant, recipient.privateKey, MEDIA_ID, RECIPIENT_ID)

    expect(opened.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', opened)).rejects.toThrow()
  })

  it('uses a fresh ephemeral key for every grant', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()

    const one = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)
    const two = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    expect(bytesEqual(one.ephemeralPublicKey, two.ephemeralPublicKey)).toBe(false)
    expect(bytesEqual(one.hkdfSalt, two.hkdfSalt)).toBe(false)
    expect(bytesEqual(one.nonce, two.nonce)).toBe(false)
    expect(bytesEqual(one.wrappedKey, two.wrappedKey)).toBe(false)

    // Both still open, and to the same key.
    for (const grant of [one, two]) {
      const opened = await unwrapContentKey(grant, recipient.privateKey, MEDIA_ID, RECIPIENT_ID)
      expect(await opensTheSameData(cek.key, opened)).toBe(true)
    }
  })

  it('stamps the version so a format change can be detected', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    expect(grant.version).toBe(MEDIA_KEY_VERSION)
    await expect(
      unwrapContentKey({ ...grant, version: 99 }, recipient.privateKey, MEDIA_ID, RECIPIENT_ID),
    ).rejects.toThrow(/Unsupported media key version/)
  })
})

describe('a grant is bound to one media item, one recipient, one key', () => {
  it('cannot be opened by anybody else', async () => {
    const recipient = await identity()
    const stranger = await identity()
    const cek = await generateContentKey()

    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)
    await expect(
      unwrapContentKey(grant, stranger.privateKey, MEDIA_ID, RECIPIENT_ID),
    ).rejects.toThrow()
  })

  it('cannot be replayed against a different media item', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    await expect(
      unwrapContentKey(grant, recipient.privateKey, `${MEDIA_ID}-other`, RECIPIENT_ID),
    ).rejects.toThrow()
  })

  it('cannot be replayed against a different recipient id', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    // Same private key, but the row moved to another user's name: the HKDF info
    // differs, so the derived wrapping key does too.
    await expect(
      unwrapContentKey(grant, recipient.privateKey, MEDIA_ID, 'someone-else'),
    ).rejects.toThrow()
  })

  it('rejects a tampered salt, nonce, ciphertext or ephemeral key', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    const mutations = [
      { ...grant, hkdfSalt: flipByte(grant.hkdfSalt, 0) },
      { ...grant, nonce: flipByte(grant.nonce, 0) },
      { ...grant, wrappedKey: flipByte(grant.wrappedKey, 0) },
      { ...grant, wrappedKey: flipByte(grant.wrappedKey, grant.wrappedKey.length - 1) },
    ]

    for (const mutated of mutations) {
      await expect(
        unwrapContentKey(mutated, recipient.privateKey, MEDIA_ID, RECIPIENT_ID),
      ).rejects.toThrow()
    }
  })

  it('rejects a substituted ephemeral public key', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)
    const other = await wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, RECIPIENT_ID)

    await expect(
      unwrapContentKey(
        { ...grant, ephemeralPublicKey: other.ephemeralPublicKey },
        recipient.privateKey,
        MEDIA_ID,
        RECIPIENT_ID,
      ),
    ).rejects.toThrow()
  })

  it('refuses to wrap without a media id or a recipient id', async () => {
    const recipient = await identity()
    const cek = await generateContentKey()

    await expect(wrapContentKeyFor(cek.raw, recipient.publicKey, '', RECIPIENT_ID)).rejects.toThrow(
      /required/,
    )
    await expect(wrapContentKeyFor(cek.raw, recipient.publicKey, MEDIA_ID, '')).rejects.toThrow(
      /required/,
    )
  })
})

describe('encrypted metadata and thumbnail', () => {
  const metadata: MediaMetadata = {
    title: 'Holiday 2019 — Ada’s birthday',
    durationMs: 5_400_000,
    width: 1920,
    height: 1080,
  }

  it('round trips a title with non-ASCII characters intact', async () => {
    const { key } = await generateContentKey()
    const blob = await encryptMetadata(key, metadata)
    expect(await decryptMetadata(key, blob)).toEqual(metadata)
  })

  it('leaks nothing recognisable into the ciphertext', async () => {
    const { key } = await generateContentKey()
    const blob = await encryptMetadata(key, metadata)
    // The title must not be sitting there in the bytes we hand to Supabase.
    expect(new TextDecoder().decode(blob.ciphertext)).not.toContain('Holiday')
  })

  it('gives every write a fresh nonce', async () => {
    const { key } = await generateContentKey()
    const one = await encryptMetadata(key, metadata)
    const two = await encryptMetadata(key, metadata)
    expect(bytesEqual(one.nonce, two.nonce)).toBe(false)
    expect(bytesEqual(one.ciphertext, two.ciphertext)).toBe(false)
  })

  it('round trips thumbnail bytes', async () => {
    const { key } = await generateContentKey()
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
    const blob = await encryptThumbnail(key, jpeg)
    expect(bytesEqual(await decryptThumbnail(key, blob), jpeg)).toBe(true)
  })

  it('will not read a thumbnail as metadata, or the reverse', async () => {
    const { key } = await generateContentKey()
    const meta = await encryptMetadata(key, metadata)
    const thumb = await encryptThumbnail(key, utf8('poster'))

    // Swapping the two columns must fail the tag, not silently decrypt.
    await expect(decryptThumbnail(key, meta)).rejects.toThrow()
    await expect(decryptMetadata(key, thumb)).rejects.toThrow()
  })

  it('rejects metadata encrypted under another content key', async () => {
    const { key } = await generateContentKey()
    const other = await generateContentKey()
    const blob = await encryptMetadata(key, metadata)
    await expect(decryptMetadata(other.key, blob)).rejects.toThrow()
  })

  it('rejects a tampered metadata blob', async () => {
    const { key } = await generateContentKey()
    const blob = await encryptMetadata(key, metadata)
    await expect(
      decryptMetadata(key, { ...blob, ciphertext: flipByte(blob.ciphertext, 2) }),
    ).rejects.toThrow()
  })

  it('does not carry stray properties into storage', async () => {
    const { key } = await generateContentKey()
    const contaminated = { ...metadata, storagePath: 'owner/secret.enc' } as MediaMetadata
    const blob = await encryptMetadata(key, contaminated)
    expect(await decryptMetadata(key, blob)).not.toHaveProperty('storagePath')
  })

  it('survives a row written by an older client with missing dimensions', async () => {
    const { key } = await generateContentKey()
    // Hand-rolled payload: only a title, as an early version might have stored.
    const legacy = await encryptMetadataRaw(key, '{"title":"Old upload"}')
    expect(await decryptMetadata(key, legacy)).toEqual({
      title: 'Old upload',
      durationMs: 0,
      width: 0,
      height: 0,
    })
  })

  it('refuses a payload with no title at all', async () => {
    const { key } = await generateContentKey()
    const broken = await encryptMetadataRaw(key, '{"durationMs":1}')
    await expect(decryptMetadata(key, broken)).rejects.toThrow(/no title/)
  })

  it('refuses a payload that is not JSON', async () => {
    const { key } = await generateContentKey()
    const broken = await encryptMetadataRaw(key, 'not json at all')
    await expect(decryptMetadata(key, broken)).rejects.toThrow(/not valid JSON/)
  })
})

/** Seal an arbitrary payload under the metadata AAD, to fake an odd row. */
async function encryptMetadataRaw(key: CryptoKey, json: string) {
  const { aesGcmEncrypt, GCM_NONCE_BYTES } = await import('./primitives')
  const { randomBytes } = await import('./bytes')
  const nonce = randomBytes(GCM_NONCE_BYTES)
  return {
    nonce,
    ciphertext: await aesGcmEncrypt(key, nonce, utf8(json), utf8('media:meta:v1')),
  }
}

describe('unwrapContentKeyRaw', () => {
  it('gives an owner the bytes back so they can re-grant to somebody else', async () => {
    const owner = await identity()
    const friend = await identity()
    const cek = await generateContentKey()

    // The owner is their own first recipient; that is how they get the key back.
    const ownGrant = await wrapContentKeyFor(cek.raw, owner.publicKey, MEDIA_ID, 'owner-id')
    const recovered = await unwrapContentKeyRaw(ownGrant, owner.privateKey, MEDIA_ID, 'owner-id')
    expect(bytesEqual(recovered, cek.raw)).toBe(true)

    // ...and re-wrapping from those bytes produces a grant the friend can open.
    const passedOn = await wrapContentKeyFor(recovered, friend.publicKey, MEDIA_ID, 'friend-id')
    const opened = await unwrapContentKey(passedOn, friend.privateKey, MEDIA_ID, 'friend-id')
    expect(await opensTheSameData(cek.key, opened)).toBe(true)
  })

  it('still refuses a grant that was not addressed to the caller', async () => {
    const owner = await identity()
    const stranger = await identity()
    const cek = await generateContentKey()
    const grant = await wrapContentKeyFor(cek.raw, owner.publicKey, MEDIA_ID, 'owner-id')

    await expect(
      unwrapContentKeyRaw(grant, stranger.privateKey, MEDIA_ID, 'owner-id'),
    ).rejects.toThrow()
  })
})
