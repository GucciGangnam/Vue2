/**
 * The room protocol: two channels carrying the same events.
 *
 * **Authority.** `set_playback_state` is the only thing that can move playback.
 * It checks permission, stamps the server clock, and assigns `seq`. Its answer
 * is the truth, and it is also what a late joiner reads to land in step.
 *
 * **Speed.** A Realtime broadcast on `room:{id}` carries the same intent
 * immediately, so a tap feels instant instead of costing a round trip to Tokyo.
 *
 * The two disagree constantly, and that is fine by design. A broadcast has no
 * `seq` -- it cannot, because `seq` does not exist until the database assigns
 * it -- so receivers apply broadcasts *optimistically* without advancing their
 * applied sequence. When the authoritative row arrives, `shouldApply` decides,
 * and the database always wins. That ordering is the whole reason a fast path
 * is safe to have.
 */

import { supabase } from '@/lib/supabase'
import type { RoomMemberRow, RoomRow } from '@/lib/database.types'
import { bestSample, ClockOffset, sampleOffset, type ClockSample } from './clock'
import type { PlaybackAnchor } from './timeline'

export type PlaybackAction = 'play' | 'pause' | 'seek'
export type RoomStatus = 'lobby' | 'live' | 'ended'
export type ControlMode = 'open' | 'owner_only'
export type MemberState = 'invited' | 'joined' | 'left' | 'kicked'

export interface RoomMember {
  userId: string
  role: 'owner' | 'viewer'
  state: MemberState
  canControl: boolean
  displayName: string
  avatarHue: number
}

export interface Room {
  id: string
  ownerId: string
  mediaId: string
  status: RoomStatus
  controlMode: ControlMode
  anchor: PlaybackAnchor
  lastActorId: string | null
}

/** What a broadcast carries. No `seq`: the database has not assigned one yet. */
export interface PlaybackIntent {
  action: PlaybackAction
  positionMs: number
  /** The actor's estimate of server time when they acted. */
  atServerMs: number
  actorId: string
}

const CLOCK_SAMPLES = 5

/* -------------------------------------------------------------------------- */
/* Clock                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Measure the offset to the database clock.
 *
 * Samples are taken in series, not in parallel: concurrent requests queue
 * behind each other and inflate exactly the round trip we are trying to
 * measure.
 *
 * The first call is thrown away. Measured against this project, a cold
 * connection costs 230-290ms against 99-120ms once warm, and because a slow
 * round trip skews the offset estimate as well as the RTT (+131ms versus +37ms
 * on the same link), a cold sample that happens to be the lowest of a small set
 * poisons the result. Two clients disagreeing about the server clock is
 * indistinguishable from them being out of sync, so this is worth one extra
 * request.
 */
export async function measureClock(sampleCount = CLOCK_SAMPLES): Promise<ClockOffset> {
  const samples: ClockSample[] = []

  await supabase.rpc('server_now')

  for (let i = 0; i < sampleCount; i++) {
    const sentAt = Date.now()
    const { data, error } = await supabase.rpc('server_now')
    const receivedAt = Date.now()
    if (error) throw error
    if (!data) continue
    samples.push(sampleOffset(sentAt, new Date(data).getTime(), receivedAt))
  }

  const best = bestSample(samples)
  if (!best) throw new Error('Could not reach the server clock.')
  return new ClockOffset(best)
}

/* -------------------------------------------------------------------------- */
/* Reading and writing rooms                                                   */
/* -------------------------------------------------------------------------- */

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    ownerId: row.owner_id,
    mediaId: row.media_id,
    status: asStatus(row.status),
    controlMode: row.control_mode === 'owner_only' ? 'owner_only' : 'open',
    lastActorId: row.last_actor_id,
    anchor: {
      seq: row.seq,
      isPlaying: row.is_playing,
      positionMs: row.position_ms,
      anchorServerTimeMs: new Date(row.anchor_server_time).getTime(),
    },
  }
}

function asStatus(value: string): RoomStatus {
  return value === 'live' || value === 'ended' ? value : 'lobby'
}

export async function loadRoom(roomId: string): Promise<Room> {
  const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('That room is not open to you.')
  return toRoom(data)
}

