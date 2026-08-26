import { useQuery } from '@tanstack/react-query'
import { Navigate, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { loadRoom } from '@/lib/sync/room'

/**
 * `/room/:roomId` was the shared-watching screen until Phase 9 folded it into
 * `/watch/:mediaId`. It survives only as a redirect, because links to it exist:
 * in the deployed app's history, in a bookmark, in the end-to-end suite.
 *
 * It resolves through the room rather than guessing, since only the database
 * can say which video a room id belongs to — and it answers "not yours" and
 * "no such room" identically, which is why a failure lands in the library
 * rather than on an error page that would confirm the id was real.
 */
export function RoomRedirect() {
  const { roomId = '' } = useParams()

  const room = useQuery({
    queryKey: ['room-redirect', roomId],
    enabled: Boolean(roomId),
    retry: false,
    staleTime: Infinity,
    queryFn: () => loadRoom(roomId),
  })

  if (room.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-black">
        <Loader2 className="size-6 animate-spin text-ink-700" aria-label="Opening" />
      </div>
    )
  }

  if (room.isError || !room.data) return <Navigate to="/library" replace />
  return <Navigate to={`/watch/${room.data.mediaId}`} replace />
}
