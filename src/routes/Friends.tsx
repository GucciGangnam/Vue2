import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, Copy, Loader2, Share2, UserPlus, X } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useFriends } from '@/hooks/useFriends'
import {
  findProfileByCode,
  isCompleteFriendCode,
  normalizeFriendCode,
  type Friend,
  type PendingRequest,
  type PersonSummary,
} from '@/lib/friends'
import { useSession } from '@/stores/sessionStore'

export function Friends() {
  const profile = useSession((s) => s.profile)
  const session = useSession((s) => s.session)
  const userId = session?.user.id ?? ''
  const { friends, incoming, outgoing, isLoading, error, send, respond, cancel, remove } =
    useFriends(userId)

  return (
    <Screen className="justify-start gap-7">
      <header className="flex flex-col gap-2">
        <Link
          to="/library"
          className="-ml-1 inline-flex items-center gap-1.5 self-start rounded-lg py-1 pr-2 pl-1 text-sm text-ink-500 hover:text-ink-300"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Library
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-ink-100">Friends</h1>
        <p className="text-base leading-relaxed text-ink-500">
          You can only watch with people you have added here.
        </p>
      </header>

      {profile && <YourCode code={profile.friend_code} name={profile.display_name} />}

      <AddByCode
        ownCode={profile?.friend_code ?? ''}
        onSend={(person) => send.mutateAsync(person.id)}
      />

      {error && (
        <p role="alert" className="text-sm text-danger-500">
          {error instanceof Error ? error.message : 'Could not load your friends.'}
        </p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-ink-700" aria-label="Loading friends" />
        </div>
      ) : (
        <>
          {incoming.length > 0 && (
            <Section title="Invitations" count={incoming.length}>
              {incoming.map((request) => (
                <IncomingRow
                  key={request.id}
                  request={request}
                  busy={respond.isPending}
                  onRespond={(outcome) => respond.mutateAsync({ requestId: request.id, outcome })}
                />
              ))}
            </Section>
          )}

          {outgoing.length > 0 && (
            <Section title="Sent" count={outgoing.length}>
              {outgoing.map((request) => (
                <OutgoingRow
                  key={request.id}
                  request={request}
                  busy={cancel.isPending}
                  onCancel={() => cancel.mutateAsync(request.id)}
                />
              ))}
            </Section>
          )}

          <Section title="Your friends" count={friends.length}>
            {friends.length === 0 ? (
              <p className="px-1 text-sm leading-relaxed text-ink-500">
                Nobody yet. Share your code above, or add someone with theirs.
              </p>
            ) : (
              friends.map((friend) => (
                <FriendRow
                  key={friend.id}
                  friend={friend}
                  onRemove={() => remove.mutateAsync(friend.id)}
                />
              ))
            )}
          </Section>
        </>
      )}
    </Screen>
  )
}

/* -------------------------------------------------------------------------- */