export async function listRoomMembers(roomId: string): Promise<RoomMember[]> {
  const { data: rows, error } = await supabase
    .from('room_members')
    .select('*')
    .eq('room_id', roomId)
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_hue')
    .in(
      'id',
      rows.map((row) => row.user_id),
    )
  if (profileError) throw profileError
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]))

  return rows.map((row: RoomMemberRow) => {
    const profile = byId.get(row.user_id)
    return {
      userId: row.user_id,
      role: row.role === 'owner' ? 'owner' : 'viewer',
      state: asMemberState(row.state),
      canControl: row.can_control,
      // A member whose profile is invisible is still in the room; showing them
      // unnamed beats dropping them out of the roster.
      displayName: profile?.display_name ?? 'Someone',
      avatarHue: profile?.avatar_hue ?? 0,
    }
  })
}

function asMemberState(value: string): MemberState {
  return value === 'joined' || value === 'left' || value === 'kicked' ? value : 'invited'
}

/** The owner is added to the roster by a trigger, not by this call. */
export async function createRoom(mediaId: string, ownerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('rooms')
    .insert({ media_id: mediaId, owner_id: ownerId })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function inviteToRoom(roomId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('room_members').insert({ room_id: roomId, user_id: userId })
  if (error && error.code !== '23505') throw error
}

export async function setMemberState(
  roomId: string,
  userId: string,
  state: MemberState,
): Promise<void> {
  const { error } = await supabase
    .from('room_members')
    .update({ state })
    .eq('room_id', roomId)
    .eq('user_id', userId)
  if (error) throw error
}

export async function setCanControl(
  roomId: string,
  userId: string,
  canControl: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('room_members')
    .update({ can_control: canControl })
    .eq('room_id', roomId)
    .eq('user_id', userId)
  if (error) throw error
}

export async function setControlMode(roomId: string, mode: ControlMode): Promise<void> {
  const { error } = await supabase.from('rooms').update({ control_mode: mode }).eq('id', roomId)
  if (error) throw error
}

export async function endRoom(roomId: string): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', roomId)
  if (error) throw error
}

/**
 * Move playback. Returns the authoritative anchor.
 *
 * The response carries the server's own clock alongside the new state, so a
 * caller can refresh its offset from the same round trip it was already paying
 * for rather than sampling again.
 */
export async function sendPlaybackAction(
  roomId: string,
  action: PlaybackAction,
  positionMs: number,
): Promise<{ anchor: PlaybackAnchor; serverTimeMs: number; lastActorId: string | null }> {
  const { data, error } = await supabase.rpc('set_playback_state', {
    p_room_id: roomId,
    p_action: action,
    p_position_ms: Math.max(0, Math.round(positionMs)),
  })
  if (error) throw error

  const row = data?.[0]
  if (!row) throw new Error('The room did not accept that.')

  return {
    anchor: {
      seq: row.seq,
      isPlaying: row.is_playing,
      positionMs: row.position_ms,
      anchorServerTimeMs: new Date(row.anchor_server_time).getTime(),
    },
    serverTimeMs: new Date(row.server_time).getTime(),
    lastActorId: row.last_actor_id,
  }
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

export interface RoomHandlers {
  /** Authoritative: carries a real `seq`. The database has spoken. */
  onRoomChanged: (room: Room) => void
  /** Optimistic: fast, unordered, no `seq`. Apply, but do not trust. */
  onIntent: (intent: PlaybackIntent) => void
  onMembersChanged: () => void
}

/**
 * Subscribe to both paths at once.
 *
 * `postgres_changes` is filtered server-side to this room, and RLS still
 * applies, so a client cannot listen to a room it is not in.
 */
export function subscribeToRoom(
  roomId: string,
  selfId: string,
  handlers: RoomHandlers,
): { broadcast: (intent: PlaybackIntent) => void; unsubscribe: () => void } {
  const channel = supabase
    // `private` is not decoration: without it the topic is public pub/sub and
    // anyone holding the room id could listen in. See the migration
    // phase5_restrict_room_broadcast_channels.
    .channel(`room:${roomId}`, { config: { private: true } })
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
      (payload) => handlers.onRoomChanged(toRoom(payload.new as RoomRow)),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` },
      () => handlers.onMembersChanged(),
    )
    .on('broadcast', { event: 'intent' }, ({ payload }) => {
      const intent = payload as PlaybackIntent
      // Our own broadcast comes back to us; applying it would fight the local
      // state we already set optimistically.
      if (!intent || intent.actorId === selfId) return
      handlers.onIntent(intent)
    })
    .subscribe()

  return {
    broadcast: (intent) => {
      void channel.send({ type: 'broadcast', event: 'intent', payload: intent })
    },
    unsubscribe: () => {
      void supabase.removeChannel(channel)
    },
  }
}
