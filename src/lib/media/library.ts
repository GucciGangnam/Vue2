/**
 * Reading the library, and granting other people access to it.
 *
 * Every title and every poster on this screen arrives as ciphertext and is
 * decrypted here, one content key at a time. A row the caller has no grant for
 * still comes back -- it is theirs, or it was shared and then revoked -- but
 * with `title: null`, so the UI can show something honest instead of pretending
 * the item does not exist.
 *
 * React-free, like the rest of `src/lib`.
 */

import { fromBytea, toBase64, wipe } from '@/lib/crypto/bytes'
import {
  unwrapContentKey,
  unwrapContentKeyRaw,
  type WrappedContentKey,
} from '@/lib/crypto/mediaKeys'
import { decryptMetadata, decryptThumbnail } from '@/lib/crypto/mediaMetadata'
import { supabase } from '@/lib/supabase'
import type { MediaKeyRow, MediaRow } from '@/lib/database.types'
import { grantContentKey, MEDIA_BUCKET } from './upload'

export type MediaStatus = 'uploading' | 'ready' | 'failed'

export interface LibraryItem {
  id: string
  ownerId: string
  isOwn: boolean
  status: MediaStatus
  storagePath: string
  mimeType: string
  plaintextSize: number
  createdAt: string
  /** null when we hold no key for it, or the metadata would not verify. */
  title: string | null
  durationMs: number
  width: number
  height: number
  /**
   * A `data:` URL rather than an object URL: posters are small, and a data URL
   * has no lifecycle to get wrong -- nothing to revoke, nothing to leak if a
   * card unmounts mid-render.
   */
  posterUrl: string | null
}

export interface Share {
  recipientId: string
  displayName: string
  avatarHue: number
  createdAt: string
}

export async function listLibrary(
  userId: string,
  identityPrivateKey: CryptoKey,
): Promise<LibraryItem[]> {
  const { data: rows, error } = await supabase
    .from('media')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const { data: grants, error: grantError } = await supabase
    .from('media_keys')
    .select('*')
    .eq('recipient_id', userId)
    .in(
      'media_id',
      rows.map((row) => row.id),
    )
  if (grantError) throw grantError

  const grantsByMedia = new Map((grants ?? []).map((grant) => [grant.media_id, grant]))

  return Promise.all(
    rows.map((row) => toLibraryItem(row, grantsByMedia.get(row.id), userId, identityPrivateKey)),
  )
}

async function toLibraryItem(
  row: MediaRow,
  grant: MediaKeyRow | undefined,
  userId: string,
  identityPrivateKey: CryptoKey,
): Promise<LibraryItem> {
  const base: LibraryItem = {
    id: row.id,
    ownerId: row.owner_id,
    isOwn: row.owner_id === userId,
    status: asStatus(row.status),
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    plaintextSize: row.plaintext_size,
    createdAt: row.created_at,
    title: null,
    durationMs: 0,
    width: 0,
    height: 0,
    posterUrl: null,
  }

  if (!grant) return base

  try {
    const key = await unwrapContentKey(toWrapped(grant), identityPrivateKey, row.id, userId)
    const metadata = await decryptMetadata(key, {
      ciphertext: fromBytea(row.encrypted_metadata),
      nonce: fromBytea(row.metadata_nonce),
    })

    let posterUrl: string | null = null
    if (row.encrypted_thumbnail && row.thumbnail_nonce) {
      try {
        const jpeg = await decryptThumbnail(key, {
          ciphertext: fromBytea(row.encrypted_thumbnail),
          nonce: fromBytea(row.thumbnail_nonce),
        })
        posterUrl = `data:image/jpeg;base64,${toBase64(jpeg)}`
      } catch {
        // A poster that will not verify is not worth failing the whole card
        // for -- the title is the part the user actually needs.
      }
    }

    return { ...base, ...metadata, posterUrl }
  } catch {
    // Wrong key, tampered row, or a format this build does not understand.
    // Returning the row untitled is more useful than dropping it silently:
    // the user can still see that something is there and delete it.
    return base
  }
}

