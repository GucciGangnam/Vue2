/**
 * The React binding for `lib/player/reveal`. The rules are there; the timer is
 * here.
 *
 * Deliberately not built on `requestAnimationFrame`: rAF does not fire in a
 * hidden document, and "hidden" includes more situations than it sounds like
 * (see the note in docs/HANDOVER.md about this environment's browser pane). A
 * control bar that never fades because a frame never arrived is a worse bug
 * than one that fades a few milliseconds late, so this is a plain timeout and
 * the fade itself is a CSS transition.
 */

import { useCallback, useEffect, useState } from 'react'
import { hideDelayMs } from '@/lib/player/reveal'

export interface Reveal {
  visible: boolean
  /** Show the chrome and restart the countdown. */
  poke: () => void
}

export function useReveal(input: { playing: boolean; held: boolean }): Reveal {
  const [visible, setVisible] = useState(true)
  // Bumped on every interaction so the effect below restarts its countdown
  // even when `visible` was already true.
  const [pokedAt, setPokedAt] = useState(0)

  const poke = useCallback(() => {
    setVisible(true)
    setPokedAt(Date.now())
  }, [])

  useEffect(() => {
    if (!visible) return
    const delay = hideDelayMs({ playing: input.playing, held: input.held })
    if (delay === null) return
    const timer = setTimeout(() => setVisible(false), delay)
    return () => clearTimeout(timer)
  }, [visible, pokedAt, input.playing, input.held])

  return { visible, poke }
}
