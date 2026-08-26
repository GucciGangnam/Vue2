import { afterEach, describe, expect, it, vi } from 'vitest'
import { hapticHoldComplete, hapticHoldStarted, hapticsAvailable } from './haptics'

function withVibrate(implementation: (pattern: number | number[]) => boolean) {
  const spy = vi.fn(implementation)
  Object.defineProperty(navigator, 'vibrate', { value: spy, configurable: true })
  return spy
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'vibrate')
})

describe('haptics', () => {
  it('does nothing at all where vibration is unsupported', () => {
    // jsdom has no navigator.vibrate, which is also iOS Safari's answer.
    expect(hapticsAvailable()).toBe(false)
    expect(() => hapticHoldStarted()).not.toThrow()
    expect(() => hapticHoldComplete()).not.toThrow()
  })

  it('ticks once when a hold starts', () => {
    const vibrate = withVibrate(() => true)
    hapticHoldStarted()
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(vibrate.mock.calls[0]?.[0]).toBeTypeOf('number')
  })

  it('uses a pattern, not a single buzz, when a hold completes', () => {
    const vibrate = withVibrate(() => true)
    hapticHoldComplete()
    expect(Array.isArray(vibrate.mock.calls[0]?.[0])).toBe(true)
  })

  it('swallows a browser that throws rather than refusing politely', () => {
    withVibrate(() => {
      throw new Error('vibration is disallowed here')
    })
    expect(() => hapticHoldComplete()).not.toThrow()
  })
})
