import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoldToUnlock, UnlockButton } from './HoldToUnlock'
import { CANCEL_DISTANCE_PX, HOLD_DURATION_MS } from '@/lib/player/holdGesture'

/**
 * The gesture is animated with `requestAnimationFrame` and timed against
 * `Date.now`, both of which the fake timers replace, so a three-second hold
 * takes no real time and lands on exact boundaries.
 */
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * The ring is driven by animation frames, so the gesture completes on the first
 * frame *after* three seconds -- up to 16ms late, which nobody can see and the
 * test should not pretend otherwise. Advancing inside `act` also lets React
 * flush the state those frames produce.
 */
const A_FEW_FRAMES = 48

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function press(element: HTMLElement, at = { x: 50, y: 50 }) {
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: at.x, clientY: at.y })
}

function moveTo(element: HTMLElement, at: { x: number; y: number }) {
  fireEvent.pointerMove(element, { pointerId: 1, clientX: at.x, clientY: at.y })
}

function release(element: HTMLElement) {
  fireEvent.pointerUp(element, { pointerId: 1 })
}

describe('HoldToUnlock', () => {
  it('says it is locked before anyone touches it', () => {
    render(<HoldToUnlock onUnlock={vi.fn()} />)
    expect(screen.getByText('Locked')).toBeInTheDocument()
  })

  it('ignores a tap, and says why', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(120)
    release(surface)

    expect(onUnlock).not.toHaveBeenCalled()
    expect(screen.getByText(/Hold for 3 seconds/)).toBeInTheDocument()
  })

  it('ignores a hold abandoned one frame early', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(HOLD_DURATION_MS - 100)
    release(surface)
    advance(HOLD_DURATION_MS)

    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('unlocks after a full three-second hold', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(HOLD_DURATION_MS + A_FEW_FRAMES)

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('shows the ring filling while the hold is in progress', () => {
    render(<HoldToUnlock onUnlock={vi.fn()} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(HOLD_DURATION_MS / 2)

    const ring = screen.getByRole('progressbar', { name: 'Hold to unlock' })
    expect(Number(ring.getAttribute('aria-valuenow'))).toBeGreaterThan(40)
    expect(Number(ring.getAttribute('aria-valuenow'))).toBeLessThan(60)
  })

  it('gives up when the finger wanders -- a scroll, or a Phase 7 stroke', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface, { x: 50, y: 50 })
    advance(200)
    moveTo(surface, { x: 50 + CANCEL_DISTANCE_PX + 5, y: 50 })
    advance(HOLD_DURATION_MS + A_FEW_FRAMES)

    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('tolerates a resting thumb drifting within the slop', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface, { x: 50, y: 50 })
    advance(200)
    moveTo(surface, { x: 50 + CANCEL_DISTANCE_PX, y: 50 })
    advance(HOLD_DURATION_MS + A_FEW_FRAMES)

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('unlocks only once, however long the finger stays down', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(HOLD_DURATION_MS * 3)
    release(surface)

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('is not disturbed by a second finger arriving mid-hold', () => {
    const onUnlock = vi.fn()
    render(<HoldToUnlock onUnlock={onUnlock} />)
    const surface = screen.getByTestId('hold-surface')

    press(surface)
    advance(500)
    fireEvent.pointerUp(surface, { pointerId: 2 })
    advance(HOLD_DURATION_MS + A_FEW_FRAMES)

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })
})

describe('UnlockButton', () => {
  it('is the escape hatch: one activation, no holding', () => {
    const onUnlock = vi.fn()
    render(<UnlockButton onUnlock={onUnlock} />)

    fireEvent.click(screen.getByRole('button', { name: 'Unlock controls' }))

    expect(onUnlock).toHaveBeenCalledTimes(1)
  })
})
