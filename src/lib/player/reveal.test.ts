import { describe, expect, it } from 'vitest'
import { decideTap, hideDelayMs, IDLE_HIDE_MS } from './reveal'

describe('decideTap', () => {
  it('never toggles playback in a shared session, however many times you tap', () => {
    expect(decideTap({ controlsVisible: false, shared: true })).toEqual({
      reveal: true,
      togglePlayback: false,
    })
    expect(decideTap({ controlsVisible: true, shared: true })).toEqual({
      reveal: true,
      togglePlayback: false,
    })
  })

  it('reveals but does not toggle on the first tap when watching alone', () => {
    expect(decideTap({ controlsVisible: false, shared: false })).toEqual({
      reveal: true,
      togglePlayback: false,
    })
  })

  it('toggles once the controls are already showing, but only alone', () => {
    expect(decideTap({ controlsVisible: true, shared: false })).toEqual({
      reveal: true,
      togglePlayback: true,
    })
  })

  it('always reveals', () => {
    for (const controlsVisible of [true, false]) {
      for (const shared of [true, false]) {
        expect(decideTap({ controlsVisible, shared }).reveal).toBe(true)
      }
    }
  })
})

describe('hideDelayMs', () => {
  it('fades while playing', () => {
    expect(hideDelayMs({ playing: true, held: false })).toBe(IDLE_HIDE_MS)
  })

  it('stays up while paused — the controls are what you are looking at', () => {
    expect(hideDelayMs({ playing: false, held: false })).toBeNull()
  })

  it('stays up while something is holding it open, playing or not', () => {
    expect(hideDelayMs({ playing: true, held: true })).toBeNull()
    expect(hideDelayMs({ playing: false, held: true })).toBeNull()
  })
})
