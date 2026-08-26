/**
 * The rooms a user can currently walk into.
 *
 * RLS already limits this to rooms they own or were invited to, so the query
 * deliberately does not filter by user.
 */

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoom, inviteToRoom } from '@/lib/sync/room'
import { shareMedia } from '@/lib/media/library'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/stores/sessionStore'

export interface RoomSummary {
  id: string
  mediaId: string
  ownerId: string
  status: 'lobby' | 'live' | 'ended'
  isPlaying: boolean
  myState: string
}

export function useRooms() {
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const userId = session?.user.id ?? ''
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['rooms', userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<RoomSummary[]> => {
      const { data: rows, error } = await supabase
        .from('rooms')
        .select('id, media_id, owner_id, status, is_playing')
        .neq('status', 'ended')
        .order('created_at', { ascending: false })
      if (error) throw error
      if (!rows || rows.length === 0) return []

      const { data: memberships } = await supabase
        .from('room_members')
        .select('room_id, state')
        .eq('user_id', userId)
      const stateByRoom = new Map((memberships ?? []).map((m) => [m.room_id, m.state]))

      return rows.map((row) => ({
        id: row.id,
        mediaId: row.media_id,
        ownerId: row.owner_id,
        status: row.status === 'live' ? 'live' : row.status === 'ended' ? 'ended' : 'lobby',
        isPlaying: row.is_playing,
        myState: stateByRoom.get(row.id) ?? 'invited',
      }))
    },
  })

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['rooms', userId] })
  }, [queryClient, userId])

  const start = useMutation({
    mutationFn: (mediaId: string) => createRoom(mediaId, userId),
    onSuccess: invalidate,
  })

  /**
   * Invite someone, granting them the content key if they do not have it.
   *
   * A room invitation without a key grant would be an invitation to watch a
   * black rectangle, so the two travel together. Granting is idempotent enough:
   * a duplicate insert is swallowed as already-shared.
   */
  const invite = useMutation({
    mutationFn: async (input: { roomId: string; mediaId: string; recipientId: string }) => {
      try {
        await shareMedia({
          mediaId: input.mediaId,
          ownerId: userId,
          recipientId: input.recipientId,
          identityPrivateKey: identityKey as CryptoKey,
        })
      } catch (cause) {
        // Already granted is the common case on a re-invite; anything else is
        // worth surfacing.
        const message = cause instanceof Error ? cause.message : ''
        if (!/duplicate|already/i.test(message)) throw cause
      }
      await inviteToRoom(input.roomId, input.recipientId)
    },
  })

  return { rooms: query.data ?? [], isLoading: query.isPending, refresh: invalidate, start, invite }
}
