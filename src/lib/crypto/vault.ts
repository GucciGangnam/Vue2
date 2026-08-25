/**
 * The key vault: create, unlock, and re-wrap a user's ECDH identity key.
 *
 * The private key exists on the server only as two independent AES-256-GCM
 * ciphertexts -- one under a key derived from the password, one under a key
 * derived from the recovery phrase. Neither the plaintext key nor either
 * derived key ever leaves the device. See docs/CRYPTO.md section 2.
 */

import { randomBytes, wipe } from './bytes'
import { utf8 } from './bytes'
import { DEFAULT_KDF_PARAMS, deriveKey, type KdfParams } from './kdf'
import { generateRecoveryPhrase, normaliseRecoveryPhrase } from './mnemonic'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportPrivateKey,
  exportPublicKey,
  generateIdentityKeyPair,
  importAesKey,
  importPrivateKey,
} from './primitives'

export const VAULT_VERSION = 1

const AAD_PASSWORD = utf8('vault:pw:v1')
const AAD_RECOVERY = utf8('vault:rc:v1')
const SALT_BYTES = 16
const NONCE_BYTES = 12

/** The wrapped-key material as it is stored in `user_private_keys`. */
export interface VaultRecord {
  version: number
  kdfParams: KdfParams
  pwSalt: Uint8Array
  pwNonce: Uint8Array
  pwWrappedKey: Uint8Array
  rcSalt: Uint8Array
  rcNonce: Uint8Array
  rcWrappedKey: Uint8Array
}

export interface CreatedVault {
  record: VaultRecord
  /** SPKI bytes for `user_public_keys.public_key`. */
  publicKey: Uint8Array
  /** Non-extractable, ready for ECDH. */
  privateKey: CryptoKey
  /** Show once, then never again. */
  recoveryPhrase: string
}

export type VaultUnlockFailure = 'wrong-password' | 'wrong-phrase' | 'corrupt'

/**
 * Distinguishes "you typed the wrong password" from "something is broken", so
 * the UI can say the right thing instead of a generic failure.
 */
export class VaultUnlockError extends Error {
  readonly reason: VaultUnlockFailure

  constructor(reason: VaultUnlockFailure) {
    super(
      reason === 'wrong-password'
        ? 'Incorrect password'
        : reason === 'wrong-phrase'
          ? 'That recovery phrase does not match this account'
          : 'Vault data is corrupt or was tampered with',
    )
    this.name = 'VaultUnlockError'
    this.reason = reason
  }
}

interface Wrap {
  salt: Uint8Array
  nonce: Uint8Array
  ciphertext: Uint8Array
}

async function wrapPkcs8(
  pkcs8: Uint8Array,
  secret: string,
  aad: Uint8Array,
  params: KdfParams,
): Promise<Wrap> {
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const derived = await deriveKey(secret, salt, params)
  try {
    const key = await importAesKey(derived)
    return { salt, nonce, ciphertext: await aesGcmEncrypt(key, nonce, pkcs8, aad) }
  } finally {
    wipe(derived)
  }
}

async function unwrapPkcs8(
  wrap: Wrap,
  secret: string,
  aad: Uint8Array,
  params: KdfParams,
  failure: VaultUnlockFailure,
): Promise<Uint8Array> {
  const derived = await deriveKey(secret, wrap.salt, params)
  try {
    const key = await importAesKey(derived)
    return await aesGcmDecrypt(key, wrap.nonce, wrap.ciphertext, aad)
  } catch {
    // A GCM tag failure cannot tell "wrong key" from "tampered ciphertext".
    // Report the benign, overwhelmingly-likely cause.
    throw new VaultUnlockError(failure)
  } finally {
    wipe(derived)
  }
}

/**
 * Create a fresh identity and wrap it under both secrets.
 *
 * The returned `privateKey` is re-imported as non-extractable: the extractable
 * copy exists only for as long as it takes to wrap it.
 */
