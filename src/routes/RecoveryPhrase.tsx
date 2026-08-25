import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Callout } from '@/components/ui/Callout'
import { Screen, ScreenHeader } from '@/components/ui/Screen'
import { recoveryPhraseWords } from '@/lib/crypto/mnemonic'
import { useSession } from '@/stores/sessionStore'

/**
 * Shown exactly once, right after the vault is created.
 *
 * The confirmation step is deliberate friction: this phrase is the only way
 * back into an account whose password is forgotten, and a user who clicks
 * past it has silently accepted permanent data loss without knowing.
 */
export function RecoveryPhrase({ phrase }: { phrase: string }) {
  const acknowledge = useSession((s) => s.acknowledgeRecoveryPhrase)
  const words = useMemo(() => recoveryPhraseWords(phrase), [phrase])

  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [guess, setGuess] = useState('')
  const [wrong, setWrong] = useState(false)

  // Ask for one word back. Chosen once via a lazy initialiser so it cannot
  // change under the user on a re-render.
  const [checkIndex] = useState(() => Math.floor(Math.random() * words.length))

  async function copy() {
    await navigator.clipboard.writeText(words.join(' '))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function verify() {
    if (guess.trim().toLowerCase() === words[checkIndex]) acknowledge()
    else setWrong(true)
  }

  if (confirming) {
    return (
      <Screen>
        <ScreenHeader
          title="Check your phrase"
          subtitle={`Type word number ${checkIndex + 1} to confirm you have written it down.`}
        />
        <div className="flex flex-col gap-4">
          <input
            aria-label={`Word ${checkIndex + 1}`}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={guess}
            onChange={(e) => {
              setGuess(e.target.value)
              setWrong(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && verify()}
            className="min-h-12 rounded-xl border border-ink-800 bg-ink-900 px-4 text-center text-lg text-ink-100 outline-none focus:border-lamp-500"
          />
          {wrong && (
            <p role="alert" className="text-center text-sm text-danger-500">
              That is not word {checkIndex + 1}. Go back and check.
            </p>
          )}
          <Button onClick={verify} disabled={guess.trim() === ''}>
            Confirm
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Show the phrase again
          </Button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <ScreenHeader
        title="Your recovery phrase"
        subtitle="Write these 12 words down and keep them somewhere safe."
      />

      <ol className="grid grid-cols-2 gap-2">
        {words.map((word, index) => (
          <li
            key={`${index}-${word}`}
            className="flex items-baseline gap-2 rounded-lg bg-ink-900 px-3 py-2.5"
          >
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-ink-700">
              {index + 1}
            </span>
            <span className="font-medium text-ink-100">{word}</span>
          </li>
        ))}
      </ol>

      <Callout tone="warning">
        This is the <strong>only</strong> way to get your videos back if you forget your password.
        We do not have a copy. If you lose both, your media is gone permanently.
      </Callout>

      <div className="flex flex-col gap-3">
        <Button variant="ghost" onClick={copy}>
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy to clipboard'}
        </Button>
        <Button onClick={() => setConfirming(true)}>I have written it down</Button>
      </div>
    </Screen>
  )
}
