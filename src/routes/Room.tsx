import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Crown, Lock, LockOpen, Pause, Play, RefreshCw, UserMinus } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { formatDuration } from '@/lib/format'
import { openStream, type OpenStream } from '@/lib/media/playback'
import {
  endRoom,
  inviteToRoom,
  setControlMode,
  setMemberState,
  type RoomMember,
} from '@/lib/sync/room'
import { useFriends } from '@/hooks/useFriends'
import { useRoom } from '@/hooks/useRoom'
import { useSession } from '@/stores/sessionStore'

export function Room() {
  const { roomId = '' } = useParams()
  const session = useSession((s) => s.session)
  const identityKey = useSession((s) => s.identityKey)
  const userId = session?.user.id ?? ''

  const {
    attachVideo,
    room,
    members,
    self,
    error: syncError,
    clockUncertaintyMs,
    lastAction,
    play,
    pause,
    seek,
    forceSync,
    join,
  } = useRoom(roomId)
  const { friends } = useFriends(userId)

  const [src, setSrc] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [position, setPosition] = useState(0)
  const [dismissedAt, setDismissedAt] = useState(0)

  const isOwner = room?.ownerId === userId
  const locked = room?.controlMode === 'owner_only'
  const canControl = !locked || isOwner || self?.canControl === true
  const joined = self?.state === 'joined'

  // Open the media once the room tells us which media it is.
  useEffect(() => {
    const mediaId = room?.mediaId
    if (!mediaId || !userId || !identityKey) return

    let stream: OpenStream | null = null
    let cancelled = false

    void (async () => {
      try {
        const opened = await openStream({ mediaId, userId, identityPrivateKey: identityKey })
        if (cancelled) {
          void opened.release()
          return
        }
        stream = opened
        setSrc(opened.src)
      } catch (cause) {
        if (!cancelled) {
          setStreamError(cause instanceof Error ? cause.message : 'Could not open the video.')
        }
      }
    })()

    return () => {
      cancelled = true
      void stream?.release()
    }
  }, [room?.mediaId, userId, identityKey])

  // Derived during render rather than pushed into state from an effect; the
  // effect below only schedules the dismissal.
  const toast =
    lastAction && lastAction.at > dismissedAt
      ? `${lastAction.actorName} ${lastAction.isPlaying ? 'played' : 'paused'}`
      : null

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setDismissedAt(Date.now()), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const roster = members.filter((m) => m.state === 'invited' || m.state === 'joined')
  const invitable = friends.filter((f) => !members.some((m) => m.userId === f.id))
  const playing = room?.anchor.isPlaying ?? false

  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          to="/library"
          className="-ml-1 inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 pl-1 text-sm text-ink-500 hover:text-ink-300"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Library
        </Link>
        {locked && (
          <span className="inline-flex items-center gap-1.5 text-xs text-lamp-500">
            <Lock className="size-3.5" aria-hidden />
            Owner controls only
          </span>
        )}
      </div>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
        {src && (
          <video
            ref={attachVideo}
            src={src}
            className="size-full"
            playsInline
            controls={false}
            preload="auto"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          />
        )}
        {toast && (
          <div className="absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-ink-950/80 px-3 py-1.5 text-xs text-ink-100">
              {toast}
            </span>
          </div>
        )}
        {(streamError || syncError) && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="text-sm text-danger-500">{streamError ?? syncError}</p>
          </div>
        )}
      </div>

      {!joined ? (
        <Button onClick={() => void join()}>Join this room</Button>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={playing ? pause : play}
            disabled={!canControl}
            aria-label={playing ? 'Pause' : 'Play'}
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-xl bg-lamp-500 text-ink-950 hover:bg-lamp-400 disabled:opacity-45"
          >
            {playing ? (
              <Pause className="size-5" aria-hidden />
            ) : (
              <Play className="size-5" aria-hidden />
            )}
          </button>

          <input
            type="range"
            min={0}
            max={duration || 0}
            step="any"
            value={position}
            onChange={(e) => seek(Number(e.target.value) * 1000)}
            disabled={!canControl || duration === 0}
            aria-label="Seek"
            className="h-11 flex-1 accent-lamp-500 disabled:opacity-45"
          />

          <p className="shrink-0 font-mono text-xs text-ink-500 tabular-nums">
            {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
          </p>
        </div>
      )}

      {!canControl && joined && (
        <p className="text-center text-xs text-ink-500">
          The owner has locked playback to themselves.
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-ink-500">In the room</h2>
        <ul className="flex flex-col gap-2">
          {roster.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              isOwner={isOwner}
              isSelf={member.userId === userId}
              onKick={() => void setMemberState(roomId, member.userId, 'kicked')}
            />
          ))}
        </ul>
      </section>

      {isOwner && (
        <section className="flex flex-col gap-3 rounded-xl bg-ink-900 p-4">
          <h2 className="text-sm font-medium text-ink-500">Owner controls</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={forceSync}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              <RefreshCw className="size-4" aria-hidden />
              Force sync
            </button>
            <button
              type="button"
              onClick={() => void setControlMode(roomId, locked ? 'open' : 'owner_only')}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              {locked ? (
                <LockOpen className="size-4" aria-hidden />
              ) : (
                <Lock className="size-4" aria-hidden />
              )}
              {locked ? 'Let anyone control' : 'Lock to me'}
            </button>
            <button
              type="button"
              onClick={() => void endRoom(roomId)}
              className="ml-auto inline-flex min-h-11 items-center rounded-xl px-3 text-sm text-ink-500 hover:text-danger-500"
            >
              End room
            </button>
          </div>

          {invitable.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-500">Invite a friend</p>
              {invitable.map((friend) => (
                <div key={friend.id} className="flex items-center gap-3 rounded-xl bg-ink-850 p-2">
                  <Avatar name={friend.displayName} hue={friend.avatarHue} />
                  <p className="min-w-0 flex-1 truncate text-sm text-ink-100">
                    {friend.displayName}
                  </p>
                  <button
                    type="button"
                    onClick={() => void inviteToRoom(roomId, friend.id)}
                    className="min-h-11 rounded-xl bg-lamp-500 px-3 text-sm font-medium text-ink-950 hover:bg-lamp-400"
                  >
                    Invite
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <p className="text-center text-xs text-ink-700">
        Clock accurate to about {clockUncertaintyMs}ms. Everyone follows server time, not their own.
      </p>
    </main>
  )
}

function MemberRow({
  member,
  isOwner,
  isSelf,
  onKick,
}: {
  member: RoomMember
  isOwner: boolean
  isSelf: boolean
  onKick: () => void
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-ink-900 p-3">
      <Avatar name={member.displayName} hue={member.avatarHue} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-ink-100">
          {member.displayName}
          {isSelf && <span className="text-ink-500"> (you)</span>}
        </p>
        <p className="text-xs text-ink-500">{member.state === 'joined' ? 'watching' : 'invited'}</p>
      </div>
      {member.role === 'owner' && <Crown className="size-4 text-lamp-500" aria-label="Owner" />}
      {isOwner && !isSelf && (
        <button
          type="button"
          onClick={onKick}
          aria-label={`Remove ${member.displayName}`}
          className="inline-flex size-11 items-center justify-center rounded-xl text-ink-500 hover:text-danger-500"
        >
          <UserMinus className="size-4" aria-hidden />
        </button>
      )}
    </li>
  )
}
