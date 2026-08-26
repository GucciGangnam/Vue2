import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Crown, KeyRound, Lock, LockOpen, RefreshCw, UserMinus } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import type { Friend } from '@/lib/friends'
import type { ConnectionState } from '@/lib/sync/connection'
import { watchers, type Room, type RoomMember } from '@/lib/sync/room'

/**
 * Everything that used to be the `/room` page, as three panels.
 *
 * They render identically in the phone's drawer and in the desktop sidebar,
 * because they are the same panels — the two layouts differ in where the
 * panels are put, not in what they say. Nothing here uses the word "room": a
 * video is the thing you are watching, and the people watching it with you are
 * viewers.
 */

export interface SessionControls {
  room: Room
  members: RoomMember[]
  self: RoomMember | null
  isOwner: boolean
  friends: Friend[]
  /**
   * Who can actually decrypt this video. A seat and a key are separate rows,
   * and for a while the player granted one without the other — see the note on
   * `inviteToWatch`. They are issued together now, but the people stranded by
   * that are still stranded, so the roster has to be able to say so.
   *
   * `null` while the answer is still being fetched — an empty set and an
   * unanswered question look identical otherwise, and guessing would accuse
   * everybody of having no key for a moment on every load.
   */
  keyHolders: Set<string> | null
  connection: ConnectionState
  clockUncertaintyMs: number
  forceSync: () => void
  invite: (recipientId: string) => Promise<void>
  remove: (userId: string) => Promise<void>
  setOwnerOnly: (ownerOnly: boolean) => Promise<void>
  stop: () => Promise<void>
}

