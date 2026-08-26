/**
 * Where playback ought to be, and what to do when it is not there.
 *
 * All pure. Every decision the sync loop makes lives here so it can be tested
 * as arithmetic rather than as a race between two browsers.
 */

/** The authoritative playback state, as the `rooms` row stores it. */
export interface PlaybackAnchor {
  /** Monotonic. Assigned only by set_playback_state(). */
  seq: number
  isPlaying: boolean
  /** Media position at `anchorServerTimeMs`. */
  positionMs: number
  anchorServerTimeMs: number
}

/**
 * Position is stored as an anchor, not as a live number, which is what makes
 * late joining exact: a client that arrives an hour after the last pause reads
 * two numbers and computes the answer, rather than asking anyone.
 */
export function expectedPositionMs(anchor: PlaybackAnchor, serverNowMs: number): number {
  if (!anchor.isPlaying) return anchor.positionMs
  // Guard against a server instant that appears to precede the anchor, which a
  // clock re-measurement mid-playback can briefly produce.
  const elapsed = Math.max(0, serverNowMs - anchor.anchorServerTimeMs)
  return anchor.positionMs + elapsed
}

export type Correction =
  { kind: 'none' } | { kind: 'rate'; playbackRate: number } | { kind: 'seek'; toMs: number }

/**
 * Thresholds from docs/ARCHITECTURE.md. The asymmetry is deliberate: nobody
 * notices a 5% speed change, and everybody notices a seek. So a small drift is
 * absorbed by gliding back over a few seconds, and only a gap too large to
 * glide away is corrected with a jump.
 */
export const NUDGE_THRESHOLD_MS = 150
export const SEEK_THRESHOLD_MS = 1000
export const NUDGE_RATE = 0.05

export function decideCorrection(
  anchor: PlaybackAnchor,
  actualPositionMs: number,
  serverNowMs: number,
): Correction {
  const expected = expectedPositionMs(anchor, serverNowMs)
  const delta = expected - actualPositionMs
  const size = Math.abs(delta)

  // While paused there is nothing to glide back to -- the element is not
  // advancing, so a rate change would do nothing at all. Correct or leave it.
  if (!anchor.isPlaying) {
    return size > NUDGE_THRESHOLD_MS ? { kind: 'seek', toMs: expected } : { kind: 'none' }
  }

  if (size > SEEK_THRESHOLD_MS) return { kind: 'seek', toMs: expected }
  if (size > NUDGE_THRESHOLD_MS) {
    // Behind the room: play slightly faster to catch up. Ahead: slow down.
    return { kind: 'rate', playbackRate: delta > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE }
  }
  return { kind: 'none' }
}

/**
 * The conflict resolver between the broadcast fast path and the database.
 *
 * Both carry the same events; the broadcast simply arrives first. `seq` is
 * assigned server-side and only ever increases, so anything not newer than what
 * has already been applied is a duplicate or a straggler and must be dropped --
 * otherwise a late-delivered older event would yank everyone backwards.
 */
export function shouldApply(incomingSeq: number, appliedSeq: number): boolean {
  return incomingSeq > appliedSeq
}
