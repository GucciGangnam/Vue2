import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * React logs a caught error to console.error regardless of the boundary, which
 * is noise rather than signal here. Silenced per-test so a genuine unexpected
 * console error elsewhere still shows up.
 */
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

function Boom({ message = 'chunk 7 failed to verify' }: { message?: string }): never {
  throw new Error(message)
}

function Fine() {
  return <p>the screen</p>
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Fine />
      </ErrorBoundary>,
    )
    expect(screen.getByText('the screen')).toBeInTheDocument()
  })

  it('shows the message, because it is what tells the user what to do next', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('chunk 7 failed to verify')).toBeInTheDocument()
  })

  it('reassures that keys and videos are untouched', () => {
    // A blank page cannot say this, and it is the first thing anyone will
    // worry about in an app that holds the only copy of their keys.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/keys are untouched/i)).toBeInTheDocument()
  })

  it('falls back to a placeholder when the error carries no message', () => {
    render(
      <ErrorBoundary>
        <Boom message="" />
      </ErrorBoundary>,
    )
    expect(screen.getByText('No further detail.')).toBeInTheDocument()
  })

  it('reports the error to a caller that wants to know', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('recovers when the cause has gone away', async () => {
    const user = userEvent.setup()

    function Flaky() {
      const [broken, setBroken] = useState(true)
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div>
              <p>caught: {error.message}</p>
              <button
                onClick={() => {
                  setBroken(false)
                  reset()
                }}
              >
                Try again
              </button>
            </div>
          )}
        >
          {broken ? <Boom /> : <Fine />}
        </ErrorBoundary>
      )
    }

    render(<Flaky />)
    expect(screen.getByText(/caught: chunk 7/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('the screen')).toBeInTheDocument()
  })

  it('renders a custom fallback instead of the default screen', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('custom: chunk 7 failed to verify')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })
})
