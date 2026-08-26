import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings, Users } from 'lucide-react'
import { PlayerShell } from './PlayerShell'
import { IDLE_HIDE_MS } from '@/lib/player/reveal'

/**
 * These replace `HoldToUnlock.test.tsx`, and they exist for the same reason it
 * did. Phase 6 spent a whole phase making sure a stray thumb could not pause a
 * film for five other people; D39 threw away the mechanism and kept the goal,
 * so the goal is what is pinned here. If a future change makes a tap toggle
 * playback in a shared session, the first two tests are what should stop it.
 */

function renderShell(props: Partial<Parameters<typeof PlayerShell>[0]> = {}) {
  const onToggle = vi.fn()
  const onSeek = vi.fn()
  render(
    <MemoryRouter>
      <PlayerShell
        title="Episode 1"
        src="blob:pretend"
        status={{ kind: 'ready', mode: 'service-worker' }}
        shared={false}
        canControl
        onToggle={onToggle}
        onSeek={onSeek}
        {...props}
      />
    </MemoryRouter>,
  )
  return { onToggle, onSeek }
}

/** The picture is a button, and its accessible name says what a tap will do. */
const picture = () => screen.getByRole('button', { name: /the controls|the video/ })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('tapping the picture', () => {
  it('never toggles playback when someone else is watching, however often it is tapped', () => {
    const { onToggle } = renderShell({ shared: true })

    fireEvent.click(picture())
    fireEvent.click(picture())
    fireEvent.click(picture())

    expect(onToggle).not.toHaveBeenCalled()
    expect(picture()).toHaveAccessibleName('Show the controls')
  })

  it('still refuses to toggle in a shared session once the controls are showing', () => {
    const { onToggle } = renderShell({ shared: true })
    const video = document.querySelector('video') as HTMLVideoElement

    act(() => {
      fireEvent.play(video)
    })
    fireEvent.click(picture())

    expect(onToggle).not.toHaveBeenCalled()
  })

  it('toggles when watching alone, but only after the controls are on screen', () => {
    const { onToggle } = renderShell({ shared: false })

    // The chrome is up on arrival, so this tap is the second one in spirit.
    expect(picture()).toHaveAccessibleName('Play the video')
    fireEvent.click(picture())
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('reveals rather than toggling when the chrome has faded, even alone', () => {
    const { onToggle } = renderShell({ shared: false })
    const video = document.querySelector('video') as HTMLVideoElement

    act(() => {
      fireEvent.play(video)
    })
    act(() => {
      vi.advanceTimersByTime(IDLE_HIDE_MS + 50)
    })
    expect(picture()).toHaveAccessibleName('Show the controls')

    fireEvent.click(picture())
    expect(onToggle).not.toHaveBeenCalled()
    expect(picture()).toHaveAccessibleName('Pause the video')
  })
})

describe('the chrome fading', () => {
  it('stops being touchable once it has faded, not merely invisible', () => {
    renderShell()
    const video = document.querySelector('video') as HTMLVideoElement
    act(() => {
      fireEvent.play(video)
    })

    expect(screen.getByRole('button', { name: 'Pause' }).closest('[inert]')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(IDLE_HIDE_MS + 50)
    })

    // Faded-out controls sit exactly where they were and stay hit-testable
    // unless something says otherwise, which would put an invisible pause
    // button under the viewer's thumb -- the very failure the tap rule exists
    // to prevent, smuggled back in through a CSS property.
    //
    // Asserted as the attribute rather than through a role query, because
    // jsdom does not implement what `inert` means -- only that it is set.
    // A real browser is what enforces it, which is why it was also checked by
    // hand in the Simulator.
    expect(screen.getByRole('button', { name: 'Pause' }).closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('slider', { name: 'Seek' }).closest('[inert]')).not.toBeNull()
  })

  it('fades on its own while the film is playing', () => {
    renderShell()
    const video = document.querySelector('video') as HTMLVideoElement

    act(() => {
      fireEvent.play(video)
    })
    expect(picture()).toHaveAccessibleName('Pause the video')

    act(() => {
      vi.advanceTimersByTime(IDLE_HIDE_MS + 50)
    })
    expect(picture()).toHaveAccessibleName('Show the controls')
  })

  it('stays up while paused — the controls are the thing being looked at', () => {
    renderShell()
    act(() => {
      vi.advanceTimersByTime(IDLE_HIDE_MS * 3)
    })
    expect(picture()).toHaveAccessibleName('Play the video')
  })

  it('stays up while a panel is open, playing or not', () => {
    renderShell({
      shared: true,
      panels: [{ id: 'viewers', label: 'Watching', icon: Users, content: <p>Grace</p> }],
    })
    const video = document.querySelector('video') as HTMLVideoElement
    act(() => {
      fireEvent.play(video)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Watching' }))
    act(() => {
      vi.advanceTimersByTime(IDLE_HIDE_MS * 3)
    })

    expect(screen.getByRole('dialog', { name: 'Watching' })).toBeInTheDocument()
  })
})

describe('the owner controls', () => {
  const panels = [
    { id: 'viewers', label: 'Watching', icon: Users, badge: 2, content: <p>Grace and Ada</p> },
    { id: 'settings', label: 'Settings', icon: Settings, content: <p>Stop watching together</p> },
  ]

  it('opens the drawer the icon belongs to, and closes it on Escape', () => {
    renderShell({ shared: true, panels })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the same panels without a drawer when there is room beside the picture', () => {
    renderShell({ shared: true, panels })
    // Rendered twice on purpose -- once in the sidebar, once in the (closed)
    // sheet -- and CSS decides which one the viewport gets.
    expect(screen.getAllByText('Grace and Ada')).toHaveLength(2)
  })

  it('offers no controls at all when nobody else is watching', () => {
    renderShell({ shared: false })
    expect(screen.queryByRole('navigation', { name: 'Session controls' })).not.toBeInTheDocument()
  })
})

describe('an element that cannot start on its own', () => {
  it('offers one press, over the top of everything else', () => {
    const onStart = vi.fn()
    renderShell({ shared: true, needsGesture: true, onStart })
    fireEvent.click(screen.getByRole('button', { name: /Tap to join the film/ }))
    expect(onStart).toHaveBeenCalled()
  })

  it('offers it to a viewer who may not control the session', () => {
    // It starts their own element and sends nothing to anybody, so "you may not
    // drive" must not become "you may not watch". On iOS this is the only way
    // a video ever loads, so withholding it strands them at 0:00 for ever.
    const onStart = vi.fn()
    renderShell({ shared: true, canControl: false, needsGesture: true, onStart })
    expect(screen.getByRole('button', { name: /Tap to join the film/ })).toBeEnabled()
  })

  it('says something different when nobody else is watching', () => {
    renderShell({ shared: false, needsGesture: true, onStart: vi.fn() })
    expect(screen.getByRole('button', { name: /Tap to start/ })).toBeInTheDocument()
  })

  it('is absent while the video is still being decrypted', () => {
    renderShell({ needsGesture: true, onStart: vi.fn(), status: { kind: 'opening' } })
    expect(screen.queryByRole('button', { name: /Tap to/ })).not.toBeInTheDocument()
  })

  it('is absent once the element is going by itself', () => {
    renderShell({ shared: true, needsGesture: false, onStart: vi.fn() })
    expect(screen.queryByRole('button', { name: /Tap to/ })).not.toBeInTheDocument()
  })
})

describe('a viewer who may not touch the controls', () => {
  it('gets a transport that is visibly there and inert', () => {
    const { onToggle } = renderShell({ shared: true, canControl: false })

    const play = screen.getByRole('button', { name: 'Play' })
    expect(play).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeDisabled()

    fireEvent.click(picture())
    expect(onToggle).not.toHaveBeenCalled()
  })
})
