import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Callout } from '@/components/ui/Callout'
import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useSession } from '@/stores/sessionStore'

const MIN_PASSWORD = 10

export function SignUp() {
  const signUp = useSession((s) => s.signUp)
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [awaitingEmail, setAwaitingEmail] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters`)
      return
    }

    setBusy(true)
    try {
      const { needsEmail } = await signUp(email, password, displayName.trim())
      if (needsEmail) setAwaitingEmail(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create your account')
    } finally {
      setBusy(false)
    }
  }

  if (awaitingEmail) {
    return (
      <Screen>
        <MailCheck className="size-8 text-lamp-500" aria-hidden />
        <ScreenHeader
          title="Confirm your email"
          subtitle={
            <>
              We sent a link to <span className="text-ink-300">{email}</span>. Open it, then sign in
              to finish setting up your encryption keys.
            </>
          }
        />
        <Link to="/signin">
          <Button variant="ghost">Back to sign in</Button>
        </Link>
      </Screen>
    )
  }

  return (
    <Screen>
      <ScreenHeader
        title="Create your account"
        subtitle="Your videos are encrypted on this device before they are uploaded."
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Display name"
          autoComplete="nickname"
          required
          maxLength={32}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          hint="What your friends will see."
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters.`}
          error={error ?? undefined}
        />
        <Callout tone="warning">
          Your password also unlocks your encryption keys. If you forget it, only your recovery
          phrase can get your videos back &mdash; we cannot reset it for you.
        </Callout>
        <Button type="submit" loading={busy}>
          Create account
        </Button>
      </form>
      <p className="text-center text-sm text-ink-500">
        Already have an account?{' '}
        <Link to="/signin" className="font-medium text-lamp-500 hover:underline">
          Sign in
        </Link>
      </p>
    </Screen>
  )
}
