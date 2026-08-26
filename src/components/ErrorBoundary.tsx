import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Screen, ScreenHeader } from '@/components/ui/Screen'

/**
 * Catches a render-time crash and offers a way out.
 *
 * Without one of these, a single thrown error unmounts the whole tree and
 * leaves a blank page -- which in this app is worse than it sounds, because
 * the most likely thing to throw is a decrypt of something unexpected, and a
 * blank page gives the user no way to tell "this one video is broken" from
 * "the app is gone".
 *
 * Recovery is deliberately cheap: the unlocked identity key lives in IndexedDB
 * (D13), so retrying or even a full reload does not cost another password
 * prompt or another Argon2id derivation.
 */

interface Props {
  children: ReactNode
  /** Shown instead of the default screen. Receives a reset that clears the error. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** Called on catch. Kept injectable so the tests can assert without a spy on console. */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <Screen>
        <ScreenHeader
          title="Something went wrong"
          subtitle="That screen stopped unexpectedly. Your videos and your keys are untouched."
        />
        {/* The message is worth showing: it is usually the difference between
            "this file will not decrypt" and "the network is down", and the
            person reading it is the one who can act on that. */}
        <p className="rounded-xl bg-ink-850 px-4 py-3 font-mono text-sm break-words text-ink-400">
          {error.message || 'No further detail.'}
        </p>
        <div className="flex flex-col gap-3">
          <Button onClick={this.reset}>Try again</Button>
          <Button variant="ghost" onClick={() => window.location.assign('/library')}>
            Back to the library
          </Button>
        </div>
      </Screen>
    )
  }
}
