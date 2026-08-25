/**
 * Thin, opinionated wrappers over WebCrypto.
 *
 * Every algorithm choice here is fixed by docs/CRYPTO.md. Do not add
 * parameters that let a caller weaken them.
 */

import { view } from './bytes'

export const AES_KEY_BITS = 256
export const GCM_NONCE_BYTES = 12
export const GCM_TAG_BYTES = 16

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }

/* -------------------------------------------------------------------------- */
/* AES-256-GCM                                                                 */
/* -------------------------------------------------------------------------- */

/** Import raw 32 bytes as an AES-GCM key. Non-extractable by default. */
export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new Error(`AES-256 key must be 32 bytes, got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', toBuffer(raw), 'AES-GCM', extractable, [
    'encrypt',
    'decrypt',
  ])
}

export async function generateAesKey(extractable = false): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_BITS }, extractable, [
    'encrypt',
    'decrypt',
  ])
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertNonce(nonce)
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad) },
    key,
    toBuffer(plaintext),
  )
  return view(out)
}

/**
 * Decrypt and authenticate. Throws if the GCM tag does not verify -- callers
 * must never swallow that error and return partial data.
 */
export async function aesGcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertNonce(nonce)
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad) },
    key,
    toBuffer(ciphertext),
  )
  return view(out)
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`AES-GCM nonce must be ${GCM_NONCE_BYTES} bytes, got ${nonce.length}`)
  }
}

/* -------------------------------------------------------------------------- */
/* ECDH P-256                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generate an identity keypair.
 *
 * `extractable` must be true at signup because the private key has to be
 * exported to PKCS8 so it can be wrapped. Re-import it non-extractable
 * (`importPrivateKey`) for everyday use.
 */
export async function generateIdentityKeyPair(extractable = true): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ECDH_PARAMS, extractable, [
    'deriveBits',
  ])) as CryptoKeyPair
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return view(await crypto.subtle.exportKey('spki', key))
}

export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  return view(await crypto.subtle.exportKey('pkcs8', key))
}

export async function importPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', toBuffer(spki), ECDH_PARAMS, true, [])
}

/** Import a PKCS8 private key. Non-extractable unless explicitly requested. */
export async function importPrivateKey(pkcs8: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', toBuffer(pkcs8), ECDH_PARAMS, extractable, ['deriveBits'])
}

/** Raw ECDH shared secret. Never use this directly as a key -- run it through HKDF. */
export async function ecdhSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  return view(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256))
}

/* -------------------------------------------------------------------------- */
/* HKDF-SHA-256                                                                */
/* -------------------------------------------------------------------------- */

/** Derive a 32-byte AES-GCM key from input keying material. */
export async function hkdfAesKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', toBuffer(ikm), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toBuffer(salt), info: toBuffer(info) },
    base,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * WebCrypto wants an ArrayBuffer. A Uint8Array may be a window onto a larger
 * buffer (common after `.subarray()`), so slice to exactly the bytes in view --
 * passing `.buffer` directly is a real and easily-missed bug.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer)
}
