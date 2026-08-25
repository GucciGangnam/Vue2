/**
 * Everything the Friends screen needs, in one hook.
 *
 * Kept apart from `src/lib/friends.ts` so that file stays React-free. The
 * realtime subscription only invalidates: it does not try to patch the cache
 * from the payload, because a request row on its own is not enough to render a
 * card (the counterparty's profile has to be fetched, and only becomes visible
 * to us at the moment the row appears). Refetching is one round trip and always
 * agrees with what RLS will actually show.
 */

import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelFriendRequest,
  listFriends,
  listPendingRequests,
  removeFriend,
  respondToRequest,
  sendFriendRequest,
} from '@/lib/friends'
import { supabase } from '@/lib/supabase'

const friendsKey = (userId: string) => ['friends', userId] as const
const requestsKey = (userId: string) => ['friend-requests', userId] as const

export function useFriends(userId: string) {
  const queryClient = useQueryClient()

  const friends = useQuery({
    queryKey: friendsKey(userId),
    queryFn: () => listFriends(userId),
  })

  const requests = useQuery({
    queryKey: requestsKey(userId),
    queryFn: () => listPendingRequests(userId),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: friendsKey(userId) })
    void queryClient.invalidateQueries({ queryKey: requestsKey(userId) })
  }

  useEffect(() => {
    // Realtime applies the same RLS policies as the REST reads, so this channel
    // only ever hears about rows this user is party to.
    const channel = supabase
      .channel(`friends:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, () => {
        void queryClient.invalidateQueries({ queryKey: friendsKey(userId) })
        void queryClient.invalidateQueries({ queryKey: requestsKey(userId) })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        void queryClient.invalidateQueries({ queryKey: friendsKey(userId) })
        void queryClient.invalidateQueries({ queryKey: requestsKey(userId) })
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId, queryClient])

  const send = useMutation({
    mutationFn: (addresseeId: string) => sendFriendRequest(userId, addresseeId),
    onSuccess: invalidate,
  })

  const respond = useMutation({
    mutationFn: (input: { requestId: string; outcome: 'accepted' | 'declined' }) =>
      respondToRequest(input.requestId, input.outcome),
    onSuccess: invalidate,
  })

  const cancel = useMutation({
    mutationFn: (requestId: string) => cancelFriendRequest(requestId),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (otherId: string) => removeFriend(userId, otherId),
    onSuccess: invalidate,
  })

  const pending = requests.data ?? []

  return {
    friends: friends.data ?? [],
    incoming: pending.filter((request) => request.direction === 'incoming'),
    outgoing: pending.filter((request) => request.direction === 'outgoing'),
    isLoading: friends.isPending || requests.isPending,
    error: friends.error ?? requests.error,
    send,
    respond,
    cancel,
    remove,
  }
}
