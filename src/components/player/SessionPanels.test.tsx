import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { InvitePanel, ViewersPanel, type SessionControls } from './SessionPanels'
import type { RoomMember } from '@/lib/sync/room'

/**
 * The roster is where a missing content key becomes visible.
 *
 * A seat and a key are two different rows, and the player used to write only
 * the first — so people are already sitting in sessions they cannot decrypt.
 * `inviteToWatch` stops it happening again but cannot undo it, and the invite
 * panel will not offer somebody who is already on the roster. Without this the
 * only way out would be to remove the guest and re-invite them.
 */

const member = (over: Partial<RoomMember> & { userId: string }): RoomMember => ({
  role: 'viewer',
  state: 'joined',
  canControl: false,
  displayName: over.userId,
  avatarHue: 0,
  ...over,
})

const grace = member({ userId: 'Grace', role: 'owner' })
const ada = member({ userId: 'Ada' })

function renderRoster(over: Partial<SessionControls> = {}) {
  const invite = vi.fn().mockResolvedValue(undefined)
  const controls = {
    room: { ownerId: 'Grace', controlMode: 'open' },
    members: [grace, ada],
    self: grace,
    isOwner: true,
    friends: [],
    connection: 'live',
    clockUncertaintyMs: 40,
    keyHolders: new Set<string>(),
    forceSync: vi.fn(),
    invite,
    remove: vi.fn().mockResolvedValue(undefined),
    setOwnerOnly: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as SessionControls

  render(
    <MemoryRouter>
      <ViewersPanel controls={controls} />
    </MemoryRouter>,
  )
  return { invite }
}

describe('a guest with no key', () => {
  it('is named, rather than left to discover it when the video will not play', () => {
    renderRoster()
    expect(screen.getByText(/Ada has no key for this/)).toBeInTheDocument()
  })

  it('can be handed one from the roster, which is the only way back', async () => {
    const { invite } = renderRoster()
    fireEvent.click(screen.getByRole('button', { name: 'Send the key' }))
    await waitFor(() => expect(invite).toHaveBeenCalledWith('Ada'))
  })

  it('says nothing at all until the grants have actually been read', () => {
    renderRoster({ keyHolders: null })
    expect(screen.queryByText(/no key/)).not.toBeInTheDocument()
  })

  it('says nothing once they hold one', () => {
    renderRoster({ keyHolders: new Set(['Ada']) })
    expect(screen.queryByText(/no key/)).not.toBeInTheDocument()
  })

  it('never accuses the owner, who holds a key to their own video by construction', () => {
    renderRoster({ keyHolders: new Set<string>() })
    expect(screen.queryByText(/Grace has no key/)).not.toBeInTheDocument()
  })

  it('tells a fellow guest what is wrong but offers them no button for it', () => {
    renderRoster({ isOwner: false, self: ada, keyHolders: new Set<string>() })
    expect(screen.getByText('They cannot decrypt this yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send the key' })).not.toBeInTheDocument()
  })
})

describe('a guest who was removed', () => {
  const removed = member({ userId: 'Ada', state: 'kicked' })

  function renderInvite(over: Partial<SessionControls> = {}) {
    const invite = vi.fn().mockResolvedValue(undefined)
    const controls = {
      room: { ownerId: 'Grace', controlMode: 'open' },
      members: [grace, removed],
      self: grace,
      isOwner: true,
      friends: [{ id: 'Ada', displayName: 'Ada', avatarHue: 200 }],
      connection: 'live',
      clockUncertaintyMs: 40,
      keyHolders: new Set<string>(),
      forceSync: vi.fn(),
      invite,
      remove: vi.fn(),
      setOwnerOnly: vi.fn(),
      stop: vi.fn(),
      ...over,
    } as unknown as SessionControls

    render(
      <MemoryRouter>
        <InvitePanel controls={controls} />
      </MemoryRouter>,
    )
    return { invite }
  }

  it('can be asked back, rather than counting as already here', () => {
    renderInvite()
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument()
  })

  it('is not offered while they are actually watching', () => {
    renderInvite({ members: [grace, member({ userId: 'Ada' })] })
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
    expect(screen.getByText('Everyone you know is already here.')).toBeInTheDocument()
  })

  it('is not offered while they are invited and simply have not arrived', () => {
    renderInvite({ members: [grace, member({ userId: 'Ada', state: 'invited' })] })
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
  })
})