function YourCode({ code, name }: { code: string; name: string }) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // Clipboard access can be refused outright (Safari without a user
      // gesture, an insecure origin). The code is on screen either way, so
      // say nothing and let them read it.
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: 'Add me on Vue2',
        text: `${name} on Vue2. My friend code is ${code}.`,
      })
    } catch {
      // Dismissing the share sheet rejects. Not an error.
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-ink-900 p-4">
      <h2 className="text-sm font-medium text-ink-500">Your friend code</h2>
      <p className="font-mono text-2xl tracking-[0.3em] text-lamp-500">{code}</p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={copy} className="min-h-11 text-sm">
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {canShare && (
          <Button variant="ghost" onClick={share} className="min-h-11 text-sm">
            <Share2 className="size-4" aria-hidden />
            Share
          </Button>
        )}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function AddByCode({
  ownCode,
  onSend,
}: {
  ownCode: string
  onSend: (person: PersonSummary) => Promise<unknown>
}) {
  const [code, setCode] = useState('')
  const [found, setFound] = useState<PersonSummary | null>(null)
  const [status, setStatus] = useState<'idle' | 'searching' | 'sending' | 'sent'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const complete = isCompleteFriendCode(code)

  function reset() {
    setCode('')
    setFound(null)
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setFound(null)

    // The RPC already excludes the caller, so without this the only feedback
    // for typing your own code would be "no account", which reads like a bug.
    if (code === normalizeFriendCode(ownCode)) {
      setMessage('That is your own code.')
      return
    }

    setStatus('searching')
    try {
      const person = await findProfileByCode(code)
      if (person) {
        setFound(person)
      } else {
        setMessage('No account with that code.')
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not look up that code.')
    } finally {
      setStatus('idle')
    }
  }

  async function sendTo(person: PersonSummary) {
    setMessage(null)
    setStatus('sending')
    try {
      await onSend(person)
      setStatus('sent')
      setMessage(`Request sent to ${person.displayName}.`)
      reset()
    } catch (cause) {
      setStatus('idle')
      setMessage(cause instanceof Error ? cause.message : 'Could not send that request.')
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-ink-500">Add someone</h2>

      <form onSubmit={search} className="flex flex-col gap-3">
        <TextField
          label="Their friend code"
          value={code}
          onChange={(event) => {
            setCode(normalizeFriendCode(event.target.value))
            setFound(null)
            setMessage(null)
            setStatus('idle')
          }}
          placeholder="ABCD1234"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          className="font-mono tracking-[0.2em] uppercase"
          hint="Eight characters. I, L and O are read as 1, 1 and 0."
        />
        <Button type="submit" variant="ghost" disabled={!complete} loading={status === 'searching'}>
          Find
        </Button>
      </form>

      {found && (
        <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900 p-3">
          <Avatar name={found.displayName} hue={found.avatarHue} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base text-ink-100">{found.displayName}</p>
            <p className="font-mono text-xs tracking-widest text-ink-500">{found.friendCode}</p>
          </div>
          <Button
            onClick={() => sendTo(found)}
            loading={status === 'sending'}
            className="min-h-11 w-auto px-4 text-sm"
          >
            <UserPlus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      )}

      {message && (
        <p
          role="status"
          className={status === 'sent' ? 'text-sm text-ok-500' : 'text-sm text-danger-500'}
        >
          {message}
        </p>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink-500">
        {title}
        {count > 0 && (
          <span className="rounded-full bg-ink-850 px-2 py-0.5 text-xs text-ink-300">{count}</span>
        )}
      </h2>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  )
}

function Row({ person, children }: { person: PersonSummary; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-ink-900 p-3">
      <Avatar name={person.displayName} hue={person.avatarHue} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base text-ink-100">{person.displayName}</p>
        <p className="font-mono text-xs tracking-widest text-ink-500">{person.friendCode}</p>
      </div>
      {children}
    </li>
  )
}

function IncomingRow({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (outcome: 'accepted' | 'declined') => Promise<unknown>
}) {
  return (
    <Row person={request.person}>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRespond('declined')}
          aria-label={`Decline ${request.person.displayName}`}
          className="inline-flex size-11 items-center justify-center rounded-xl bg-ink-850 text-ink-300 hover:bg-ink-800 disabled:opacity-45"
        >
          <X className="size-5" aria-hidden />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRespond('accepted')}
          aria-label={`Accept ${request.person.displayName}`}
          className="inline-flex size-11 items-center justify-center rounded-xl bg-lamp-500 text-ink-950 hover:bg-lamp-400 disabled:opacity-45"
        >
          <Check className="size-5" aria-hidden />
        </button>
      </div>
    </Row>
  )
}

function OutgoingRow({
  request,
  busy,
  onCancel,
}: {
  request: PendingRequest
  busy: boolean
  onCancel: () => Promise<unknown>
}) {
  return (
    <Row person={request.person}>
      <span className="text-xs text-ink-500">Waiting</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onCancel()}
        className="min-h-11 rounded-xl px-3 text-sm text-ink-500 hover:text-ink-300 disabled:opacity-45"
      >
        Cancel
      </button>
    </Row>
  )
}

function FriendRow({ friend, onRemove }: { friend: Friend; onRemove: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <Row person={friend}>
      {confirming ? (
        <button
          type="button"
          onClick={() => void onRemove()}
          className="min-h-11 rounded-xl bg-ink-850 px-3 text-sm text-danger-500"
        >
          Remove?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Remove ${friend.displayName}`}
          className="min-h-11 rounded-xl px-3 text-sm text-ink-500 hover:text-ink-300"
        >
          Remove
        </button>
      )}
    </Row>
  )
}
