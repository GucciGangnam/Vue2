/**
 * Two rules about a media element that were learned the hard way on WebKit.
 *
 * Both are here rather than inline in the sync hook because they are the sort
 * of thing a later reader will simplify away — each looks, on its own, like an
 * over-cautious guard — and each has a measurement behind it.
 */

/** `HTMLMediaElement.readyState` values, named. */
export const HAVE_NOTHING = 0
export const HAVE_METADATA = 1
export const HAVE_CURRENT_DATA = 2

export interface ElementState {
  readyState: number
  /** Whether the element itself is paused, not what the session wants. */
  paused: boolean
  /** Whether the session says the film is running. */
  sessionPlaying: boolean
}

/**
 * May we move this element's `currentTime`?
 *
 * Only once it holds data. Seeking a WebKit element that is sitting at
 * `NETWORK_IDLE` **wedges it permanently**: the assignment is accepted,
 * `seeking` goes true, and it never goes false again — not even after a user
 * gesture has started the download and `buffered` has grown to cover the
 * target. Measured on the iOS Simulator, with the whole file already decrypted
 * into a local blob it had simply never touched:
 *
 *     t=171.6  rs=4  ns=2  seek=true  buf=[0-749]   ← target inside the buffer
 *
 * And because the drift loop's own first guard is `seeking`, a wedged element
 * also stops the loop for ever, so the viewer never recovers.
 *
 * The fix for "this viewer is stuck at 0:00" is therefore never a more eager
 * seek. It is `needsUserGesture` below.
 */
export function canPosition(readyState: number): boolean {
  return readyState >= HAVE_CURRENT_DATA
}

/**
 * Is this element unable to get anywhere without somebody pressing something?
 *
 * iOS will not load a video that has never been played by a user gesture. Not
 * lazily, not eventually: `networkState` stays `NETWORK_IDLE`, `buffered` stays
 * empty, `readyState` stays at `HAVE_METADATA`, and nothing the page does by
 * itself changes any of it — `play()` called from a timer is not a gesture and
 * is refused.
 *
 * So a viewer arriving at a session in progress sits at `0:00` watching black
 * while everyone else watches the film, and no amount of correction reaches
 * them. The interface has to ask for one press.
 *
 * The second clause catches the ordinary autoplay refusal too: the session is
 * running and this element is not, which is the same problem with a shorter
 * history.
 */
export function needsUserGesture(state: ElementState): boolean {
  if (!canPosition(state.readyState)) return true
  return state.sessionPlaying && state.paused
}
