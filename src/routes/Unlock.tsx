import { useState, type FormEvent } from 'react'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { isValidRecoveryPhrase } from '@/lib/crypto/mnemonic'
import { useSession } from '@/stores/sessionStore'

export function Unlock() {
  const unlock = useSession((s) => s.unlock)
  const recoverWithPhrase = useSession((s) => s.recoverWithPhrase)
  const signOut = useSession((s) => s.signOut)

  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submitPassword(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await unlock(password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unlock')
    } finally {
      setBusy(false)
    }
  }

  async function submitRecovery(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (!isValidRecoveryPhrase(phrase)) {
      setError('That does not look like a valid 12-word phrase')
      return
    }
    if (newPassword.length < 10) {
      setError('Use at least 10 characters for the new password')
      return
    }

    setBusy(true)
    try {
      await recoverWithPhrase(phrase, newPassword)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not recover your account')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'recovery') {
    return (
      <Screen>
        <ScreenHeader
          title="Use your recovery phrase"
          subtitle="Enter your 12 words and choose a new password."
        />
        <form onSubmit={submitRecovery} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="phrase" className="text-sm font-medium text-ink-300">
              Recovery phrase
            </label>
            <textarea
              id="phrase"
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="twelve words separated by spaces"
              className="rounded-xl border border-ink-800 bg-ink-900 px-4 py-3 text-base text-ink-100 outline-none placeholder:text-ink-700 focus:border-lamp-500"
            />
          </div>
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={error ?? undefined}
          />
          <Button type="submit" loading={busy}>
            Recover my account
          </Button>
          <Button variant="ghost" type="button" onClick={() => setMode('password')}>
            Back
          </Button>
        </form>
      </Screen>
    )
  }

  return (
    <Screen>
      <Lock className="size-7 text-lamp-500" aria-hidden />
      <ScreenHeader
        title="Unlock your vault"
        subtitle="Enter your password to decrypt your keys on this device."
      />
      <form onSubmit={submitPassword} className="flex flex-col gap-4">
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
        <Button type="submit" loading={busy}>
          Unlock
        </Button>
      </form>
      <div className="flex flex-col gap-2 text-center text-sm">
        <button
          type="button"
          onClick={() => {
            setMode('recovery')
            setError(null)
          }}
          className="font-medium text-lamp-500 hover:underline"
        >
          I forgot my password
        </button>
        <button type="button" onClick={signOut} className="text-ink-500 hover:text-ink-300">
          Sign out
        </button>
      </div>
    </Screen>
  )
}
