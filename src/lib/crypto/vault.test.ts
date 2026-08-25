// @vitest-environment node
//
// Node gives us a complete WebCrypto implementation; jsdom does not expose
// crypto.subtle. Argon2 cost is dialled right down so the suite stays fast --
// the parameters under test are the format, not the work factor.

import { describe, expect, it } from 'vitest'
import {
  changePassword,
  createVault,
  resetPasswordWithRecoveryPhrase,
  unlockWithPassword,
  unlockWithRecoveryPhrase,
  VaultUnlockError,
  type VaultRecord,
} from './vault'
import { ecdhSharedSecret, exportPublicKey, importPublicKey } from './primitives'
import { bytesEqual } from './bytes'
import type { KdfParams } from './kdf'
import { isValidRecoveryPhrase, normaliseRecoveryPhrase } from './mnemonic'

const FAST: KdfParams = { algo: 'argon2id', m: 256, t: 1, p: 1 }

/** Corrupt one byte, to prove the GCM tag actually catches it. */
function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes)
  copy.set([(copy.at(0) ?? 0) ^ 0xff], 0)
  return copy
}
const PASSWORD = 'correct horse battery staple'

/**
 * Two identity keys are "the same" if they agree on an ECDH shared secret with
 * the same third party. We cannot compare private keys directly -- they are
 * deliberately non-extractable.
 */
async function provesSameIdentity(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const { publicKey } = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair
  const [sa, sb] = await Promise.all([
    ecdhSharedSecret(a, publicKey),
    ecdhSharedSecret(b, publicKey),
  ])
  return bytesEqual(sa, sb)
}

describe('createVault', () => {
  it('produces a usable identity, a valid recovery phrase and both wraps', async () => {
    const vault = await createVault(PASSWORD, FAST)

    expect(isValidRecoveryPhrase(vault.recoveryPhrase)).toBe(true)
    expect(normaliseRecoveryPhrase(vault.recoveryPhrase).split(' ')).toHaveLength(12)

    // SPKI for P-256 is 91 bytes.
    expect(vault.publicKey.length).toBe(91)
    expect(vault.privateKey.extractable).toBe(false)

    expect(vault.record.pwSalt.length).toBe(16)
    expect(vault.record.pwNonce.length).toBe(12)
    expect(vault.record.rcSalt.length).toBe(16)
    expect(vault.record.rcNonce.length).toBe(12)

    // The two wraps must not collide: different salts, different nonces,
    // therefore different ciphertext for the same plaintext key.
    expect(bytesEqual(vault.record.pwSalt, vault.record.rcSalt)).toBe(false)
    expect(bytesEqual(vault.record.pwWrappedKey, vault.record.rcWrappedKey)).toBe(false)
  })

  it('generates a distinct identity every time', async () => {
    const [a, b] = await Promise.all([createVault(PASSWORD, FAST), createVault(PASSWORD, FAST)])
    expect(bytesEqual(a.publicKey, b.publicKey)).toBe(false)
    expect(a.recoveryPhrase).not.toBe(b.recoveryPhrase)
  })
})

describe('unlocking', () => {
  it('recovers the same identity from the password', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const unlocked = await unlockWithPassword(vault.record, PASSWORD)
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)
  })

  it('recovers the same identity from the recovery phrase', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const unlocked = await unlockWithRecoveryPhrase(vault.record, vault.recoveryPhrase)
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)
  })

  it('accepts a sloppily retyped recovery phrase', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const messy = `  ${vault.recoveryPhrase.toUpperCase().split(' ').join(',  ')}\n`
    const unlocked = await unlockWithRecoveryPhrase(vault.record, messy)
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)
  })

  it('rejects the wrong password with a distinguishable error', async () => {
    const vault = await createVault(PASSWORD, FAST)
    await expect(unlockWithPassword(vault.record, 'not the password')).rejects.toThrow(
      VaultUnlockError,
    )
    await expect(unlockWithPassword(vault.record, 'not the password')).rejects.toMatchObject({
      reason: 'wrong-password',
    })
  })

  it('rejects a valid-but-wrong recovery phrase', async () => {
    const [a, b] = await Promise.all([createVault(PASSWORD, FAST), createVault(PASSWORD, FAST)])
    await expect(unlockWithRecoveryPhrase(a.record, b.recoveryPhrase)).rejects.toMatchObject({
      reason: 'wrong-phrase',
    })
  })

  it('detects tampering with the wrapped key', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const tampered: VaultRecord = {
      ...vault.record,
      pwWrappedKey: flipFirstByte(vault.record.pwWrappedKey),
    }

    await expect(unlockWithPassword(tampered, PASSWORD)).rejects.toThrow(VaultUnlockError)
  })

  it('detects tampering with the nonce', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const tampered: VaultRecord = {
      ...vault.record,
      pwNonce: flipFirstByte(vault.record.pwNonce),
    }

    await expect(unlockWithPassword(tampered, PASSWORD)).rejects.toThrow(VaultUnlockError)
  })

  it('will not open the password wrap with the recovery phrase', async () => {
    // The two wraps use different AAD, so they must not be interchangeable even
    // if an attacker swaps the salt and nonce across.
    const vault = await createVault(PASSWORD, FAST)
    const swapped: VaultRecord = {
      ...vault.record,
      pwSalt: vault.record.rcSalt,
      pwNonce: vault.record.rcNonce,
      pwWrappedKey: vault.record.rcWrappedKey,
    }
    await expect(
      unlockWithPassword(swapped, normaliseRecoveryPhrase(vault.recoveryPhrase)),
    ).rejects.toThrow(VaultUnlockError)
  })
})

describe('changePassword', () => {
  it('rewraps under the new password and keeps the same identity', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const updated = await changePassword(vault.record, PASSWORD, 'a brand new password', FAST)

    const unlocked = await unlockWithPassword(updated, 'a brand new password')
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)

    await expect(unlockWithPassword(updated, PASSWORD)).rejects.toThrow(VaultUnlockError)
  })

  it('leaves the recovery wrap working', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const updated = await changePassword(vault.record, PASSWORD, 'another password', FAST)

    const unlocked = await unlockWithRecoveryPhrase(updated, vault.recoveryPhrase)
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)
  })

  it('refuses without the current password', async () => {
    const vault = await createVault(PASSWORD, FAST)
    await expect(changePassword(vault.record, 'wrong', 'new', FAST)).rejects.toMatchObject({
      reason: 'wrong-password',
    })
  })
})

describe('resetPasswordWithRecoveryPhrase', () => {
  it('restores access after a forgotten password', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const updated = await resetPasswordWithRecoveryPhrase(
      vault.record,
      vault.recoveryPhrase,
      'chosen after the reset',
      FAST,
    )

    const unlocked = await unlockWithPassword(updated, 'chosen after the reset')
    expect(await provesSameIdentity(vault.privateKey, unlocked)).toBe(true)
  })

  it('refuses a phrase from a different account', async () => {
    const [a, b] = await Promise.all([createVault(PASSWORD, FAST), createVault(PASSWORD, FAST)])
    await expect(
      resetPasswordWithRecoveryPhrase(a.record, b.recoveryPhrase, 'new', FAST),
    ).rejects.toMatchObject({ reason: 'wrong-phrase' })
  })
})

describe('public key round trip', () => {
  it('survives export and re-import', async () => {
    const vault = await createVault(PASSWORD, FAST)
    const reimported = await importPublicKey(vault.publicKey)
    const reexported = await exportPublicKey(reimported)
    expect(bytesEqual(reexported, vault.publicKey)).toBe(true)
  })
})
