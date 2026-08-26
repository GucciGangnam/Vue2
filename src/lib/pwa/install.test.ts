import { describe, expect, it } from 'vitest'
import { installMethod, isIosSafari } from './install'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'
const IPADOS_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const MAC_SAFARI = IPADOS_SAFARI
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

describe('isIosSafari', () => {
  it('recognises Safari on an iPhone', () => {
    expect(isIosSafari(IPHONE_SAFARI, 5)).toBe(true)
  })

  it('separates iPadOS from a real Mac by touch points', () => {
    // iPadOS sends a desktop Mac user agent; the touch points are the only tell.
    expect(isIosSafari(IPADOS_SAFARI, 5)).toBe(true)
    expect(isIosSafari(MAC_SAFARI, 0)).toBe(false)
  })

  it('does not offer Safari instructions to other iOS browsers', () => {
    // They are WebKit underneath but have no Add to Home Screen of their own,
    // so the instructions would describe a button that is not there.
    expect(isIosSafari(IPHONE_CHROME, 5)).toBe(false)
  })

  it('is false on Android', () => {
    expect(isIosSafari(ANDROID_CHROME, 5)).toBe(false)
  })
})

describe('installMethod', () => {
  const base = { hasPrompt: false, standalone: false, iosSafari: false, dismissed: false }

  it('replays a captured prompt where one exists', () => {
    expect(installMethod({ ...base, hasPrompt: true })).toBe('prompt')
  })

  it('falls back to instructions on iOS Safari, which has no prompt', () => {
    expect(installMethod({ ...base, iosSafari: true })).toBe('manual-ios')
  })

  it('offers nothing once installed', () => {
    expect(installMethod({ ...base, hasPrompt: true, standalone: true })).toBe('none')
    expect(installMethod({ ...base, iosSafari: true, standalone: true })).toBe('none')
  })

  it('offers nothing after the user has said no', () => {
    expect(installMethod({ ...base, hasPrompt: true, dismissed: true })).toBe('none')
    expect(installMethod({ ...base, iosSafari: true, dismissed: true })).toBe('none')
  })

  it('offers nothing on a desktop browser with no prompt', () => {
    expect(installMethod(base)).toBe('none')
  })
})
