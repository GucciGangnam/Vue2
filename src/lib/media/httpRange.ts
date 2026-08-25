/**
 * Parsing and formatting HTTP byte ranges.
 *
 * Pulled out of the service worker deliberately: this is fiddly, inclusive-
 * bounded arithmetic that a media element will exercise in every awkward form
 * it can, and it is far easier to test as a pure function than through a
 * `fetch` event. See RFC 9110 section 14.
 *
 * We only support single ranges. Multi-range requests (`bytes=0-9,20-29`) would
 * need a multipart/byteranges response, and no media element sends them.
 */

export interface ByteRange {
  /** Inclusive. */
  start: number
  /** Inclusive. */
  end: number
}

export type RangeParse =
  /** No `Range` header: the caller wants the whole resource. */
  | { kind: 'none' }
  | { kind: 'range'; range: ByteRange }
  /** Syntactically fine but outside the resource: answer 416. */
  | { kind: 'unsatisfiable' }
  /** Not something we can answer with a single 206; fall back to 200. */
  | { kind: 'unsupported' }

export function parseRangeHeader(header: string | null | undefined, size: number): RangeParse {
  if (!header) return { kind: 'none' }

  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (!match) return { kind: 'unsupported' }

  const spec = (match[1] ?? '').trim()
  // A comma means multiple ranges, which we deliberately do not serve.
  if (spec.includes(',')) return { kind: 'unsupported' }

  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return { kind: 'unsupported' }

  const rawStart = parts[1] ?? ''
  const rawEnd = parts[2] ?? ''
  if (rawStart === '' && rawEnd === '') return { kind: 'unsupported' }

  // An empty resource can satisfy nothing.
  if (size <= 0) return { kind: 'unsatisfiable' }

  // `bytes=-500` means the *last* 500 bytes, not "up to 500".
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix)) return { kind: 'unsupported' }
    if (suffix === 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, size - suffix)
    return { kind: 'range', range: { start, end: size - 1 } }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start)) return { kind: 'unsupported' }
  if (start >= size) return { kind: 'unsatisfiable' }

  // `bytes=100-` runs to the end. An end past the resource is clamped rather
  // than refused -- that is what RFC 9110 asks for, and media elements rely on
  // it when they guess beyond the file.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end)) return { kind: 'unsupported' }
  if (end < start) return { kind: 'unsatisfiable' }

  return { kind: 'range', range: { start, end } }
}

/** The `Content-Range` value for a 206. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

/** The `Content-Range` value for a 416, which reports only the size. */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`
}

/** The `Range` value to ask upstream for an inclusive ciphertext window. */
export function rangeHeader(start: number, end: number): string {
  return `bytes=${start}-${end}`
}
