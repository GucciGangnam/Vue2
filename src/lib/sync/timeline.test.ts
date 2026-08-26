import { describe, expect, it } from 'vitest'
import { bestSample, ClockOffset, sampleOffset } from './clock'
import {
  clampToDuration,
  decideCorrection,
  expectedPositionMs,
  hasRunOut,
  NUDGE_RATE,
  shouldApply,
  type PlaybackAnchor,
} from './timeline'

const playing: PlaybackAnchor = {
  seq: 1,
  isPlaying: true,
  positionMs: 60_000,
  anchorServerTimeMs: 1_000_000,
}
const paused: PlaybackAnchor = { ...playing, isPlaying: false }

describe('clock offset', () => {
  it('puts the server instant at the midpoint of the round trip', () => {
    // Left at 1000, back at 1200, server said 5100. Midpoint is 1100, so the
    // server clock is 4000ms ahead of ours.
    const sample = sampleOffset(1000, 5100, 1200)
    expect(sample.rttMs).toBe(200)
    expect(sample.offsetMs).toBe(4000)
  })

  it('reports a negative offset when the local clock is ahead', () => {
    expect(sampleOffset(10_000, 9_000, 10_100).offsetMs).toBe(-1050)
  })

  it('handles an instantaneous round trip', () => {
    expect(sampleOffset(500, 500, 500)).toEqual({ rttMs: 0, offsetMs: 0 })
  })

  it('never reports a negative round trip if clocks jump mid-measurement', () => {
    expect(sampleOffset(1000, 1000, 900).rttMs).toBe(0)
  })

  it('keeps the lowest-RTT sample rather than averaging', () => {
    // Averaging would let the 900ms sample drag the answer; the 20ms one is
    // bounded by +/-10ms and is the only one worth believing.
    const samples = [
      { rttMs: 900, offsetMs: 400 },
      { rttMs: 20, offsetMs: 12 },
      { rttMs: 250, offsetMs: 100 },
    ]
    expect(bestSample(samples)).toEqual({ rttMs: 20, offsetMs: 12 })
  })

  it('has nothing to offer from no samples', () => {
    expect(bestSample([])).toBeNull()
  })

  it('converts local time to server time, and bounds its own error', () => {
    const offset = new ClockOffset({ rttMs: 80, offsetMs: 4000 })
    expect(offset.now(1000)).toBe(5000)
    expect(offset.uncertaintyMs).toBe(40)
  })

  it('is a no-op before anything has been measured', () => {
    expect(ClockOffset.unmeasured().now(1234)).toBe(1234)
  })
})

describe('expectedPositionMs', () => {
  it('advances with the server clock while playing', () => {
    expect(expectedPositionMs(playing, 1_000_000)).toBe(60_000)
    expect(expectedPositionMs(playing, 1_005_000)).toBe(65_000)
  })

  it('stays put while paused, however much time passes', () => {
    // This is what makes a pause hold: an hour later the answer is the same.
    expect(expectedPositionMs(paused, 1_000_000)).toBe(60_000)
    expect(expectedPositionMs(paused, 4_600_000)).toBe(60_000)
  })

  it('lands a late joiner exactly in step', () => {
    // Someone opening the room 10 minutes after play started.
    expect(expectedPositionMs(playing, 1_600_000)).toBe(660_000)
  })

  it('does not run backwards if the clock is re-measured behind the anchor', () => {
    expect(expectedPositionMs(playing, 999_000)).toBe(60_000)
  })
})

describe('decideCorrection', () => {
  /** Server time at which the room should be exactly at `positionMs`. */
  const atAnchor = playing.anchorServerTimeMs

  it('leaves small drift alone', () => {
    expect(decideCorrection(playing, 60_000, atAnchor)).toEqual({ kind: 'none' })
    expect(decideCorrection(playing, 60_100, atAnchor)).toEqual({ kind: 'none' })
    expect(decideCorrection(playing, 59_900, atAnchor)).toEqual({ kind: 'none' })
  })

  it('speeds up slightly when behind the room', () => {
    // Expected 60000, actual 59700: 300ms behind, inside the glide band.
    expect(decideCorrection(playing, 59_700, atAnchor)).toEqual({
      kind: 'rate',
      playbackRate: 1 + NUDGE_RATE,
    })
  })

  it('slows down slightly when ahead of the room', () => {
    expect(decideCorrection(playing, 60_300, atAnchor)).toEqual({
      kind: 'rate',
      playbackRate: 1 - NUDGE_RATE,
    })
  })

  it('seeks when the gap is too large to glide away', () => {
    expect(decideCorrection(playing, 55_000, atAnchor)).toEqual({ kind: 'seek', toMs: 60_000 })
    expect(decideCorrection(playing, 90_000, atAnchor)).toEqual({ kind: 'seek', toMs: 60_000 })
  })

  it('treats the thresholds as exclusive, so a value on the line does nothing', () => {
    // Exactly 150ms out is still "leave alone"; 151 is a nudge.
    expect(decideCorrection(playing, 60_000 - 150, atAnchor)).toEqual({ kind: 'none' })
    expect(decideCorrection(playing, 60_000 - 151, atAnchor).kind).toBe('rate')
    // Exactly 1000ms out still glides; 1001 jumps.
    expect(decideCorrection(playing, 60_000 - 1000, atAnchor).kind).toBe('rate')
    expect(decideCorrection(playing, 60_000 - 1001, atAnchor).kind).toBe('seek')
  })

  it('never changes rate while paused, because it would do nothing', () => {
    // A paused element does not advance, so gliding cannot close a gap.
    expect(decideCorrection(paused, 60_300, atAnchor)).toEqual({ kind: 'seek', toMs: 60_000 })
    expect(decideCorrection(paused, 60_050, atAnchor)).toEqual({ kind: 'none' })
  })

  it('corrects against where the room is NOW, not where it was anchored', () => {
    // Five seconds after the anchor the room is at 65s. A client sitting at
    // 60s is five seconds behind and must jump, not glide.
    expect(decideCorrection(playing, 60_000, atAnchor + 5_000)).toEqual({
      kind: 'seek',
      toMs: 65_000,
    })
  })
})

