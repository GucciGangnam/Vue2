import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Crown,
  Hand,
  Lock,
  LockOpen,
  Pause,
  Play,
  RefreshCw,
  UserMinus,
} from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { HoldToUnlock, UnlockButton } from '@/components/player/HoldToUnlock'
import { formatDuration } from '@/lib/format'
import { openStream, type OpenStream } from '@/lib/media/playback'
import { connectionMessage } from '@/lib/sync/connection'
import {
  endRoom,
  inviteToRoom,
  setControlMode,
  setMemberState,
  setRequireHold,
  type RoomMember,
} from '@/lib/sync/room'
import { useFriends } from '@/hooks/useFriends'
import { useRoom } from '@/hooks/useRoom'
import { useSession } from '@/stores/sessionStore'

/**
 * How long unlocked controls stay unlocked with nobody touching them.
 *
 * Long enough to play, scrub, and change your mind; short enough that a phone
 * put down mid-film is locked again by the time it is picked back up, which is
 * exactly when a pocket or a knee is most likely to press the screen.
 */
const RELOCK_AFTER_MS = 12_000

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
  const connectionNotice = connectionMessage(connection)

  const [src, setSrc] = useState<string | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [position, setPosition] = useState(0)
  const [dismissedAt, setDismissedAt] = useState(0)
  const [unlocked, setUnlocked] = useState(false)
  // Bumped by every use of the controls, to restart the re-lock countdown.
  const [lastTouchedAt, setLastTouchedAt] = useState(0)

  const isOwner = room?.ownerId === userId
  const ownerOnly = room?.controlMode === 'owner_only'
  const canControl = !ownerOnly || isOwner || self?.canControl === true
  const joined = self?.state === 'joined'

  // Phase 6. The room's setting, not the viewer's: an accidental tap costs
  // everyone in the room, so it is not one person's decision to opt out of.
  const requireHold = room?.requireHold ?? true
  const controlsOpen = !requireHold || unlocked

  // Re-lock on its own. An unlocked player left alone is the state this whole
  // phase exists to avoid, so it is not allowed to persist.
  useEffect(() => {
    if (!unlocked) return
    const timer = setTimeout(() => setUnlocked(false), RELOCK_AFTER_MS)
    return () => clearTimeout(timer)
  }, [unlocked, lastTouchedAt])

  // The owner turning the lock back on takes effect everywhere immediately,
  // rather than waiting out somebody else's countdown. Adjusted during render
  // rather than in an effect: it is derived from a value that just changed, and
  // an effect would render the unlocked controls once before taking them away.
  const [lockSetting, setLockSetting] = useState(requireHold)
  if (lockSetting !== requireHold) {
    setLockSetting(requireHold)
    if (requireHold) setUnlocked(false)
  }

  // Every deliberate use of the controls is also a reason not to re-lock yet.
  const touched = () => setLastTouchedAt(Date.now())

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
        {ownerOnly && (
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

        {/* The gesture only exists for people who could act on it: a viewer in
            an owner-only room has nothing to unlock. It also owns the whole
            video surface while it is mounted, which is the contract Phase 7's
            canvas inherits -- see docs/DECISIONS.md D32. */}
        {joined && canControl && requireHold && !unlocked && (
          <HoldToUnlock onUnlock={() => setUnlocked(true)} />
        )}
      </div>

      {!joined ? (
        <Button onClick={() => void join()}>Join this room</Button>
      ) : !canControl ? (
        // Owner-only mode. There is nothing behind the lock for this viewer, so
        // showing them a way through it would only be a lie.
        <Transport playing={playing} position={position} duration={duration} disabled />
      ) : controlsOpen ? (
        <div className="flex items-center gap-3">
          <Transport
            playing={playing}
            position={position}
            duration={duration}
            onToggle={() => {
              touched()
              if (playing) pause()
              else play()
            }}
            onSeek={(seconds) => {
              touched()
              seek(seconds * 1000)
            }}
          />
          {requireHold && (
            <button
              type="button"
              onClick={() => setUnlocked(false)}
              aria-label="Lock the controls"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-500 hover:text-ink-100"
            >
              <Lock className="size-4" aria-hidden />
            </button>
          )}
        </div>
      ) : (
        // Two rows rather than one wrapping row: at 375px the sentence and the
        // button fight for the same line and the message breaks into four.
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-sm text-ink-500">
            <Lock className="size-4 shrink-0" aria-hidden />
            Controls locked — hold the video for 3 seconds
          </p>
          <div className="flex items-center gap-3">
            <p className="font-mono text-xs text-ink-500 tabular-nums">
              {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
            </p>
            {/* Not everyone can hold a button for three seconds. This is the
                same action, one press, and it is never hidden. */}
            <div className="ml-auto">
              <UnlockButton onUnlock={() => setUnlocked(true)} />
            </div>
          </div>
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
              onClick={() => void setControlMode(roomId, ownerOnly ? 'open' : 'owner_only')}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              {ownerOnly ? (
                <LockOpen className="size-4" aria-hidden />
              ) : (
                <Lock className="size-4" aria-hidden />
              )}
              {ownerOnly ? 'Let anyone control' : 'Lock to me'}
            </button>
            <button
              type="button"
              onClick={() => void setRequireHold(roomId, !requireHold)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              <Hand className="size-4" aria-hidden />
              {requireHold ? 'Stop requiring a hold' : 'Require a 3s hold'}
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

      {connectionNotice && (
        <p
          role="status"
          className="rounded-xl border border-lamp-500/40 bg-lamp-500/10 px-4 py-3 text-center text-sm text-lamp-200"
        >
          {connectionNotice}
        </p>
      )}

      <p className="text-center text-xs text-ink-700">
        Clock accurate to about {clockUncertaintyMs}ms. Everyone follows server time, not their own.
      </p>
    </main>
  )
}

/**
 * The transport, in one place, because it is rendered both live and inert and
 * the two must not drift apart. Without handlers it renders disabled, which is
 * what a viewer in an owner-only room sees.
 */
function Transport({
  playing,
  position,
  duration,
  disabled = false,
  onToggle,
  onSeek,
}: {
  playing: boolean
  position: number
  duration: number
  disabled?: boolean
  onToggle?: () => void
  onSeek?: (seconds: number) => void
}) {
  const inert = disabled || !onToggle

  return (
    <div className="flex flex-1 items-center gap-3">
      <button
        type="button"
        onClick={onToggle}
        disabled={inert}
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
        onChange={(event) => onSeek?.(Number(event.target.value))}
        disabled={inert || duration === 0}
        aria-label="Seek"
        className="h-11 flex-1 accent-lamp-500 disabled:opacity-45"
      />

      <p className="shrink-0 font-mono text-xs text-ink-500 tabular-nums">
        {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
      </p>
    </div>
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
