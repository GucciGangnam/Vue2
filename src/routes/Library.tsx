import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Film,
  Loader2,
  Play,
  Share2,
  Trash2,
  Tv,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { InstallPrompt } from '@/components/InstallPrompt'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useFriends } from '@/hooks/useFriends'
import { useLibrary, useShares, useUpload } from '@/hooks/useLibrary'
import { useRooms } from '@/hooks/useRooms'
import { formatBytes, formatDuration, formatPercent } from '@/lib/format'
import type { LibraryItem } from '@/lib/media/library'
import type { UploadProgress } from '@/lib/media/upload'
import { useSession } from '@/stores/sessionStore'

const PHASE_LABEL: Record<UploadProgress['phase'], string> = {
  reading: 'Reading the video',
  encrypting: 'Encrypting',
  uploading: 'Uploading',
  finishing: 'Finishing up',
}

export function Library() {
  const profile = useSession((s) => s.profile)
  const signOut = useSession((s) => s.signOut)
  const { items, isLoading, error, refresh, remove, share, revoke } = useLibrary()
  const upload = useUpload(refresh)
  const { rooms, start } = useRooms()
  const navigate = useNavigate()
  const [sharing, setSharing] = useState<LibraryItem | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)

  const openRooms = rooms.filter((room) => room.myState !== 'left' && room.myState !== 'kicked')

  async function watchTogether(item: LibraryItem) {
    setRoomError(null)
    try {
      const roomId = await start.mutateAsync(item.id)
      void navigate(`/room/${roomId}`)
    } catch (cause) {
      // Creation is rate limited, so this can genuinely refuse. The database
      // words that refusal for a reader, so pass it straight through.
      setRoomError(cause instanceof Error ? cause.message : 'Could not open a room just now.')
    }
  }

  return (
    <Screen className="justify-start gap-7">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight text-ink-100">
            {profile ? profile.display_name : 'Library'}
          </h1>
          {profile && (
            <p className="font-mono text-xs tracking-widest text-ink-500">{profile.friend_code}</p>
          )}
        </div>
        <Link
          to="/friends"
          aria-label="Friends"
          className="inline-flex size-11 items-center justify-center rounded-xl bg-ink-850 text-ink-300 hover:bg-ink-800"
        >
          <Users className="size-5" aria-hidden />
        </Link>
      </header>

      <InstallPrompt />

      <UploadPanel upload={upload} />

      {openRooms.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-ink-500">Rooms</h2>
          <ul className="flex flex-col gap-2">
            {openRooms.map((room) => {
              const item = items.find((candidate) => candidate.id === room.mediaId)
              return (
                <li key={room.id}>
                  <Link
                    to={`/room/${room.id}`}
                    className="flex items-center gap-3 rounded-xl bg-ink-900 p-3 hover:bg-ink-850"
                  >
                    <Tv className="size-5 shrink-0 text-lamp-500" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-ink-100">{item?.title ?? 'A video'}</p>
                      <p className="text-xs text-ink-500">
                        {room.myState === 'invited' ? 'You were invited' : 'You are in this room'}
                        {room.isPlaying && ' · playing'}
                      </p>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {roomError && (
        <p role="alert" className="text-sm text-danger-500">
          {roomError}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-500">
          {error instanceof Error ? error.message : 'Could not load your library.'}
        </p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-ink-700" aria-label="Loading library" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink-800 px-6 py-12 text-center">
          <Film className="size-6 text-ink-700" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-500">
            Nothing here yet. Everything you add is encrypted on this device before it is uploaded —
            the server only ever holds ciphertext.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              busy={remove.isPending}
              onShare={() => setSharing(item)}
              onWatchTogether={() => void watchTogether(item)}
              onDelete={() => remove.mutate(item)}
              onResume={(file) => upload.resume(item.id, file)}
            />
          ))}
        </ul>
      )}

      {sharing && (
        <ShareSheet
          item={sharing}
          onClose={() => setSharing(null)}
          onShare={(recipientId) =>
            share.mutateAsync({ mediaId: sharing.id, recipientId }).then(() => undefined)
          }
          onRevoke={(recipientId) =>
            revoke.mutateAsync({ mediaId: sharing.id, recipientId }).then(() => undefined)
          }
        />
      )}

      <Button variant="ghost" onClick={signOut}>
        Sign out
      </Button>
    </Screen>
  )
}

/* -------------------------------------------------------------------------- */

function UploadPanel({ upload }: { upload: ReturnType<typeof useUpload> }) {
  const input = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState<File | null>(null)
  const [title, setTitle] = useState('')

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    setChosen(file)
    // A sensible default the user can overwrite: the filename without its
    // extension is almost always closer than an empty box.
    setTitle(file ? file.name.replace(/\.[^.]+$/, '') : '')
    // Reset, or picking the same file twice in a row fires no change event.
    event.target.value = ''
  }

  if (upload.active) return <UploadProgressPanel upload={upload} />

  return (
    <section className="flex flex-col gap-3">
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={onPick}
        data-testid="video-input"
      />

      {chosen ? (
        <div className="flex flex-col gap-3 rounded-xl bg-ink-900 p-4">
          <p className="truncate text-sm text-ink-300">{chosen.name}</p>
          <p className="text-xs text-ink-500">{formatBytes(chosen.size)}</p>
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            hint="Encrypted before it is stored. Supabase never sees it."
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setChosen(null)} className="text-sm">
              Cancel
            </Button>
            <Button
              onClick={() => {
                upload.start(chosen, title)
                setChosen(null)
              }}
              className="text-sm"
            >
              <Upload className="size-4" aria-hidden />
              Encrypt and upload
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden />
          Add a video
        </Button>
      )}

      {upload.error && (
        <p role="alert" className="text-sm text-danger-500">
          {upload.error}
        </p>
      )}
    </section>
  )
}

