import { describe, expect, it } from 'vitest'
import { contentRange, parseRangeHeader, rangeHeader, unsatisfiedContentRange } from './httpRange'

const SIZE = 1000

function range(header: string | null, size = SIZE) {
  return parseRangeHeader(header, size)
}

describe('parseRangeHeader', () => {
  it('treats a missing header as a request for everything', () => {
    expect(range(null)).toEqual({ kind: 'none' })
    expect(range('')).toEqual({ kind: 'none' })
  })

  it('parses a closed range inclusively', () => {
    expect(range('bytes=0-99')).toEqual({ kind: 'range', range: { start: 0, end: 99 } })
    expect(range('bytes=100-199')).toEqual({ kind: 'range', range: { start: 100, end: 199 } })
  })

  it('parses an open-ended range as running to the last byte', () => {
    // This is what a video element sends first, and the answer must be the
    // whole remainder -- not a guess at a buffer size.
    expect(range('bytes=0-')).toEqual({ kind: 'range', range: { start: 0, end: 999 } })
    expect(range('bytes=990-')).toEqual({ kind: 'range', range: { start: 990, end: 999 } })
  })

  it('parses a suffix range as the LAST n bytes', () => {
    // `bytes=-500` is the final 500 bytes, not the first 500. Getting this
    // backwards produces a file that plays and seeks to the wrong place.
    expect(range('bytes=-500')).toEqual({ kind: 'range', range: { start: 500, end: 999 } })
    expect(range('bytes=-1')).toEqual({ kind: 'range', range: { start: 999, end: 999 } })
  })

  it('clamps a suffix longer than the resource', () => {
    expect(range('bytes=-5000')).toEqual({ kind: 'range', range: { start: 0, end: 999 } })
  })

  it('clamps an end past the resource instead of refusing', () => {
    // Media elements routinely ask past what they think the size is.
    expect(range('bytes=900-99999')).toEqual({ kind: 'range', range: { start: 900, end: 999 } })
  })

  it('asks for a single byte correctly', () => {
    expect(range('bytes=0-0')).toEqual({ kind: 'range', range: { start: 0, end: 0 } })
    expect(range('bytes=999-999')).toEqual({ kind: 'range', range: { start: 999, end: 999 } })
  })

  it('is unsatisfiable past the end, or when reversed', () => {
    expect(range('bytes=1000-')).toEqual({ kind: 'unsatisfiable' })
    expect(range('bytes=1000-1010')).toEqual({ kind: 'unsatisfiable' })
    expect(range('bytes=-0')).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable against an empty resource', () => {
    expect(range('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('declines multi-range rather than answering half of it', () => {
    // Answering only the first range of a multipart request would silently
    // corrupt the response, so refuse and let the caller send 200.
    expect(range('bytes=0-9,20-29')).toEqual({ kind: 'unsupported' })
  })

  it('declines units it does not understand', () => {
    expect(range('items=0-9')).toEqual({ kind: 'unsupported' })
    expect(range('bytes=abc-def')).toEqual({ kind: 'unsupported' })
    expect(range('bytes=-')).toEqual({ kind: 'unsupported' })
    expect(range('nonsense')).toEqual({ kind: 'unsupported' })
  })

  it('tolerates whitespace and mixed case', () => {
    expect(range('  Bytes=0-99  ')).toEqual({ kind: 'range', range: { start: 0, end: 99 } })
  })
})

describe('range headers', () => {
  it('formats Content-Range for a 206', () => {
    expect(contentRange({ start: 0, end: 99 }, 1000)).toBe('bytes 0-99/1000')
  })

  it('formats Content-Range for a 416 with only the size', () => {
    expect(unsatisfiedContentRange(1000)).toBe('bytes */1000')
  })

  it('formats an upstream Range request', () => {
    expect(rangeHeader(0, 1048591)).toBe('bytes=0-1048591')
  })

  it('round trips: what we ask upstream, we can parse back', () => {
    const asked = rangeHeader(500, 799)
    expect(parseRangeHeader(asked, 1000)).toEqual({
      kind: 'range',
      range: { start: 500, end: 799 },
    })
  })
})
