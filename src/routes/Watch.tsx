import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Settings, UserPlus, Users } from 'lucide-react'
import { PlayerShell, type PlayerPanel } from '@/components/player/PlayerShell'
import {
  InvitePanel,
  SettingsPanel,
  ViewersPanel,
  type SessionControls,
} from '@/components/player/SessionPanels'
import { useFriends } from '@/hooks/useFriends'
import { useLibrary, useShares } from '@/hooks/useLibrary'
import { useMediaStream } from '@/hooks/useMediaStream'
import { useRoom } from '@/hooks/useRoom'
import { useRooms } from '@/hooks/useRooms'
import { connectionMessage } from '@/lib/sync/connection'
import {
  endRoom,
  resolveWatchTarget,
  setControlMode,
  setMemberState,
  watchers,
  type WatchTarget,
} from '@/lib/sync/room'
import { useSession } from '@/stores/sessionStore'

/**
 * The only player route. A video *is* the thing you watch together, so there is
 * no separate act of creating a room and no second screen to navigate to — the
 * word "room" appears nowhere a user can see it, including in this URL.
 *
 * What opening a video means depends on who you are, and the database decides
 * (`resolveWatchTarget`): the owner gets its session, a guest who was invited
 * gets the same session, and anybody else who holds a key simply watches it on
 * their own. Two components rather than one because they need different hooks,
 * and hooks cannot be conditional — but they render the same shell.
 */
export function Watch() {
  const { mediaId = '' } = useParams()
  const session = useSession((s) => s.session)
  const userId = session?.user.id ?? ''

  const target = useQuery({
    queryKey: ['watch-target', mediaId, userId],
    enabled: Boolean(mediaId && userId),
    // Resolving twice could create nothing new — get-or-create is idempotent —
    // but it would spend a rate-limit slot each time, so it is not retried and
    // not refetched behind the user's back.
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: (): Promise<WatchTarget> => resolveWatchTarget(mediaId, userId),
  })

  if (target.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-black">
        <Loader2 className="size-6 animate-spin text-ink-700" aria-label="Opening" />
      </div>
    )
  }

  if (target.isError || !target.data) {
    return <Alone mediaId={mediaId} notice={errorText(target.error)} />
  }

  const { roomId, notice } = target.data
  if (!roomId) return <Alone mediaId={mediaId} notice={notice} />
  return <Together mediaId={mediaId} roomId={roomId} />
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Could not open that video.'
}

/* -------------------------------------------------------------------------- */
/* Watching on your own                                                        */
/* -------------------------------------------------------------------------- */

