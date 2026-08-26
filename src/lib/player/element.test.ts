import { describe, expect, it } from 'vitest'
import { canPosition, HAVE_METADATA, HAVE_NOTHING, needsUserGesture } from './element'

/**
 * These two rules are what stop a viewer on an iPhone sitting at 0:00 for ever
 * while everybody else watches the film. Both look like over-caution and are
 * not; the reasoning is on the functions.
 */

describe('canPosition', () => {
  it('refuses to seek an element that holds no data', () => {
    // The measurement behind this: seeking a WebKit element at NETWORK_IDLE
    // wedges `seeking` true permanently, and the drift loop's first guard is
    // `seeking`, so the element never recovers and neither does the loop.
    expect(canPosition(HAVE_NOTHING)).toBe(false)
    expect(canPosition(HAVE_METADATA)).toBe(false)
  })

  it('allows it once there is a current frame to move from', () => {
    expect(canPosition(2)).toBe(true)
    expect(canPosition(4)).toBe(true)
  })
})

describe('needsUserGesture', () => {
  it('asks for a press when the element holds no data', () => {
    // iOS, before any tap: rs=1, networkState idle, buffered empty. Nothing the
    // page does by itself moves it.
    expect(
      needsUserGesture({ readyState: HAVE_METADATA, paused: true, sessionPlaying: false }),
    ).toBe(true)
  })

  it('asks for a press when the session is running and this element is not', () => {
    // The ordinary autoplay refusal, which has the same cure.
    expect(needsUserGesture({ readyState: 4, paused: true, sessionPlaying: true })).toBe(true)
  })

  it('stays quiet once the element is playing along', () => {
    expect(needsUserGesture({ readyState: 4, paused: false, sessionPlaying: true })).toBe(false)
  })

  it('stays quiet on a paused session the viewer has already loaded', () => {
    // Paused and holding a frame is a perfectly good place to be: it is what
    // everybody else is looking at.
    expect(needsUserGesture({ readyState: 4, paused: true, sessionPlaying: false })).toBe(false)
  })

  it('asks even when the session is paused, if there is nothing to show', () => {
    expect(needsUserGesture({ readyState: 1, paused: true, sessionPlaying: false })).toBe(true)
  })
})
