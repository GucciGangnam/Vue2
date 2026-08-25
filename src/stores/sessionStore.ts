/**
 * Auth session + vault state.
 *
 * `status` drives routing:
 *   loading     -- restoring the Supabase session, show nothing
 *   signed-out  -- no session
 *   needs-vault -- signed in, but no identity key exists yet (first run)
 *   locked      -- vault exists, needs a password to open
 *   ready       -- identity key is in memory and usable
 */

import type { Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { clearIdentityKeys, getIdentityKey, putIdentityKey } from '@/lib/crypto/keyStore'
import { loadVault, saveNewVault, updateVaultWraps } from '@/lib/crypto/vaultRepository'
import {
  createVault,
  resetPasswordWithRecoveryPhrase,
  unlockWithPassword,
  unlockWithRecoveryPhrase,
} from '@/lib/crypto/vault'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/database.types'

export type SessionStatus = 'loading' | 'signed-out' | 'needs-vault' | 'locked' | 'ready'

interface SessionState {
  status: SessionStatus
  session: Session | null
  profile: Profile | null
  /** Non-extractable ECDH private key. Never serialise this. */
  identityKey: CryptoKey | null
  publicKey: Uint8Array | null
  /**
   * Held in memory only, between sign-in and vault creation, so first-run setup
   * does not have to ask for the password a second time. Cleared as soon as the
   * vault exists.
   */
  transientPassword: string | null
  /** Shown exactly once, immediately after the vault is created. */
  pendingRecoveryPhrase: string | null

  initialize: () => () => void
  refreshVaultState: (session: Session) => Promise<void>
  signUp: (email: string, password: string, displayName: string) => Promise<{ needsEmail: boolean }>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** First-run identity creation. Returns the recovery phrase to show once. */
  setupVault: (password: string) => Promise<string>
  unlock: (password: string) => Promise<void>
  recoverWithPhrase: (phrase: string, newPassword: string) => Promise<void>
  acknowledgeRecoveryPhrase: () => void
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  session: null,
  profile: null,
  identityKey: null,
  publicKey: null,
  transientPassword: null,
  pendingRecoveryPhrase: null,

  initialize: () => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        set({
          status: 'signed-out',
          session: null,
          profile: null,
          identityKey: null,
          publicKey: null,
          transientPassword: null,
          pendingRecoveryPhrase: null,
        })
        return
      }

      set({ session })

      // TOKEN_REFRESHED fires on a timer and must not reset an unlocked vault.
      if (event === 'TOKEN_REFRESHED' && get().status === 'ready') return

      void get().refreshVaultState(session)
    })

    return () => data.subscription.unsubscribe()
  },

  refreshVaultState: async (session) => {
    const userId = session.user.id

    const [profileResult, vault] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      loadVault(userId),
    ])

    set({ profile: profileResult.data ?? null })

    if (!vault) {
      set({ status: 'needs-vault', identityKey: null, publicKey: null })
      return
    }

    // A key cached on this device means no password prompt on refresh.
    const cached = await getIdentityKey(userId)
    set({
      status: cached ? 'ready' : 'locked',
      identityKey: cached,
      publicKey: vault.publicKey,
      transientPassword: null,
    })
  },

  signUp: async (email, password, displayName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    })
    if (error) throw error

    // With email confirmation on, there is no session yet and the vault is
    // created after the first real sign-in instead.
    if (data.session) set({ transientPassword: password })
    return { needsEmail: data.session === null }
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // Kept only until first-run vault setup consumes it.
    set({ transientPassword: password })
  },

  signOut: async () => {
    await clearIdentityKeys()
    set({ identityKey: null, publicKey: null, profile: null })
    await supabase.auth.signOut()
  },

  setupVault: async (password) => {
    const session = get().session
    if (!session) throw new Error('Not signed in')

    const vault = await createVault(password)
    await saveNewVault(session.user.id, {
      record: vault.record,
      publicKey: vault.publicKey,
    })
    await putIdentityKey(session.user.id, vault.privateKey)

    set({
      status: 'ready',
      identityKey: vault.privateKey,
      publicKey: vault.publicKey,
      transientPassword: null,
      pendingRecoveryPhrase: vault.recoveryPhrase,
    })
    return vault.recoveryPhrase
  },

  unlock: async (password) => {
    const session = get().session
    if (!session) throw new Error('Not signed in')

    const vault = await loadVault(session.user.id)
    if (!vault) {
      set({ status: 'needs-vault' })
      return
    }

    const key = await unlockWithPassword(vault.record, password)
    await putIdentityKey(session.user.id, key)
    set({
      status: 'ready',
      identityKey: key,
      publicKey: vault.publicKey,
      transientPassword: null,
    })
  },

  recoverWithPhrase: async (phrase, newPassword) => {
    const session = get().session
    if (!session) throw new Error('Not signed in')

    const vault = await loadVault(session.user.id)
    if (!vault) throw new Error('No vault to recover')

    // Verify the phrase opens the vault before writing anything back.
    const key = await unlockWithRecoveryPhrase(vault.record, phrase)
    const updated = await resetPasswordWithRecoveryPhrase(vault.record, phrase, newPassword)
    await updateVaultWraps(session.user.id, updated)

    await putIdentityKey(session.user.id, key)
    set({ status: 'ready', identityKey: key, publicKey: vault.publicKey })
  },

  acknowledgeRecoveryPhrase: () => set({ pendingRecoveryPhrase: null }),
}))