export async function createVault(
  password: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<CreatedVault> {
  const recoveryPhrase = generateRecoveryPhrase()
  const pair = await generateIdentityKeyPair(true)

  const publicKey = await exportPublicKey(pair.publicKey)
  const pkcs8 = await exportPrivateKey(pair.privateKey)

  try {
    const [pw, rc] = await Promise.all([
      wrapPkcs8(pkcs8, password, AAD_PASSWORD, kdfParams),
      wrapPkcs8(pkcs8, normaliseRecoveryPhrase(recoveryPhrase), AAD_RECOVERY, kdfParams),
    ])

    return {
      record: {
        version: VAULT_VERSION,
        kdfParams,
        pwSalt: pw.salt,
        pwNonce: pw.nonce,
        pwWrappedKey: pw.ciphertext,
        rcSalt: rc.salt,
        rcNonce: rc.nonce,
        rcWrappedKey: rc.ciphertext,
      },
      publicKey,
      privateKey: await importPrivateKey(pkcs8, false),
      recoveryPhrase,
    }
  } finally {
    wipe(pkcs8)
  }
}

export async function unlockWithPassword(
  record: VaultRecord,
  password: string,
): Promise<CryptoKey> {
  const pkcs8 = await unwrapPkcs8(
    { salt: record.pwSalt, nonce: record.pwNonce, ciphertext: record.pwWrappedKey },
    password,
    AAD_PASSWORD,
    record.kdfParams,
    'wrong-password',
  )
  try {
    return await importPrivateKey(pkcs8, false)
  } finally {
    wipe(pkcs8)
  }
}

export async function unlockWithRecoveryPhrase(
  record: VaultRecord,
  phrase: string,
): Promise<CryptoKey> {
  const pkcs8 = await unwrapPkcs8(
    { salt: record.rcSalt, nonce: record.rcNonce, ciphertext: record.rcWrappedKey },
    normaliseRecoveryPhrase(phrase),
    AAD_RECOVERY,
    record.kdfParams,
    'wrong-phrase',
  )
  try {
    return await importPrivateKey(pkcs8, false)
  } finally {
    wipe(pkcs8)
  }
}

/**
 * Change the password wrap, leaving the recovery wrap untouched.
 * Requires the current password -- we need the plaintext PKCS8 to re-wrap it.
 */
export async function changePassword(
  record: VaultRecord,
  currentPassword: string,
  newPassword: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<VaultRecord> {
  const pkcs8 = await unwrapPkcs8(
    { salt: record.pwSalt, nonce: record.pwNonce, ciphertext: record.pwWrappedKey },
    currentPassword,
    AAD_PASSWORD,
    record.kdfParams,
    'wrong-password',
  )
  try {
    const pw = await wrapPkcs8(pkcs8, newPassword, AAD_PASSWORD, kdfParams)
    return { ...record, kdfParams, pwSalt: pw.salt, pwNonce: pw.nonce, pwWrappedKey: pw.ciphertext }
  } finally {
    wipe(pkcs8)
  }
}

/**
 * Re-establish a password wrap using the recovery phrase, for someone who has
 * forgotten their password. This is the *only* path that restores access after
 * an email password reset -- the reset itself cannot touch the vault.
 */
export async function resetPasswordWithRecoveryPhrase(
  record: VaultRecord,
  phrase: string,
  newPassword: string,
  kdfParams: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<VaultRecord> {
  const pkcs8 = await unwrapPkcs8(
    { salt: record.rcSalt, nonce: record.rcNonce, ciphertext: record.rcWrappedKey },
    normaliseRecoveryPhrase(phrase),
    AAD_RECOVERY,
    record.kdfParams,
    'wrong-phrase',
  )
  try {
    const pw = await wrapPkcs8(pkcs8, newPassword, AAD_PASSWORD, kdfParams)
    return { ...record, kdfParams, pwSalt: pw.salt, pwNonce: pw.nonce, pwWrappedKey: pw.ciphertext }
  } finally {
    wipe(pkcs8)
  }
}
