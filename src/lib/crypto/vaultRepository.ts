/**
 * Moves vault material between the app and Supabase.
 *
 * The only thing that crosses this boundary is ciphertext plus the public
 * parameters needed to derive a key from a secret the user supplies. If you
 * find yourself adding a field here that came from a password, stop.
 */

import { supabase } from '../supabase'
import { fromBytea, toBytea } from './bytes'
import { kdfParamsToJson, parseKdfParams } from './kdf'
import type { VaultRecord } from './vault'

export interface StoredIdentity {
  record: VaultRecord
  publicKey: Uint8Array
}

/** Read the current user's vault. `null` means they have not set one up yet. */
export async function loadVault(userId: string): Promise<StoredIdentity | null> {
  const [privateResult, publicResult] = await Promise.all([
    supabase.from('user_private_keys').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('user_public_keys').select('public_key').eq('user_id', userId).maybeSingle(),
  ])

  if (privateResult.error) throw privateResult.error
  if (publicResult.error) throw publicResult.error
  if (!privateResult.data || !publicResult.data) return null

  const row = privateResult.data
  return {
    record: {
      version: row.version,
      kdfParams: parseKdfParams(row.kdf_params),
      pwSalt: fromBytea(row.pw_salt),
      pwNonce: fromBytea(row.pw_nonce),
      pwWrappedKey: fromBytea(row.pw_wrapped_key),
      rcSalt: fromBytea(row.rc_salt),
      rcNonce: fromBytea(row.rc_nonce),
      rcWrappedKey: fromBytea(row.rc_wrapped_key),
    },
    publicKey: fromBytea(publicResult.data.public_key),
  }
}

/**
 * Persist a newly created vault.
 *
 * The public key is written first: if the second insert fails the user retries
 * setup, and an orphan public key with no matching private key is harmless
 * (`loadVault` treats a half-written pair as "no vault"). The reverse order
 * would leave a private key nobody can share media with.
 */
export async function saveNewVault(userId: string, identity: StoredIdentity): Promise<void> {
  const { error: publicError } = await supabase
    .from('user_public_keys')
    .insert({ user_id: userId, public_key: toBytea(identity.publicKey) })
  if (publicError) throw publicError

  const { error: privateError } = await supabase.from('user_private_keys').insert({
    user_id: userId,
    version: identity.record.version,
    kdf_params: kdfParamsToJson(identity.record.kdfParams),
    pw_salt: toBytea(identity.record.pwSalt),
    pw_nonce: toBytea(identity.record.pwNonce),
    pw_wrapped_key: toBytea(identity.record.pwWrappedKey),
    rc_salt: toBytea(identity.record.rcSalt),
    rc_nonce: toBytea(identity.record.rcNonce),
    rc_wrapped_key: toBytea(identity.record.rcWrappedKey),
  })
  if (privateError) throw privateError
}

/** Replace the stored wraps after a password change or recovery-phrase reset. */
export async function updateVaultWraps(userId: string, record: VaultRecord): Promise<void> {
  const { error } = await supabase
    .from('user_private_keys')
    .update({
      version: record.version,
      kdf_params: kdfParamsToJson(record.kdfParams),
      pw_salt: toBytea(record.pwSalt),
      pw_nonce: toBytea(record.pwNonce),
      pw_wrapped_key: toBytea(record.pwWrappedKey),
      rc_salt: toBytea(record.rcSalt),
      rc_nonce: toBytea(record.rcNonce),
      rc_wrapped_key: toBytea(record.rcWrappedKey),
    })
    .eq('user_id', userId)
  if (error) throw error
}
