// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { concatBytes, fromBytea, fromUtf8, toBytea, uint64BE, utf8 } from './bytes'

describe('bytea encoding', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(fromBytea(toBytea(bytes))).toEqual(bytes)
  })

  it('emits the Postgres hex format', () => {
    expect(toBytea(Uint8Array.from([0x00, 0x0f, 0xde, 0xad]))).toBe('\\x000fdead')
  })

  it('accepts a hex string without the prefix', () => {
    expect(fromBytea('deadbeef')).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
  })

  it('handles empty input', () => {
    expect(toBytea(new Uint8Array(0))).toBe('\\x')
    expect(fromBytea('\\x')).toEqual(new Uint8Array(0))
  })

  it('rejects malformed input rather than silently truncating', () => {
    expect(() => fromBytea('\\xabc')).toThrow(/odd number/i)
    expect(() => fromBytea('\\xzz')).toThrow(/non-hex/i)
  })
})

describe('byte helpers', () => {
  it('round-trips utf8 including astral characters', () => {
    const text = 'sync — 🎬 movie night'
    expect(fromUtf8(utf8(text))).toBe(text)
  })

  it('concatenates in order', () => {
    expect(concatBytes(Uint8Array.from([1, 2]), new Uint8Array(0), Uint8Array.from([3]))).toEqual(
      Uint8Array.from([1, 2, 3]),
    )
  })

  it('encodes uint64 big-endian', () => {
    expect(uint64BE(1)).toEqual(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]))
    expect(uint64BE(0x0102030405060708n)).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
  })
})
