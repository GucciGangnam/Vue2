/**
 * Friend requests and friendships.
 *
 * Framework-agnostic on purpose, like the crypto and sync modules: this file
 * knows about Supabase and nothing about React, so the same logic survives a
 * move to another shell later.
 *
 * Almost none of the access control lives here. RLS already limits every read
 * to rows the caller is party to, so these queries deliberately do not filter
 * by user id -- adding a `.eq('requester_id', me)` would only hide the fact
 * that the database is the thing enforcing it. The one place `userId` matters
 * is working out which end of a row is "the other person".
 */

import { supabase } from './supabase'

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'

/** The subset of a profile that friend-facing UI ever needs. */
export interface PersonSummary {
  id: string
  displayName: string
  avatarHue: number
  friendCode: string
}

export interface Friend extends PersonSummary {
  friendsSince: string
}

export interface PendingRequest {
  id: string
  direction: 'incoming' | 'outgoing'
  person: PersonSummary
  createdAt: string
}

const PERSON_COLUMNS = 'id, display_name, avatar_hue, friend_code'

interface ProfileRow {
  id: string
  display_name: string
  avatar_hue: number
  friend_code: string
}

function toPerson(row: ProfileRow): PersonSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    friendCode: row.friend_code,
  }
}

/**
 * `friendships` stores one row per pair with `user_a < user_b`, so the pair has
 * a single canonical form and friendship needs no second row to be symmetric.
 * Postgres compares uuids as 16 raw bytes; canonical lowercase uuid strings
 * sort identically, because the hyphens sit at the same offsets in both. That
 * equivalence is what lets the client address a row without asking the server
 * which way round it was stored.
 */
export function orderedPair(one: string, two: string): [string, string] {
  return one < two ? [one, two] : [two, one]
}

/**
 * Match `find_profile_by_code`'s normalisation so the field can validate before
 * a round trip. Crockford base32 treats I and L as 1 and O as 0: those are
 * transcription mistakes, not distinct symbols, and a code read aloud down a
 * phone should still resolve.
 */
export function normalizeFriendCode(input: string): string {
  return input
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase()
    .replace(/[ILO]/g, (character) => (character === 'O' ? '0' : '1'))
    .slice(0, 8)
}

export function isCompleteFriendCode(code: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)
}

/**
 * Turn a Postgres error into something worth showing someone.
 *
 * The database rejects the impossible states itself -- already friends, a
 * crossed invitation -- and raises them with wording meant to be read, so the
 * default is to pass the message straight through. Only the constraint
 * violations, which surface as machine text, need translating here.
 */
export function friendRequestMessage(error: { code?: string; message: string }): string {
  if (error.code === '23505') return 'You have already sent this person a request.'
  if (error.code === '23514') return 'You cannot send yourself a friend request.'
  if (error.code === '42501') return 'That was refused. Try signing out and back in.'
  return error.message
}

/** Resolve a friend code. `null` means no such code, or it is the caller's own. */
export async function findProfileByCode(code: string): Promise<PersonSummary | null> {
  const { data, error } = await supabase.rpc('find_profile_by_code', { p_code: code })
  if (error) throw error

  const row = data?.[0]
  if (!row) return null
  return {
    id: row.id,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    friendCode: row.friend_code,
  }
}

export async function listFriends(userId: string): Promise<Friend[]> {
  const { data: links, error } = await supabase
    .from('friendships')
    .select('user_a, user_b, created_at')
  if (error) throw error
  if (!links || links.length === 0) return []

  const friendsSince = new Map<string, string>()
  for (const link of links) {
    friendsSince.set(link.user_a === userId ? link.user_b : link.user_a, link.created_at)
  }

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select(PERSON_COLUMNS)
    .in('id', [...friendsSince.keys()])
  if (profileError) throw profileError

  return (profiles ?? [])
    .map((row) => ({ ...toPerson(row), friendsSince: friendsSince.get(row.id) ?? '' }))
    .sort((one, two) => one.displayName.localeCompare(two.displayName))
}

export async function listPendingRequests(userId: string): Promise<PendingRequest[]> {
  const { data: rows, error } = await supabase
    .from('friend_requests')
    .select('id, requester_id, addressee_id, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const otherIds = rows.map((row) =>
    row.requester_id === userId ? row.addressee_id : row.requester_id,
  )

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select(PERSON_COLUMNS)
    .in('id', otherIds)
  if (profileError) throw profileError

  const byId = new Map((profiles ?? []).map((row) => [row.id, toPerson(row)]))

  return rows.flatMap((row) => {
    const incoming = row.addressee_id === userId
    const person = byId.get(incoming ? row.requester_id : row.addressee_id)
    // Only reachable if the row policy and the profile policy disagree. Drop
    // the row rather than render a card with nobody's name on it.
    if (!person) return []
    return [
      {
        id: row.id,
        direction: incoming ? ('incoming' as const) : ('outgoing' as const),
        person,
        createdAt: row.created_at,
      },
    ]
  })
}

export async function sendFriendRequest(requesterId: string, addresseeId: string): Promise<void> {
  const { error } = await supabase
    .from('friend_requests')
    .insert({ requester_id: requesterId, addressee_id: addresseeId })
  if (error) throw new Error(friendRequestMessage(error))
}

/**
 * Accept or decline. The status the addressee is allowed to write is fixed by
 * RLS, so a wrong value here fails at the database rather than going through.
 */
export async function respondToRequest(
  requestId: string,
  outcome: 'accepted' | 'declined',
): Promise<void> {
  const { error } = await supabase
    .from('friend_requests')
    .update({ status: outcome })
    .eq('id', requestId)
  if (error) throw new Error(friendRequestMessage(error))
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  const { error } = await supabase
    .from('friend_requests')
    .update({ status: 'cancelled' })
    .eq('id', requestId)
  if (error) throw new Error(friendRequestMessage(error))
}

export async function removeFriend(userId: string, otherId: string): Promise<void> {
  const [userA, userB] = orderedPair(userId, otherId)
  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('user_a', userA)
    .eq('user_b', userB)
  if (error) throw new Error(friendRequestMessage(error))
}
