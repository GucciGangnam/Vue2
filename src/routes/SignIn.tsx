import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useSession } from '@/stores/sessionStore'

export function SignIn() {
  const signIn = useSession((s) => s.signIn)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(email, password)
      // Routing is driven by the auth listener in sessionStore.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in')
      setBusy(false)
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Welcome back" subtitle="Sign in to watch with your friends." />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="text-center text-sm text-ink-500">
        No account?{' '}
        <Link to="/signup" className="font-medium text-lamp-500 hover:underline">
          Create one
        </Link>
      </p>
    </Screen>
  )
}
