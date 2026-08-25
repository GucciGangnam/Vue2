import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Callout } from '@/components/ui/Callout'
import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useSession } from '@/stores/sessionStore'

/**
 * First-run identity creation. Reached when a user is signed in but has no
 * keypair yet -- normally straight after sign-up, but also if setup was
 * interrupted, or the account was confirmed in another tab.
 */
export function VaultSetup() {
  const setupVault = useSession((s) => s.setupVault)
  const transientPassword = useSession((s) => s.transientPassword)

  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const attempted = useRef(false)

  // If we still hold the password from sign-in, don't make them type it again.
  useEffect(() => {
    if (!transientPassword || attempted.current) return
    attempted.current = true
    setBusy(true)
    setupVault(transientPassword)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Could not create your keys'),
      )
      .finally(() => setBusy(false))
  }, [transientPassword, setupVault])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await setupVault(password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create your keys')
      setBusy(false)
    }
  }

  if (transientPassword || busy) {
    return (
      <Screen className="items-center text-center">
        <KeyRound className="size-8 animate-pulse text-lamp-500" aria-hidden />
        <ScreenHeader
          title="Generating your keys"
          subtitle="This happens on your device and takes a moment."
        />
        {error && <p className="text-sm text-danger-500">{error}</p>}
      </Screen>
    )
  }

  return (
    <Screen>
      <ScreenHeader
        title="Set up your keys"
        subtitle="Confirm your password to generate the encryption keys for your account."
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Callout>
          Your password never leaves this device. It is used to encrypt your private key before
          anything is stored.
        </Callout>
        <Button type="submit" loading={busy}>
          Generate keys
        </Button>
      </form>
    </Screen>
  )
}