/**
 * Share media with someone.
 *
 * This is the only operation that needs the raw content key, because granting
 * means wrapping those bytes again for a different identity. It comes back out
 * of the owner's own grant and is wiped as soon as the new one is written.
 */
export async function shareMedia(options: {
  mediaId: string
  ownerId: string
  recipientId: string
  identityPrivateKey: CryptoKey
}): Promise<void> {
  const { mediaId, ownerId, recipientId, identityPrivateKey } = options

  const recipientPublicKey = await loadPublicKey(recipientId)
  const ownGrant = await loadGrant(mediaId, ownerId)

  const cek = await unwrapContentKeyRaw(ownGrant, identityPrivateKey, mediaId, ownerId)
  try {
    await grantContentKey({
      mediaId,
      cek,
      recipientId,
      recipientPublicKey,
      grantedBy: ownerId,
    })
  } finally {
    wipe(cek)
  }
}

/**
 * Revoke a share.
 *
 * Honest about its limits: this stops future reads -- the row disappears, the
 * storage policy stops answering -- but it cannot un-see what somebody already
 * watched or cached. The UI must not imply otherwise.
 */
export async function revokeShare(mediaId: string, recipientId: string): Promise<void> {
  const { error } = await supabase
    .from('media_keys')
    .delete()
    .eq('media_id', mediaId)
    .eq('recipient_id', recipientId)
  if (error) throw error
}

export async function listShares(mediaId: string, ownerId: string): Promise<Share[]> {
  const { data: grants, error } = await supabase
    .from('media_keys')
    .select('recipient_id, created_at')
    .eq('media_id', mediaId)
    .neq('recipient_id', ownerId)
  if (error) throw error
  if (!grants || grants.length === 0) return []

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_hue')
    .in(
      'id',
      grants.map((grant) => grant.recipient_id),
    )
  if (profileError) throw profileError

  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]))

  return grants.flatMap((grant) => {
    const profile = byId.get(grant.recipient_id)
    if (!profile) return []
    return [
      {
        recipientId: grant.recipient_id,
        displayName: profile.display_name,
        avatarHue: profile.avatar_hue,
        createdAt: grant.created_at,
      },
    ]
  })
}

/**
 * Delete media and its object.
 *
 * The object goes first. If the row went first, a failure on the storage call
 * would leave bytes nobody has a row for and no way to find them again; this
 * way a failure leaves the row in place and the user can simply try again.
 * `media_keys` cascades from the row.
 */
export async function deleteMedia(item: Pick<LibraryItem, 'id' | 'storagePath'>): Promise<void> {
  const { error: storageError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .remove([item.storagePath])
  if (storageError) throw storageError

  const { error } = await supabase.from('media').delete().eq('id', item.id)
  if (error) throw error
}

/* -------------------------------------------------------------------------- */

async function loadPublicKey(userId: string): Promise<Uint8Array> {
  const { data, error } = await supabase
    .from('user_public_keys')
    .select('public_key')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('That person has not finished setting up their keys yet.')
  return fromBytea(data.public_key)
}

async function loadGrant(mediaId: string, recipientId: string): Promise<WrappedContentKey> {
  const { data, error } = await supabase
    .from('media_keys')
    .select('*')
    .eq('media_id', mediaId)
    .eq('recipient_id', recipientId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('You do not have the key for this video.')
  return toWrapped(data)
}

function toWrapped(grant: MediaKeyRow): WrappedContentKey {
  return {
    ephemeralPublicKey: fromBytea(grant.ephemeral_public_key),
    hkdfSalt: fromBytea(grant.hkdf_salt),
    nonce: fromBytea(grant.nonce),
    wrappedKey: fromBytea(grant.wrapped_key),
    version: grant.version,
  }
}

function asStatus(value: string): MediaStatus {
  return value === 'ready' || value === 'failed' ? value : 'uploading'
}
