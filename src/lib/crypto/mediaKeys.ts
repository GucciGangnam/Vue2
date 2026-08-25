/**
 * Sharing a content key -- docs/CRYPTO.md section 4.
 *
 * ECIES over ECDH P-256: a fresh ephemeral keypair per grant, an ECDH against
 * the recipient's long-term identity key, HKDF to a wrapping key, then
 * AES-256-GCM over the CEK. One row per (media, recipient).
 *
 * Why ephemeral: the owner's long-term key never touches the wrap, so
 * compromising it later does not retroactively unwrap every grant they ever
 * made. Only the ephemeral private key could, and it never leaves this
 * function -- it is generated, used once, and dropped.
 *
 * `mediaId` and `recipientUserId` are bound into the HKDF info, and `mediaId`
 * again into the GCM AAD. That is what stops a grant row being lifted and
 * replayed against a different media item, or against a different recipient:
 * the derived key simply comes out different and the tag fails.
 */

import { randomBytes, utf8, wipe } from './bytes'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  ecdhSharedSecret,
  exportPublicKey,
  generateIdentityKeyPair,
  hkdfAesKey,
  importAesKey,
  importPublicKey,
  GCM_NONCE_BYTES,
} from './primitives'

export const MEDIA_KEY_VERSION = 1

const HKDF_SALT_BYTES = 32

/** One `media_keys` row, in bytes rather than bytea strings. */
export interface WrappedContentKey {
  /** SPKI of the ephemeral public key, fresh per grant. */
  ephemeralPublicKey: Uint8Array
  hkdfSalt: Uint8Array
  nonce: Uint8Array
  wrappedKey: Uint8Array
  version: number
}

/**
 * Wrap `cek` so that only `recipientUserId` can open it.
 *
 * `cek` is the caller's to dispose of: wipe it once every recipient has been
 * granted. This function does not wipe it, because the owner usually grants to
 * several people from the same key.
 */
export async function wrapContentKeyFor(
  cek: Uint8Array,
  recipientPublicKeySpki: Uint8Array,
  mediaId: string,
  recipientUserId: string,
): Promise<WrappedContentKey> {
  if (!mediaId || !recipientUserId) {
    throw new Error('mediaId and recipientUserId are required to wrap a content key')
  }

  const ephemeral = await generateIdentityKeyPair(true)
  const recipientKey = await importPublicKey(recipientPublicKeySpki)

  const shared = await ecdhSharedSecret(ephemeral.privateKey, recipientKey)
  const hkdfSalt = randomBytes(HKDF_SALT_BYTES)
  const nonce = randomBytes(GCM_NONCE_BYTES)

  try {
    const wrapKey = await hkdfAesKey(shared, hkdfSalt, wrapInfo(mediaId, recipientUserId))
    return {
      ephemeralPublicKey: await exportPublicKey(ephemeral.publicKey),
      hkdfSalt,
      nonce,
      wrappedKey: await aesGcmEncrypt(wrapKey, nonce, cek, utf8(mediaId)),
      version: MEDIA_KEY_VERSION,
    }
  } finally {
    // The shared secret is as good as the wrapping key. Drop it immediately;
    // the ephemeral private key goes out of scope with it and is never stored.
    wipe(shared)
  }
}

/**
 * Open a grant and return the raw CEK.
 *
 * Only one caller should want this: an owner re-granting their own media to
 * somebody else, which needs the key bytes in order to wrap them again. The
 * result is live key material -- `wipe()` it as soon as the re-wrap is done.
 * Everything whose job is to *read* a video should use `unwrapContentKey`,
 * which never exposes the bytes at all.
 */
export async function unwrapContentKeyRaw(
  wrapped: WrappedContentKey,
  identityPrivateKey: CryptoKey,
  mediaId: string,
  recipientUserId: string,
): Promise<Uint8Array> {
  if (wrapped.version !== MEDIA_KEY_VERSION) {
    throw new Error(`Unsupported media key version ${wrapped.version}`)
  }

  const ephemeralKey = await importPublicKey(wrapped.ephemeralPublicKey)
  const shared = await ecdhSharedSecret(identityPrivateKey, ephemeralKey)

  try {
    const wrapKey = await hkdfAesKey(shared, wrapped.hkdfSalt, wrapInfo(mediaId, recipientUserId))
    return await aesGcmDecrypt(wrapKey, wrapped.nonce, wrapped.wrappedKey, utf8(mediaId))
  } finally {
    wipe(shared)
  }
}

/**
 * Open a grant for playback.
 *
 * Returns a **non-extractable** AES key and wipes the raw bytes on the way out,
 * so a compromised page can decrypt what this user was already allowed to watch
 * but cannot lift the key out and hand it to anyone else.
 */
export async function unwrapContentKey(
  wrapped: WrappedContentKey,
  identityPrivateKey: CryptoKey,
  mediaId: string,
  recipientUserId: string,
): Promise<CryptoKey> {
  const raw = await unwrapContentKeyRaw(wrapped, identityPrivateKey, mediaId, recipientUserId)
  try {
    return await importAesKey(raw)
  } finally {
    wipe(raw)
  }
}

function wrapInfo(mediaId: string, recipientUserId: string): Uint8Array {
  return utf8(`mediakey:v1:${mediaId}:${recipientUserId}`)
}
