/**
 * The sessions somebody else has open that you are part of — "Now streaming".
 *
 * RLS already limits this to rooms you own or were invited to, so the query
 * deliberately does not filter by user. The owner does not need this list: a
 * video they own *is* its session, and it is already in their library.
 */

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { inviteToWatch } from '@/lib/sync/room'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/stores/sessionStore'

export interface StreamingSession {
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
    queryFn: async (): Promise<StreamingSession[]> => {
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

  /**
   * Ask a friend to watch along. `inviteToWatch` grants the content key in the
   * same breath — see the note on it for why the two are not separable.
   */
  const invite = useMutation({
    mutationFn: (input: { roomId: string; mediaId: string; recipientId: string }) =>
      inviteToWatch({
        roomId: input.roomId,
        mediaId: input.mediaId,
        ownerId: userId,
        recipientId: input.recipientId,
        identityPrivateKey: identityKey as CryptoKey,
      }),
  })

  return { rooms: query.data ?? [], isLoading: query.isPending, refresh: invalidate, invite }
}