function Alone({ mediaId, notice }: { mediaId: string; notice: string | null }) {
  const stream = useMediaStream(mediaId)
  const title = useTitle(mediaId)
  const video = useRef<HTMLVideoElement | null>(null)

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    video.current = element
  }, [])

  return (
    <PlayerShell
      title={title}
      src={stream.src}
      status={stream.status}
      shared={false}
      canControl={stream.status.kind === 'ready'}
      attachVideo={attachVideo}
      notice={notice}
      onToggle={(shouldPlay) => {
        const element = video.current
        if (!element) return
        if (shouldPlay) void element.play().catch(() => {})
        else element.pause()
      }}
      onSeek={(seconds) => {
        const element = video.current
        if (element) element.currentTime = seconds
      }}
      footnote={<StreamNote status={stream.status} />}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Watching together                                                           */
/* -------------------------------------------------------------------------- */

function Together({ mediaId, roomId }: { mediaId: string; roomId: string }) {
  const session = useSession((s) => s.session)
  const userId = session?.user.id ?? ''
  const stream = useMediaStream(mediaId)
  const title = useTitle(mediaId)

  const {
    attachVideo,
    room,
    members,
    self,
    error: syncError,
    connection,
    clockUncertaintyMs,
    lastAction,
    play,
    pause,
    seek,
    forceSync,
    join,
  } = useRoom(roomId)

  const { friends } = useFriends(userId)
  const { invite } = useRooms()
  const [dismissedAt, setDismissedAt] = useState(0)

  const isOwner = room !== null && room.ownerId === userId
  const ownerOnly = room?.controlMode === 'owner_only'

  // Only the owner may read the grants on their own media, and they are also
  // the only person who could do anything about one being missing.
  const shares = useShares(isOwner ? mediaId : null)
  const canControl =
    stream.status.kind === 'ready' && (!ownerOnly || isOwner || self?.canControl === true)

  /**
   * Arriving *is* accepting. Under the old model an invitation was a room you
   * then had to join, which meant a button between the person and the film for
   * no reason anyone could explain. Clicking the video is the acceptance.
   */
  const joining = useRef(false)
  useEffect(() => {
    if (!self || self.state === 'joined' || self.state === 'kicked') return
    if (joining.current) return
    joining.current = true
    void join().catch(() => {
      joining.current = false
    })
  }, [self, join])

  const toast =
    lastAction && lastAction.at > dismissedAt
      ? `${lastAction.actorName} ${lastAction.isPlaying ? 'played' : 'paused'}`
      : null

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setDismissedAt(Date.now()), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const controls: SessionControls | null = useMemo(
    () =>
      room
        ? {
            room,
            members,
            self,
            isOwner,
            friends,
            keyHolders: shares.data ? new Set(shares.data.map((share) => share.recipientId)) : null,
            connection,
            clockUncertaintyMs,
            forceSync,
            invite: async (recipientId) => {
              await invite.mutateAsync({ roomId, mediaId: room.mediaId, recipientId })
              // Re-read who holds a key, or the roster goes on saying they do
              // not and the button that just worked looks like it did nothing.
              await shares.refetch()
            },
            remove: (targetId) => setMemberState(roomId, targetId, 'kicked'),
            setOwnerOnly: (next) => setControlMode(roomId, next ? 'owner_only' : 'open'),
            stop: () => endRoom(roomId),
          }
        : null,
    [
      room,
      members,
      self,
      isOwner,
      friends,
      connection,
      clockUncertaintyMs,
      forceSync,
      invite,
      roomId,
      shares,
    ],
  )

  const others = controls ? watchers(members).filter((m) => m.userId !== userId) : []

  const panels: PlayerPanel[] = controls
    ? [
        {
          id: 'viewers',
          label: 'Watching',
          icon: Users,
          badge: others.length,
          content: <ViewersPanel controls={controls} />,
        },
        ...(controls.isOwner
          ? [
              {
                id: 'invite',
                label: 'Invite a friend',
                icon: UserPlus,
                content: <InvitePanel controls={controls} />,
              },
            ]
          : []),
        {
          id: 'settings',
          label: 'Settings',
          icon: Settings,
          content: <SettingsPanel controls={controls} />,
        },
      ]
    : []

  const subtitle =
    others.length === 0
      ? isOwner
        ? 'Nobody else yet — invite someone'
        : null
      : `Watching with ${listNames(others.map((m) => m.displayName))}`

  return (
    <PlayerShell
      title={title}
      subtitle={subtitle}
      src={stream.src}
      status={stream.status}
      shared
      canControl={canControl}
      attachVideo={attachVideo}
      panels={panels}
      toast={toast}
      error={syncError}
      notice={
        ownerOnly && !canControl && stream.status.kind === 'ready'
          ? 'The owner is driving. You can watch, but not touch the controls.'
          : connectionMessage(connection)
      }
      onToggle={(shouldPlay) => (shouldPlay ? play() : pause())}
      onSeek={(seconds) => seek(seconds * 1000)}
      footnote={<StreamNote status={stream.status} />}
    />
  )
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/* -------------------------------------------------------------------------- */

/**
 * The title is already decrypted in the library cache in the ordinary case —
 * the user clicked a card to get here. A deep link pays for one decrypt pass,
 * which is cheaper than a second read path that could disagree with the first.
 */
function useTitle(mediaId: string): string {
  const { items } = useLibrary()
  return items.find((item) => item.id === mediaId)?.title ?? 'Your video'
}

function StreamNote({ status }: { status: ReturnType<typeof useMediaStream>['status'] }) {
  if (status.kind !== 'ready') return null
  return (
    <p>
      {status.mode === 'service-worker'
        ? 'Decrypting as you watch — only the parts you reach are ever decrypted.'
        : 'Decrypted in full on this device, because this browser will not stream through a service worker.'}
    </p>
  )
}