describe('shouldApply', () => {
  it('applies anything newer than what is already applied', () => {
    expect(shouldApply(5, 4)).toBe(true)
  })

  it('drops duplicates, which the two paths produce by design', () => {
    // The broadcast and the database carry the same event; the second to
    // arrive must not be applied twice.
    expect(shouldApply(4, 4)).toBe(false)
  })

  it('drops a straggler that would yank everyone backwards', () => {
    expect(shouldApply(3, 7)).toBe(false)
  })

  it('accepts the first event against a fresh client', () => {
    expect(shouldApply(1, 0)).toBe(true)
  })
})

/**
 * A session left playing when the film runs out.
 *
 * `is_playing` stays true and the anchor keeps describing a position that
 * climbs forever, so an hour later it claims an hour past the credits. The
 * client that notices stops the session; this is the arithmetic that holds
 * even when no client was there to notice.
 */
describe('running past the end', () => {
  const ONE_HOUR = 60 * 60 * 1000
  const film = 20 * 60 * 1000

  /** Playing from the start, an hour ago, of a twenty-minute film. */
  const abandoned: PlaybackAnchor = {
    seq: 9,
    isPlaying: true,
    positionMs: 0,
    anchorServerTimeMs: 1_000_000,
  }
  const anHourLater = abandoned.anchorServerTimeMs + ONE_HOUR

  it('would otherwise claim a position long past the credits', () => {
    expect(expectedPositionMs(abandoned, anHourLater)).toBe(ONE_HOUR)
  })

  it('lands on the last frame instead, once the length is known', () => {
    expect(expectedPositionMs(abandoned, anHourLater, film)).toBe(film)
  })

  it('clamps a paused anchor that was written past the end too', () => {
    const stranded: PlaybackAnchor = { ...abandoned, isPlaying: false, positionMs: ONE_HOUR }
    expect(expectedPositionMs(stranded, anHourLater, film)).toBe(film)
  })

  it('leaves an ordinary position alone', () => {
    const midway: PlaybackAnchor = { ...abandoned, positionMs: 5 * 60 * 1000, isPlaying: false }
    expect(expectedPositionMs(midway, anHourLater, film)).toBe(5 * 60 * 1000)
  })

  it('seeks to the end rather than past it', () => {
    const correction = decideCorrection(abandoned, 0, anHourLater, film)
    expect(correction).toEqual({ kind: 'seek', toMs: film })
  })

  it('is reported as run out, so somebody present can stop the session', () => {
    expect(hasRunOut(abandoned, anHourLater, film)).toBe(true)
  })

  it('is not reported as run out one millisecond before the end', () => {
    const nearly = abandoned.anchorServerTimeMs + film - 1
    expect(hasRunOut(abandoned, nearly, film)).toBe(false)
  })

  it('is reported exactly on the final millisecond', () => {
    expect(hasRunOut(abandoned, abandoned.anchorServerTimeMs + film, film)).toBe(true)
  })

  it('never reports a paused session as run out, however stale its anchor', () => {
    const paused: PlaybackAnchor = { ...abandoned, isPlaying: false, positionMs: ONE_HOUR }
    expect(hasRunOut(paused, anHourLater, film)).toBe(false)
  })
})

describe('clampToDuration', () => {
  it('passes a position through when the length is not known yet', () => {
    // `duration` is NaN until metadata loads and Infinity for a live stream.
    // Both have to mean "do not clamp", never "clamp to nothing".
    expect(clampToDuration(5000, null)).toBe(5000)
    expect(clampToDuration(5000, NaN)).toBe(5000)
    expect(clampToDuration(5000, Infinity)).toBe(5000)
    expect(clampToDuration(5000, 0)).toBe(5000)
  })

  it('never returns a negative position', () => {
    expect(clampToDuration(-1, 1000)).toBe(0)
    expect(clampToDuration(-1, null)).toBe(0)
  })

  it('keeps a position that is already inside the film', () => {
    expect(clampToDuration(999, 1000)).toBe(999)
    expect(clampToDuration(1000, 1000)).toBe(1000)
  })
})
