import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The bug this pins actually shipped, and it was invisible from the host's
 * side. The player invited a friend by inserting a `room_members` row and
 * nothing else, so the guest arrived with a membership and no content key —
 * RLS then hid the `media` row from them and the screen said "That video is no
 * longer available to you." Grace saw a successful invitation; Ada saw a
 * broken app.
 *
 * The two writes are one function now, and this is what says so.
 */

const mocks = vi.hoisted(() => ({
  shareMedia: vi.fn(),
  insert: vi.fn(),
  order: [] as string[],
}))

vi.mock('@/lib/media/library', () => ({
  shareMedia: (...args: unknown[]) => {
    mocks.order.push('grant key')
    return mocks.shareMedia(...args)
  },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (row: unknown) => {
        mocks.order.push(`insert ${table}`)
        return mocks.insert(row)
      },
    }),
  },
}))

const { canControlPlayback, inviteToWatch, watchers } = await import('./room')

const invitation = {
  roomId: 'room-1',
  mediaId: 'media-1',
  ownerId: 'grace',
  recipientId: 'ada',
  identityPrivateKey: {} as CryptoKey,
}

beforeEach(() => {
  mocks.order.length = 0
  mocks.shareMedia.mockReset().mockResolvedValue(undefined)
  mocks.insert.mockReset().mockResolvedValue({ error: null })
})

describe('inviteToWatch', () => {
  it('grants the content key before it adds anybody to the roster', async () => {
    await inviteToWatch(invitation)
    expect(mocks.order).toEqual(['grant key', 'insert room_members'])
  })

  it('wraps the key to the recipient, not to the host', async () => {
    await inviteToWatch(invitation)
    expect(mocks.shareMedia).toHaveBeenCalledWith({
      mediaId: 'media-1',
      ownerId: 'grace',
      recipientId: 'ada',
      identityPrivateKey: invitation.identityPrivateKey,
    })
  })

  it('treats an existing grant as fine, because re-inviting is ordinary', async () => {
    mocks.shareMedia.mockRejectedValue(new Error('duplicate key value violates unique constraint'))
    await expect(inviteToWatch(invitation)).resolves.toBeUndefined()
    expect(mocks.order).toEqual(['grant key', 'insert room_members'])
  })

  it('refuses to seat somebody it could not give a key to', async () => {
    mocks.shareMedia.mockRejectedValue(new Error('no public key for that user'))
    await expect(inviteToWatch(invitation)).rejects.toThrow('no public key')
    // The important half: no membership row, so nobody is invited to watch a
    // video they would not be able to decrypt.
    expect(mocks.order).toEqual(['grant key'])
  })

  it('survives being invited twice, which is a duplicate membership and not an error', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '23505' } })
    await expect(inviteToWatch(invitation)).resolves.toBeUndefined()
  })
})

describe('watchers', () => {
  const member = (userId: string, state: string) =>
    ({
      userId,
      state,
      role: 'viewer',
      canControl: false,
      displayName: userId,
      avatarHue: 0,
    }) as never

  it('counts the people here and the people on their way, and nobody else', () => {
    const roster = watchers([
      member('grace', 'joined'),
      member('ada', 'invited'),
      member('gone', 'left'),
      member('removed', 'kicked'),
    ])
    expect(roster.map((m) => m.userId)).toEqual(['grace', 'ada'])
  })
})

describe('canControlPlayback', () => {
  const room = (over: Record<string, unknown> = {}) =>
    ({ ownerId: 'grace', controlMode: 'open', ...over }) as never
  const member = (over: Record<string, unknown> = {}) =>
    ({ userId: 'ada', role: 'viewer', state: 'joined', canControl: false, ...over }) as never

  it('lets anybody who has joined control an open session (D2)', () => {
    expect(canControlPlayback(room(), member(), 'ada')).toBe(true)
  })

  it('refuses somebody who is only invited, and has not arrived', () => {
    expect(canControlPlayback(room(), member({ state: 'invited' }), 'ada')).toBe(false)
  })

  it('refuses somebody who has been removed', () => {
    expect(canControlPlayback(room(), member({ state: 'kicked' }), 'ada')).toBe(false)
  })

  it('refuses a viewer when the owner has kept the controls', () => {
    expect(canControlPlayback(room({ controlMode: 'owner_only' }), member(), 'ada')).toBe(false)
  })

  it('still lets the owner control their own locked session', () => {
    const owner = member({ userId: 'grace', role: 'owner' })
    expect(canControlPlayback(room({ controlMode: 'owner_only' }), owner, 'grace')).toBe(true)
  })

  it('lets a viewer the owner has trusted control a locked session', () => {
    const trusted = member({ canControl: true })
    expect(canControlPlayback(room({ controlMode: 'owner_only' }), trusted, 'ada')).toBe(true)
  })

  it('refuses before the room or the roster has loaded', () => {
    expect(canControlPlayback(null, member(), 'ada')).toBe(false)
    expect(canControlPlayback(room(), null, 'ada')).toBe(false)
  })
})