function UploadProgressPanel({ upload }: { upload: ReturnType<typeof useUpload> }) {
  const active = upload.active
  if (!active) return null

  const { phase, bytesDone, bytesTotal } = active.progress
  const percent = formatPercent(bytesDone, bytesTotal)

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-ink-900 p-4" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm text-ink-300">{active.fileName}</p>
        <p className="shrink-0 font-mono text-sm text-lamp-500">{percent}</p>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-ink-850">
        <div
          className="h-full rounded-full bg-lamp-500 transition-[width] duration-200"
          style={{ width: percent }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-500">
          {PHASE_LABEL[phase]}
          {bytesTotal > 1 && ` · ${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`}
        </p>
        <button
          type="button"
          onClick={upload.cancel}
          className="min-h-11 rounded-xl px-3 text-sm text-ink-500 hover:text-ink-300"
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function MediaCard({
  item,
  busy,
  onShare,
  onWatchTogether,
  onDelete,
  onResume,
}: {
  item: LibraryItem
  busy: boolean
  onShare: () => void
  onWatchTogether: () => void
  onDelete: () => void
  onResume: (file: File) => void
}) {
  const resumeInput = useRef<HTMLInputElement>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  const incomplete = item.status !== 'ready'

  return (
    <li className="overflow-hidden rounded-xl bg-ink-900">
      <Poster posterUrl={item.posterUrl} />

      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base text-ink-100">
              {item.title ?? <span className="text-ink-500">Locked — no key for this video</span>}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
              {formatDuration(item.durationMs)} · {formatBytes(item.plaintextSize)}
              {!item.isOwn && ' · shared with you'}
            </p>
          </div>
        </div>

        {incomplete && (
          <div className="flex items-start gap-2 rounded-lg border border-lamp-600/40 bg-lamp-600/10 p-3 text-xs leading-relaxed text-lamp-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {item.status === 'failed'
                ? 'This upload did not finish. Pick the same file again to complete it.'
                : 'This upload is still in progress.'}
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {item.status === 'ready' && item.title && (
            <Link
              to={`/watch/${item.id}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-lamp-500 px-4 text-sm font-medium text-ink-950 hover:bg-lamp-400"
            >
              <Play className="size-4" aria-hidden />
              Watch
            </Link>
          )}

          {item.isOwn && incomplete && (
            <>
              <input
                ref={resumeInput}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) onResume(file)
                  event.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => resumeInput.current?.click()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
              >
                <Upload className="size-4" aria-hidden />
                Finish upload
              </button>
            </>
          )}

          {item.status === 'ready' && item.title && (
            <button
              type="button"
              onClick={onWatchTogether}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              <Tv className="size-4" aria-hidden />
              Watch together
            </button>
          )}

          {item.isOwn && item.status === 'ready' && item.title && (
            <button
              type="button"
              onClick={onShare}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
            >
              <Share2 className="size-4" aria-hidden />
              Share
            </button>
          )}

          {item.isOwn && (
            <button
              type="button"
              disabled={busy}
              onClick={() => (confirming ? onDelete() : setConfirming(true))}
              aria-label={confirming ? undefined : `Delete ${item.title ?? 'this video'}`}
              className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-ink-500 hover:text-danger-500 disabled:opacity-45"
            >
              <Trash2 className="size-4" aria-hidden />
              {confirming ? 'Delete for good?' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

/** Decrypted poster, or a placeholder. */
function Poster({ posterUrl }: { posterUrl: string | null }) {
  return (
    <div className="relative aspect-video w-full bg-ink-850">
      {posterUrl ? (
        <img src={posterUrl} alt="" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Film className="size-7 text-ink-700" aria-hidden />
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ShareSheet({
  item,
  onClose,
  onShare,
  onRevoke,
}: {
  item: LibraryItem
  onClose: () => void
  onShare: (recipientId: string) => Promise<void>
  onRevoke: (recipientId: string) => Promise<void>
}) {
  const session = useSession((s) => s.session)
  const { friends } = useFriends(session?.user.id ?? '')
  const shares = useShares(item.id)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sharedWith = new Set((shares.data ?? []).map((share) => share.recipientId))

  async function act(recipientId: string, action: (id: string) => Promise<void>) {
    setError(null)
    setBusy(recipientId)
    try {
      await action(recipientId)
      await shares.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${item.title ?? 'video'}`}
    >
      <div className="safe-bottom flex max-h-[85dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl bg-ink-900 p-5 sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-medium text-ink-100">Share</h2>
            <p className="truncate text-sm text-ink-500">{item.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-500 hover:text-ink-100"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <p className="text-xs leading-relaxed text-ink-500">
          Sharing wraps this video&rsquo;s key to your friend&rsquo;s identity key, on this device.
          Removing access takes their key away, but it cannot undo what they have already watched,
          and their copy may keep working for a few minutes.
        </p>

        {friends.length === 0 ? (
          <p className="text-sm text-ink-500">
            You have no friends yet.{' '}
            <Link to="/friends" className="text-lamp-500 hover:underline">
              Add someone first.
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {friends.map((friend) => {
              const has = sharedWith.has(friend.id)
              return (
                <li key={friend.id} className="flex items-center gap-3 rounded-xl bg-ink-850 p-3">
                  <Avatar name={friend.displayName} hue={friend.avatarHue} />
                  <p className="min-w-0 flex-1 truncate text-base text-ink-100">
                    {friend.displayName}
                  </p>
                  <button
                    type="button"
                    disabled={busy === friend.id}
                    onClick={() => void act(friend.id, has ? onRevoke : onShare)}
                    className={
                      has
                        ? 'min-h-11 rounded-xl px-3 text-sm text-ink-500 hover:text-danger-500 disabled:opacity-45'
                        : 'min-h-11 rounded-xl bg-lamp-500 px-4 text-sm font-medium text-ink-950 hover:bg-lamp-400 disabled:opacity-45'
                    }
                  >
                    {busy === friend.id ? '…' : has ? 'Remove' : 'Share'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
