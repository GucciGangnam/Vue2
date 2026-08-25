import { describe, expect, it } from 'vitest'
import {
  friendRequestMessage,
  isCompleteFriendCode,
  normalizeFriendCode,
  orderedPair,
} from './friends'

describe('orderedPair', () => {
  const lower = '0a1b2c3d-0000-4000-8000-000000000000'
  const higher = 'f9e8d7c6-0000-4000-8000-000000000000'

  it('returns the pair in the order friendships stores it', () => {
    expect(orderedPair(lower, higher)).toEqual([lower, higher])
  })

  it('gives the same answer whichever way round it is asked', () => {
    expect(orderedPair(higher, lower)).toEqual(orderedPair(lower, higher))
  })

  /**
   * The `user_a < user_b` check is evaluated by Postgres on 16 raw bytes, but
   * the client sorts canonical uuid strings. If those two orderings ever
   * disagreed, unfriending would silently match no row -- the delete would
   * report success and the friendship would still be there.
   */
  it('agrees with byte order across the whole hex alphabet', () => {
    const digits = '0123456789abcdef'
    for (let i = 0; i < digits.length; i++) {
      for (let j = 0; j < digits.length; j++) {
        const one = `${digits[i]}${digits[j]}000000-0000-4000-8000-000000000000`
        const two = `${digits[j]}${digits[i]}000000-0000-4000-8000-000000000000`
        const [first, second] = orderedPair(one, two)

        const bytesOf = (uuid: string) => uuid.replace(/-/g, '')
        expect(bytesOf(first) <= bytesOf(second)).toBe(true)
      }
    }
  })

  it('handles a pair that differs only after the first hyphen', () => {
    const one = '00000000-aaaa-4000-8000-000000000000'
    const two = '00000000-bbbb-4000-8000-000000000000'
    expect(orderedPair(two, one)).toEqual([one, two])
  })
})

describe('normalizeFriendCode', () => {
  it('uppercases and strips separators people type or paste', () => {
    expect(normalizeFriendCode('rqrf-t1w2')).toBe('RQRFT1W2')
    expect(normalizeFriendCode(' rqrf t1w2 ')).toBe('RQRFT1W2')
  })

  it('folds the Crockford lookalikes the way the server does', () => {
    // I and L are both a mis-read 1; O is a mis-read 0.
    expect(normalizeFriendCode('ILOilo12')).toBe('11011012')
  })

  it('stops at eight characters so the field cannot overrun', () => {
    expect(normalizeFriendCode('ABCD1234EXTRA')).toBe('ABCD1234')
  })

  it('is idempotent', () => {
    const once = normalizeFriendCode('rq-rf t1w2')
    expect(normalizeFriendCode(once)).toBe(once)
  })

  it('survives an empty or junk-only input', () => {
    expect(normalizeFriendCode('')).toBe('')
    expect(normalizeFriendCode('---')).toBe('')
  })
})

describe('isCompleteFriendCode', () => {
  it('accepts a real code', () => {
    expect(isCompleteFriendCode('RQRFT1W2')).toBe(true)
    expect(isCompleteFriendCode('DNEQQPTM')).toBe(true)
  })

  it('rejects anything short, long, or outside the alphabet', () => {
    expect(isCompleteFriendCode('RQRFT1W')).toBe(false)
    expect(isCompleteFriendCode('RQRFT1W2X')).toBe(false)
    expect(isCompleteFriendCode('rqrft1w2')).toBe(false)
  })

  it('rejects the excluded letters, since normalising removes them first', () => {
    for (const letter of ['I', 'L', 'O', 'U']) {
      expect(isCompleteFriendCode(`ABCD123${letter}`)).toBe(false)
    }
  })
})

describe('friendRequestMessage', () => {
  it('turns a duplicate-pending violation into something readable', () => {
    expect(
      friendRequestMessage({
        code: '23505',
        message: 'duplicate key value violates unique constraint "friend_requests_unique_pending"',
      }),
    ).toBe('You have already sent this person a request.')
  })

  it('passes the database trigger wording straight through', () => {
    // These are raised deliberately, already phrased for a human to read.
    const message = 'You are already friends with this person.'
    expect(friendRequestMessage({ code: 'P0001', message })).toBe(message)
  })

  it('explains an RLS refusal instead of showing the raw text', () => {
    expect(
      friendRequestMessage({
        code: '42501',
        message: 'new row violates row-level security policy for table "friend_requests"',
      }),
    ).toBe('That was refused. Try signing out and back in.')
  })

  it('falls back to the message when there is no code at all', () => {
    expect(friendRequestMessage({ message: 'Failed to fetch' })).toBe('Failed to fetch')
  })
})
