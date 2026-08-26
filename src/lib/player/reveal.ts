/**
 * When the controls are on screen, and what touching the video means.
 *
 * This replaces the three-second hold (D39). The hold existed for one reason:
 * a stray thumb pausing a film is a cost paid by everybody watching, silently.
 * The mechanism is gone; the protection is this rule, and it is the only thing
 * in the player that must not be casually changed:
 *
 *     A tap reveals the controls. In a shared session it never toggles
 *     playback -- play/pause is a button you have to hit.
 *
 * Alone, a tap may toggle, because the only person a mistake costs is the one
 * who made it and it is undone by tapping again. That is what `/watch` already
 * did before this phase and what every phone video player does. But even alone
 * the *first* tap only reveals: on a phone with the chrome hidden there is
 * nothing on screen to say what a tap will do, so it says it by showing you.
 *
 * Pure on purpose -- the rule is worth testing as a rule, not as a race
 * against a timer.
 */

/** How long the chrome stays up with nobody touching it. */
export const IDLE_HIDE_MS = 3000

export interface TapOutcome {
  /** Always true. Named rather than implied, because it is half the rule. */
  reveal: boolean
  togglePlayback: boolean
}

export function decideTap(input: {
  /** Whether the transport is already on screen. */
  controlsVisible: boolean
  /** Whether anyone else is watching this with us. */
  shared: boolean
}): TapOutcome {
  if (input.shared) return { reveal: true, togglePlayback: false }
  return { reveal: true, togglePlayback: input.controlsVisible }
}

/**
 * How long before the chrome fades, or `null` to leave it up.
 *
 * Paused means somebody is looking at the controls rather than the film, so
 * they stay. `held` covers the states where hiding would be actively wrong:
 * a drawer open, a finger on the scrubber, a keyboard focus inside the chrome.
 */
export function hideDelayMs(input: { playing: boolean; held: boolean }): number | null {
  if (!input.playing || input.held) return null
  return IDLE_HIDE_MS
}
