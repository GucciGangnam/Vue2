/**
 * Byte-wrangling helpers shared by every crypto module.
 *
 * Postgres `bytea` arrives from PostgREST as a hex string (`\xdeadbeef`) and
 * must be sent back in the same shape, so the conversion lives here rather
 * than being reinvented at each call site.
 */

const HEX_PREFIX = '\\x'

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

/** Encode bytes for a Postgres `bytea` column. */
export function toBytea(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return HEX_PREFIX + hex
}

/** Decode a Postgres `bytea` value returned by PostgREST. */
export function fromBytea(value: string): Uint8Array {
  const hex = value.startsWith(HEX_PREFIX) ? value.slice(HEX_PREFIX.length) : value
  if (hex.length % 2 !== 0) {
    throw new Error('Malformed bytea: odd number of hex digits')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('Malformed bytea: non-hex characters')
    out[i] = byte
  }
  return out
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Concatenate byte arrays into one buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Big-endian uint64, used for chunk indices in the media cipher. */
export function uint64BE(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}

/**
 * Best-effort scrub of key material we are done with. JavaScript gives no real
 * guarantee (the GC may already have copied the buffer), but overwriting the
 * bytes we can still reach costs nothing and shortens the window.
 */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0)
}

/**
 * Compare two byte arrays without early exit. Not a security boundary here --
 * GCM already authenticates -- but constant-time comparison is the right habit
 * in a crypto module, and it costs nothing at these sizes.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

/** `ArrayBuffer` view helper: WebCrypto returns buffers, we work in views. */
export function view(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer)
}
