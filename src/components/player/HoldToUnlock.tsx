/**
 * The locked player's two ways in.
 *
 * `HoldToUnlock` is the gesture: a transparent surface over the video that
 * answers taps with nothing and unlocks after a deliberate three-second hold,
 * with a ring filling as it goes. That is the whole feature -- one person
 * shifting their grip on a phone must not pause the film for everybody.
 *
 * `UnlockButton` is the same door with a handle. A keyboard user cannot hold,
 * and a switch user cannot hold *at all*, so a gesture with no alternative
 * would lock them out of the room's controls entirely. It is a real button, it
 * is always visible while the room is locked, and one activation opens the
 * controls. That is a deliberate trade: the surface it protects is the whole
 * video, where an accidental touch is likely; a labelled button in the control
 * strip is not somewhere a thumb lands by accident. See docs/DECISIONS.md D32.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import { hapticHoldComplete, hapticHoldStarted } from '@/lib/player/haptics'
import {
  beginHold,
  holdProgress,
  isHoldComplete,
  hasMovedTooFar,
  ownsPointer,
  type Hold,
} from '@/lib/player/holdGesture'

/** How long the "hold, don't tap" hint stays up after a press that did nothing. */
const HINT_MS = 1800

const RING_RADIUS = 34
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function HoldToUnlock({ onUnlock }: { onUnlock: () => void }) {
  const [progress, setProgress] = useState(0)
  const [hinting, setHinting] = useState(false)

  const hold = useRef<Hold | null>(null)
  const frame = useRef(0)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const stopAnimating = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])

  useEffect(() => {
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      clearTimeout(hintTimer.current)
    }
  }, [])

  // A named function expression rather than a self-referencing arrow: the
  // callback schedules itself, and reading `tick` from inside its own
  // initialiser is exactly the pattern the linter objects to.
  const tick = useCallback(
    function step() {
      const current = hold.current
      if (!current) return

      const now = Date.now()
      if (isHoldComplete(current, now)) {
        hold.current = null
        stopAnimating()
        setProgress(0)
        hapticHoldComplete()
        onUnlock()
        return
      }

      setProgress(holdProgress(current, now))
      frame.current = requestAnimationFrame(step)
    },
    [onUnlock, stopAnimating],
  )

  /** A press that ended without completing. Say why nothing happened. */
  const abandon = useCallback(
    (withHint: boolean) => {
      hold.current = null
      stopAnimating()
      setProgress(0)
      if (!withHint) return
      setHinting(true)
      clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setHinting(false), HINT_MS)
    },
    [stopAnimating],
  )

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Only the primary button, and only one finger: a second pointer arriving
    // mid-hold is a pinch or a stray palm, not a second attempt.
    if (event.button > 0 || hold.current) return

    hold.current = beginHold(event.pointerId, { x: event.clientX, y: event.clientY }, Date.now())

    clearTimeout(hintTimer.current)
    setHinting(false)
    setProgress(0)
    hapticHoldStarted()
    frame.current = requestAnimationFrame(tick)

    // Capture so a finger that drifts off the video still reports its release
    // here; without it a hold that ends outside the box never resolves.
    //
    // Last, and guarded. `setPointerCapture` throws `NotFoundError` for a
    // pointer the browser no longer considers active, and a throw earlier in
    // this handler would leave a hold that had begun and would never tick --
    // the gesture would simply stop working, with nothing on screen to say so.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Without capture, a finger leaving the video ends the hold. Acceptable.
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = hold.current
    if (!current || !ownsPointer(current, event.pointerId)) return
    // A moving finger is a scroll, or -- from Phase 7 -- a drawn stroke. Either
    // way it is not this gesture, and silently letting go is the right answer.
    if (hasMovedTooFar(current, { x: event.clientX, y: event.clientY })) abandon(false)
  }

  function onPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const current = hold.current
    if (!current || !ownsPointer(current, event.pointerId)) return
    abandon(true)
  }

  const holding = progress > 0

  return (
    <div
      data-testid="hold-surface"
      // `touch-none` is load-bearing: without it the browser claims the gesture
      // for scrolling and the pointer stream stops mid-hold.
      className="absolute inset-0 touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-ink-950/70 px-2.5 py-1.5 text-xs text-ink-300">
        <Lock className="size-3.5" aria-hidden />
        Locked
      </div>

      {holding && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <svg
            viewBox="0 0 80 80"
            className="size-20 -rotate-90"
            role="progressbar"
            aria-label="Hold to unlock"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <circle
              cx="40"
              cy="40"
              r={RING_RADIUS}
              className="fill-ink-950/50 stroke-ink-100/25"
              strokeWidth="4"
            />
            <circle
              cx="40"
              cy="40"
              r={RING_RADIUS}
              className="fill-none stroke-lamp-500"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
            />
          </svg>
        </div>
      )}

      {hinting && !holding && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="rounded-full bg-ink-950/85 px-3 py-1.5 text-xs text-ink-100">
            Hold for 3 seconds to unlock the controls
          </span>
        </div>
      )}
    </div>
  )
}

/** The escape hatch. Not optional, and not hidden behind a menu. */
export function UnlockButton({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink-850 px-3 text-sm text-ink-100 hover:bg-ink-800"
    >
      <LockOpen className="size-4" aria-hidden />
      Unlock controls
    </button>
  )
}
