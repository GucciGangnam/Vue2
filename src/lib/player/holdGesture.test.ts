import { describe, expect, it } from 'vitest'
import {
  beginHold,
  CANCEL_DISTANCE_PX,
  distanceBetween,
  hasMovedTooFar,
  HOLD_DURATION_MS,
  holdProgress,
  isHoldComplete,
  ownsPointer,
} from './holdGesture'

const origin = { x: 100, y: 100 }
const hold = beginHold(1, origin, 1_000)

describe('holdProgress', () => {
  it('is zero at the moment of the press', () => {
    expect(holdProgress(hold, 1_000)).toBe(0)
  })

  it('is half way through half way through', () => {
    expect(holdProgress(hold, 1_000 + HOLD_DURATION_MS / 2)).toBeCloseTo(0.5)
  })

  it('never exceeds one, however long the finger stays down', () => {
    expect(holdProgress(hold, 1_000 + HOLD_DURATION_MS)).toBe(1)
    expect(holdProgress(hold, 1_000 + HOLD_DURATION_MS * 10)).toBe(1)
  })

  it('never goes negative if a clock reading arrives out of order', () => {
    expect(holdProgress(hold, 900)).toBe(0)
  })
})

describe('isHoldComplete', () => {
  it('is not complete one millisecond early', () => {
    expect(isHoldComplete(hold, 1_000 + HOLD_DURATION_MS - 1)).toBe(false)
  })

  it('is complete exactly on time', () => {
    expect(isHoldComplete(hold, 1_000 + HOLD_DURATION_MS)).toBe(true)
  })
})

describe('hasMovedTooFar', () => {
  it('tolerates a finger that has not moved', () => {
    expect(hasMovedTooFar(hold, origin)).toBe(false)
  })

  it('tolerates movement exactly at the limit', () => {
    expect(hasMovedTooFar(hold, { x: origin.x + CANCEL_DISTANCE_PX, y: origin.y })).toBe(false)
  })

  it('gives up one pixel past the limit', () => {
    expect(hasMovedTooFar(hold, { x: origin.x + CANCEL_DISTANCE_PX + 1, y: origin.y })).toBe(true)
  })

  it('measures diagonals as distance, not as axes', () => {
    // 15 across and 15 down is 21.2 away, past the limit, even though neither
    // axis alone would be.
    expect(hasMovedTooFar(hold, { x: origin.x + 15, y: origin.y + 15 })).toBe(true)
    expect(distanceBetween(origin, { x: origin.x + 3, y: origin.y + 4 })).toBe(5)
  })
})

describe('ownsPointer', () => {
  it('recognises its own pointer and ignores a second finger', () => {
    expect(ownsPointer(hold, 1)).toBe(true)
    expect(ownsPointer(hold, 2)).toBe(false)
  })
})