export function ViewersPanel({ controls }: { controls: SessionControls }) {
  const { members, self, isOwner, keyHolders } = controls
  const [sending, setSending] = useState<string | null>(null)
  const roster = watchers(members)

  async function sendKey(userId: string) {
    setSending(userId)
    try {
      await controls.invite(userId)
    } finally {
      setSending(null)
    }
  }

  return (
    <ul className="flex flex-col gap-2">
      {roster.map((member) => {
        const isSelf = member.userId === self?.userId
        // The owner always holds a key to their own video (D24), so a missing
        // one is only ever a guest's problem.
        const locked =
          keyHolders !== null && member.role !== 'owner' && !keyHolders.has(member.userId)

        return (
          <li key={member.userId} className="flex flex-col gap-2 rounded-xl bg-ink-850 p-3">
            <div className="flex items-center gap-3">
              <Avatar name={member.displayName} hue={member.avatarHue} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-ink-100">
                  {member.displayName}
                  {isSelf && <span className="text-ink-500"> (you)</span>}
                </p>
                <p className="text-xs text-ink-500">
                  {member.state === 'joined' ? 'watching' : 'invited, not here yet'}
                </p>
              </div>
              {member.role === 'owner' && (
                <Crown className="size-4 shrink-0 text-lamp-500" aria-label="Owner" />
              )}
              {isOwner && !isSelf && (
                <button
                  type="button"
                  onClick={() => void controls.remove(member.userId)}
                  aria-label={`Remove ${member.displayName}`}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-500 hover:text-danger-500"
                >
                  <UserMinus className="size-4" aria-hidden />
                </button>
              )}
            </div>

            {locked && (
              <div className="flex items-center gap-2 rounded-lg border border-lamp-600/40 bg-lamp-600/10 p-2 text-xs text-lamp-400">
                <KeyRound className="size-3.5 shrink-0" aria-hidden />
                <span className="flex-1">
                  {isOwner
                    ? `${member.displayName} has no key for this and cannot decrypt it.`
                    : 'They cannot decrypt this yet.'}
                </span>
                {isOwner && (
                  <button
                    type="button"
                    disabled={sending === member.userId}
                    onClick={() => void sendKey(member.userId)}
                    className="min-h-9 shrink-0 rounded-lg bg-lamp-500 px-3 text-xs font-medium text-ink-950 hover:bg-lamp-400 disabled:opacity-45"
                  >
                    {sending === member.userId ? '…' : 'Send the key'}
                  </button>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function InvitePanel({ controls }: { controls: SessionControls }) {
  const { friends, members } = controls
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invited, setInvited] = useState<string[]>([])

  const alreadyHere = new Set(members.map((member) => member.userId))
  const invitable = friends.filter((friend) => !alreadyHere.has(friend.id))

  async function ask(friendId: string) {
    setError(null)
    setBusy(friendId)
    try {
      await controls.invite(friendId)
      setInvited((current) => [...current, friendId])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That invitation did not go through.')
    } finally {
      setBusy(null)
    }
  }

  if (friends.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-500">
        You have no friends here yet.{' '}
        <Link to="/friends" className="text-lamp-500 hover:underline">
          Add someone first.
        </Link>
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-ink-500">
        Inviting someone also wraps this video&rsquo;s key to their identity key, on this device.
        Without that they would arrive to a video they cannot decrypt.
      </p>

      {invitable.length === 0 ? (
        <p className="text-sm text-ink-500">Everyone you know is already here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {invitable.map((friend) => (
            <li key={friend.id} className="flex items-center gap-3 rounded-xl bg-ink-850 p-2">
              <Avatar name={friend.displayName} hue={friend.avatarHue} />
              <p className="min-w-0 flex-1 truncate text-sm text-ink-100">{friend.displayName}</p>
              <button
                type="button"
                disabled={busy === friend.id || invited.includes(friend.id)}
                onClick={() => void ask(friend.id)}
                className="min-h-11 rounded-xl bg-lamp-500 px-4 text-sm font-medium text-ink-950 hover:bg-lamp-400 disabled:opacity-45"
              >
                {busy === friend.id ? '…' : invited.includes(friend.id) ? 'Asked' : 'Invite'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-500">
          {error}
        </p>
      )}
    </div>
  )
}

export function SettingsPanel({ controls }: { controls: SessionControls }) {
  const { room, isOwner, clockUncertaintyMs } = controls
  const ownerOnly = room.controlMode === 'owner_only'
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={controls.forceSync}
        className="inline-flex min-h-12 items-center gap-3 rounded-xl bg-ink-850 px-4 text-sm text-ink-100 hover:bg-ink-800"
      >
        <RefreshCw className="size-4 shrink-0" aria-hidden />
        <span className="text-left">
          Pull everyone into step
          <span className="block text-xs text-ink-500">
            Re-sends where you are, and everyone lands on it.
          </span>
        </span>
      </button>

      {isOwner && (
        <button
          type="button"
          onClick={() => void controls.setOwnerOnly(!ownerOnly)}
          aria-pressed={ownerOnly}
          className="inline-flex min-h-12 items-center gap-3 rounded-xl bg-ink-850 px-4 text-sm text-ink-100 hover:bg-ink-800"
        >
          {ownerOnly ? (
            <Lock className="size-4 shrink-0 text-lamp-500" aria-hidden />
          ) : (
            <LockOpen className="size-4 shrink-0" aria-hidden />
          )}
          <span className="text-left">
            {ownerOnly ? 'Only you can control playback' : 'Anyone watching can control playback'}
            <span className="block text-xs text-ink-500">
              {ownerOnly ? 'Tap to hand the controls back.' : 'Tap to keep them to yourself.'}
            </span>
          </span>
        </button>
      )}

      <p className="text-xs leading-relaxed text-ink-700">
        Everyone follows the server&rsquo;s clock rather than their own, measured to about{' '}
        {clockUncertaintyMs}ms.
      </p>

      {isOwner && (
        <button
          type="button"
          onClick={() => (confirming ? void controls.stop() : setConfirming(true))}
          className="mt-1 inline-flex min-h-12 items-center justify-center rounded-xl bg-ink-850 px-4 text-sm text-danger-500 hover:bg-ink-800"
        >
          {confirming ? 'Really stop it for everyone?' : 'Stop watching together'}
        </button>
      )}
    </div>
  )
}
