/**
 * Haptic punctuation for the hold gesture.
 *
 * A three-second hold with no physical feedback feels broken -- the user cannot
 * tell whether the press registered until the ring is well underway. A tick at
 * the start and a firmer pattern at the end make the gesture legible without
 * looking at the screen, which is the point of a gesture you perform while
 * watching something else.
 *
 * Everything here is best-effort. `navigator.vibrate` is absent on iOS, and
 * present-but-refused wherever the page is not the user's active gesture
 * target, so the calls are guarded and swallow their failures. Nothing about
 * the gesture depends on the vibration happening.
 */

/** Enough to feel, short enough not to buzz: the press registered. */
const HOLD_START_PATTERN = 12
/** Two beats, because "it worked" should not feel like "it started". */
const HOLD_COMPLETE_PATTERN = [18, 60, 32]

function vibrate(pattern: number | number[]): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
    return navigator.vibrate(pattern)
  } catch {
    // Some browsers throw rather than returning false when vibration is
    // disallowed. A silent gesture is a fine outcome; a thrown error is not.
    return false
  }
}

export function hapticHoldStarted(): void {
  vibrate(HOLD_START_PATTERN)
}

export function hapticHoldComplete(): void {
  vibrate(HOLD_COMPLETE_PATTERN)
}

/**
 * Deliberately silent on cancel. A hold abandoned by accident is the common
 * case, and buzzing at someone for shifting their grip is a punishment for
 * doing nothing wrong.
 */
export function hapticsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}
